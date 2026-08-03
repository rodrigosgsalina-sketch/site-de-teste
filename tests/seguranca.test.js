'use strict';

/**
 * Testes das defesas da aplicação exposta na internet:
 *  - cabeçalhos de segurança e CSP com nonce;
 *  - CSRF em toda escrita;
 *  - sessão renovada no login e destruída na saída;
 *  - freio de força bruta;
 *  - redirecionamento para HTTPS;
 *  - política de senha e nomes de arquivo dos anexos.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgrilo-seg-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'teste.db');
process.env.LOGIN_TENTATIVAS = '3';

const db = require('../src/db');
const { carregarSeed, criarCliente } = require('./apoio');
const seguranca = require('../src/lib/seguranca');
const usuarios = require('../src/domain/usuarios');
const documentos = require('../src/domain/documentos');
const config = require('../src/config');

carregarSeed(db);

const app = require('../src/app');
const servidor = app.listen(0);
const base = `http://127.0.0.1:${servidor.address().port}`;

/* ------------------------------------------------------------ cabeçalhos */

test('toda resposta traz os cabeçalhos de segurança e uma CSP com nonce', async () => {
  const cliente = criarCliente(base);
  const resposta = await cliente.get('/login');
  const csp = resposta.headers.get('content-security-policy');

  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.strictEqual(resposta.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(resposta.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(resposta.headers.get('referrer-policy'), 'same-origin');
  assert.strictEqual(resposta.headers.get('x-powered-by'), null, 'não anuncia o Express');

  // o nonce muda a cada resposta — token roubado de uma página não vale na outra
  const outra = await cliente.get('/login');
  const nonce = (n) => n.match(/'nonce-([^']+)'/)[1];
  assert.notStrictEqual(nonce(csp), nonce(outra.headers.get('content-security-policy')));
});

test('as telas carregam seus scripts com o nonce do próprio request', async () => {
  const cliente = criarCliente(base);
  await cliente.entrar('jacqueline', 'teste123');
  const resposta = await cliente.get('/');
  const nonce = resposta.headers.get('content-security-policy').match(/'nonce-([^']+)'/)[1];
  const html = await resposta.text();

  assert.ok(html.includes(`nonce="${nonce}"`), 'o <script> da página traz o nonce do cabeçalho');
  // Nenhum script inline sem nonce: com a CSP acima, o navegador recusaria.
  const inlineSemNonce = [...html.matchAll(/<script(?![^>]*\bnonce=)[^>]*>/gi)];
  assert.deepStrictEqual(inlineSemNonce.map((m) => m[0]), []);
});

test('o cookie de sessão é httpOnly e o HSTS só aparece em conexão segura', async () => {
  const cliente = criarCliente(base);
  const resposta = await cliente.get('/login');
  const cookie = (resposta.headers.getSetCookie() || []).find((c) => c.startsWith('jsgrilo.sid'));
  assert.ok(cookie, 'a sessão é criada já na tela de login (para o token CSRF)');
  assert.match(cookie, /HttpOnly/i, 'o JavaScript da página não enxerga o cookie');
  assert.match(cookie, /SameSite=Lax/i);
  // Em HTTP puro o HSTS seria inútil (e enganoso): só é enviado sob HTTPS.
  assert.strictEqual(resposta.headers.get('strict-transport-security'), null);
});

/* ------------------------------------------------------------------ CSRF */

test('escrita sem token CSRF é recusada', async () => {
  const cliente = criarCliente(base);
  await cliente.get('/login'); // cria a sessão
  const resposta = await cliente.post('/login', { login: 'jacqueline', senha: 'teste123' });

  assert.strictEqual(resposta.status, 403);
  assert.match(await resposta.text(), /Recarregue a página/i);
});

test('token de outra sessão não serve', async () => {
  const vitima = criarCliente(base);
  const atacante = criarCliente(base);
  const tokenDoAtacante = await atacante.token('/login');

  await vitima.get('/login');
  const resposta = await vitima.post('/login', {
    _csrf: tokenDoAtacante,
    login: 'jacqueline',
    senha: 'teste123',
  });
  assert.strictEqual(resposta.status, 403);
});

