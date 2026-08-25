'use strict';

const fs = require('fs');
const path = require('path');
const Banco = require('./driver');
const config = require('../config');

let db = null;

function open(file = config.dbFile) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Banco(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function colunas(conn, tabela) {
  return conn.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name);
}

function tabelaExiste(conn, nome) {
  return Boolean(conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(nome));
}

/** Login sugerido a partir do e-mail ou do nome (usado só na migração). */
function loginSugerido(usuario) {
  const base = usuario.email ? String(usuario.email).split('@')[0] : String(usuario.nome || '');
  const limpo = base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '');
  return limpo || `usuario${usuario.id}`;
}

/**
 * Bancos criados antes da mudança de login autenticavam por e-mail e não
 * possuem a coluna `login`. Reconstrói a tabela preservando os dados.
 */
function migrarLoginDeUsuarios(conn) {
  if (!tabelaExiste(conn, 'usuarios')) return;
  if (colunas(conn, 'usuarios').includes('login')) return;

  const antigos = conn.prepare('SELECT * FROM usuarios').all();
  const usados = new Set();
  const comLogin = antigos.map((u) => {
    let login = loginSugerido(u);
    let sufixo = 2;
    while (usados.has(login)) login = `${loginSugerido(u)}${sufixo++}`;
    usados.add(login);
    return { ...u, login };
  });

  conn.pragma('foreign_keys = OFF');
  conn.transaction(() => {
    conn.exec(`
      CREATE TABLE usuarios_novo (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        nome       TEXT    NOT NULL,
        login      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        email      TEXT    UNIQUE COLLATE NOCASE,
        senha_hash TEXT    NOT NULL,
        setor_id   INTEGER NOT NULL REFERENCES setores (id),
        perfil     TEXT    NOT NULL DEFAULT 'Usuário' CHECK (perfil IN ('Administrador', 'Usuário')),
        status     TEXT    NOT NULL DEFAULT 'Ativo'   CHECK (status IN ('Ativo', 'Inativo')),
        criado_em  TEXT    NOT NULL DEFAULT (datetime('now')),
        ultimo_login TEXT
      );
    `);
    const inserir = conn.prepare(
      `INSERT INTO usuarios_novo (id, nome, login, email, senha_hash, setor_id, perfil, status, criado_em, ultimo_login)
       VALUES (@id, @nome, @login, @email, @senha_hash, @setor_id, @perfil, @status, @criado_em, @ultimo_login)`
    );
    comLogin.forEach((u) => inserir.run(u));
    conn.exec('DROP TABLE usuarios; ALTER TABLE usuarios_novo RENAME TO usuarios;');
  })();
  conn.pragma('foreign_keys = ON');

  // eslint-disable-next-line no-console
  console.log(`[migração] coluna "login" criada para ${comLogin.length} usuário(s).`);
}

/**
 * Bancos anteriores ao seletor de clientes gravavam a empresa como texto livre
 * no processo. Cria a coluna `cliente_id` e liga os processos existentes ao
 * cadastro correspondente comparando os dígitos do CNPJ.
 */
function migrarClienteEmProcessos(conn) {
  if (!tabelaExiste(conn, 'processos')) return;
  if (colunas(conn, 'processos').includes('cliente_id')) return;

  conn.exec('ALTER TABLE processos ADD COLUMN cliente_id INTEGER REFERENCES clientes (id);');

  let ligados = 0;
  if (tabelaExiste(conn, 'clientes')) {
    const digitos = (coluna) => `REPLACE(REPLACE(REPLACE(REPLACE(IFNULL(${coluna}, ''), '.', ''), '/', ''), '-', ''), ' ', '')`;
    const casa = `${digitos('c.cnpj_cpf')} = ${digitos('processos.cnpj')} AND ${digitos('c.cnpj_cpf')} <> ''`;
    const info = conn
      .prepare(
        `UPDATE processos
            SET cliente_id = (SELECT c.id FROM clientes c WHERE ${casa} LIMIT 1)
          WHERE cliente_id IS NULL
            AND EXISTS (SELECT 1 FROM clientes c WHERE ${casa})`
      )
      .run();
    ligados = Number(info.changes || 0);
  }

  // eslint-disable-next-line no-console
  console.log(`[migração] coluna "cliente_id" criada em processos (${ligados} processo(s) ligados pelo CNPJ).`);
}

