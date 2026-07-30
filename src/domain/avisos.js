'use strict';

/**
 * Avisos internos da plataforma.
 *
 * Diferente das notificações por e-mail (dirigidas ao setor responsável),
 * o aviso aparece dentro do sistema para TODOS os usuários — hoje quando um
 * processo é concluído com sucesso ou quando é impedido. Cada usuário dispensa
 * o seu, sem afetar os demais.
 */

const db = require('../db');

const TIPOS = { CONCLUIDO: 'concluido', IMPEDIDO: 'impedido' };

function publicar({ tipo, titulo, mensagem, processoId, usuario }) {
  const info = db
    .get()
    .prepare(
      `INSERT INTO avisos (tipo, titulo, mensagem, processo_id, usuario_id, usuario_nome)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      tipo,
      titulo,
      mensagem,
      processoId || null,
      usuario ? usuario.id : null,
      usuario ? usuario.nome : 'Sistema'
    );
  return Number(info.lastInsertRowid);
}

/** Processo concluído com sucesso. */
function processoConcluido(processo, usuario) {
  return publicar({
    tipo: TIPOS.CONCLUIDO,
    titulo: `Processo ${processo.codigo} concluído`,
    mensagem: `${processo.tipo_processo} de ${processo.razao_social} foi concluído com sucesso` +
      `${usuario ? ` por ${usuario.nome}` : ''}.`,
    processoId: processo.id,
    usuario,
  });
}

/** Processo impedido — o motivo entra na mensagem. */
function processoImpedido(processo, item, usuario) {
  const motivo = (item && item.descricao_impedimento) || 'motivo não informado';
  return publicar({
    tipo: TIPOS.IMPEDIDO,
    titulo: `Processo ${processo.codigo} impedido`,
    mensagem: `${processo.tipo_processo} de ${processo.razao_social} está impedido` +
      `${item ? ` no setor ${item.setor}` : ''}: ${motivo}`,
    processoId: processo.id,
    usuario,
  });
}

const SELECT = `
  SELECT a.*, p.codigo AS processo_codigo
    FROM avisos a
    LEFT JOIN processos p ON p.id = a.processo_id`;

/** Avisos que o usuário ainda não dispensou. */
function naoLidos(usuarioId, limite = 5) {
  return db
    .get()
    .prepare(
      `${SELECT}
        WHERE NOT EXISTS (SELECT 1 FROM avisos_lidos l WHERE l.aviso_id = a.id AND l.usuario_id = ?)
        ORDER BY a.id DESC
        LIMIT ?`
    )
    .all(usuarioId, limite);
}

function contarNaoLidos(usuarioId) {
  return db
    .get()
    .prepare(
      `SELECT COUNT(*) AS total FROM avisos a
        WHERE NOT EXISTS (SELECT 1 FROM avisos_lidos l WHERE l.aviso_id = a.id AND l.usuario_id = ?)`
    )
    .get(usuarioId).total;
}

/** Histórico completo, marcando o que o usuário já leu. */
function listar(usuarioId, limite = 100) {
  return db
    .get()
    .prepare(
      `SELECT a.*, p.codigo AS processo_codigo,
              (SELECT l.lido_em FROM avisos_lidos l WHERE l.aviso_id = a.id AND l.usuario_id = ?) AS lido_em
         FROM avisos a
         LEFT JOIN processos p ON p.id = a.processo_id
        ORDER BY a.id DESC
        LIMIT ?`
    )
    .all(usuarioId, limite);
}

function marcarLido(avisoId, usuarioId) {
  db.get()
    .prepare(
      `INSERT INTO avisos_lidos (aviso_id, usuario_id) VALUES (?, ?)
       ON CONFLICT (aviso_id, usuario_id) DO NOTHING`
    )
    .run(avisoId, usuarioId);
}

function marcarTodosLidos(usuarioId) {
  db.get()
    .prepare(
      `INSERT INTO avisos_lidos (aviso_id, usuario_id)
       SELECT a.id, ? FROM avisos a
        WHERE NOT EXISTS (SELECT 1 FROM avisos_lidos l WHERE l.aviso_id = a.id AND l.usuario_id = ?)`
    )
    .run(usuarioId, usuarioId);
}

module.exports = {
  TIPOS,
  publicar,
  processoConcluido,
  processoImpedido,
  naoLidos,
  contarNaoLidos,
  listar,
  marcarLido,
  marcarTodosLidos,
};
