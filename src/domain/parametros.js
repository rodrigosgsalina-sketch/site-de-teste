'use strict';

const db = require('../db');

/** Leitura crua de um parâmetro (string) com valor padrão. */
function raw(chave, padrao = null) {
  const row = db.get().prepare('SELECT valor FROM parametros WHERE chave = ?').get(chave);
  return row && row.valor !== null && row.valor !== '' ? row.valor : padrao;
}

/** Parâmetro booleano. Na planilha os booleanos são "Sim"/"Não". */
function bool(chave, padrao = false) {
  const v = raw(chave, null);
  if (v === null) return padrao;
  return ['sim', 's', 'true', '1', 'yes'].includes(String(v).trim().toLowerCase());
}

function num(chave, padrao = 0) {
  const v = Number(raw(chave, null));
  return Number.isFinite(v) ? v : padrao;
}

function texto(chave, padrao = '') {
  return raw(chave, padrao);
}

function todos() {
  return db
    .get()
    .prepare('SELECT chave, valor, tipo, categoria, descricao, editavel FROM parametros ORDER BY categoria, chave')
    .all();
}

function porCategoria() {
  const grupos = new Map();
  for (const p of todos()) {
    if (!grupos.has(p.categoria)) grupos.set(p.categoria, []);
    grupos.get(p.categoria).push(p);
  }
  return grupos;
}

/**
 * Endereços gravados em parâmetro saem da plataforma para a internet: só
 * aceitamos https, para o conteúdo do processo nunca trafegar em claro.
 */
function validarEndereco(chave, valor) {
  const texto = String(valor || '').trim();
  if (!texto) return texto;
  if (!/^(WEBHOOK_|URL_)/.test(chave) && !/_URL$/.test(chave)) return texto;
  if (!/^https:\/\//i.test(texto)) {
    const erro = new Error(`${chave} precisa começar com https:// (endereço em http:// trafega sem criptografia).`);
    erro.validacao = true;
    throw erro;
  }
  return texto;
}

function definir(chave, valor) {
  validarEndereco(chave, valor);
  const info = db.get().prepare('SELECT chave FROM parametros WHERE chave = ?').get(chave);
  if (!info) {
    db.get()
      .prepare('INSERT INTO parametros (chave, valor, tipo, categoria) VALUES (?, ?, ?, ?)')
      .run(chave, String(valor), 'texto', 'Geral');
    return;
  }
  db.get().prepare('UPDATE parametros SET valor = ? WHERE chave = ?').run(String(valor), chave);
}

/**
 * Gera o próximo número de processo conforme PREFIXO/ANO/DIGITOS/PROXIMO_PROCESSO.
 * A sequência reinicia automaticamente quando o ano corrente muda.
 * Deve ser chamado dentro de uma transação.
 */
function proximoCodigoProcesso(hoje = new Date()) {
  const conn = db.get();
  const prefixo = texto('PREFIXO_PROCESSO', 'PR');
  const digitos = num('DIGITOS_PROCESSO', 4);
  const anoAtual = hoje.getFullYear();
  const anoParam = num('ANO_PROCESSO', anoAtual);

  let seq = num('PROXIMO_PROCESSO', 1);
  if (anoParam !== anoAtual) {
    seq = 1;
    definir('ANO_PROCESSO', anoAtual);
  }

  // Blindagem contra colisão caso o parâmetro tenha sido editado à mão.
  let codigo;
  for (;;) {
    codigo = `${prefixo}-${anoAtual}-${String(seq).padStart(digitos, '0')}`;
    const existe = conn.prepare('SELECT 1 FROM processos WHERE codigo = ?').get(codigo);
    if (!existe) break;
    seq += 1;
  }

  definir('PROXIMO_PROCESSO', seq + 1);
  return codigo;
}

/** Mapa setor -> e-mail configurado em PARAMETROS. */
const EMAIL_POR_SETOR = {
  Fiscal: 'EMAIL_FISCAL',
  Contábil: 'EMAIL_CONTABIL',
  'Departamento Pessoal': 'EMAIL_PESSOAL',
  Financeiro: 'EMAIL_FINANCEIRO',
  Diretoria: 'EMAIL_DIRETORIA',
  Administrativo: 'EMAIL_ADMIN',
  Paralegal: 'EMAIL_PARALEGAL',
  Jurídico: 'EMAIL_JURIDICO',
};

/** Mapa setor -> parâmetro liga/desliga de notificação. */
const NOTIFICAR_POR_SETOR = {
  Paralegal: 'NOTIFICAR_PARLEGAL', // grafia da planilha preservada
  Fiscal: 'NOTIFICAR_FISCAL',
  'Departamento Pessoal': 'NOTIFICAR_DP',
  Contábil: 'NOTIFICAR_CONTABIL',
  Jurídico: 'NOTIFICAR_JURIDICO',
};

/** Mapa setor -> parâmetro de prazo em horas. */
const PRAZO_POR_SETOR = {
  Fiscal: 'PRAZO_FISCAL_HORAS',
  'Departamento Pessoal': 'PRAZO_DP_HORAS',
  Contábil: 'PRAZO_CONTABIL_HORAS',
  Jurídico: 'PRAZO_JURIDICO_HORAS',
};

/** Mapa setor -> parâmetro de aprovação obrigatória. */
const APROVACAO_POR_SETOR = {
  Fiscal: 'EXIGIR_APROVACAO_FISCAL',
  'Departamento Pessoal': 'EXIGIR_APROVACAO_DP',
  Contábil: 'EXIGIR_APROVACAO_CONTABIL',
  Jurídico: 'EXIGIR_APROVACAO_JURIDICA',
};

function emailDoSetor(setor) {
  const chave = EMAIL_POR_SETOR[setor];
  return chave ? texto(chave, '') : '';
}

function notificaSetor(setor) {
  const chave = NOTIFICAR_POR_SETOR[setor];
  // Setores sem chave própria seguem a chave geral EMAIL_NOTIFICACAO.
  return chave ? bool(chave, true) : true;
}

/** Prazo em horas para o setor responder; cai no prazo padrão do processo. */
function prazoHorasDoSetor(setor) {
  const chave = PRAZO_POR_SETOR[setor];
  if (chave) return num(chave, 24);
  return num('PRAZO_PADRAO_PROCESSO_DIAS', 15) * 24;
}

/**
 * Setor cuja aprovação é obrigatória para concluir o processo.
 * Setores sem parâmetro específico são sempre considerados obrigatórios
 * (a obrigatoriedade real do item vem do CHECKLIST_MODELO).
 */
function aprovacaoObrigatoria(setor) {
  const chave = APROVACAO_POR_SETOR[setor];
  return chave ? bool(chave, true) : true;
}

module.exports = {
  raw,
  bool,
  num,
  texto,
  todos,
  porCategoria,
  definir,
  validarEndereco,
  proximoCodigoProcesso,
  emailDoSetor,
  notificaSetor,
  prazoHorasDoSetor,
  aprovacaoObrigatoria,
  EMAIL_POR_SETOR,
  NOTIFICAR_POR_SETOR,
  PRAZO_POR_SETOR,
  APROVACAO_POR_SETOR,
};