/**
 * O mural nasceu só com "concluído" e "impedido", presos por um CHECK, e todo
 * aviso valia para todos. Com as notificações em tempo real ele passou a ter
 * mais tipos e escopo por setor — e um CHECK não se altera no SQLite, então a
 * tabela é reconstruída preservando os avisos já publicados.
 */
function migrarEscopoDeAvisos(conn) {
  if (!tabelaExiste(conn, 'avisos')) return;
  if (colunas(conn, 'avisos').includes('escopo')) return;

  const antigos = conn.prepare('SELECT * FROM avisos').all();

  conn.pragma('foreign_keys = OFF');
  conn.transaction(() => {
    conn.exec(`
      CREATE TABLE avisos_novo (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo        TEXT    NOT NULL CHECK (tipo IN ('concluido', 'impedido', 'aberto', 'cancelado',
                                                     'reaberto', 'vez_setor', 'prazo', 'documento')),
        escopo      TEXT    NOT NULL DEFAULT 'todos' CHECK (escopo IN ('todos', 'setores')),
        titulo      TEXT    NOT NULL,
        mensagem    TEXT    NOT NULL,
        processo_id INTEGER REFERENCES processos (id) ON DELETE CASCADE,
        usuario_id  INTEGER REFERENCES usuarios (id),
        usuario_nome TEXT,
        criado_em   TEXT    NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const inserir = conn.prepare(
      `INSERT INTO avisos_novo (id, tipo, escopo, titulo, mensagem, processo_id, usuario_id, usuario_nome, criado_em)
       VALUES (@id, @tipo, 'todos', @titulo, @mensagem, @processo_id, @usuario_id, @usuario_nome, @criado_em)`
    );
    antigos.forEach((a) => inserir.run(a));
    conn.exec('DROP TABLE avisos; ALTER TABLE avisos_novo RENAME TO avisos;');
  })();
  conn.pragma('foreign_keys = ON');

  // eslint-disable-next-line no-console
  console.log(`[migração] avisos ganharam escopo e novos tipos (${antigos.length} preservado(s)).`);
}

/**
 * Tipos de aviso novos entram num CHECK que já existe — e CHECK não se altera
 * no SQLite. A tabela é reconstruída com a lista de hoje, preservando os
 * avisos publicados e os seus ids (é por eles que `avisos_lidos` e
 * `avisos_destinos` apontam de volta).
 *
 * A conferência é feita na própria definição da tabela: se o tipo mais novo já
 * está lá, não há nada a fazer.
 */
function migrarTiposDeAviso(conn) {
  if (!tabelaExiste(conn, 'avisos')) return;
  const criacao = conn.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'avisos'").get();
  if (!criacao || /'status'/.test(criacao.sql)) return;

  const antigos = conn.prepare('SELECT * FROM avisos').all();

  conn.pragma('foreign_keys = OFF');
  conn.transaction(() => {
    conn.exec(`
      CREATE TABLE avisos_novo (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        tipo        TEXT    NOT NULL CHECK (tipo IN ('concluido', 'impedido', 'aberto', 'cancelado',
                                                     'reaberto', 'status', 'vez_setor', 'prazo',
                                                     'documento')),
        escopo      TEXT    NOT NULL DEFAULT 'todos' CHECK (escopo IN ('todos', 'setores')),
        titulo      TEXT    NOT NULL,
        mensagem    TEXT    NOT NULL,
        processo_id INTEGER REFERENCES processos (id) ON DELETE CASCADE,
        usuario_id  INTEGER REFERENCES usuarios (id),
        usuario_nome TEXT,
        criado_em   TEXT    NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const inserir = conn.prepare(
      `INSERT INTO avisos_novo (id, tipo, escopo, titulo, mensagem, processo_id, usuario_id, usuario_nome, criado_em)
       VALUES (@id, @tipo, @escopo, @titulo, @mensagem, @processo_id, @usuario_id, @usuario_nome, @criado_em)`
    );
    antigos.forEach((a) => inserir.run(a));
    conn.exec('DROP TABLE avisos; ALTER TABLE avisos_novo RENAME TO avisos;');
  })();
  conn.pragma('foreign_keys = ON');

  // eslint-disable-next-line no-console
  console.log(`[migração] avisos aceitam o tipo "status" (${antigos.length} preservado(s)).`);
}

/**
 * O subtipo do processo nasceu como uma coluna única e virou uma lista: um
 * processo pode ter vários. O que estava na coluna passa para a tabela de
 * ligação e a coluna sai — duas fontes para o mesmo dado é o começo de uma
 * divergir da outra.
 */
function migrarSubtiposDoProcesso(conn) {
  if (!tabelaExiste(conn, 'processos')) return;
  if (!colunas(conn, 'processos').includes('subtipo_processo_id')) return;

  const antigos = conn
    .prepare('SELECT id, subtipo_processo_id FROM processos WHERE subtipo_processo_id IS NOT NULL')
    .all();

  conn.pragma('foreign_keys = OFF');
  conn.transaction(() => {
    const inserir = conn.prepare(
      'INSERT OR IGNORE INTO processos_subtipos (processo_id, subtipo_id) VALUES (?, ?)'
    );
    for (const linha of antigos) inserir.run(linha.id, linha.subtipo_processo_id);
    conn.exec('ALTER TABLE processos DROP COLUMN subtipo_processo_id;');
  })();
  conn.pragma('foreign_keys = ON');

  // eslint-disable-next-line no-console
  console.log(`[migração] subtipos do processo passaram para a tabela de ligação (${antigos.length} processo(s)).`);
}

/**
 * O item do checklist modelo passou a poder ser de um subtipo, e não só de um
 * tipo. A coluna nasce vazia: todo item existente continua valendo para o tipo
 * inteiro, como antes.
 */
function migrarSubtipoNoChecklistModelo(conn) {
  if (!tabelaExiste(conn, 'checklist_modelo')) return;
  if (colunas(conn, 'checklist_modelo').includes('subtipo_processo_id')) return;

  conn.exec(
    'ALTER TABLE checklist_modelo ADD COLUMN subtipo_processo_id INTEGER REFERENCES subtipos_processo (id);'
  );
  // eslint-disable-next-line no-console
  console.log('[migração] coluna "subtipo_processo_id" criada em checklist_modelo.');
}

/**
 * Parâmetros novos chegam a bancos que já existem.
 *
 * A carga inicial (`npm run seed`) só roda uma vez. Sem isto, um parâmetro
 * criado numa versão nova ficaria fora da tela de Parâmetros em toda
 * instalação já em uso — funcionando pelo valor padrão do código, mas sem
 * ninguém conseguir mudá-lo. Só INSERE o que falta: nada que o escritório já
 * ajustou é tocado.
 */
function semearParametrosNovos(conn) {
  if (!tabelaExiste(conn, 'parametros')) return;
  // Banco vazio é banco recém-criado: a carga inicial (`npm run seed`) é que
  // preenche a tabela. Aqui só interessa a instalação que já está em uso.
  if (!conn.prepare('SELECT 1 FROM parametros LIMIT 1').get()) return;

  const seed = require('./seed-data');
  const existe = conn.prepare('SELECT 1 FROM parametros WHERE chave = ?');
  const inserir = conn.prepare(
    `INSERT INTO parametros (chave, valor, tipo, categoria, descricao)
     VALUES (@chave, @valor, @tipo, @categoria, @descricao)`
  );

  const novos = seed.PARAMETROS.filter((p) => !existe.get(p.chave));
  if (!novos.length) return;

  conn.transaction(() => novos.forEach((p) => inserir.run(p)))();
  // eslint-disable-next-line no-console
  console.log(`[migração] ${novos.length} parâmetro(s) novo(s): ${novos.map((p) => p.chave).join(', ')}.`);
}

/**
 * O usuário passou a poder atuar em vários setores. O que já existia vira a
 * primeira linha da tabela de ligação: ninguém perde acesso, e quem precisar
 * de um segundo setor ganha na tela de Usuários.
 */
function migrarSetoresDoUsuario(conn) {
  if (!tabelaExiste(conn, 'usuarios') || !tabelaExiste(conn, 'usuarios_setores')) return;

  const info = conn
    .prepare(
      `INSERT INTO usuarios_setores (usuario_id, setor_id)
       SELECT u.id, u.setor_id FROM usuarios u
        WHERE NOT EXISTS (SELECT 1 FROM usuarios_setores us WHERE us.usuario_id = u.id AND us.setor_id = u.setor_id)`
    )
    .run();
  const criadas = Number(info.changes || 0);
  if (!criadas) return;
  // eslint-disable-next-line no-console
  console.log(`[migração] setor de ${criadas} usuário(s) levado para a tabela de setores por usuário.`);
}

/**
 * Situações de processo criadas em versões novas.
 *
 * Vale o mesmo raciocínio dos parâmetros: a carga inicial só roda uma vez, e
 * sem isto uma situação nova nunca apareceria na lista de quem já usa a
 * plataforma. A ordem de todas as situações do código é reaplicada junto, para
 * que a nova caia no lugar certo da lista e não no fim dela — a tela de Tipos e
 * setores mostra as situações, mas não deixa reordená-las, então nada que o
 * escritório tenha ajustado à mão se perde aqui.
 */
function semearStatusNovos(conn) {
  if (!tabelaExiste(conn, 'status_processo')) return;
  // Banco vazio é banco recém-criado: quem preenche é o `npm run seed`.
  if (!conn.prepare('SELECT 1 FROM status_processo LIMIT 1').get()) return;

  const seed = require('./seed-data');
  const existe = conn.prepare('SELECT 1 FROM status_processo WHERE nome = ?');
  const novos = seed.STATUS_PROCESSO.filter((s) => !existe.get(s.nome));
  if (!novos.length) return;

  const inserir = conn.prepare(
    'INSERT INTO status_processo (nome, ordem, final, espera) VALUES (@nome, @ordem, @final, @espera)'
  );
  const reordenar = conn.prepare('UPDATE status_processo SET ordem = @ordem WHERE nome = @nome');
  conn.transaction(() => {
    novos.forEach((s) => inserir.run(s));
    seed.STATUS_PROCESSO.forEach((s) => reordenar.run({ nome: s.nome, ordem: s.ordem }));
  })();
  // eslint-disable-next-line no-console
  console.log(`[migração] ${novos.length} situação(ões) de processo: ${novos.map((s) => s.nome).join(', ')}.`);
}

/**
 * Parâmetros que deixaram de existir no código.
 *
 * Um parâmetro que ninguém mais lê é pior do que nenhum: ele continua na tela
 * de Parâmetros, aceita ser mudado e não muda nada. Some junto com a regra que
 * o usava.
 */
const PARAMETROS_APOSENTADOS = [
  // A conclusão deixou de ser privilégio de Administrador/Diretoria: quem
  // participa do processo conclui, desde que cumpra os requisitos.
  'EXIGIR_APROVACAO_GESTOR',
];

function removerParametrosAposentados(conn) {
  if (!tabelaExiste(conn, 'parametros')) return;
  const apagar = conn.prepare('DELETE FROM parametros WHERE chave = ?');
  const apagados = PARAMETROS_APOSENTADOS.filter((chave) => Number(apagar.run(chave).changes || 0) > 0);
  if (!apagados.length) return;
  // eslint-disable-next-line no-console
  console.log(`[migração] parâmetro(s) sem uso removido(s): ${apagados.join(', ')}.`);
}

function migrate(conn) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  migrarLoginDeUsuarios(conn);
  migrarClienteEmProcessos(conn);
  migrarEscopoDeAvisos(conn);
  migrarTiposDeAviso(conn);
  // Antes do schema: ele cria um índice sobre a coluna nova do checklist
  // modelo, e o índice não existe sem a coluna.
  migrarSubtipoNoChecklistModelo(conn);
  conn.exec(schema);
  // Depois do schema: estas dependem das tabelas de ligação que ele acabou de criar.
  migrarSubtiposDoProcesso(conn);
  migrarSetoresDoUsuario(conn);
  semearParametrosNovos(conn);
  semearStatusNovos(conn);
  removerParametrosAposentados(conn);
}

function get() {
  return db || open();
}

/** Executa `fn` dentro de uma transação (aninhamento seguro via savepoint). */
function tx(fn) {
  return get().transaction(fn)();
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { open, get, tx, close, migrate, loginSugerido };