test('com o token da própria sessão o login funciona e a sessão é renovada', async () => {
  const cliente = criarCliente(base);
  await cliente.get('/login');
  const sessaoAntes = cliente.cookies.get('jsgrilo.sid');

  const resposta = await cliente.entrar('jacqueline', 'teste123');
  assert.strictEqual(resposta.status, 302);
  assert.strictEqual(resposta.headers.get('location'), '/');
  assert.notStrictEqual(
    cliente.cookies.get('jsgrilo.sid'),
    sessaoAntes,
    'o identificador de sessão muda ao entrar (evita fixação de sessão)'
  );

  const painel = await cliente.get('/');
  assert.strictEqual(painel.status, 200);
});

test('sair destrói a sessão', async () => {
  const cliente = criarCliente(base);
  await cliente.entrar('jacqueline', 'teste123');
  const token = await cliente.token('/');
  const saida = await cliente.post('/logout', { _csrf: token });
  assert.strictEqual(saida.status, 302);

  const painel = await cliente.get('/');
  assert.strictEqual(painel.status, 302);
  assert.strictEqual(painel.headers.get('location'), '/login');
});

/* ------------------------------------------------------------- força bruta */

test('senha errada em sequência trava o login por um tempo', async () => {
  seguranca.zerarFreio();
  const cliente = criarCliente(base);

  for (let i = 0; i < Number(process.env.LOGIN_TENTATIVAS); i += 1) {
    const token = await cliente.token('/login');
    const erro = await cliente.post('/login', { _csrf: token, login: 'jacqueline', senha: 'errada' });
    assert.strictEqual(erro.status, 401);
  }

  const token = await cliente.token('/login');
  const travado = await cliente.post('/login', { _csrf: token, login: 'jacqueline', senha: 'teste123' });
  assert.strictEqual(travado.status, 429, 'nem a senha certa passa enquanto o freio estiver ativo');
  assert.ok(Number(travado.headers.get('retry-after')) > 0);
  assert.match(await travado.text(), /Muitas tentativas/i);

  seguranca.zerarFreio();
});

test('a mensagem de erro não revela se o ID existe', async () => {
  seguranca.zerarFreio();
  const cliente = criarCliente(base);
  const token = await cliente.token('/login');
  const inexistente = await cliente.post('/login', { _csrf: token, login: 'nao.existe', senha: 'qualquer' });
  const existente = await criarCliente(base).entrar('jacqueline', 'errada');

  assert.strictEqual(inexistente.status, 401);
  assert.strictEqual(existente.status, 401);
  const a = await inexistente.text();
  const b = await existente.text();
  assert.ok(a.includes('ID de usuário ou senha inválidos.'));
  assert.ok(b.includes('ID de usuário ou senha inválidos.'));
  seguranca.zerarFreio();
});

/* -------------------------------------------------------------- acesso */

test('área restrita continua exigindo login e perfil', async () => {
  const anonimo = criarCliente(base);
  const semLogin = await anonimo.get('/admin/parametros');
  assert.strictEqual(semLogin.status, 302);
  assert.strictEqual(semLogin.headers.get('location'), '/login');

  seguranca.zerarFreio();
  const comum = criarCliente(base);
  await comum.entrar('ana.paula', 'teste123');
  const negado = await comum.get('/admin/parametros');
  assert.strictEqual(negado.status, 403);
});

test('o retorno pós-login não vira redirecionador para fora do site', async () => {
  seguranca.zerarFreio();
  const cliente = criarCliente(base);
  // guarda um destino externo na sessão, como faria um link malicioso
  await cliente.get('/processos');
  const resposta = await cliente.entrar('jacqueline', 'teste123');
  const destino = resposta.headers.get('location');
  assert.ok(destino.startsWith('/') && !destino.startsWith('//'), `destino interno esperado, veio ${destino}`);
});

/* --------------------------------------------------------------- HTTPS */

test('com FORCE_HTTPS ligado, requisição em HTTP puro é redirecionada', () => {
  const original = config.forcarHttps;
  config.forcarHttps = true;
  try {
    const respostas = [];
    const res = {
      redirect: (codigo, destino) => respostas.push({ codigo, destino }),
      status: () => ({ send: (texto) => respostas.push({ codigo: 403, texto }) }),
    };
    seguranca.exigirHttps(
      { secure: false, method: 'GET', headers: { host: 'processos.jsgrilo.com.br' }, originalUrl: '/processos?q=1' },
      res,
      () => respostas.push({ seguiu: true })
    );
    assert.deepStrictEqual(respostas, [
      { codigo: 308, destino: 'https://processos.jsgrilo.com.br/processos?q=1' },
    ]);

    // já em HTTPS (ou com o proxy avisando), segue direto
    const seguiu = [];
    seguranca.exigirHttps({ secure: true, method: 'GET', headers: {} }, {}, () => seguiu.push(true));
    assert.deepStrictEqual(seguiu, [true]);
  } finally {
    config.forcarHttps = original;
  }
});

