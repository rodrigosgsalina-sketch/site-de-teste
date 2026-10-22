'use strict';

/**
 * Importação de empresas no modelo do Domínio Sistemas.
 *
 * O relatório "Empresas / Dados cadastrais" do Domínio não vem em formato de
 * tabela: cada empresa ocupa um bloco de linhas com pares "Rótulo: valor" em
 * duas colunas, e o cabeçalho de página se repete a cada página. O leitor
 * abaixo entende esse formato e também aceita planilhas tabulares comuns
 * (uma linha de títulos e uma empresa por linha), reconhecendo os nomes de
 * coluna por sinônimos.
 *
 * Formatos aceitos: .xlsx, .xls, .csv (a biblioteca também lê o "xls" que
 * alguns sistemas exportam como HTML).
 */

const clientes = require('./clientes');
const db = require('../db');
const { agoraISO } = require('../lib/datas');
const { ErroValidacao } = require('./checklist');
const { repararXls } = require('../lib/xls-reparo');

/** Normaliza rótulos para comparação: sem acento, sem pontuação, minúsculo. */
function chave(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Rótulo da planilha -> campo do cadastro. Inclui as variações que aparecem
 * no Domínio e os nomes mais usados em planilhas montadas à mão.
 */
const DE_PARA = {
  codigo: 'codigo',
  cod: 'codigo',
  apelido: 'apelido',
  nome: 'nome',
  'razao social': 'razao_social',
  'nome fantasia': 'nome_fantasia',
  fantasia: 'nome_fantasia',

  'cnpj cpf cei caepf': 'cnpj_cpf',
  cnpj: 'cnpj_cpf',
  'cnpj cpf': 'cnpj_cpf',
  cpf: 'cnpj_cpf',
  'insc estadual': 'inscricao_estadual',
  'inscricao estadual': 'inscricao_estadual',
  'insc municipal': 'inscricao_municipal',
  'inscricao municipal': 'inscricao_municipal',
  'insc junta comercial': 'inscricao_junta',
  'junta comercial': 'inscricao_junta',
  'insc suframa': 'inscricao_suframa',
  'insc sub trib': 'inscricao_sub_trib',

  'tipo de endereco': 'tipo_endereco',
  endereco: 'endereco',
  logradouro: 'endereco',
  numero: 'numero',
  complemento: 'complemento',
  bairro: 'bairro',
  municipio: 'municipio',
  cidade: 'municipio',
  uf: 'uf',
  estado: 'uf',
  cep: 'cep',
  'caixa postal': 'caixa_postal',
  pais: 'pais',

  telefone: 'telefone',
  fone: 'telefone',
  fax: 'fax',
  'e mail': 'email',
  email: 'email',
  'pagina na internet': 'site',
  site: 'site',

  'natureza juridica': 'natureza_juridica',
  'cnae 2 3': 'cnae',
  cnae: 'cnae',
  cae: 'cae',
  'ramo de atividade': 'ramo_atividade',
  atividade: 'ramo_atividade',
  'capital social': 'capital_social',
  'responsavel legal': 'responsavel_legal',
  contador: 'contador',
  'foro comarca': 'foro_comarca',
  'duracao do contrato': 'duracao_contrato',
  registro: 'registro',
  'outro registro': 'outro_registro',
  'data de registro': 'data_registro',

  situacao: 'situacao',
  'data da situacao': 'data_situacao',
  motivo: 'motivo',
  'data da inscricao': 'data_inscricao',
  'inicio atividades': 'inicio_atividades',
  'inicio das atividades': 'inicio_atividades',
  'cliente desde': 'cliente_desde',
  observacoes: 'observacoes',
};

/** Rótulos do cabeçalho do relatório, que não pertencem à empresa. */
const RODAPE_RELATORIO = new Set(['empresa', 'c n p j', 'pagina', 'emissao', 'hora']);

/**
 * A biblioteca de planilhas é carregada só na hora de ler uma.
 *
 * Ela é a única dependência que vem de fora do npm (o CDN do SheetJS), e é
 * também a única que pode faltar numa instalação que deu errado pela metade.
 * Carregando aqui, a falta dela derruba a importação de empresas com uma
 * mensagem clara — e não a plataforma inteira no `npm start`, por causa de um
 * `require` no topo de um arquivo que quase ninguém usa.
 */
function planilhas() {
  try {
    // eslint-disable-next-line global-require
    return require('xlsx');
  } catch (_) {
    throw new ErroValidacao(
      'A biblioteca de leitura de planilhas (xlsx) não está instalada. ' +
        'Rode "npm install" na pasta da plataforma e tente de novo.'
    );
  }
}

function lerPlanilha(buffer) {
  const XLSX = planilhas();

  // O .xls que o Domínio exporta tem o índice das abas fora do lugar, e a
  // biblioteca o lia como uma pasta sem conteúdo — era o "não encontrei
  // empresas" com o arquivo certo na mão. O reparo refaz o arquivo em memória
  // e, de quebra, descarta as células mescladas, que só deixavam a leitura
  // lenta (ver src/lib/xls-reparo.js). Arquivo que não precisa de reparo — ou
  // que não é um .xls binário — segue como veio.
  const preparado = repararXls(buffer, XLSX, { descartarMesclas: true }) || buffer;

  let wb;
  try {
    wb = XLSX.read(preparado, { type: 'buffer', cellDates: false, cellFormula: false, raw: false });
  } catch (_) {
    throw new ErroValidacao(
      'Não consegui abrir este arquivo como planilha. Confira se é o relatório exportado do Domínio ' +
        '(.xls ou .xlsx) e, se o problema continuar, abra-o no Excel e salve de novo antes de enviar.'
    );
  }

  // Aba listada mas sem conteúdo é o sintoma de arquivo que a biblioteca não
  // conseguiu montar: diga isso, em vez de "não encontrei empresas", que
  // manda procurar o problema no lugar errado.
  const nomeAba = wb.SheetNames.find((nome) => wb.Sheets[nome]);
  if (!nomeAba) {
    if (wb.SheetNames.length) {
      throw new ErroValidacao(
        `A planilha tem a aba "${wb.SheetNames[0]}", mas o conteúdo dela não pôde ser lido. Abra o ` +
          'arquivo no Excel, use "Salvar como" no formato .xlsx e envie o arquivo salvo.'
      );
    }
    throw new ErroValidacao('A planilha está vazia.');
  }
  const linhas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, raw: false, defval: '' });
  return { aba: nomeAba, abas: wb.SheetNames, linhas };
}

