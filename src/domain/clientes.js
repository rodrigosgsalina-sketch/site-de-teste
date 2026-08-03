'use strict';

/**
 * Cadastro de clientes (empresas atendidas pelo escritório).
 *
 * Os campos espelham a ficha "Dados cadastrais" do relatório de empresas do
 * Domínio Sistemas, de onde os dados podem ser importados em lote. Somente
 * administradores cadastram, editam ou importam; os demais usuários consultam.
 */

const db = require('../db');
const { agoraISO } = require('../lib/datas');
const { ErroValidacao } = require('./checklist');

/** Campos gravados a partir do formulário e da importação. */
const CAMPOS = [
  'codigo', 'apelido', 'nome', 'razao_social', 'nome_fantasia',
  'cnpj_cpf', 'inscricao_estadual', 'inscricao_municipal', 'inscricao_junta',
  'inscricao_suframa', 'inscricao_sub_trib',
  'tipo_endereco', 'endereco', 'numero', 'complemento', 'bairro', 'municipio', 'uf',
  'cep', 'caixa_postal', 'pais',
  'telefone', 'fax', 'email', 'site',
  'natureza_juridica', 'cnae', 'cae', 'ramo_atividade', 'capital_social', 'data_capital',
  'responsavel_legal', 'contador', 'foro_comarca', 'duracao_contrato', 'data_duracao',
  'registro', 'outro_registro', 'data_registro',
  'situacao', 'data_situacao', 'motivo', 'data_inscricao', 'inicio_atividades', 'cliente_desde',
  'observacoes',
];

const SITUACOES = ['Ativa', 'Inativa', 'Ativo - Sem Movimento', 'Baixada', 'Suspensa'];

/** Só os dígitos — usado para comparar CNPJ digitado de formas diferentes. */
function soDigitos(valor) {
  return String(valor || '').replace(/\D+/g, '');
}

/** "40.000,00" -> 40000 ; "1234.56" -> 1234.56 ; vazio -> null */
function valorNumerico(texto) {
  const bruto = String(texto || '').trim();
  if (!bruto) return null;
  const limpo = bruto.replace(/[^\d,.-]/g, '');
  if (!limpo) return null;
  // formato brasileiro: ponto separa milhar, vírgula separa decimal
  const normalizado = limpo.includes(',') ? limpo.replace(/\./g, '').replace(',', '.') : limpo;
  const numero = Number(normalizado);
  return Number.isFinite(numero) ? numero : null;
}

/** "14/04/2003" -> "2003-04-14"; já em ISO, devolve como está. */
function dataISO(texto) {
  const bruto = String(texto || '').trim();
  if (!bruto) return null;
  const br = bruto.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(bruto)) return bruto;
  return bruto;
}

const CAMPOS_DATA = [
  'data_capital', 'data_duracao', 'data_registro', 'data_situacao',
  'data_inscricao', 'inicio_atividades', 'cliente_desde',
];

function limpar(dados) {
  const saida = {};
  for (const campo of CAMPOS) {
    let valor = dados[campo];
    valor = valor === undefined || valor === null ? '' : String(valor).trim();
    if (CAMPOS_DATA.includes(campo)) valor = valor ? dataISO(valor) : null;
    saida[campo] = valor === '' ? null : valor;
  }
  saida.uf = saida.uf ? saida.uf.toUpperCase().slice(0, 2) : null;
  saida.situacao = saida.situacao || 'Ativa';
  saida.capital_social_valor = valorNumerico(saida.capital_social);
  return saida;
}

/* ------------------------------------------------------------------ leitura */

function obter(id) {
  return db
    .get()
    .prepare(
      `SELECT c.*, u.nome AS criado_por
         FROM clientes c LEFT JOIN usuarios u ON u.id = c.criado_por_id
        WHERE c.id = ?`
    )
    .get(id);
}

function porCodigo(codigo) {
  return db.get().prepare('SELECT * FROM clientes WHERE codigo = ?').get(String(codigo).trim());
}

