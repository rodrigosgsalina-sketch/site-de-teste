'use strict';

/**
 * Testes do que foi otimizado — cada um guarda uma regressão concreta que já
 * aconteceu ou que custaria caro se voltasse:
 *
 *  - a tela de abrir processo não pode voltar a despejar o cadastro inteiro no
 *    HTML (eram 676 KB por carregamento, com 945 empresas);
 *  - a busca de cliente precisa manter as regras de antes (acento, caixa, CNPJ
 *    com ou sem pontuação, código exato, várias palavras);
 *  - as respostas de texto viajam comprimidas, e o canal de avisos NÃO — se ele
 *    for comprimido, os avisos ficam presos no buffer;
 *  - o estado inicial do canal vai só para quem acabou de conectar, não para
 *    todas as abas do usuário.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const zlib = require('zlib');

process.env.NODE_ENV = 'test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgrilo-perf-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'teste.db');

const db = require('../src/db');
const { carregarSeed, criarCliente } = require('./apoio');
const clientesDom = require('../src/domain/clientes');
const eventos = require('../src/lib/eventos');

const conn = carregarSeed(db);
const app = require('../src/app');
const servidor = app.listen(0);
const porta = servidor.address().port;
const base = `http://127.0.0.1:${porta}`;

const admin = conn.prepare("SELECT * FROM usuarios WHERE login = 'jacqueline'").get();

/* Um cadastro grande o bastante para a diferença aparecer. */
const QUANTAS = 400;
for (let i = 1; i <= QUANTAS; i += 1) {
  clientesDom.criar(
    {
      codigo: String(i),
      nome: `EMPRESA ${i}`,
      razao_social: `EMPRESA ${i} LTDA`,
      cnpj_cpf: `${String(10000000 + i).padStart(8, '0')}/0001-${String(i % 100).padStart(2, '0')}`,
      municipio: i % 2 ? 'Goianinha' : 'São José',
      uf: 'RN',
    },
    admin
  );
}
clientesDom.criar(
  { codigo: '9001', nome: 'PADARIA PAO QUENTE', razao_social: 'PADARIA PÃO QUENTE LTDA', cnpj_cpf: '12.345.678/0001-99', municipio: 'Natal', uf: 'RN' },
  admin
);

async function autenticado() {
  const cliente = criarCliente(base);
  await cliente.entrar('jacqueline', 'teste123');
  return cliente;
}

/* ------------------------------------------------- peso da tela de abertura */

test('a tela de abrir processo não carrega o cadastro inteiro no HTML', async () => {
  const cliente = await autenticado();
  const html = await (await cliente.get('/processos/novo')).text();

  const opcoes = (html.match(/<option/g) || []).length;
  assert.ok(
    opcoes < 100,
    `a tela trouxe ${opcoes} <option> — o cadastro voltou para dentro do HTML (são ${QUANTAS + 1} empresas)`
  );
  assert.ok(!html.includes('EMPRESA 200'), 'nenhuma empresa deve vir listada antes de o usuário procurar');
  assert.ok(html.includes('data-busca-cliente'), 'o campo de busca precisa continuar na tela');
  assert.ok(html.includes('name="cliente_id"'), 'o campo enviado no formulário continua sendo cliente_id');
});

test('a empresa já escolhida vem pronta na edição, sem depender da busca', async () => {
  const cliente = await autenticado();
  const alvo = clientesDom.porCodigo('9001');
  const token = await cliente.token('/processos/novo');
  const tipo = conn.prepare('SELECT id FROM tipos_processo LIMIT 1').get();

  const criado = await cliente.post('/processos', {
    _csrf: token,
    cliente_id: String(alvo.id),
    tipo_processo_id: String(tipo.id),
    data_abertura: '2026-01-10',
  });
  assert.equal(criado.status, 302);

  const html = await (await cliente.get(`${criado.headers.get('location')}/editar`)).text();
  assert.match(html, /PADARIA PÃO QUENTE LTDA/, 'a empresa do processo aparece já selecionada');
  assert.match(html, /selected/, 'a opção vem marcada');
});

/* -------------------------------------------------------- busca de cliente */

