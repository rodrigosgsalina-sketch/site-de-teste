'use strict';

/**
 * Driver de banco sobre o `node:sqlite` — o SQLite que já vem embutido no
 * Node.js. Não há módulo nativo para compilar: a instalação não precisa de
 * Visual Studio, Xcode, Python ou node-gyp, e o mesmo projeto roda em
 * Windows, macOS e Linux sem binário pré-compilado.
 *
 * A superfície exposta aqui é intencionalmente a mesma do better-sqlite3
 * (`prepare`, `exec`, `pragma`, `transaction`, `close`), de modo que o resto
 * da aplicação não conhece o driver.
 */

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  throw new Error(
    'Este projeto precisa do SQLite embutido no Node.js (node:sqlite), disponível a partir do ' +
      `Node 22.5. A versão em uso é ${process.version}. Atualize o Node (recomendado: 22 LTS ou 24) ` +
      'e rode novamente.'
  );
}

/**
 * O node:sqlite devolve linhas com protótipo nulo. Copiamos para objetos
 * comuns para que views e utilitários possam tratá-las como objetos normais.
 */
function normalizar(linha) {
  return linha == null ? linha : Object.assign({}, linha);
}

class Instrucao {
  constructor(stmt) {
    this.stmt = stmt;
  }

  run(...args) {
    return this.stmt.run(...args);
  }

  get(...args) {
    return normalizar(this.stmt.get(...args));
  }

  all(...args) {
    return this.stmt.all(...args).map(normalizar);
  }

  iterate(...args) {
    return this.stmt.iterate(...args);
  }
}

class Banco {
  constructor(arquivo) {
    this.db = new DatabaseSync(arquivo);
    this.contadorSavepoint = 0;
  }

  prepare(sql) {
    return new Instrucao(this.db.prepare(sql));
  }

  exec(sql) {
    this.db.exec(sql);
    return this;
  }

  /**
   * `pragma('journal_mode = WAL')` aplica; `pragma('table_info(x)')` consulta.
   */
  pragma(texto) {
    const comando = String(texto).trim();
    if (comando.includes('=')) {
      this.db.exec(`PRAGMA ${comando}`);
      return [];
    }
    return this.db.prepare(`PRAGMA ${comando}`).all().map(normalizar);
  }

  /**
   * Envolve `fn` em uma transação. Chamadas aninhadas viram SAVEPOINT, de modo
   * que uma transação interna que falhe não derrube a externa inteira.
   */
  transaction(fn) {
    return (...args) => {
      const externa = !this.db.isTransaction;
      const marca = `sp_${++this.contadorSavepoint}`;

      this.db.exec(externa ? 'BEGIN' : `SAVEPOINT ${marca}`);
      try {
        const resultado = fn(...args);
        this.db.exec(externa ? 'COMMIT' : `RELEASE ${marca}`);
        return resultado;
      } catch (erro) {
        try {
          this.db.exec(externa ? 'ROLLBACK' : `ROLLBACK TO ${marca}; RELEASE ${marca}`);
        } catch (falhaAoDesfazer) {
          // A transação já pode ter sido desfeita pelo próprio SQLite.
        }
        throw erro;
      }
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = Banco;
