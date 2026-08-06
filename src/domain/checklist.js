'use strict';

const db = require('../db');
const avisos = require('./avisos');
const ordemSetores = require('./ordem-setores');
const parametros = require('./parametros');
const { agoraISO, somarHoras } = require('../lib/datas');

const STATUS_ITEM = { PENDENTE: 'Pendente', CONCLUIDO: 'Concluído', IMPEDIDO: 'Impedido' };

/**
 * Próximo número da sequência CHK-0001.
 *
 * Sai do MAIOR número já usado, não da contagem de linhas: contar volta atrás
 * quando um processo é excluído, e os itens seguintes tentariam nascer com um
 * código que ainda existe — o banco recusa, e a abertura do próximo processo
 * falharia. O maior número só cresce, então o código nunca se repete.
 */
function proximoCodigoItem(conn) {
  const row = conn
    .prepare("SELECT MAX(CAST(substr(codigo, 5) AS INTEGER)) AS maior FROM checklist WHERE codigo LIKE 'CHK-%'")
    .get();
  return (row && row.maior ? row.maior : 0) + 1;
}

/**
 * Clona o CHECKLIST_MODELO para um processo recém-criado:
 * itens do tipo escolhido + itens da linha "Todos" (tipo_processo_id IS NULL).
 * Deve rodar dentro da transação de criação do processo.
 */
function gerarParaProcesso(processoId, tipoProcessoId, aberturaISO = agoraISO()) {
  const conn = db.get();
  const modelos = conn
    .prepare(
      `SELECT m.id, m.setor_id, m.item, m.obrigatorio, m.ordem, s.nome AS setor,
              ${ordemSetores.posicaoSQL()} AS setor_ordem
         FROM checklist_modelo m
         JOIN setores s ON s.id = m.setor_id
         ${ordemSetores.joinSQL('?', 's.id')}
        WHERE m.ativo = 1
          AND (m.tipo_processo_id = ? OR m.tipo_processo_id IS NULL)
        ORDER BY setor_ordem, m.ordem, m.id`
    )
    .all(tipoProcessoId, tipoProcessoId);

  const inserir = conn.prepare(
    `INSERT INTO checklist
       (codigo, processo_id, setor_id, item, obrigatorio, status_item, prazo, data_criacao, ordem)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let seq = proximoCodigoItem(conn);
  const criados = [];
  modelos.forEach((m, indice) => {
    const horas = parametros.prazoHorasDoSetor(m.setor);
    const prazo = somarHoras(aberturaISO, horas).toISOString();
    const codigo = `CHK-${String(seq++).padStart(4, '0')}`;
    const info = inserir.run(
      codigo,
      processoId,
      m.setor_id,
      m.item,
      m.obrigatorio,
      STATUS_ITEM.PENDENTE,
      prazo,
      agoraISO(),
      indice + 1
    );
    criados.push({ id: info.lastInsertRowid, codigo, setor: m.setor });
  });
  return criados;
}

const SELECT_ITEM = `
  SELECT c.*, s.nome AS setor, s.auxiliar AS setor_auxiliar,
         ${ordemSetores.posicaoSQL()} AS setor_ordem,
         u.nome AS responsavel_nome, uc.nome AS conferente_nome,
         p.codigo AS processo_codigo, p.razao_social, p.data_previsao,
         t.nome AS tipo_processo
    FROM checklist c
    JOIN setores s ON s.id = c.setor_id
    JOIN processos p ON p.id = c.processo_id
    JOIN tipos_processo t ON t.id = p.tipo_processo_id
    ${ordemSetores.joinSQL('p.tipo_processo_id', 'c.setor_id')}
    LEFT JOIN usuarios u ON u.id = c.responsavel_id
    LEFT JOIN usuarios uc ON uc.id = c.conferido_por_id`;

function obterItem(id) {
  return db.get().prepare(`${SELECT_ITEM} WHERE c.id = ?`).get(id);
}

function doProcesso(processoId) {
  return db
    .get()
    .prepare(`${SELECT_ITEM} WHERE c.processo_id = ? ORDER BY setor_ordem, c.ordem, c.id`)
    .all(processoId);
}

/** Agrupa os itens por setor, com o progresso de cada grupo. */
function agrupadoPorSetor(processoId) {
  const itens = doProcesso(processoId);
  const grupos = new Map();
  for (const item of itens) {
    if (!grupos.has(item.setor)) {
      grupos.set(item.setor, {
        setor: item.setor,
        setor_id: item.setor_id,
        auxiliar: item.setor_auxiliar,
        itens: [],
        total: 0,
        concluidos: 0,
        impedidos: 0,
        pendentes: 0,
        obrigatorios_pendentes: 0,
      });
    }
    const g = grupos.get(item.setor);
    g.itens.push(item);
    g.total += 1;
    if (item.status_item === STATUS_ITEM.CONCLUIDO) g.concluidos += 1;
    if (item.status_item === STATUS_ITEM.IMPEDIDO) g.impedidos += 1;
    if (item.status_item === STATUS_ITEM.PENDENTE) g.pendentes += 1;
    if (item.obrigatorio && item.status_item !== STATUS_ITEM.CONCLUIDO) g.obrigatorios_pendentes += 1;
  }
  return [...grupos.values()].map((g) => ({
    ...g,
    percentual: g.total ? Math.round((g.concluidos / g.total) * 100) : 0,
  }));
}

function progresso(processoId) {
  const row = db
    .get()
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status_item = 'Concluído' THEN 1 ELSE 0 END) AS concluidos,
              SUM(CASE WHEN status_item = 'Impedido'  THEN 1 ELSE 0 END) AS impedidos,
              SUM(CASE WHEN status_item = 'Pendente'  THEN 1 ELSE 0 END) AS pendentes,
              SUM(CASE WHEN obrigatorio = 1 AND status_item <> 'Concluído' THEN 1 ELSE 0 END) AS obrigatorios_pendentes
         FROM checklist WHERE processo_id = ?`
    )
    .get(processoId);
  const total = row.total || 0;
  return {
    total,
    concluidos: row.concluidos || 0,
    impedidos: row.impedidos || 0,
    pendentes: row.pendentes || 0,
    obrigatorios_pendentes: row.obrigatorios_pendentes || 0,
    percentual: total ? Math.round(((row.concluidos || 0) / total) * 100) : 0,
  };
}

