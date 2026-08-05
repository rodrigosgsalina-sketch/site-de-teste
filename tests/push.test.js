'use strict';

/**
 * Testes do Web Push e da reposição de avisos:
 *  - criptografia aes128gcm (RFC 8291) e JWT VAPID (RFC 8292);
 *  - inscrição do navegador, envio e limpeza de inscrição morta;
 *  - reposição do que passou enquanto a tela estava fora do ar.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgrilo-push-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'teste.db');

const webpush = require('../src/lib/webpush');
const chavesVapid = webpush.gerarChaves();
process.env.VAPID_PUBLIC_KEY = chavesVapid.publica;
process.env.VAPID_PRIVATE_KEY = chavesVapid.privada;
process.env.VAPID_SUBJECT = 'mailto:teste@jsgrilo.com.br';

const db = require('../src/db');
const { carregarSeed, criarCliente } = require('./apoio');
const config = require('../src/config');
const pushDom = require('../src/domain/push');
const avisos = require('../src/domain/avisos');
const eventos = require('../src/lib/eventos');
const clientesDom = require('../src/domain/clientes');
const processosDom = require('../src/domain/processos');

const conn = carregarSeed(db);
const app = require('../src/app');
const servidor = app.listen(0);
const base = `http://127.0.0.1:${servidor.address().port}`;

function usuario(login) {
  return conn
    .prepare('SELECT u.*, s.nome AS setor FROM usuarios u JOIN setores s ON s.id = u.setor_id WHERE u.login = ?')
    .get(login);
}
const admin = usuario('jacqueline');
const fiscal = usuario('ana.paula');
const tipo = conn.prepare("SELECT id FROM tipos_processo WHERE nome = 'Emissão de Certidões'").get();
const cliente = clientesDom.criar({ codigo: '20', nome: 'Empresa Push', razao_social: 'EMPRESA PUSH LTDA' }, admin);

/** Simula o par de chaves que um navegador gera ao se inscrever. */
function navegadorFicticio() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    privada: ecdh.getPrivateKey(),
    p256dh: webpush.paraBase64Url(ecdh.getPublicKey()),
    auth: webpush.paraBase64Url(crypto.randomBytes(16)),
  };
}

/* --------------------------------------------------------------- criptografia */

test('a mensagem sai cifrada para a chave do navegador e só ele consegue abrir', () => {
  const navegador = navegadorFicticio();
  const texto = JSON.stringify({ titulo: 'Processo PR-2026-0001 impedido', mensagem: 'Faltou a certidão.' });

  const corpo = webpush.criptografar(texto, navegador.p256dh, navegador.auth);

  // Cabeçalho do aes128gcm: salt(16) + tamanho do registro(4) + chave(1+65).
  assert.strictEqual(corpo[20], 65, 'a chave efêmera do servidor viaja no cabeçalho');
  assert.ok(corpo.length > 86 + texto.length, 'o corpo carrega cabeçalho e etiqueta de autenticação');
  assert.ok(!corpo.toString('utf8').includes('impedido'), 'o texto não trafega em claro');

  const aberto = webpush.descriptografar(corpo, navegador.privada, navegador.auth);
  assert.strictEqual(aberto, texto);

  // A chave de outro navegador não abre a mensagem.
  const intruso = navegadorFicticio();
  assert.throws(() => webpush.descriptografar(corpo, intruso.privada, navegador.auth));
});

test('o JWT do VAPID é assinado e verificável com a chave pública anunciada', () => {
  const jwt = webpush.jwtVapid('https://fcm.googleapis.com', {
    publica: chavesVapid.publica,
    privada: chavesVapid.privada,
    contato: 'mailto:teste@jsgrilo.com.br',
  });

  const [cabecalho, corpo, assinatura] = jwt.split('.');
  const meta = JSON.parse(webpush.deBase64Url(cabecalho).toString());
  const dados = JSON.parse(webpush.deBase64Url(corpo).toString());

  assert.strictEqual(meta.alg, 'ES256');
  assert.strictEqual(dados.aud, 'https://fcm.googleapis.com');
  assert.strictEqual(dados.sub, 'mailto:teste@jsgrilo.com.br');
  assert.ok(dados.exp > Math.floor(Date.now() / 1000), 'o token não nasce vencido');

  const publica = webpush.deBase64Url(chavesVapid.publica);
  const chave = crypto.createPublicKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: webpush.paraBase64Url(publica.subarray(1, 33)),
      y: webpush.paraBase64Url(publica.subarray(33, 65)),
    },
  });
  const confere = crypto.verify(
    'sha256',
    Buffer.from(`${cabecalho}.${corpo}`),
    { key: chave, dsaEncoding: 'ieee-p1363' },
    webpush.deBase64Url(assinatura)
  );
  assert.ok(confere, 'a assinatura fecha com a chave pública enviada ao navegador');
});

