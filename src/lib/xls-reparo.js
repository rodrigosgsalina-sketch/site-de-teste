'use strict';

/**
 * Reparo de planilhas .xls (Excel 97–2003, formato BIFF8) com o índice das
 * abas fora do lugar.
 *
 * Por que existe: o relatório "Empresas" exportado pelo Domínio Sistemas vem
 * num .xls que o Excel abre normalmente, mas que a biblioteca de leitura
 * (SheetJS) lê como uma pasta de trabalho sem conteúdo — ela vê o nome da aba e
 * nenhuma célula. Por dentro, o arquivo é uma sequência de registros: primeiro
 * o "miolo global" (fontes, estilos, textos compartilhados e a lista de abas,
 * cada uma com a posição em que começa), depois cada aba, entre um registro de
 * início (BOF) e um de fim (EOF). O gerador do Domínio grava centenas de
 * milhares de células vazias **soltas** entre o fim do miolo e o começo da aba,
 * e a posição anotada na lista de abas aponta para essas células, não para o
 * começo da aba. O Excel procura o início da aba sozinho e não se importa; a
 * biblioteca confia na posição anotada, não encontra aba nenhuma ali e a deixa
 * de fora.
 *
 * O reparo refaz o arquivo como o formato manda: as células soltas entram na
 * aba que vem logo depois delas (nada se perde — elas são de lá), e a posição
 * de cada aba é recalculada. Planilha que já está certa não é tocada.
 *
 * Opcionalmente, também descarta as **células mescladas** (`descartarMesclas`).
 * A mescla é só aparência — o valor de uma área mesclada fica na primeira
 * célula, que é onde a leitura olha —, mas a biblioteca as processa de um jeito
 * que fica muito lento quando são muitas: o relatório do Domínio tem 70 mil, e
 * a leitura cai de 17 segundos para menos de meio segundo sem elas. Quem só
 * precisa dos valores (a importação de empresas) pede o descarte.
 *
 * Tudo em memória: o arquivo enviado não é alterado.
 */

const BOF = 0x0809;
const EOF = 0x000a;
const BOUNDSHEET = 0x0085;

/**
 * Células vazias (BLANK e MULBLANK): guardam só o estilo de uma posição, nunca
 * um valor. Soltas fora da aba, são descartadas em vez de devolvidas a ela —
 * no relatório do Domínio são 255 mil, e carregá-las de volta só triplicava o
 * tempo de leitura para não acrescentar nada ao que se importa.
 */
const SO_ESTILO = new Set([0x0201, 0x00be]);

const MERGECELLS = 0x00e5;

/** Tipo de "subfluxo" no BOF: 0x0005 é o miolo global da pasta de trabalho. */
const BOF_GLOBAL = 0x0005;

/** Lê o fluxo como lista de registros { tipo, inicio, fim }. */
function registros(fluxo) {
  const lista = [];
  let pos = 0;
  while (pos + 4 <= fluxo.length) {
    const tipo = fluxo.readUInt16LE(pos);
    const tamanho = fluxo.readUInt16LE(pos + 2);
    // Registro de tipo zero não existe no formato: daqui em diante é o
    // preenchimento com zeros que alguns geradores deixam no fim do fluxo.
    if (tipo === 0 && tamanho === 0 && fluxo.subarray(pos).every((b) => b === 0)) return lista;
    const fim = pos + 4 + tamanho;
    if (fim > fluxo.length) return null; // registro cortado: não é um BIFF que dê para refazer
    lista.push({ tipo, inicio: pos, fim });
    pos = fim;
  }
  const sobra = fluxo.subarray(pos);
  return sobra.every((b) => b === 0) ? lista : null;
}

/**
 * Separa o fluxo em miolo global, abas e registros soltos.
 *
 * Um BOF dentro de uma aba (gráfico embutido) abre um nível a mais e é
 * fechado pelo EOF correspondente — por isso a contagem de profundidade, e
 * não "do BOF ao primeiro EOF".
 */
function separar(fluxo, lista) {
  const blocos = []; // { tipo: 'global' | 'aba' | 'solto', registros: [] }
  let atual = null;
  let profundidade = 0;

  for (const r of lista) {
    if (profundidade === 0) {
      if (r.tipo === BOF) {
        const subtipo = r.fim - r.inicio >= 8 ? fluxo.readUInt16LE(r.inicio + 6) : 0;
        atual = { tipo: subtipo === BOF_GLOBAL && !blocos.some((b) => b.tipo === 'global') ? 'global' : 'aba', registros: [r] };
        blocos.push(atual);
        profundidade = 1;
        continue;
      }
      // Fora de qualquer subfluxo: registro solto.
      const ultimo = blocos[blocos.length - 1];
      if (ultimo && ultimo.tipo === 'solto') ultimo.registros.push(r);
      else blocos.push({ tipo: 'solto', registros: [r] });
      continue;
    }

    atual.registros.push(r);
    if (r.tipo === BOF) profundidade += 1;
    else if (r.tipo === EOF) profundidade -= 1;
  }

  // Aba sem EOF no fim do arquivo: o formato está quebrado de um jeito que o
  // reparo não sabe consertar.
  if (profundidade !== 0) return null;
  return blocos;
}