class ErroValidacao extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroValidacao';
    this.validacao = true;
  }
}

/**
 * Grava a resposta de um item de checklist.
 * Regras:
 *  - impedimento exige descrição (EXIGIR_OBSERVACAO_IMPEDIMENTO);
 *  - com EXIGIR_DUPLA_CONFERENCIA ligado o item fica pendente de conferência
 *    por um segundo colaborador antes de contar como concluído.
 */
function responder(itemId, dados, usuario) {
  const conn = db.get();
  const item = obterItem(itemId);
  if (!item) throw new ErroValidacao('Item de checklist não encontrado.');

  const resposta = dados.resposta || null;
  const impedimento = dados.possui_impedimento === true || dados.possui_impedimento === 'Sim' || dados.possui_impedimento === '1';
  const descricao = (dados.descricao_impedimento || '').trim();
  const observacao = (dados.observacao || '').trim();

  if (!resposta) throw new ErroValidacao('Informe a resposta (Sim, Não ou N/A).');
  if (!['Sim', 'Não', 'N/A'].includes(resposta)) throw new ErroValidacao('Resposta inválida.');
  if (impedimento && parametros.bool('EXIGIR_OBSERVACAO_IMPEDIMENTO', true) && !descricao) {
    throw new ErroValidacao('Descreva o impedimento — a descrição é obrigatória.');
  }

  const dupla = parametros.bool('EXIGIR_DUPLA_CONFERENCIA', false);
  let statusItem;
  if (impedimento) statusItem = STATUS_ITEM.IMPEDIDO;
  else if (dupla) statusItem = STATUS_ITEM.PENDENTE; // aguardando conferência
  else statusItem = STATUS_ITEM.CONCLUIDO;

  conn
    .prepare(
      `UPDATE checklist
          SET resposta = ?, possui_impedimento = ?, descricao_impedimento = ?,
              responsavel_id = ?, data_resposta = ?, status_item = ?,
              observacao = ?, data_atualizacao = ?,
              conferido_por_id = NULL, data_conferencia = NULL
        WHERE id = ?`
    )
    .run(
      resposta,
      impedimento ? 1 : 0,
      impedimento ? descricao : null,
      usuario ? usuario.id : null,
      agoraISO(),
      statusItem,
      observacao || null,
      agoraISO(),
      itemId
    );

  const atualizado = { ...obterItem(itemId), aguardando_conferencia: dupla && !impedimento };

  // Impedimento gera aviso interno para todos os usuários.
  if (statusItem === STATUS_ITEM.IMPEDIDO) {
    const processo = db
      .get()
      .prepare(
        `SELECT p.id, p.codigo, p.razao_social, t.nome AS tipo_processo
           FROM processos p JOIN tipos_processo t ON t.id = p.tipo_processo_id
          WHERE p.id = ?`
      )
      .get(item.processo_id);
    if (processo) avisos.processoImpedido(processo, atualizado, usuario);
  }

  return atualizado;
}

