'use strict';

/**
 * Proteção contra CSRF (falsificação de requisição entre sites).
 *
 * Cada sessão recebe um segredo; todo formulário carrega um token derivado dele
 * no campo oculto `_csrf`. Sem o token — ou com um token de outra sessão — a
 * escrita é recusada. Assim um site malicioso não consegue fazer o navegador do
 * usuário logado concluir processos, criar usuários ou restaurar um backup.
 */

const crypto = require('crypto');

const CAMPO = '_csrf';
const CABECALHO = 'x-csrf-token';
const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

class ErroCsrf extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroCsrf';
    this.csrf = true;
  }
}

/** Garante um segredo por sessão e devolve o token a ser publicado nas telas. */
function token(req) {
  if (!req.session) return '';
  if (!req.session.csrfSegredo) {
    req.session.csrfSegredo = crypto.randomBytes(32).toString('base64url');
  }
  return req.session.csrfSegredo;
}

/** Comparação em tempo constante — evita descobrir o token por medição. */
function iguais(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function enviado(req) {
  return (
    (req.body && req.body[CAMPO]) ||
    req.headers[CABECALHO] ||
    (req.query && req.query[CAMPO]) ||
    ''
  );
}

/** Publica o token nas views e valida os métodos de escrita. */
function proteger(req, res, next) {
  res.locals.csrfToken = token(req);

  if (METODOS_SEGUROS.has(req.method)) return next();

  // Envios com arquivo (multipart) só têm corpo depois do multer: essas rotas
  // chamam `verificar` explicitamente, logo após o upload.
  const tipo = String(req.headers['content-type'] || '');
  if (tipo.startsWith('multipart/form-data')) return next();

  return verificar(req, res, next);
}

/** Validação propriamente dita. Usada também após o multer. */
function verificar(req, res, next) {
  if (METODOS_SEGUROS.has(req.method)) return next();
  if (!iguais(enviado(req), req.session && req.session.csrfSegredo)) {
    return next(
      new ErroCsrf(
        'Sessão expirada ou formulário inválido. Recarregue a página e tente novamente — ' +
          'nenhuma alteração foi gravada.'
      )
    );
  }
  return next();
}

module.exports = { CAMPO, CABECALHO, ErroCsrf, proteger, verificar, token };
