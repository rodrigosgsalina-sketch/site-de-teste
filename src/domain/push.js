'use strict';

/**
 * Inscrições de push do navegador.
 *
 * Cada navegador/aparelho em que o usuário autorizar as notificações gera uma
 * inscrição própria (endpoint + chaves). É por ela que o aviso chega mesmo com
 * a plataforma fechada — a entrega em tempo real com a aba aberta continua
 * sendo feita pelo canal SSE (src/lib/eventos.js).
 */

const config = require('../config');
const db = require('../db');
const webpush = require('../lib/webpush');
const registro = require('../lib/registro');

/** Web Push só funciona com o par de chaves VAPID configurado. */
function habilitado() {
  return Boolean(config.vapid.publica && config.vapid.privada);
}

function chavePublica() {
  return habilitado() ? config.vapid.publica : null;
}

/** Guarda (ou atualiza) a inscrição do navegador do usuário. */
function registrarInscricao(usuarioId, inscricao, navegador) {
  const endpoint = String((inscricao && inscricao.endpoint) || '').trim();
  const chaves = (inscricao && inscricao.keys) || {};
  if (!endpoint.startsWith('https://')) throw new Error('Inscrição de push inválida.');
  if (!chaves.p256dh || !chaves.auth) throw new Error('Inscrição de push sem as chaves do navegador.');

  db.get()
    .prepare(
      `INSERT INTO push_inscricoes (usuario_id, endpoint, p256dh, auth, navegador)
       VALUES (@usuario, @endpoint, @p256dh, @auth, @navegador)
       ON CONFLICT (endpoint) DO UPDATE SET
         usuario_id = excluded.usuario_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         navegador = excluded.navegador,
         falhas = 0`
    )
    .run({
      usuario: usuarioId,
      endpoint,
      p256dh: String(chaves.p256dh),
      auth: String(chaves.auth),
      navegador: String(navegador || '').slice(0, 200) || null,
    });

  return db.get().prepare('SELECT * FROM push_inscricoes WHERE endpoint = ?').get(endpoint);
}

function remover(endpoint) {
  return db.get().prepare('DELETE FROM push_inscricoes WHERE endpoint = ?').run(endpoint).changes;
}

function doUsuario(usuarioId) {
  return db.get().prepare('SELECT * FROM push_inscricoes WHERE usuario_id = ?').all(usuarioId);
}

function deUsuarios(usuarioIds) {
  const ids = [...new Set(usuarioIds || [])].filter(Boolean);
  if (!ids.length) return [];
  const marcas = ids.map(() => '?').join(',');
  return db.get().prepare(`SELECT * FROM push_inscricoes WHERE usuario_id IN (${marcas})`).all(...ids);
}

function contar() {
  return db.get().prepare('SELECT COUNT(*) AS total FROM push_inscricoes').get().total;
}

/**
 * Envia o aviso para as inscrições dos usuários indicados. Best-effort: a
 * falha de um aparelho não interrompe os outros, e inscrição morta é apagada.
 */
async function enviarPara(usuarioIds, carga) {
  if (!habilitado()) return { enviados: 0, falhas: 0, removidos: 0, desligado: true };

  const inscricoes = deUsuarios(usuarioIds);
  if (!inscricoes.length) return { enviados: 0, falhas: 0, removidos: 0 };

  const payload = JSON.stringify(carga);
  let enviados = 0;
  let falhas = 0;
  let removidos = 0;

  await Promise.all(
    inscricoes.map(async (inscricao) => {
      const resultado = await webpush.enviar(inscricao, payload, { chaves: config.vapid });
      if (resultado.ok) {
        enviados += 1;
        db.get().prepare("UPDATE push_inscricoes SET usado_em = datetime('now'), falhas = 0 WHERE id = ?").run(inscricao.id);
        return;
      }
      falhas += 1;
      if (resultado.remover) {
        remover(inscricao.endpoint);
        removidos += 1;
      } else {
        db.get().prepare('UPDATE push_inscricoes SET falhas = falhas + 1 WHERE id = ?').run(inscricao.id);
      }
      registro.notificacao('push falhou', {
        inscricao: inscricao.id,
        usuario: inscricao.usuario_id,
        motivo: resultado.motivo,
        removida: resultado.remover,
      });
    })
  );

  registro.notificacao('push enviado', { aviso: carga.id, enviados, falhas, removidos });
  return { enviados, falhas, removidos };
}

module.exports = {
  habilitado,
  chavePublica,
  registrarInscricao,
  remover,
  doUsuario,
  deUsuarios,
  contar,
  enviarPara,
};
