'use strict';

/**
 * Testes da migração para HTTPS:
 *  - certificado emitido pela autoridade local (cadeia, nomes e uso);
 *  - a porta 80 redirecionando, recusando envio em claro e entregando o
 *    desafio do Let's Encrypt;
 *  - a recusa de subir em produção sem HTTPS declarado.
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgrilo-tls-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'teste.db');

const seguranca = require('../src/lib/seguranca');
const config = require('../src/config');

function temOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

/* ------------------------------------------------- certificado da autoridade */

test('o script emite um certificado assinado pela autoridade local, com os nomes do escritório', { skip: !temOpenssl() && 'openssl não disponível' }, () => {
  const pasta = path.join(tmp, 'certificados');
  execFileSync(
    process.execPath,
    [
      path.join(__dirname, '..', 'scripts', 'gerar-certificado.js'),
      '--nomes', 'jsgriloprocessos,localhost',
      '--ips', '192.168.0.10',
      '--validade', '825',
    ],
    { env: { ...process.env, DATA_DIR: tmp }, stdio: 'ignore' }
  );

  const certificado = path.join(pasta, 'certificado.pem');
  const autoridade = path.join(pasta, 'autoridade.pem');
  assert.ok(fs.existsSync(certificado), 'certificado do servidor');
  assert.ok(fs.existsSync(autoridade), 'certificado da autoridade, para instalar nos aparelhos');
  assert.ok(fs.existsSync(path.join(pasta, 'COMO-INSTALAR.txt')), 'instruções de instalação');

  const texto = (args) => execFileSync('openssl', args, { encoding: 'utf8' });

  // A cadeia fecha: é isso que faz o navegador parar de avisar, uma vez
  // instalada a autoridade no aparelho.
  const verificacao = texto(['verify', '-CAfile', autoridade, certificado]);
  assert.match(verificacao, /OK/);

  const detalhes = texto(['x509', '-in', certificado, '-noout', '-text']);
  assert.match(detalhes, /DNS:jsgriloprocessos/);
  assert.match(detalhes, /DNS:localhost/);
  assert.match(detalhes, /IP Address:192\.168\.0\.10/);
  assert.match(detalhes, /TLS Web Server Authentication/);
  assert.match(detalhes, /CA:FALSE/);
  assert.match(detalhes, /Issuer:.*JS Grilo - Autoridade Local/);

  const daAutoridade = texto(['x509', '-in', autoridade, '-noout', '-text']);
  assert.match(daAutoridade, /CA:TRUE/);
  assert.match(daAutoridade, /Certificate Sign/);

  // Rodar de novo não troca a autoridade: os aparelhos já instalados continuam
  // valendo.
  const antes = fs.readFileSync(autoridade, 'utf8');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'gerar-certificado.js'), '--forcar'], {
    env: { ...process.env, DATA_DIR: tmp },
    stdio: 'ignore',
  });
  assert.strictEqual(fs.readFileSync(autoridade, 'utf8'), antes, 'a autoridade é reaproveitada');
  assert.notStrictEqual(
    fs.readFileSync(certificado, 'utf8'),
    '',
    'o certificado do servidor é reemitido'
  );

  // A chave privada da autoridade não pode ficar legível para todos.
  if (process.platform !== 'win32') {
    const modo = fs.statSync(path.join(pasta, 'autoridade-chave.pem')).mode & 0o777;
    assert.strictEqual(modo, 0o600);
  }
});

/* ------------------------------------------------------ porta de redirecionamento */

/** Sobe o tratador da porta 80 em uma porta livre e devolve o endereço. */
function subirRedirecionador(opcoes) {
  const servidor = http.createServer(seguranca.tratadorDeRedirecionamento(opcoes));
  return new Promise((resolve) => {
    servidor.listen(0, '127.0.0.1', () => resolve({ servidor, porta: servidor.address().port }));
  });
}

/**
 * Requisição crua: o `fetch` não deixa definir o cabeçalho Host, e é
 * justamente o Host que o redirecionador usa para montar o destino.
 */
function pedir(porta, caminho, { host = 'jsgriloprocessos', metodo = 'GET', corpo = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: porta, path: caminho, method: metodo, headers: { Host: host } },
      (res) => {
        let texto = '';
        res.on('data', (p) => { texto += p; });
        res.on('end', () => resolve({ status: res.statusCode, cabecalhos: res.headers, texto }));
      }
    );
    req.on('error', reject);
    if (corpo) req.write(corpo);
    req.end();
  });
}

