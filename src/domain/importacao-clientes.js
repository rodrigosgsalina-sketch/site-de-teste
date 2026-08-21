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
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellFormula: false, raw: false });
  const nomeAba = wb.SheetNames[0];
  if (!nomeAba) throw new ErroValidacao('A planilha está vazia.');
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
        'do Domínio Sistemas ou uma planilha com as colunas Código, Apelido, Nome e Razão social.'
    );
  }

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

    const existente = clientes.porCodigo(codigo);
    registros.push({ ...bruto, codigo, nome, __novo: !existente, __idExistente: existente ? existente.id : null });
  });

  return {
    formato: usarFichas ? 'ficha' : 'tabela',
    aba,
    abas,
    totalLinhas: linhas.length,
    registros,
    novos: registros.filter((r) => r.__novo).length,
    existentes: registros.filter((r) => !r.__novo).length,
    erros,
    naoReconhecidos: escolhido.naoReconhecidos || [],
    camposEncontrados: [...new Set(registros.flatMap((r) => Object.keys(r)))].filter((c) => !c.startsWith('__')),
  };
}

/**
 * Grava os registros analisados. `atualizarExistentes` decide o que fazer com
 * empresas cujo código já está cadastrado.
 */
function importar(registros, usuario, { atualizarExistentes = true } = {}) {
  let criados = 0;
  let atualizados = 0;
  let ignorados = 0;
  const falhas = [];

  db.tx(() => {
    for (const registro of registros) {
      const dados = {};
      for (const campo of clientes.CAMPOS) {
        if (registro[campo] !== undefined) dados[campo] = registro[campo];
      }
      try {
        const existente = clientes.porCodigo(dados.codigo);
        if (existente) {
          if (!atualizarExistentes) {
            ignorados += 1;
            continue;
          }
          // preserva as observações internas, que não vêm da planilha
          clientes.atualizar(existente.id, { ...dados, observacoes: existente.observacoes });
          atualizados += 1;
        } else {
          clientes.criar(dados, usuario, 'Importação');
          criados += 1;
        }
      } catch (err) {
        falhas.push({ codigo: dados.codigo, motivo: err.message });
      }
    }
  });

  return { criados, atualizados, ignorados, falhas, quando: agoraISO() };
}

module.exports = { analisar, importar, chave, DE_PARA };