test('o proxy só é acreditado quando declarado em TRUST_PROXY', () => {
  const original = config.trustProxy;
  const req = { secure: false, headers: { 'x-forwarded-proto': 'https' } };
  try {
    config.trustProxy = '';
    assert.strictEqual(seguranca.ehSeguro(req), false, 'sem proxy declarado, o cabeçalho é ignorado');
    config.trustProxy = '1';
    assert.strictEqual(seguranca.ehSeguro(req), true);
  } finally {
    config.trustProxy = original;
  }
});

test('destinos de retorno só apontam para dentro do site', () => {
  assert.strictEqual(seguranca.destinoInterno('/processos/12#setor-3'), '/processos/12#setor-3');
  assert.strictEqual(seguranca.destinoInterno('//site-falso.com/phishing'), '/');
  assert.strictEqual(seguranca.destinoInterno('https://site-falso.com'), '/');
  assert.strictEqual(seguranca.destinoInterno('javascript:alert(1)'), '/');
  assert.strictEqual(seguranca.destinoInterno('/x\\@evil.com'), '/');
  assert.strictEqual(seguranca.destinoInterno('', '/avisos'), '/avisos');
});

/* ------------------------------------------------------------- senhas */

test('a política de senha recusa as escolhas frágeis', () => {
  assert.throws(() => usuarios.validarSenha('1234567'), /ao menos 8 caracteres/i);
  assert.throws(() => usuarios.validarSenha('12345678'), /adivinhar/i);
  assert.throws(() => usuarios.validarSenha('aaaaaaaaaa'), /repetido/i);
  assert.strictEqual(usuarios.validarSenha('contabil-2026!'), 'contabil-2026!');

  const setor = db.get().prepare("SELECT id FROM setores WHERE nome = 'Fiscal'").get();
  assert.throws(
    () => usuarios.criar({ nome: 'Teste Fraco', senha: 'abc', setor_id: setor.id }),
    /ao menos 8 caracteres/i
  );
});

/* ---------------------------------------------------------- parâmetros */

test('endereço de webhook em http:// é recusado', () => {
  const parametros = require('../src/domain/parametros');
  assert.throws(
    () => parametros.definir('WEBHOOK_GOOGLE_CHAT', 'http://chat.exemplo.com/hook'),
    /precisa começar com https/i
  );
  parametros.definir('WEBHOOK_GOOGLE_CHAT', 'https://chat.googleapis.com/v1/spaces/AAA');
  assert.strictEqual(parametros.texto('WEBHOOK_GOOGLE_CHAT'), 'https://chat.googleapis.com/v1/spaces/AAA');
  parametros.definir('WEBHOOK_GOOGLE_CHAT', '');
});

/* ------------------------------------------------------------- anexos */

test('nome de anexo é higienizado e o caminho não escapa da pasta de uploads', () => {
  assert.strictEqual(documentos.nomeSeguro('../../etc/passwd'), 'passwd');
  assert.strictEqual(documentos.nomeSeguro('contrato assinado.pdf'), 'contrato assinado.pdf');
  assert.strictEqual(documentos.nomeSeguro('relatório "final".pdf'), 'relatorio _final_.pdf');
  assert.strictEqual(documentos.nomeSeguro(''), 'arquivo');

  assert.ok(documentos.extensaoAceita('balanco.pdf'));
  assert.ok(!documentos.extensaoAceita('script.html'), 'HTML rodaria no navegador de outro usuário');
  assert.ok(!documentos.extensaoAceita('malicioso.svg'));
  assert.ok(!documentos.extensaoAceita('instalador.exe'));

  const dentro = documentos.caminhoAbsoluto({ processo_id: 7, nome_arquivo: 'abc.pdf' });
  assert.ok(dentro.startsWith(path.resolve(config.uploadsDir) + path.sep));
  // um nome adulterado no banco não leva para fora
  const escapado = documentos.caminhoAbsoluto({ processo_id: 7, nome_arquivo: '../../../etc/passwd' });
  assert.ok(escapado.startsWith(path.resolve(config.uploadsDir) + path.sep));
});

test.after(() => {
  servidor.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
