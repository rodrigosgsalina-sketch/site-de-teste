'use strict';

/**
 * Web Push (RFC 8030/8291/8292) com o `crypto` do próprio Node — sem
 * dependência nova.
 *
 * É o único caminho que entrega notificação com o navegador **fechado**: o
 * servidor manda a mensagem cifrada para o serviço de push do navegador
 * (Google/Mozilla/Apple), que a repassa ao aparelho e acorda o Service Worker.
 *
 * O conteúdo vai cifrado ponta a ponta (aes128gcm) com a chave pública que o
 * próprio navegador gerou: o serviço de push encaminha, mas não lê o aviso.
 *
 * Fica desligado enquanto não houver par de chaves VAPID configurado — sem
 * elas, a plataforma não conversa com nenhum serviço externo.
 */

const crypto = require('crypto');

/* --------------------------------------------------------------- base64url */

function paraBase64Url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function deBase64Url(texto) {
  const normalizado = String(texto || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalizado, 'base64');
}

/* ------------------------------------------------------------------ chaves */

/** Gera o par VAPID (usado por `npm run vapid`). */
function gerarChaves() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publica: paraBase64Url(ecdh.getPublicKey()),
    privada: paraBase64Url(ecdh.getPrivateKey()),
  };
}

/** Monta a chave privada em JWK a partir do par bruto (32 + 65 bytes). */
function chavePrivadaJwk(privadaB64, publicaB64) {
  const publica = deBase64Url(publicaB64);
  if (publica.length !== 65 || publica[0] !== 0x04) {
    throw new Error('A chave pública VAPID precisa ter 65 bytes no formato não comprimido.');
  }
  return crypto.createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: paraBase64Url(deBase64Url(privadaB64)),
      x: paraBase64Url(publica.subarray(1, 33)),
      y: paraBase64Url(publica.subarray(33, 65)),
    },
  });
}

/* ------------------------------------------------------------------- VAPID */

/**
 * JWT ES256 que identifica o servidor para o serviço de push (RFC 8292).
 * `audience` é a origem do endpoint (ex.: https://fcm.googleapis.com).
 */
function jwtVapid(audience, { publica, privada, contato }, validadeSegundos = 12 * 3600) {
  const cabecalho = { typ: 'JWT', alg: 'ES256' };
  const corpo = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + validadeSegundos,
    sub: contato,
  };
  const base =
    `${paraBase64Url(JSON.stringify(cabecalho))}.${paraBase64Url(JSON.stringify(corpo))}`;
  const assinatura = crypto.sign('sha256', Buffer.from(base), {
    key: chavePrivadaJwk(privada, publica),
    dsaEncoding: 'ieee-p1363', // JWS pede R||S puro, não DER
  });
  return `${base}.${paraBase64Url(assinatura)}`;
}

/* -------------------------------------------------------------- criptografia */

function hmac(chave, dados) {
  return crypto.createHmac('sha256', chave).update(dados).digest();
}

/** HKDF-Expand com uma única iteração (basta para os tamanhos usados aqui). */
function expandir(prk, info, tamanho) {
  return hmac(prk, Buffer.concat([Buffer.from(info), Buffer.from([1])])).subarray(0, tamanho);
}

/**
 * Cifra o payload no formato aes128gcm (RFC 8188) com as chaves do navegador
 * (RFC 8291). Devolve o corpo pronto do POST.
 */
