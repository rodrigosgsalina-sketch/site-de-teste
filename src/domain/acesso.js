'use strict';

/**
 * Controle de acesso por perfil e setor.
 *
 *  - Perfil "Administrador" e setor "Diretoria": visão e edição totais.
 *  - Perfil "Usuário": enxerga apenas processos em que seu setor atua e
 *    responde somente os itens do próprio setor.
 *  - Setores auxiliares (Sócios, Cliente, TI, Qualidade) não têm equipe
 *    própria: quem responde por eles é o Administrativo (além dos gestores).
 */

const db = require('../db');

const SETORES_AUXILIARES_DO_ADMINISTRATIVO = ['Sócios', 'Cliente', 'TI', 'Qualidade'];

function ehGestor(usuario) {
  if (!usuario) return false;
  return usuario.perfil === 'Administrador' || usuario.setor === 'Diretoria';
}

/** Nomes de setores que o usuário pode responder. */
function setoresDoUsuario(usuario) {
  if (!usuario) return [];
  if (ehGestor(usuario)) {
    return db.get().prepare('SELECT nome FROM setores ORDER BY ordem').all().map((s) => s.nome);
  }
  const nomes = [usuario.setor];
  if (usuario.setor === 'Administrativo') nomes.push(...SETORES_AUXILIARES_DO_ADMINISTRATIVO);
  return nomes;
}

/** IDs dos setores que o usuário pode responder (null = todos). */
function setorIdsDoUsuario(usuario) {
  if (ehGestor(usuario)) return null;
  const nomes = setoresDoUsuario(usuario);
  if (!nomes.length) return [];
  const marcas = nomes.map(() => '?').join(',');
  return db
    .get()
    .prepare(`SELECT id FROM setores WHERE nome IN (${marcas})`)
    .all(...nomes)
    .map((s) => s.id);
}

function podeEditarItem(usuario, item) {
  if (!usuario) return false;
  if (ehGestor(usuario)) return true;
  return setoresDoUsuario(usuario).includes(item.setor);
}

/** O usuário pode abrir a tela do processo? */
function podeVerProcesso(usuario, processoId) {
  if (ehGestor(usuario)) return true;
  const ids = setorIdsDoUsuario(usuario);
  if (ids === null) return true;
  if (!ids.length) return false;
  const marcas = ids.map(() => '?').join(',');
  const row = db
    .get()
    .prepare(
      `SELECT 1 FROM processos p
        WHERE p.id = ?
          AND (p.criado_por_id = ? OR p.responsavel_interno_id = ?
               OR EXISTS (SELECT 1 FROM checklist c WHERE c.processo_id = p.id AND c.setor_id IN (${marcas})))`
    )
    .get(processoId, usuario.id, usuario.id, ...ids);
  return Boolean(row);
}

/** Somente gestores alteram cadastro/status/conclusão de qualquer processo. */
function podeGerenciarProcesso(usuario, processo) {
  if (ehGestor(usuario)) return true;
  if (!processo) return false;
  return processo.criado_por_id === usuario.id || processo.responsavel_interno_id === usuario.id;
}

function exigirAdministrador(req, res, next) {
  if (req.session && req.session.usuario && req.session.usuario.perfil === 'Administrador') return next();
  return res.status(403).render('erro', {
    titulo: 'Acesso restrito',
    mensagem: 'Esta área é exclusiva de administradores.',
  });
}

module.exports = {
  ehGestor,
  setoresDoUsuario,
  setorIdsDoUsuario,
  podeEditarItem,
  podeVerProcesso,
  podeGerenciarProcesso,
  exigirAdministrador,
  SETORES_AUXILIARES_DO_ADMINISTRATIVO,
};
