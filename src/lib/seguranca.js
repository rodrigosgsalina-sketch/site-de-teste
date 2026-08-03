'use strict';

/**
 * Camada de segurança HTTP da plataforma.
 *
 * Reúne, sem dependências externas, o que uma aplicação exposta na internet
 * precisa ter antes de receber a primeira visita: HTTPS obrigatório, cabeçalhos
 * defensivos com Content-Security-Policy por nonce e freio de força bruta no
 * login.
 */

const crypto = require('crypto');
const config = require('../config');

/** Requisição chegou por HTTPS? Considera o proxy quando ele é confiável. */
function ehSeguro(req) {
  if (req.secure) return true;
  if (!config.trustProxy) return false;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}

/**
 * Redireciona HTTP → HTTPS. Só age quando FORCE_HTTPS está ligado, para não
 * atrapalhar o desenvolvimento local em http://localhost.
 */
function exigirHttps(req, res, next) {
  if (!config.forcarHttps || ehSeguro(req)) return next();

  // Sem host confiável não há para onde redirecionar com segurança.
  const host = String(req.headers.host || '').replace(/[^a-zA-Z0-9.:\-[\]]/g, '');
  if (!host || req.method !== 'GET') {
    return res.status(403).send('Esta aplicação só aceita conexões HTTPS.');
  }
  return res.redirect(308, `https://${host}${req.originalUrl}`);
}

/**
 * Cabeçalhos de segurança. A CSP é restritiva: nada de origem externa, nada de
 * script inline sem o nonce do request, nada de <iframe> hospedando a página.
 */
function cabecalhos(req, res, next) {
  res.locals.nonce = crypto.randomBytes(16).toString('base64');

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${res.locals.nonce}'`,
    // Os atributos style= das telas exigem 'unsafe-inline' aqui; scripts não.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
  ];
  if (config.forcarHttps) csp.push('upgrade-insecure-requests');

  res.setHeader('Content-Security-Policy', csp.join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Origin-Agent-Cluster', '?1');

  // HSTS só faz sentido — e só é seguro — em resposta servida por HTTPS.
  if (config.hstsMaxAge > 0 && ehSeguro(req)) {
    res.setHeader('Strict-Transport-Security', `max-age=${config.hstsMaxAge}; includeSubDomains`);
  }
  next();
}

/**
 * Só deixa passar destino dentro do próprio site. Um "retorno" vindo do
 * formulário nunca pode virar um salto para fora ("//site-falso", "https://…",
 * "javascript:…"), que é como um phishing usaria a plataforma como trampolim.
 */
function destinoInterno(valor, padrao = '/') {
  const destino = String(valor || '').trim();
  if (!destino.startsWith('/')) return padrao;
  if (destino.startsWith('//') || destino.includes('\\')) return padrao;
  if (/[\u0000-\u001f\u007f]/.test(destino)) return padrao;
  return destino;
}

/* ------------------------------------------------------------------------ *
 * Freio de força bruta                                                      *
 * ------------------------------------------------------------------------ */

const tentativas = new Map();

function chaveDoPedido(req) {
  const ip = req.ip || req.connection.remoteAddress || 'desconhecido';
  const login = String((req.body && req.body.login) || '').trim().toLowerCase();
  return `${ip}|${login}`;
}

function limparExpirados(agora) {
  for (const [chave, registro] of tentativas) {
    if (registro.ate <= agora) tentativas.delete(chave);
  }
}

/**
 * Conta as tentativas malsucedidas por IP + usuário dentro de uma janela.
 * Estouram o limite → 429 com o tempo de espera, sem consultar o banco.
 */
function freioDeLogin(req, res, next) {
  const agora = Date.now();
  if (tentativas.size > 500) limparExpirados(agora);

  const chave = chaveDoPedido(req);
  const registro = tentativas.get(chave);
  if (registro && registro.ate > agora && registro.falhas >= config.loginTentativas) {
    const minutos = Math.max(1, Math.ceil((registro.ate - agora) / 60000));
    res.setHeader('Retry-After', String(minutos * 60));
    return res.status(429).render('login', {
      titulo: 'Entrar',
      erro: `Muitas tentativas de acesso. Tente novamente em ${minutos} minuto(s).`,
      login: (req.body && req.body.login) || '',
    });
  }
  next();
}

/** Chamado quando a senha não confere. */
function registrarFalha(req) {
  const agora = Date.now();
  const chave = chaveDoPedido(req);
  const janela = config.loginJanelaMinutos * 60 * 1000;
  const registro = tentativas.get(chave);
  if (registro && registro.ate > agora) {
    registro.falhas += 1;
    // Cada falha depois do limite renova a espera: insistir não adianta.
    if (registro.falhas >= config.loginTentativas) registro.ate = agora + janela;
  } else {
    tentativas.set(chave, { falhas: 1, ate: agora + janela });
  }
}

/** Chamado quando a autenticação dá certo. */
function limparFalhas(req) {
  tentativas.delete(chaveDoPedido(req));
}

/** Usado nos testes para começar do zero. */
function zerarFreio() {
  tentativas.clear();
}

module.exports = {
  ehSeguro,
  destinoInterno,
  exigirHttps,
  cabecalhos,
  freioDeLogin,
  registrarFalha,
  limparFalhas,
  zerarFreio,
};