/** Pares "Rótulo:" + valor de uma linha, respeitando o rótulo seguinte. */
function paresDaLinha(celulas) {
  const pares = [];
  for (let i = 0; i < celulas.length; i++) {
    if (!celulas[i].endsWith(':')) continue;
    let valor = '';
    for (let j = i + 1; j < celulas.length; j++) {
      if (celulas[j].endsWith(':')) break; // já é o próximo rótulo
      if (celulas[j]) {
        valor = celulas[j];
        break;
      }
    }
    pares.push([celulas[i].slice(0, -1).trim(), valor]);
  }
  return pares;
}

/** Relatório do Domínio: uma ficha por empresa, com pares rótulo/valor. */
function lerFichas(linhas) {
  const registros = [];
  const naoReconhecidos = new Set();
  let atual = null;

  for (const linha of linhas) {
    const celulas = linha.map((c) => String(c == null ? '' : c).trim());
    for (const [rotulo, valor] of paresDaLinha(celulas)) {
      const k = chave(rotulo);
      if (RODAPE_RELATORIO.has(k)) continue;

      if (k === 'codigo') {
        atual = { __linha: registros.length + 1 };
        registros.push(atual);
      }
      if (!atual) continue;

      // "Data:" aparece duas vezes na ficha; o contexto define a qual pertence
      let campo = DE_PARA[k];
      if (k === 'data') {
        campo = atual.capital_social !== undefined ? 'data_capital' : 'data_duracao';
      }
      if (!campo) {
        if (rotulo) naoReconhecidos.add(rotulo);
        continue;
      }
      if (atual[campo] === undefined || (!atual[campo] && valor)) atual[campo] = valor;
    }
  }
  return { registros, naoReconhecidos: [...naoReconhecidos] };
}

/** Planilha tabular: primeira linha com títulos, uma empresa por linha. */
function lerTabela(linhas) {
  const indiceTitulos = linhas.findIndex((l) =>
    l.some((c) => ['codigo', 'cod'].includes(chave(c))) &&
    l.some((c) => ['nome', 'razao social', 'apelido'].includes(chave(c)))
  );
  if (indiceTitulos === -1) return null;

  const titulos = linhas[indiceTitulos].map((c) => String(c || '').trim());
  const mapa = titulos.map((t) => DE_PARA[chave(t)] || null);
  const naoReconhecidos = titulos.filter((t, i) => t && !mapa[i]);

  const registros = [];
  for (let i = indiceTitulos + 1; i < linhas.length; i++) {
    const celulas = linhas[i].map((c) => String(c == null ? '' : c).trim());
    if (!celulas.some(Boolean)) continue;
    const registro = { __linha: i + 1 };
    mapa.forEach((campo, coluna) => {
      if (campo && celulas[coluna]) registro[campo] = celulas[coluna];
    });
    if (registro.codigo || registro.nome || registro.razao_social) registros.push(registro);
  }
  return { registros, naoReconhecidos, titulos };
}