function criptografar(payload, p256dhB64, authB64, { salt, chavesLocais } = {}) {
  const uaPublica = deBase64Url(p256dhB64);
  const authSecret = deBase64Url(authB64);
  if (uaPublica.length !== 65) throw new Error('p256dh inválido (esperado 65 bytes).');
  if (authSecret.length !== 16) throw new Error('auth inválido (esperado 16 bytes).');

  const ecdh = chavesLocais || crypto.createECDH('prime256v1');
  if (!chavesLocais) ecdh.generateKeys();
  const asPublica = ecdh.getPublicKey();
  const compartilhado = ecdh.computeSecret(uaPublica);

  // IKM = HKDF(auth_secret, ECDH, "WebPush: info\0" || ua_public || as_public)
  const ikm = expandir(
    hmac(authSecret, compartilhado),
    Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublica, asPublica]),
    32
  );

  const sal = salt || crypto.randomBytes(16);
  const prk = hmac(sal, ikm);
  const cek = expandir(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = expandir(prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  const corpo = Buffer.from(payload, 'utf8');
  // 0x02 fecha o último (e único) registro.
  const registro = Buffer.concat([corpo, Buffer.from([0x02])]);
  const cifra = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const cifrado = Buffer.concat([cifra.update(registro), cifra.final(), cifra.getAuthTag()]);

  const tamanhoRegistro = Buffer.alloc(4);
  tamanhoRegistro.writeUInt32BE(4096, 0);
  const cabecalho = Buffer.concat([sal, tamanhoRegistro, Buffer.from([asPublica.length]), asPublica]);

  return Buffer.concat([cabecalho, cifrado]);
}

/**
 * Decifra um corpo aes128gcm com a chave privada do "navegador".
 * Existe para o teste conseguir provar que a cifragem está correta.
 */
function descriptografar(corpo, chavePrivadaUa, authB64) {
  const sal = corpo.subarray(0, 16);
  const tamanhoChave = corpo[20];
  const asPublica = corpo.subarray(21, 21 + tamanhoChave);
  const cifrado = corpo.subarray(21 + tamanhoChave);

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(chavePrivadaUa);
  const uaPublica = ecdh.getPublicKey();
  const compartilhado = ecdh.computeSecret(asPublica);

  const ikm = expandir(
    hmac(deBase64Url(authB64), compartilhado),
    Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublica, asPublica]),
    32
  );
  const prk = hmac(sal, ikm);
  const cek = expandir(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = expandir(prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  const decifra = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decifra.setAuthTag(cifrado.subarray(cifrado.length - 16));
  const aberto = Buffer.concat([decifra.update(cifrado.subarray(0, cifrado.length - 16)), decifra.final()]);
  // Tira o delimitador (0x02) e o enchimento.
  let fim = aberto.length - 1;
  while (fim >= 0 && aberto[fim] === 0x00) fim -= 1;
  return aberto.subarray(0, fim).toString('utf8');
}

/* ------------------------------------------------------------------- envio */

/**
 * Entrega uma mensagem a uma inscrição. Devolve
 * { ok, status, remover } — `remover: true` quando a inscrição morreu
 * (navegador desinstalado, permissão revogada) e deve sair do banco.
 */
async function enviar(inscricao, payload, { chaves, ttl = 3600, urgencia = 'normal', tempoLimiteMs = 8000 } = {}) {
  if (!chaves || !chaves.publica || !chaves.privada) {
    return { ok: false, status: 0, motivo: 'VAPID não configurado', remover: false };
  }

  let endpoint;
  try {
    endpoint = new URL(inscricao.endpoint);
  } catch (_) {
    return { ok: false, status: 0, motivo: 'endpoint inválido', remover: true };
  }

  const corpo = criptografar(payload, inscricao.p256dh, inscricao.auth);
  const autorizacao = `vapid t=${jwtVapid(endpoint.origin, chaves)}, k=${chaves.publica}`;

  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), tempoLimiteMs);
  try {
    const resposta = await fetch(inscricao.endpoint, {
      method: 'POST',
      headers: {
        TTL: String(ttl),
        Urgency: urgencia,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(corpo.length),
        Authorization: autorizacao,
      },
      body: corpo,
      signal: controle.signal,
    });
    // 404/410: o serviço de push avisa que a inscrição não existe mais.
    return {
      ok: resposta.ok,
      status: resposta.status,
      motivo: resposta.ok ? null : `HTTP ${resposta.status}`,
      remover: resposta.status === 404 || resposta.status === 410,
    };
  } catch (err) {
    return { ok: false, status: 0, motivo: err.name === 'AbortError' ? 'tempo esgotado' : err.message, remover: false };
  } finally {
    clearTimeout(relogio);
  }
}

module.exports = {
  gerarChaves,
  jwtVapid,
  criptografar,
  descriptografar,
  enviar,
  paraBase64Url,
  deBase64Url,
};