test('a busca de cliente mantém as regras de antes', async () => {
  const cliente = await autenticado();

  async function buscar(termo) {
    const resposta = await cliente.get(`/clientes/buscar?q=${encodeURIComponent(termo)}`, {
      headers: { accept: 'application/json' },
    });
    assert.equal(resposta.status, 200);
    return resposta.json();
  }

  // acento e caixa não atrapalham
  const semAcento = await buscar('padaria pao quente');
  assert.equal(semAcento.itens[0].titulo, 'PADARIA PÃO QUENTE LTDA');
  const comAcento = await buscar('PÃO');
  assert.equal(comAcento.itens[0].titulo, 'PADARIA PÃO QUENTE LTDA');

  // CNPJ com e sem pontuação
  const pontuado = await buscar('12.345.678/0001-99');
  assert.equal(pontuado.itens[0].titulo, 'PADARIA PÃO QUENTE LTDA');
  const cru = await buscar('12345678000199');
  assert.equal(cru.itens[0].titulo, 'PADARIA PÃO QUENTE LTDA');

  // código exato
  const porCodigo = await buscar('9001');
  assert.equal(porCodigo.itens[0].codigo, '9001');

  // várias palavras, em qualquer ordem
  const soltas = await buscar('quente padaria');
  assert.equal(soltas.itens[0].titulo, 'PADARIA PÃO QUENTE LTDA');

  // município
  const cidade = await buscar('Natal');
  assert.ok(cidade.itens.some((c) => c.titulo === 'PADARIA PÃO QUENTE LTDA'));

  // nada encontrado
  const nenhum = await buscar('zzzz-nao-existe');
  assert.equal(nenhum.total, 0);
  assert.deepEqual(nenhum.itens, []);
});

test('a busca devolve poucos registros e avisa quando há mais', async () => {
  const cliente = await autenticado();
  const resposta = await cliente.get('/clientes/buscar?q=EMPRESA', { headers: { accept: 'application/json' } });
  const dados = await resposta.json();

  assert.ok(dados.total > 100, 'o termo casa com muitas empresas');
  assert.ok(dados.itens.length <= 20, `vieram ${dados.itens.length} itens — a resposta precisa ser enxuta`);
  assert.equal(dados.parcial, true, 'a tela precisa saber que a lista foi cortada');

  // Só os campos que o seletor usa — nada do resto da ficha.
  const chaves = Object.keys(dados.itens[0]).sort();
  assert.deepEqual(chaves, [
    'apelido', 'cnpj', 'codigo', 'email', 'id', 'local', 'responsavel', 'situacao', 'telefone', 'titulo',
  ]);
});

test('consultar o cadastro pela busca é liberado a quem não é administrador', async () => {
  const cliente = criarCliente(base);
  await cliente.entrar('daiane', 'teste123');
  const resposta = await cliente.get('/clientes/buscar?q=padaria', { headers: { accept: 'application/json' } });
  assert.equal(resposta.status, 200);
});

/* ------------------------------------------------------------- compressão */