/* ------------------------------------------------- empresas já cadastradas */

/** Só os dígitos do CNPJ/CPF. */
function digitos(valor) {
  return String(valor || '').replace(/\D+/g, '');
}

/**
 * Documento que serve para reconhecer uma empresa: CNPJ (14), CPF (11) ou
 * CEI/CAEPF (12), e que não seja um enchimento como "00000000000000".
 *
 * O próprio relatório do Domínio traz três empresas diferentes com o CNPJ
 * zerado — se ele valesse como identificação, as três seriam a "mesma".
 */
function documentoUtil(valor) {
  const d = digitos(valor);
  if (![11, 12, 14].includes(d.length)) return '';
  if (/^(\d)\1+$/.test(d)) return '';
  return d;
}

/**
 * Fotografia do que já está cadastrado, para comparar a planilha inteira com
 * uma consulta só (e não duas por linha).
 */
function cadastroAtual() {
  const linhas = db.get().prepare('SELECT id, codigo, nome, cnpj_cpf FROM clientes').all();
  const porCodigo = new Map();
  const porDocumento = new Map();
  for (const c of linhas) {
    porCodigo.set(String(c.codigo).trim(), c);
    const d = documentoUtil(c.cnpj_cpf);
    if (d) {
      if (!porDocumento.has(d)) porDocumento.set(d, []);
      porDocumento.get(d).push(c);
    }
  }
  return { porCodigo, porDocumento };
}

/**
 * Situação de uma empresa da planilha em relação ao cadastro:
 *
 *  - **cadastrada**: o código do Domínio já existe. É a mesma empresa — o
 *    código é a identidade dela no Domínio e aqui.
 *  - **mesmo_documento**: o código é novo, mas o CNPJ/CPF já pertence a uma
 *    empresa cadastrada com outro código. Quase sempre é a mesma empresa
 *    recadastrada no Domínio, e por padrão ela **não** entra — senão viraria
 *    duplicata aqui. Mas não é certeza: o Domínio tem empresas diferentes
 *    com o mesmo documento, por erro de digitação lá. Por isso ela aparece
 *    separada na conferência, com a opção de cadastrar mesmo assim.
 *  - **nova**: nem o código nem o documento existem. Entra.
 */
function situacaoNoCadastro(registro, cadastro) {
  const doCodigo = cadastro.porCodigo.get(String(registro.codigo).trim());
  if (doCodigo) return { situacao: 'cadastrada', existente: doCodigo };

  const doc = documentoUtil(registro.cnpj_cpf);
  const doDocumento = doc ? cadastro.porDocumento.get(doc) : null;
  if (doDocumento && doDocumento.length) return { situacao: 'mesmo_documento', existente: doDocumento[0] };

  return { situacao: 'nova', existente: null };
}

/* ------------------------------------------------------------------ análise */

/**
 * Lê o arquivo e devolve o que será importado, sem gravar nada.
 * A tela usa esse resultado para a conferência antes de confirmar.
 */
function analisar(buffer) {
  const { aba, abas, linhas } = lerPlanilha(buffer);

  const tabela = lerTabela(linhas);
  const fichas = lerFichas(linhas);
  // O formato de ficha é o do Domínio; a tabela é o caminho alternativo.
  const usarFichas = fichas.registros.length >= (tabela ? tabela.registros.length : 0);
  const escolhido = usarFichas ? fichas : tabela;

  if (!escolhido || !escolhido.registros.length) {
    throw new ErroValidacao(
      'Não encontrei empresas nesta planilha. Esperado o relatório "Empresas · Dados cadastrais" ' +
        'do Domínio Sistemas ou uma planilha com as colunas Código, Apelido, Nome e Razão social. ' +
        `A aba lida foi "${aba}", com ${linhas.length} linha(s).`
    );
  }

  const cadastro = cadastroAtual();
  const vistos = new Map();
  const erros = [];
  const registros = [];

  escolhido.registros.forEach((bruto) => {
    const codigo = String(bruto.codigo || '').trim();
    const nome = String(bruto.nome || bruto.razao_social || '').trim();
    if (!codigo) {
      erros.push({ linha: bruto.__linha, motivo: 'sem código', nome });
      return;
    }
    if (!nome) {
      erros.push({ linha: bruto.__linha, motivo: 'sem nome e sem razão social', codigo });
      return;
    }
    if (vistos.has(codigo)) {
      erros.push({ linha: bruto.__linha, motivo: `código ${codigo} repetido na planilha`, nome });
      return;
    }
    vistos.set(codigo, true);

    const { situacao, existente } = situacaoNoCadastro({ ...bruto, codigo }, cadastro);
    registros.push({
      ...bruto,
      codigo,
      nome,
      __situacao: situacao,
      __novo: situacao === 'nova',
      __idExistente: existente ? existente.id : null,
      __codigoNoSistema: existente ? existente.codigo : null,
      __nomeNoSistema: existente ? existente.nome : null,
    });
  });

  // Documento repetido dentro da própria planilha, entre empresas novas:
  // é o Domínio que tem a repetição, e as duas entram (cada uma com o seu
  // código). A conferência só mostra, para ninguém ser pego de surpresa.
  const novasPorDocumento = new Map();
  for (const r of registros) {
    if (r.__situacao !== 'nova') continue;
    const d = documentoUtil(r.cnpj_cpf);
    if (!d) continue;
    if (!novasPorDocumento.has(d)) novasPorDocumento.set(d, []);
    novasPorDocumento.get(d).push({ codigo: r.codigo, nome: r.nome });
  }
  const repetidasNaPlanilha = [...novasPorDocumento.entries()]
    .filter(([, lista]) => lista.length > 1)
    .map(([documento, empresas]) => ({ documento, empresas }));

  const contar = (situacao) => registros.filter((r) => r.__situacao === situacao).length;
  return {
    formato: usarFichas ? 'ficha' : 'tabela',
    aba,
    abas,
    totalLinhas: linhas.length,
    registros,
    novos: contar('nova'),
    existentes: contar('cadastrada'),
    mesmoDocumento: registros.filter((r) => r.__situacao === 'mesmo_documento'),
    repetidasNaPlanilha,
    erros,
    naoReconhecidos: escolhido.naoReconhecidos || [],
    camposEncontrados: [...new Set(registros.flatMap((r) => Object.keys(r)))].filter((c) => !c.startsWith('__')),
  };
}