/* ------------------------------------------------------------------ inscrição */

test('o navegador se inscreve, reinscreve sem duplicar e cancela', async () => {
  const navegador = navegadorFicticio();
  const inscricao = {
    endpoint: 'https://push.exemplo.com/abc123',
    keys: { p256dh: navegador.p256dh, auth: navegador.auth },
  };

  const cliente1 = criarCliente(base);
  await cliente1.entrar('ana.paula', 'teste123');
  const token = await cliente1.token('/');

  const chave = await (await cliente1.get('/push/chave', { headers: { accept: 'application/json' } })).json();
  assert.strictEqual(chave.habilitado, true);
  assert.strictEqual(chave.chavePublica, chavesVapid.publica);

  const resposta = await cliente1.pedir('/push/inscrever', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token },
    body: JSON.stringify({ inscricao }),
  });
  assert.strictEqual(resposta.status, 201);
  assert.strictEqual(pushDom.doUsuario(fiscal.id).length, 1);

  // Mesma inscrição de novo não duplica (o endpoint é único).
  await cliente1.pedir('/push/inscrever', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token },
    body: JSON.stringify({ inscricao }),
  });
  assert.strictEqual(pushDom.doUsuario(fiscal.id).length, 1);

  // Inscrição sem as chaves do navegador é recusada.
  const invalida = await cliente1.pedir('/push/inscrever', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token },
    body: JSON.stringify({ inscricao: { endpoint: 'https://push.exemplo.com/x' } }),
  });
  assert.strictEqual(invalida.status, 400);

  const cancelou = await cliente1.pedir('/push/cancelar', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token },
    body: JSON.stringify({ endpoint: inscricao.endpoint }),
  });
  assert.strictEqual(cancelou.status, 200);
  assert.strictEqual(pushDom.doUsuario(fiscal.id).length, 0);
});

test('inscrever exige login e token CSRF', async () => {
  // Visitante com token válido da própria sessão, mas sem ter entrado.
  const anonimo = criarCliente(base);
  const tokenAnonimo = await anonimo.token('/login');
  const semLogin = await anonimo.pedir('/push/inscrever', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-csrf-token': tokenAnonimo,
    },
    body: '{}',
  });
  assert.strictEqual(semLogin.status, 401, 'sem login não se inscreve ninguém');

  // Sem token, a barreira de CSRF barra antes mesmo de olhar a sessão.
  const semNada = await anonimo.pedir('/push/inscrever', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.strictEqual(semNada.status, 403);

  const logado = criarCliente(base);
  await logado.entrar('ana.paula', 'teste123');
  const semToken = await logado.pedir('/push/inscrever', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.strictEqual(semToken.status, 403);
});

/* ---------------------------------------------------------------- entrega */

