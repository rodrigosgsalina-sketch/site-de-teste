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

function migrate(conn) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  migrarLoginDeUsuarios(conn);
  migrarClienteEmProcessos(conn);
  conn.exec(schema);
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