/**
 * Devolve o fluxo "Workbook" refeito, ou `null` se não há nada a reparar (ou
 * se o arquivo está quebrado de um jeito que este reparo não cobre).
 */
function repararFluxo(fluxo, { descartarMesclas = false } = {}) {
  const lista = registros(fluxo);
  if (!lista || !lista.length) return null;
  const blocos = separar(fluxo, lista);
  if (!blocos) return null;

  const global = blocos.find((b) => b.tipo === 'global');
  const abas = blocos.filter((b) => b.tipo === 'aba');
  if (!global || !abas.length) return null;

  // Soltos entram na aba seguinte, logo antes do EOF dela; os que sobram no
  // fim do arquivo, na última aba.
  // (Sem `push(...lista)`: com centenas de milhares de registros, espalhar a
  // lista como argumentos estoura a pilha.)
  const extrasPorAba = new Map(abas.map((a) => [a, []]));
  let pendentes = [];
  for (const bloco of blocos) {
    if (bloco.tipo === 'solto') {
      pendentes = pendentes.concat(bloco.registros.filter((r) => !SO_ESTILO.has(r.tipo)));
    }
    else if (bloco.tipo === 'aba' && pendentes.length) {
      extrasPorAba.set(bloco, extrasPorAba.get(bloco).concat(pendentes));
      pendentes = [];
    }
  }
  if (pendentes.length) {
    const ultima = abas[abas.length - 1];
    extrasPorAba.set(ultima, extrasPorAba.get(ultima).concat(pendentes));
  }

  const fatias = (rs) => rs.map((r) => fluxo.subarray(r.inicio, r.fim));
  const pedacosGlobal = fatias(global.registros);
  const tamanhoGlobal = pedacosGlobal.reduce((s, b) => s + b.length, 0);

  // Monta as abas e anota onde cada uma começa no fluxo novo.
  const pedacosAbas = [];
  const inicios = [];
  let pos = tamanhoGlobal;
  for (const aba of abas) {
    inicios.push(pos);
    const extras = extrasPorAba.get(aba);
    let corpo = aba.registros.slice(0, -1); // tudo menos o EOF final
    if (descartarMesclas) corpo = corpo.filter((r) => r.tipo !== MERGECELLS);
    const ordem = corpo.concat(extras, [aba.registros[aba.registros.length - 1]]);
    for (const pedaco of fatias(ordem)) {
      pedacosAbas.push(pedaco);
      pos += pedaco.length;
    }
  }

  // Confere se havia de fato algo errado: posições que não batem ou soltos.
  const boundsheets = global.registros.filter((r) => r.tipo === BOUNDSHEET);
  const posicoesAnotadas = boundsheets.map((r) => fluxo.readUInt32LE(r.inicio + 4));
  const posicoesReais = abas.map((a) => a.registros[0].inicio);
  const haviaSoltos = blocos.some((b) => b.tipo === 'solto');
  const posicoesErradas =
    posicoesAnotadas.length !== posicoesReais.length || posicoesAnotadas.some((p, i) => p !== posicoesReais[i]);
  const haviaMesclas = descartarMesclas && abas.some((a) => a.registros.some((r) => r.tipo === MERGECELLS));
  if (!haviaSoltos && !posicoesErradas && !haviaMesclas) return null;

  // Grava as posições novas na lista de abas (cópia: o original fica intacto).
  const globalNovo = Buffer.concat(pedacosGlobal);
  let deslocamento = 0;
  let indiceAba = 0;
  for (const r of global.registros) {
    if (r.tipo === BOUNDSHEET && indiceAba < inicios.length) {
      globalNovo.writeUInt32LE(inicios[indiceAba], deslocamento + 4);
      indiceAba += 1;
    }
    deslocamento += r.fim - r.inicio;
  }

  return Buffer.concat([globalNovo, ...pedacosAbas]);
}

/**
 * Recebe o arquivo .xls inteiro e devolve um .xls reparado, ou `null` quando
 * não há o que reparar (ou quando o arquivo não é um .xls binário). `XLSX` é a biblioteca de planilhas já carregada (ela
 * traz o leitor do contêiner OLE em que o .xls é guardado).
 */
function repararXls(buffer, XLSX, opcoes = {}) {
  let cfb;
  try {
    cfb = XLSX.CFB.read(buffer, { type: 'buffer' });
  } catch (_) {
    return null; // não é um .xls binário (pode ser .xlsx, .csv, HTML)
  }
  const entrada = XLSX.CFB.find(cfb, 'Workbook') || XLSX.CFB.find(cfb, 'Book');
  if (!entrada || !entrada.content) return null;

  const reparado = repararFluxo(Buffer.from(entrada.content), opcoes);
  if (!reparado) return null;

  const novo = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(novo, 'Workbook', reparado);
  return Buffer.from(XLSX.CFB.write(novo, { type: 'buffer', fileType: 'cfb' }));
}

module.exports = { repararXls, repararFluxo };