test('o aviso é entregue às inscrições e a inscrição morta é apagada', async () => {
  const vivo = navegadorFicticio();
  const morto = navegadorFicticio();
  pushDom.registrarInscricao(fiscal.id, {
    endpoint: 'https://push.exemplo.com/vivo',
    keys: { p256dh: vivo.p256dh, auth: vivo.auth },
  }, 'Chrome de teste');
  pushDom.registrarInscricao(fiscal.id, {
    endpoint: 'https://push.exemplo.com/morto',
    keys: { p256dh: morto.p256dh, auth: morto.auth },
  }, 'Chrome de teste');
  assert.strictEqual(pushDom.doUsuario(fiscal.id).length, 2);

  // Substitui a ida à rede: registra o que sairia e simula as respostas.
  const enviados = [];
  const fetchOriginal = global.fetch;
  global.fetch = async (url, opcoes) => {
    enviados.push({ url, opcoes });
    if (String(url).endsWith('/morto')) return new Response('', { status: 410 });
    return new Response('', { status: 201 });
  };

  try {
    const resultado = await pushDom.enviarPara([fiscal.id], {
      id: 99,
      titulo: 'Processo PR-2026-0099 concluído',
      mensagem: 'Tudo certo.',
      url: '/processos/99',
    });

    assert.strictEqual(resultado.enviados, 1);
    assert.strictEqual(resultado.removidos, 1, 'o 410 apaga a inscrição que não existe mais');
    assert.strictEqual(pushDom.doUsuario(fiscal.id).length, 1);

    const chamada = enviados.find((e) => String(e.url).endsWith('/vivo'));
    assert.strictEqual(chamada.opcoes.headers['Content-Encoding'], 'aes128gcm');
    assert.match(chamada.opcoes.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    assert.ok(Buffer.isBuffer(chamada.opcoes.body));

    // O que o navegador receberia é exatamente o aviso.
    const aberto = JSON.parse(webpush.descriptografar(chamada.opcoes.body, vivo.privada, vivo.auth));
    assert.strictEqual(aberto.titulo, 'Processo PR-2026-0099 concluído');
    assert.strictEqual(aberto.url, '/processos/99');
  } finally {
    global.fetch = fetchOriginal;
  }
});

test('sem chaves VAPID a plataforma não fala com serviço de push nenhum', async () => {
  const originais = { ...config.vapid };
  config.vapid.publica = '';
  config.vapid.privada = '';
  const fetchOriginal = global.fetch;
  let tentativas = 0;
  global.fetch = async () => {
    tentativas += 1;
    return new Response('', { status: 201 });
  };

  try {
    assert.strictEqual(pushDom.habilitado(), false);
    assert.strictEqual(pushDom.chavePublica(), null);
    const resultado = await pushDom.enviarPara([fiscal.id], { id: 1, titulo: 'x', mensagem: 'y' });
    assert.strictEqual(resultado.desligado, true);
    assert.strictEqual(tentativas, 0, 'nenhuma requisição sai para fora');
  } finally {
    global.fetch = fetchOriginal;
    Object.assign(config.vapid, originais);
  }
});

/* -------------------------------------------------------------- reposição */

test('o que aconteceu enquanto a tela trocava de página é reposto na reconexão', async () => {
  const processo = processosDom.criar({ tipo_processo_id: tipo.id, cliente_id: cliente.id }, admin);
  const antes = avisos.contarNaoLidos(fiscal.id);

  // Nenhuma aba aberta: ninguém recebe pelo canal neste instante.
  const idAviso = avisos.processoConcluido(processo, admin);
  assert.strictEqual(avisos.contarNaoLidos(fiscal.id), antes + 1);

  const pendentes = avisos.pendentesDesde(fiscal.id, idAviso - 1);
  assert.ok(pendentes.some((a) => a.id === idAviso), 'o aviso perdido fica na fila de reposição');

  // Já visto: não volta.
  assert.ok(!avisos.pendentesDesde(fiscal.id, idAviso).some((a) => a.id === idAviso));

  // Lido: também não volta.
  avisos.marcarLido(idAviso, fiscal.id);
  assert.ok(!avisos.pendentesDesde(fiscal.id, idAviso - 1).some((a) => a.id === idAviso));
});

test('ao abrir o canal informando o último aviso visto, o servidor repõe o intervalo', async () => {
  const navegador = criarCliente(base);
  await navegador.entrar('ana.paula', 'teste123');
  const cookie = `jsgrilo.sid=${navegador.cookies.get('jsgrilo.sid')}`;

  const processo = processosDom.criar({ tipo_processo_id: tipo.id, cliente_id: cliente.id }, admin);
  const idAviso = avisos.processoConcluido(processo, admin); // publicado sem ninguém conectado

  const controle = new AbortController();
  const resposta = await fetch(`${base}/eventos?desde=${idAviso - 1}`, {
    headers: { cookie, accept: 'text/event-stream' },
    signal: controle.signal,
  });

  const leitor = resposta.body.getReader();
  const decodificador = new TextDecoder();
  let texto = '';
  try {
    const limite = Date.now() + 4000;
    while (Date.now() < limite && !texto.includes('event: aviso')) {
      const pedaco = await leitor.read();
      if (pedaco.done) break;
      texto += decodificador.decode(pedaco.value, { stream: true });
    }
  } finally {
    controle.abort();
  }

  assert.match(texto, /event: conectado/);
  assert.match(texto, /event: aviso/);
  const linhaDados = texto.split('\n').find((l) => l.startsWith('data: ') && l.includes('"atrasado":true'));
  assert.ok(linhaDados, 'o aviso reposto vem marcado como atrasado');
  assert.ok(JSON.parse(linhaDados.slice(6)).id === idAviso);
});

test.after(() => {
  eventos.encerrarTodas();
  servidor.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
