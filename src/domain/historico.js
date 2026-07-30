'use strict';

const db = require('../db');
const parametros = require('./parametros');
const { agoraISO } = require('../lib/datas');

/**
 * Registra uma linha de auditoria. Chamado pelas próprias operações de
 * domínio — nunca depende do usuário registrar manualmente.
 *
 * @param {object} opts
 * @param {number} opts.processoId
 * @param {string} opts.acao         ex.: 'Processo Criado', 'Aprovação Fiscal'
 * @param {object} [opts.usuario]    { id, nome }
 * @param {string} [opts.observacao]
 */
function registrar({ processoId, acao, usuario, observacao }) {
  if (!parametros.bool('REGISTRAR_HISTORICO', true)) return null;
  const info = db
    .get()
    .prepare(
      `INSERT INTO historico (processo_id, acao, usuario_id, usuario_nome, data_hora, observacao)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      processoId || null,
      acao,
      usuario ? usuario.id : null,
      usuario ? usuario.nome : 'Sistema',
      agoraISO(),
      observacao || null
    );
  return info.lastInsertRowid;
}

function doProcesso(processoId) {
  return db
    .get()
    .prepare(
      `SELECT h.*, u.nome AS usuario_atual
         FROM historico h
         LEFT JOIN usuarios u ON u.id = h.usuario_id
        WHERE h.processo_id = ?
        ORDER BY h.id DESC`
    )
    .all(processoId);
}

function recentes(limite = 50) {
  return db
    .get()
    .prepare(
      `SELECT h.*, p.codigo AS processo_codigo
         FROM historico h
         LEFT JOIN processos p ON p.id = h.processo_id
        ORDER BY h.id DESC
        LIMIT ?`
    )
    .all(limite);
}

module.exports = { registrar, doProcesso, recentes };
