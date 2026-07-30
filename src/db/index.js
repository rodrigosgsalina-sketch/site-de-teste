'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

let db = null;

function open(file = config.dbFile) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(conn) {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
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

module.exports = { open, get, tx, close, migrate };