/** Segunda conferência (EXIGIR_DUPLA_CONFERENCIA). */
function conferir(itemId, usuario) {
  const item = obterItem(itemId);
  if (!item) throw new ErroValidacao('Item de checklist não encontrado.');
  if (!item.resposta) throw new ErroValidacao('O item ainda não foi respondido.');
  if (item.status_item === STATUS_ITEM.IMPEDIDO) throw new ErroValidacao('Item impedido não pode ser conferido.');
  if (item.responsavel_id && usuario && item.responsavel_id === usuario.id) {
    throw new ErroValidacao('A conferência deve ser feita por um colaborador diferente de quem respondeu.');
  }
  db.get()
    .prepare(
      `UPDATE checklist
          SET status_item = ?, conferido_por_id = ?, data_conferencia = ?, data_atualizacao = ?
        WHERE id = ?`
    )
    .run(STATUS_ITEM.CONCLUIDO, usuario ? usuario.id : null, agoraISO(), agoraISO(), itemId);
  return obterItem(itemId);
}

/** Reabre um item já respondido (volta para Pendente). */
function reabrir(itemId) {
  db.get()
    .prepare(
      `UPDATE checklist
          SET status_item = 'Pendente', resposta = NULL, possui_impedimento = 0,
              descricao_impedimento = NULL, conferido_por_id = NULL, data_conferencia = NULL,
              data_atualizacao = ?
        WHERE id = ?`
    )
    .run(agoraISO(), itemId);
  return obterItem(itemId);
}

/** Fila de trabalho: itens pendentes/impedidos, ordenados por urgência. */
function fila({ setorIds = null, apenasPendentes = true, limite = 200 } = {}) {
  const filtros = ["p.status_id NOT IN (SELECT id FROM status_processo WHERE final = 1)"];
  const args = [];
  if (apenasPendentes) filtros.push("c.status_item <> 'Concluído'");
  if (setorIds && setorIds.length) {
    filtros.push(`c.setor_id IN (${setorIds.map(() => '?').join(',')})`);
    args.push(...setorIds);
  }
  args.push(limite);
  return db
    .get()
    .prepare(
      `${SELECT_ITEM}
        WHERE ${filtros.join(' AND ')}
        ORDER BY CASE c.status_item WHEN 'Impedido' THEN 0 ELSE 1 END,
                 c.prazo IS NULL, c.prazo, c.id
        LIMIT ?`
    )
    .all(...args);
}

/** Setores com itens ainda pendentes, na ordem de atendimento. */
function setoresPendentes(processoId) {
  return db
    .get()
    .prepare(
      `SELECT s.id, s.nome, ${ordemSetores.posicaoSQL()} AS ordem, COUNT(*) AS pendentes,
              SUM(CASE WHEN c.status_item = 'Impedido' THEN 1 ELSE 0 END) AS impedidos
         FROM checklist c
         JOIN processos p ON p.id = c.processo_id
         JOIN setores s ON s.id = c.setor_id
         ${ordemSetores.joinSQL('p.tipo_processo_id', 'c.setor_id')}
        WHERE c.processo_id = ? AND c.status_item <> 'Concluído'
        GROUP BY s.id
        ORDER BY ordem`
    )
    .all(processoId);
}

function setoresDoProcesso(processoId) {
  return db
    .get()
    .prepare(
      `SELECT s.nome, MIN(${ordemSetores.posicaoSQL()}) AS ordem
         FROM checklist c
         JOIN processos p ON p.id = c.processo_id
         JOIN setores s ON s.id = c.setor_id
         ${ordemSetores.joinSQL('p.tipo_processo_id', 'c.setor_id')}
        WHERE c.processo_id = ?
        GROUP BY s.id
        ORDER BY ordem`
    )
    .all(processoId)
    .map((r) => r.nome);
}

module.exports = {
  STATUS_ITEM,
  ErroValidacao,
  gerarParaProcesso,
  obterItem,
  doProcesso,
  agrupadoPorSetor,
  progresso,
  responder,
  conferir,
  reabrir,
  fila,
  setoresPendentes,
  setoresDoProcesso,
};