/** Pedido cru, para ver o corpo exatamente como ele chega. */
function pedirCru(caminho, cabecalhos) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: porta, path: caminho, headers: cabecalhos }, (res) => {
      const partes = [];
      res.on('data', (p) => partes.push(p));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo: Buffer.concat(partes) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('as telas viajam comprimidas para quem aceita gzip', async () => {
  const semGzip = await pedirCru('/login', {});
  const comGzip = await pedirCru('/login', { 'accept-encoding': 'gzip' });

  assert.equal(semGzip.headers['content-encoding'], undefined, 'quem não pede gzip recebe texto puro');
  assert.equal(comGzip.headers['content-encoding'], 'gzip');
  assert.match(String(comGzip.headers.vary || ''), /accept-encoding/i, 'sem Vary, um cache entrega errado');

  // O corpo não é byte a byte igual — cada carregamento traz um token CSRF e um
  // nonce de CSP próprios. O que importa é que descomprima em HTML íntegro.
  const descomprimido = zlib.gunzipSync(comGzip.corpo).toString('utf8');
  assert.match(descomprimido, /<\/html>\s*$/, 'o HTML precisa chegar inteiro depois de descomprimir');
  assert.match(descomprimido, /name="_csrf"/, 'a tela de login continua completa');
  assert.ok(
    comGzip.corpo.length < semGzip.corpo.length,
    `comprimido (${comGzip.corpo.length} B) deveria ser menor que o original (${semGzip.corpo.length} B)`
  );
});

test('arquivo grande comprimido chega inteiro (e chega ao fim)', async () => {
  // O Chart.js tem 208 KB e é servido em fluxo. Sem repassar a contrapressão
  // do compressor, a resposta parava no meio e a tela do dashboard ficava
  // carregando para sempre. Este teste falha por tempo esgotado se voltar.
  const caminho = path.join(__dirname, '..', 'src', 'public', 'vendor', 'chart.umd.js');
  if (!fs.existsSync(caminho)) return; // o vendor só existe depois do npm install

  const original = fs.readFileSync(caminho);
  const resposta = await pedirCru('/static/vendor/chart.umd.js', { 'accept-encoding': 'gzip' });

  assert.equal(resposta.status, 200);
  assert.equal(resposta.headers['content-encoding'], 'gzip');
  assert.ok(resposta.corpo.length < original.length, 'o arquivo deveria viajar comprimido');

  const devolta = zlib.gunzipSync(resposta.corpo);
  assert.equal(devolta.length, original.length, 'o arquivo chegou cortado');
  assert.ok(Buffer.compare(devolta, original) === 0, 'o arquivo chegou corrompido');
});

test('o que já nasce comprimido passa intacto', async () => {
  const fonte = await pedirCru('/static/fonts/manrope-latin-wght-normal.woff2', { 'accept-encoding': 'gzip' });
  if (fonte.status !== 200) return; // fonte ausente em instalação mínima
  assert.equal(fonte.headers['content-encoding'], undefined, 'passar gzip por cima de woff2 só gasta processador');
  assert.match(String(fonte.headers['cache-control'] || ''), /immutable/, 'fonte tem nome fixo: pode ficar em cache');
});

test('o canal de avisos NUNCA é comprimido', async () => {
  const cliente = await autenticado();
  const cookie = [...cliente.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  const recebido = await new Promise((resolve, reject) => {
    const req = http.request(
      { port: porta, path: '/eventos?desde=0', headers: { cookie, accept: 'text/event-stream', 'accept-encoding': 'gzip' } },
      (res) => {
        let texto = '';
        res.on('data', (p) => {
          texto += p.toString('utf8');
          if (texto.includes('event: conectado')) {
            req.destroy();
            resolve({ headers: res.headers, texto });
          }
        });
        setTimeout(() => {
          req.destroy();
          resolve({ headers: res.headers, texto });
        }, 3000);
      }
    );
    req.on('error', (err) => (err.code === 'ECONNRESET' ? undefined : reject(err)));
    req.end();
  });

  assert.equal(recebido.headers['content-encoding'], undefined, 'gzip no SSE seguraria os avisos no buffer');
  assert.match(recebido.headers['content-type'], /text\/event-stream/);
  assert.match(recebido.texto, /event: conectado/, 'o primeiro quadro chega legível e na hora');
  eventos.encerrarTodas();
});

/* ------------------------------------------- estado inicial por conexão */

test('o estado inicial vai só para a conexão que acabou de abrir', () => {
  const escritos = [[], []];
  const conexoes = escritos.map((destino) => ({
    writeHead() {},
    flushHeaders() {},
    write(texto) {
      destino.push(texto);
      return true;
    },
    end() {},
  }));

  const req = { on() {} };
  eventos.assinar(999, req, conexoes[0]);
  eventos.assinar(999, req, conexoes[1]);
  escritos.forEach((d) => (d.length = 0));

  eventos.enviarNesta(conexoes[0], 'conectado', { oi: 1 });
  assert.equal(escritos[0].length, 1, 'a conexão que conectou recebe');
  assert.equal(escritos[1].length, 0, 'a outra aba do mesmo usuário não é incomodada');

  // Um aviso de verdade continua indo para todas as abas.
  eventos.enviarPara(999, 'aviso', { id: 1 }, 1);
  assert.equal(escritos[0].length, 2);
  assert.equal(escritos[1].length, 1);

  eventos.encerrarTodas();
});

/* ------------------------------------------ uma conexão por aba, no limite */

test('o servidor não deixa um usuário acumular canais sem fim', () => {
  const req = { on() {} };
  const feitas = [];
  for (let i = 0; i < 10; i += 1) {
    const res = { writeHead() {}, flushHeaders() {}, write() { return true; }, end() { this.fechada = true; } };
    feitas.push(res);
    eventos.assinar(1234, req, res);
  }
  assert.ok(eventos.contar() <= 4, `sobraram ${eventos.contar()} canais para o mesmo usuário`);
  assert.ok(feitas[0].fechada, 'a conexão mais antiga é encerrada, não abandonada');
  eventos.encerrarTodas();
});

test.after(() => {
  eventos.encerrarTodas();
  servidor.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
