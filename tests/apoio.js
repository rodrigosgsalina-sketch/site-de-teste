'use strict';

/** Carga de dados compartilhada pelos testes (mesma origem do `npm run seed`). */

const bcrypt = require('bcryptjs');
const seed = require('../src/db/seed-data');

/** Popula um banco recém-criado com setores, tipos, status, parâmetros e usuários. */
function carregarSeed(db, { senha = 'teste123' } = {}) {
  const conn = db.open();
  db.tx(() => {
    const setor = conn.prepare('INSERT INTO setores (nome, auxiliar, ordem) VALUES (?, ?, ?)');
    seed.SETORES.forEach((s) => setor.run(s.nome, s.auxiliar, s.ordem));

    const tipo = conn.prepare('INSERT INTO tipos_processo (nome, ativo, ordem) VALUES (?, ?, ?)');
    seed.TIPOS_PROCESSO.forEach((t) => tipo.run(t.nome, t.ativo, t.ordem));

    const status = conn.prepare('INSERT INTO status_processo (nome, ordem, final, espera) VALUES (?, ?, ?, ?)');
    seed.STATUS_PROCESSO.forEach((s) => status.run(s.nome, s.ordem, s.final, s.espera));

    // A migração já semeia os parâmetros novos ao abrir o banco, então aqui a
    // carga sobrescreve em vez de inserir cegamente.
    const param = conn.prepare(
      `INSERT INTO parametros (chave, valor, tipo, categoria, descricao) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor, tipo = excluded.tipo,
                                         categoria = excluded.categoria, descricao = excluded.descricao`
    );
    seed.PARAMETROS.forEach((p) => param.run(p.chave, p.valor, p.tipo, p.categoria, p.descricao));

    const idSetor = conn.prepare('SELECT id FROM setores WHERE nome = ?');
    const modelo = conn.prepare(
      'INSERT INTO checklist_modelo (tipo_processo_id, setor_id, item, obrigatorio, ordem) VALUES (?, ?, ?, ?, ?)'
    );
    const idTipo = conn.prepare('SELECT id FROM tipos_processo WHERE nome = ?');
    seed.CHECKLIST_MODELO.forEach((m, i) => {
      modelo.run(m.tipo ? idTipo.get(m.tipo).id : null, idSetor.get(m.setor).id, m.item, m.obrigatorio, i);
    });

    const usuario = conn.prepare(
      'INSERT INTO usuarios (nome, login, email, senha_hash, setor_id, perfil, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const hash = bcrypt.hashSync(senha, 4);
    const ligarSetor = conn.prepare(
      'INSERT INTO usuarios_setores (usuario_id, setor_id) VALUES (?, ?) ON CONFLICT DO NOTHING'
    );
    seed.USUARIOS.forEach((u) => {
      const setorId = idSetor.get(u.setor).id;
      const info = usuario.run(u.nome, u.login, u.email, hash, setorId, u.perfil, u.status);
      ligarSetor.run(Number(info.lastInsertRowid), setorId);
    });
  });
  return conn;
}

/* ------------------------------------------------------------- cliente HTTP */

/**
 * Cliente HTTP mínimo com cookies, suficiente para exercitar as telas nos
 * testes sem trazer uma dependência só para isso.
 */
function criarCliente(base) {
  const cookies = new Map();

  function cabecalhoCookie() {
    return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  function guardarCookies(resposta) {
    const enviados = resposta.headers.getSetCookie ? resposta.headers.getSetCookie() : [];
    for (const bruto of enviados) {
      const [par] = bruto.split(';');
      const igual = par.indexOf('=');
      const nome = par.slice(0, igual).trim();
      const valor = par.slice(igual + 1).trim();
      if (valor === '' || /Expires=Thu, 01 Jan 1970/i.test(bruto)) cookies.delete(nome);
      else cookies.set(nome, valor);
    }
  }

  async function pedir(caminho, opcoes = {}) {
    const cabecalhos = { ...(opcoes.headers || {}) };
    const cookie = cabecalhoCookie();
    if (cookie) cabecalhos.cookie = cookie;
    const resposta = await fetch(`${base}${caminho}`, { redirect: 'manual', ...opcoes, headers: cabecalhos });
    guardarCookies(resposta);
    return resposta;
  }

  return {
    cookies,
    pedir,
    get: (caminho, opcoes) => pedir(caminho, { method: 'GET', ...opcoes }),
    post: (caminho, corpo, opcoes = {}) =>
      pedir(caminho, {
        ...opcoes,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(opcoes.headers || {}) },
        body: new URLSearchParams(corpo).toString(),
      }),
    /** Lê o token CSRF publicado em uma tela. */
    async token(caminho = '/login') {
      const html = await (await pedir(caminho)).text();
      const achado = html.match(/name="_csrf" value="([^"]+)"/);
      return achado ? achado[1] : '';
    },
    async entrar(login, senha) {
      const token = await this.token('/login');
      return this.post('/login', { _csrf: token, login, senha });
    },
  };
}

/**
 * Responde os setores que vêm ANTES de `setor` no checklist do processo.
 *
 * O checklist é atendido em ordem (EXIGIR_ORDEM_SETORES), então um teste que
 * quer exercitar o Fiscal precisa antes destravar quem vem na frente dele.
 * Usa a mesma ordem que a tela: `doProcesso` já devolve na ordem de
 * atendimento do tipo.
 */
function liberarAteOSetor(processoId, setor, usuario) {
  const checklist = require('../src/domain/checklist');
  for (const item of checklist.doProcesso(processoId)) {
    if (item.setor === setor) return;
    if (!item.resposta) checklist.responder(item.id, { resposta: 'Sim' }, usuario);
  }
}

module.exports = { carregarSeed, criarCliente, liberarAteOSetor };