/* ------------------------------------------------------------------ gravação */

/**
 * Dados da planilha por cima do cadastro, **sem apagar nada**: só o que veio
 * preenchido na planilha substitui. Antes a atualização regravava a ficha
 * inteira, e uma planilha com poucas colunas apagava o resto do cadastro — e
 * devolvia a situação para "Ativa", que é o padrão de campo vazio.
 */
function mesclar(existente, dados) {
  const resultado = {};
  for (const campo of clientes.CAMPOS) resultado[campo] = existente[campo];
  for (const [campo, valor] of Object.entries(dados)) {
    if (valor !== undefined && valor !== null && String(valor).trim() !== '') resultado[campo] = valor;
  }
  // O código é a identidade da empresa no Domínio: não muda por importação.
  resultado.codigo = existente.codigo;
  // Observações internas são da plataforma, não do Domínio.
  resultado.observacoes = existente.observacoes;
  return resultado;
}

/**
 * Grava os registros analisados.
 *
 *  - `atualizarExistentes`: empresas já cadastradas (mesmo código) recebem os
 *    dados preenchidos da planilha. Desligado, ficam como estão.
 *  - `incluirMesmoDocumento`: empresas de código novo cujo CNPJ/CPF já está
 *    cadastrado entram mesmo assim. Desligado, ficam de fora.
 *
 * A situação de cada empresa é refeita aqui, contra o cadastro de agora — a
 * conferência pode ter sido feita minutos antes, e alguém pode ter cadastrado
 * uma delas nesse meio-tempo. A comparação usa o cadastro de **antes** desta
 * importação: duas empresas da planilha com o mesmo documento não se anulam.
 */
function importar(registros, usuario, { atualizarExistentes = false, incluirMesmoDocumento = false } = {}) {
  let criados = 0;
  let atualizados = 0;
  let ignorados = 0;
  let mesmoDocumento = 0;
  const falhas = [];

  db.tx(() => {
    const cadastro = cadastroAtual();
    for (const registro of registros) {
      const dados = {};
      for (const campo of clientes.CAMPOS) {
        if (registro[campo] !== undefined) dados[campo] = registro[campo];
      }
      try {
        const { situacao, existente } = situacaoNoCadastro(dados, cadastro);
        if (situacao === 'cadastrada') {
          if (!atualizarExistentes) {
            ignorados += 1;
            continue;
          }
          clientes.atualizar(existente.id, mesclar(clientes.obter(existente.id), dados));
          atualizados += 1;
          continue;
        }
        if (situacao === 'mesmo_documento' && !incluirMesmoDocumento) {
          mesmoDocumento += 1;
          continue;
        }
        clientes.criar(dados, usuario, 'Importação');
        criados += 1;
      } catch (err) {
        falhas.push({ codigo: dados.codigo, motivo: err.message });
      }
    }
  });

  return { criados, atualizados, ignorados, mesmoDocumento, falhas, quando: agoraISO() };
}

module.exports = { analisar, importar, chave, DE_PARA, documentoUtil, mesclar };
