'use strict';

/**
 * Controle de acesso por perfil e setor.
 *
 *  - **Ver, todo mundo vê.** Qualquer usuário abre qualquer processo que exista
 *    (o excluído não existe mais). O escritório trabalha o mesmo processo em
 *    várias mãos, e esconder o andamento de quem não responde o checklist só
 *    fazia a informação circular por fora da plataforma.
 *  - **Agir, só quem participa.** Quem não tem setor no checklist — nem abriu,
 *    nem conduz o processo — está ali de leitura: não responde item, não anexa
 *    documento, não mexe no status.
 *  - **Uma pessoa pode atuar em vários setores.** No escritório é comum
 *    acumular, e quem acumula responde os itens de todos os seus setores.
 *  - Perfil "Administrador" e setor "Diretoria": visão e edição totais.
 *  - Setores **auxiliares sem equipe própria** (nenhum usuário ativo lotado
 *    neles) são respondidos pelo Administrativo, além dos gestores.
 */

const db = require('../db');

/**
 * Setores auxiliares que não têm equipe própria — quem responde por eles é o
 * Administrativo.
 *
 * A lista sai do banco, e não de nomes escritos aqui dentro: um setor marcado
 * como auxiliar e sem nenhum usuário ativo é, por definição, um setor sem
 * equipe. Antes eram quatro nomes fixos ("Sócios", "Cliente", "TI",
 * "Qualidade") e bastava o escritório renomear um deles — "TI" virou
 * "TI/Administrativo" numa instalação real — para o Administrativo perder
 * calado o direito de responder por ele. Auxiliar COM equipe (o Financeiro,
 * que tem gente lotada) continua de fora, como sempre esteve.
 */
function setoresSemEquipe() {
  return db
    .get()
    .prepare(
      `SELECT s.nome FROM setores s
        WHERE s.auxiliar = 1
          AND NOT EXISTS (
            SELECT 1 FROM usuarios u
             WHERE u.status = 'Ativo'
               AND (u.setor_id = s.id
                    OR s.id IN (SELECT setor_id FROM usuarios_setores WHERE usuario_id = u.id)))
        ORDER BY s.ordem, s.nome`
    )
    .all()
    .map((s) => s.nome);
}

/**
 * Setores em que a pessoa atua — ela pode acumular mais de um.
 *
 * A fonte é o banco, não a sessão: mudar os setores de alguém na tela de
 * Usuários passa a valer na hora, sem esperar o próximo login. Quando não há
 * id (objeto montado à mão, teste), cai no setor que vier no próprio objeto.
 */
function setoresProprios(usuario) {
  if (!usuario) return [];
  if (usuario.id) {
    const nomes = db
      .get()
      .prepare(
        `SELECT s.nome FROM setores s
          WHERE s.id = (SELECT setor_id FROM usuarios WHERE id = @usuario)
             OR s.id IN (SELECT setor_id FROM usuarios_setores WHERE usuario_id = @usuario)
          ORDER BY s.ordem, s.nome`
      )
      .all({ usuario: usuario.id })
      .map((s) => s.nome);
    if (nomes.length) return nomes;
  }
  return usuario.setor ? [usuario.setor] : [];
}

function ehGestor(usuario) {
  if (!usuario) return false;
  if (usuario.perfil === 'Administrador') return true;
  return setoresProprios(usuario).includes('Diretoria');
}

/** Nomes de setores que o usuário pode responder. */
function setoresDoUsuario(usuario) {
  if (!usuario) return [];
  if (ehGestor(usuario)) {
    return db.get().prepare('SELECT nome FROM setores ORDER BY ordem').all().map((s) => s.nome);
  }
  const nomes = setoresProprios(usuario);
  // O Administrativo responde pelos setores sem equipe própria — e continua
  // respondendo mesmo quando o Administrativo é o segundo setor da pessoa.
  if (nomes.includes('Administrativo')) {
    for (const auxiliar of setoresSemEquipe()) {
      if (!nomes.includes(auxiliar)) nomes.push(auxiliar);
    }
  }
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

/**
 * O usuário participa do processo — isto é, pode **agir** nele?
 *
 * Participa quem tem setor no checklist, quem abriu e quem conduz. Os demais
 * continuam vendo o processo inteiro; só não escrevem nada nele.
 */
function participaDoProcesso(usuario, processoId) {
  if (!usuario) return false;
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

/**
 * Quem altera a tabela de preço: o administrador e o setor responsável por
 * ela (Financeiro, de fábrica — `SETOR_TABELA_PRECO` muda isso sem mexer no
 * código, para o dia em que o setor for renomeado ou passar a ser outro).
 *
 * Ver, todo mundo vê. Aqui a conta é sobre os setores **próprios** da pessoa:
 * `setoresDoUsuario` devolveria a lista inteira para um gestor, e preço é
 * assunto de quem responde por preço.
 */
function podeEditarTabelaPreco(usuario) {
  if (!usuario) return false;
  if (usuario.perfil === 'Administrador') return true;
  // require aqui dentro: tabela-preco depende de parametros, que depende do
  // banco, e o topo deste arquivo é carregado antes de tudo isso existir.
  // eslint-disable-next-line global-require
  const setor = require('./tabela-preco').setorResponsavel();
  return setoresProprios(usuario).includes(setor);
}

function exigirTabelaPreco(req, res, next) {
  if (req.session && podeEditarTabelaPreco(req.session.usuario)) return next();
  // eslint-disable-next-line global-require
  const setor = require('./tabela-preco').setorResponsavel();
  return res.status(403).render('erro', {
    titulo: 'Somente leitura',
    mensagem: `A tabela de preço é alterada pelo setor ${setor} e pelos administradores. ` +
      'Para todos os demais ela fica disponível para consulta.',
  });
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
  setoresProprios,
  setoresDoUsuario,
  setorIdsDoUsuario,
  podeEditarItem,
  participaDoProcesso,
  podeGerenciarProcesso,
  podeEditarTabelaPreco,
  exigirTabelaPreco,
  exigirAdministrador,
  setoresSemEquipe,
};