test('a porta HTTP redireciona com 308 e preserva o caminho', async () => {
  const { servidor, porta } = await subirRedirecionador({ portaHttps: 443 });
  try {
    const resposta = await pedir(porta, '/processos/12?aba=checklist');
    assert.strictEqual(resposta.status, 308);
    assert.strictEqual(resposta.cabecalhos.location, 'https://jsgriloprocessos/processos/12?aba=checklist');
  } finally {
    servidor.close();
  }
});

test('em porta HTTPS diferente de 443, o destino carrega a porta', async () => {
  const { servidor, porta } = await subirRedirecionador({ portaHttps: 8443 });
  try {
    const resposta = await pedir(porta, '/');
    assert.strictEqual(resposta.cabecalhos.location, 'https://jsgriloprocessos:8443/');
  } finally {
    servidor.close();
  }
});

test('envio de formulário em HTTP puro é recusado, não redirecionado', async () => {
  const { servidor, porta } = await subirRedirecionador({ portaHttps: 443 });
  try {
    const resposta = await pedir(porta, '/login', {
      metodo: 'POST',
      corpo: 'login=jacqueline&senha=segredo',
    });
    // 308 reenviaria a senha por baixo dos panos, como se nada tivesse
    // acontecido — ela já viajou em claro uma vez.
    assert.strictEqual(resposta.status, 403);
    assert.match(resposta.texto, /só aceita envios por HTTPS/i);
  } finally {
    servidor.close();
  }
});

test('o desafio do Let\'s Encrypt passa pela porta 80 sem parar a plataforma', async () => {
  const raiz = path.join(tmp, 'acme');
  fs.mkdirSync(path.join(raiz, '.well-known', 'acme-challenge'), { recursive: true });
  fs.writeFileSync(path.join(raiz, '.well-known', 'acme-challenge', 'token-de-teste'), 'prova-123');

  const { servidor, porta } = await subirRedirecionador({ portaHttps: 443, acmeWebroot: raiz });
  try {
    const host = 'processos.jsgrilo.com.br';
    const ok = await pedir(porta, '/.well-known/acme-challenge/token-de-teste', { host });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.texto, 'prova-123');

    const inexistente = await pedir(porta, '/.well-known/acme-challenge/nao-existe', { host });
    assert.strictEqual(inexistente.status, 404);

    // O caminho do desafio não vira porta de entrada para o resto do disco.
    const escapando = await pedir(porta, '/.well-known/acme-challenge/..%2f..%2f..%2fetc%2fpasswd', { host });
    assert.strictEqual(escapando.status, 404);
  } finally {
    servidor.close();
  }
});

test('sem host confiável não há para onde redirecionar', async () => {
  const { servidor, porta } = await subirRedirecionador({ portaHttps: 443 });
  try {
    const resposta = await pedir(porta, '/', { host: '@@@' });
    assert.strictEqual(resposta.status, 400);
  } finally {
    servidor.close();
  }
});

/* ------------------------------------------------------------- produção */

test('em produção, subir sem HTTPS declarado é recusado', () => {
  const original = {
    producao: config.producao,
    segredoPadrao: config.segredoPadrao,
    httpsProprio: config.httpsProprio,
    trustProxy: config.trustProxy,
  };
  try {
    config.segredoPadrao = false;
    config.httpsProprio = false;
    config.trustProxy = '';
    assert.throws(() => config.validarProducao(), /TLS_CERT\/TLS_KEY|TRUST_PROXY/);

    // Com certificado próprio (rede local) passa.
    config.httpsProprio = true;
    assert.doesNotThrow(() => config.validarProducao());

    // Com proxy declarado (Caddy à frente) também.
    config.httpsProprio = false;
    config.trustProxy = '1';
    assert.doesNotThrow(() => config.validarProducao());

    // Segredo de exemplo continua barrando.
    config.segredoPadrao = true;
    assert.throws(() => config.validarProducao(), /SESSION_SECRET/);
  } finally {
    Object.assign(config, original);
  }
});

test('o segredo de sessão que vem no .env.example é tratado como inseguro', () => {
  const exemplo = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  const valor = (exemplo.match(/^SESSION_SECRET=(.*)$/m) || [])[1];

  assert.ok(valor, 'o .env.example precisa trazer uma linha SESSION_SECRET');
  assert.equal(
    config.segredoInseguro(valor),
    true,
    'copiar o .env.example sem trocar o segredo não pode passar pela validação de produção'
  );

  // Um valor de verdade (openssl rand -hex 32 dá 64 caracteres) passa.
  assert.equal(config.segredoInseguro('a'.repeat(64)), false);
  // Curto demais não passa, mesmo sendo próprio.
  assert.equal(config.segredoInseguro('senha-do-escritorio'), true);
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