/** Texto comparável: sem acento, sem caixa. */
function semAcento(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Lista com filtros combináveis. A busca textual é tolerante a acento e caixa
 * e também aceita CNPJ digitado com ou sem pontuação.
 */
function listar({ busca = '', situacao = '', uf = '', municipio = '', limite = 500, pagina = 1 } = {}) {
  const condicoes = [];
  const args = [];
  if (situacao) {
    condicoes.push('situacao = ?');
    args.push(situacao);
  }
  if (uf) {
    condicoes.push('uf = ?');
    args.push(uf.toUpperCase());
  }
  if (municipio) {
    condicoes.push('municipio = ?');
    args.push(municipio);
  }
  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
  let linhas = db
    .get()
    .prepare(`SELECT * FROM clientes ${where} ORDER BY CAST(codigo AS INTEGER), nome`)
    .all(...args);

  const termo = String(busca || '').trim();
  if (termo) {
    const alvoDigitos = soDigitos(termo);
    const termos = semAcento(termo).split(/\s+/).filter(Boolean);
    linhas = linhas.filter((c) => {
      if (alvoDigitos.length >= 3 && soDigitos(c.cnpj_cpf).includes(alvoDigitos)) return true;
      if (alvoDigitos.length >= 1 && String(c.codigo) === termo) return true;
      const alvo = semAcento(
        [c.codigo, c.apelido, c.nome, c.razao_social, c.nome_fantasia, c.municipio, c.uf, c.email]
          .filter(Boolean)
          .join(' ')
      );
      return termos.every((t) => alvo.includes(t));
    });
  }

  const total = linhas.length;
  const inicio = (Math.max(1, pagina) - 1) * limite;
  return { total, itens: linhas.slice(inicio, inicio + limite), pagina: Math.max(1, pagina), limite };
}

/** Números para os cartões da tela de clientes. */
function resumo() {
  const conn = db.get();
  const totais = conn
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN situacao = 'Ativa' THEN 1 ELSE 0 END) AS ativas,
              SUM(CASE WHEN situacao = 'Inativa' THEN 1 ELSE 0 END) AS inativas,
              SUM(CASE WHEN situacao NOT IN ('Ativa', 'Inativa') THEN 1 ELSE 0 END) AS outras
         FROM clientes`
    )
    .get();
  return {
    total: totais.total || 0,
    ativas: totais.ativas || 0,
    inativas: totais.inativas || 0,
    outras: totais.outras || 0,
  };
}

function situacoesCadastradas() {
  return db
    .get()
    .prepare('SELECT situacao, COUNT(*) AS total FROM clientes GROUP BY situacao ORDER BY total DESC')
    .all();
}

function ufsCadastradas() {
  return db
    .get()
    .prepare("SELECT uf, COUNT(*) AS total FROM clientes WHERE uf IS NOT NULL AND uf <> '' GROUP BY uf ORDER BY uf")
    .all();
}

/**
 * Processos da empresa: os abertos pelo seletor de clientes (cliente_id) e,
 * por compatibilidade, os antigos que só guardavam o CNPJ como texto.
 */
function processosDoCliente(cliente) {
  const digitos = soDigitos(cliente.cnpj_cpf);
  return db
    .get()
    .prepare(
      `SELECT p.id, p.codigo, p.razao_social, p.data_abertura, p.data_previsao, p.data_conclusao,
              t.nome AS tipo_processo, st.nome AS status, st.final AS status_final
         FROM processos p
         JOIN tipos_processo t ON t.id = p.tipo_processo_id
         JOIN status_processo st ON st.id = p.status_id
        WHERE p.cliente_id = @id
           OR (p.cliente_id IS NULL AND @digitos <> ''
               AND REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(p.cnpj, ''), '.', ''), '/', ''), '-', ''), ' ', '') = @digitos)
        ORDER BY p.data_abertura DESC, p.id DESC`
    )
    .all({ id: cliente.id, digitos });
}

/* ------------------------------------------------------------------ escrita */

function validar(dados, idAtual = null) {
  const campos = limpar(dados);
  if (!campos.codigo) throw new ErroValidacao('Informe o código da empresa.');
  if (!campos.nome && !campos.razao_social) {
    throw new ErroValidacao('Informe ao menos o nome ou a razão social.');
  }
  campos.nome = campos.nome || campos.razao_social;
  const existente = porCodigo(campos.codigo);
  if (existente && existente.id !== Number(idAtual)) {
    throw new ErroValidacao(`Já existe um cliente com o código ${campos.codigo}.`);
  }
  if (campos.situacao && !SITUACOES.includes(campos.situacao)) SITUACOES.push(campos.situacao);
  return campos;
}

function criar(dados, usuario, origem = 'Manual') {
  const campos = validar(dados);
  const colunas = [...CAMPOS, 'capital_social_valor'];
  const info = db
    .get()
    .prepare(
      `INSERT INTO clientes (${colunas.join(', ')}, origem, criado_por_id, criado_em, atualizado_em)
       VALUES (${colunas.map((c) => `@${c}`).join(', ')}, @origem, @criado_por_id, @agora, @agora)`
    )
    .run({
      ...campos,
      origem,
      criado_por_id: usuario ? usuario.id : null,
      agora: agoraISO(),
    });
  return obter(Number(info.lastInsertRowid));
}

function atualizar(id, dados) {
  const atual = obter(id);
  if (!atual) throw new ErroValidacao('Cliente não encontrado.');
  const campos = validar(dados, id);
  const colunas = [...CAMPOS, 'capital_social_valor'];
  db.get()
    .prepare(
      `UPDATE clientes SET ${colunas.map((c) => `${c} = @${c}`).join(', ')}, atualizado_em = @agora
        WHERE id = @id`
    )
    .run({ ...campos, id, agora: agoraISO() });
  return obter(id);
}

function remover(id) {
  const cliente = obter(id);
  if (!cliente) throw new ErroValidacao('Cliente não encontrado.');
  const vinculados = db
    .get()
    .prepare('SELECT COUNT(*) AS total FROM processos WHERE cliente_id = ?')
    .get(id);
  if (vinculados.total) {
    throw new ErroValidacao(
      `Não é possível excluir: existem ${vinculados.total} processo(s) abertos para este cliente. ` +
        'Marque a empresa como Inativa se ela não deve mais receber processos.'
    );
  }
  db.get().prepare('DELETE FROM clientes WHERE id = ?').run(id);
  return cliente;
}

module.exports = {
  CAMPOS,
  SITUACOES,
  soDigitos,
  valorNumerico,
  dataISO,
  obter,
  porCodigo,
  listar,
  resumo,
  situacoesCadastradas,
  ufsCadastradas,
  processosDoCliente,
  criar,
  atualizar,
  remover,
};
