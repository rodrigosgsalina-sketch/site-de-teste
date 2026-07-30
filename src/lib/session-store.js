'use strict';

/**
 * Armazenamento de sessões em SQLite usando a mesma conexão better-sqlite3 da
 * aplicação — evita uma segunda dependência nativa só para as sessões.
 */

const session = require('express-session');

module.exports = function criarStore(db) {
  const Store = session.Store;

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessoes (
      sid     TEXT PRIMARY KEY,
      expira  INTEGER NOT NULL,
      dados   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessoes_expira ON sessoes (expira);
  `);

  const selecionar = db.prepare('SELECT dados, expira FROM sessoes WHERE sid = ?');
  const gravar = db.prepare(
    `INSERT INTO sessoes (sid, expira, dados) VALUES (?, ?, ?)
     ON CONFLICT (sid) DO UPDATE SET expira = excluded.expira, dados = excluded.dados`
  );
  const apagar = db.prepare('DELETE FROM sessoes WHERE sid = ?');
  const limpar = db.prepare('DELETE FROM sessoes WHERE expira <= ?');
  const tocar = db.prepare('UPDATE sessoes SET expira = ? WHERE sid = ?');
  const contar = db.prepare('SELECT COUNT(*) AS total FROM sessoes WHERE expira > ?');
  const todas = db.prepare('SELECT dados FROM sessoes WHERE expira > ?');

  function validade(sess) {
    if (sess && sess.cookie && sess.cookie.expires) return new Date(sess.cookie.expires).getTime();
    return Date.now() + 12 * 3600 * 1000;
  }

  class SQLiteSessionStore extends Store {
    constructor() {
      super();
      // Faxina periódica das sessões expiradas.
      this.timer = setInterval(() => {
        try {
          limpar.run(Date.now());
        } catch (_) {
          /* banco fechado durante o encerramento */
        }
      }, 15 * 60 * 1000);
      this.timer.unref();
    }

    get(sid, cb) {
      try {
        const linha = selecionar.get(sid);
        if (!linha) return cb(null, null);
        if (linha.expira <= Date.now()) {
          apagar.run(sid);
          return cb(null, null);
        }
        return cb(null, JSON.parse(linha.dados));
      } catch (err) {
        return cb(err);
      }
    }

    set(sid, sess, cb) {
      try {
        gravar.run(sid, validade(sess), JSON.stringify(sess));
        return cb ? cb(null) : undefined;
      } catch (err) {
        return cb ? cb(err) : undefined;
      }
    }

    destroy(sid, cb) {
      try {
        apagar.run(sid);
        return cb ? cb(null) : undefined;
      } catch (err) {
        return cb ? cb(err) : undefined;
      }
    }

    touch(sid, sess, cb) {
      try {
        tocar.run(validade(sess), sid);
        return cb ? cb(null) : undefined;
      } catch (err) {
        return cb ? cb(err) : undefined;
      }
    }

    length(cb) {
      try {
        return cb(null, contar.get(Date.now()).total);
      } catch (err) {
        return cb(err);
      }
    }

    clear(cb) {
      try {
        db.prepare('DELETE FROM sessoes').run();
        return cb ? cb(null) : undefined;
      } catch (err) {
        return cb ? cb(err) : undefined;
      }
    }

    all(cb) {
      try {
        return cb(null, todas.all(Date.now()).map((l) => JSON.parse(l.dados)));
      } catch (err) {
        return cb(err);
      }
    }
  }

  return new SQLiteSessionStore();
};
