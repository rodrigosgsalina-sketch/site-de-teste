'use strict';

/**
 * Ver todos os processos, agir só nos seus — e quem já viu cada aviso.
 *
 * Três regras andam juntas aqui:
 *  - qualquer usuário abre qualquer processo que exista;
 *  - quem não tem setor no checklist fica de leitura: nada de responder item,
 *    anexar documento ou mexer no status;
 *  - o administrador consegue ver quem marcou cada aviso como visto.
 *
 * O que estes testes guardam é a fronteira: abrir a visão não pode ter aberto
 * junto a porta da escrita.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgrilo-vis-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'teste.db');

const db = require('../src/db');
const { carregarSeed, criarCliente } = require('./apoio');
const acesso = require('../src/domain/acesso');
const avisos = require('../src/domain/avisos');
const checklist = require('../src/domain/checklist');
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

const admin = usuario('jacqueline'); // Diretoria / Administrador
const fiscal = usuario('ana.paula'); // Fiscal — participa da Emissão de Certidões
const pessoal = usuario('samuel'); // Departamento Pessoal — fica de fora dela
const tipoCertidoes = conn.prepare("SELECT id FROM tipos_processo WHERE nome = 'Emissão de Certidões'").get();

const cliente = clientesDom.criar(
  { codigo: '77', nome: 'Empresa Visível', razao_social: 'EMPRESA VISIVEL LTDA' },
  admin
);

function novoProcesso() {
  return processosDom.criar({ tipo_processo_id: tipoCertidoes.id, cliente_id: cliente.id }, admin);
}

async function entrar(login) {
  const http = criarCliente(base);
  const resposta = await http.entrar(login, 'teste123');
  assert.strictEqual(resposta.status, 302, `login de ${login} falhou`);
  return http;
}

test.after(() => servidor.close());

/* ------------------------------------------------------ ver todo mundo vê */

test('o setor de fora do checklist não participa, mas enxerga o processo', () => {
  const processo = novoProcesso();
  const setores = checklist.setoresDoProcesso(processo.id).map((s) => s.nome || s);
  assert.ok(!setores.includes('Departamento Pessoal'), 'o teste precisa de um setor fora do checklist');

  assert.strictEqual(acesso.participaDoProcesso(fiscal, processo.id), true);
  assert.strictEqual(acesso.participaDoProcesso(pessoal, processo.id), false);
  // Gestor participa de tudo, como sempre.
  assert.strictEqual(acesso.participaDoProcesso(admin, processo.id), true);
});

test('a tela do processo abre para quem não participa, marcada como leitura', async () => {
  const processo = novoProcesso();
  const http = await entrar('samuel');
  const resposta = await http.get(`/processos/${processo.id}`);
  const html = await resposta.text();

  assert.strictEqual(resposta.status, 200, 'processo de outro setor precisa abrir');
  assert.match(html, new RegExp(processo.codigo));
  assert.match(html, /Somente leitura/i);
  assert.ok(!/name="arquivo"/.test(html), 'sem formulário de anexo para quem só lê');
  assert.ok(!/\/concluir"/.test(html), 'sem botão de concluir para quem só lê');
  assert.ok(!/\/status"/.test(html), 'sem alteração de status para quem só lê');
});

test('a listagem mostra o escritório inteiro; o filtro "meu setor" recorta', async () => {
  const processo = novoProcesso();
  const http = await entrar('samuel');

  const todos = await (await http.get('/processos')).text();
  assert.match(todos, new RegExp(processo.codigo), 'processo de outro setor precisa aparecer na lista');

  const meus = await (await http.get('/processos?meu_setor=1')).text();
  assert.ok(!new RegExp(processo.codigo).test(meus), 'com o filtro ligado, some o que não é do setor');
});

test('processo excluído não existe para ninguém', async () => {
  const processo = novoProcesso();
  processosDom.remover(processo.id, admin, 'teste de visibilidade');

  const http = await entrar('samuel');
  assert.strictEqual((await http.get(`/processos/${processo.id}`)).status, 404);
  const comoAdmin = await entrar('jacqueline');
  assert.strictEqual((await comoAdmin.get(`/processos/${processo.id}`)).status, 404);
});

/* -------------------------------------------------- agir, só quem participa */

test('quem só lê é recusado no status, na conclusão e no anexo', async () => {
  const processo = novoProcesso();
  const http = await entrar('samuel');
  const token = await http.token(`/processos/${processo.id}`);

  const status = await http.post(`/processos/${processo.id}/status`, {
    _csrf: token,
    status: 'Aguardando Cliente',
  });
  assert.strictEqual(status.status, 403);
  assert.match(await status.text(), /Somente leitura/i);
  assert.notStrictEqual(processosDom.obter(processo.id).status, 'Aguardando Cliente');

  const concluir = await http.post(`/processos/${processo.id}/concluir`, { _csrf: token });
  assert.strictEqual(concluir.status, 403);
  assert.ok(!processosDom.obter(processo.id).status_final, 'o processo não pode ter sido concluído');

  const anexo = await http.post(`/processos/${processo.id}/documentos`, { _csrf: token });
  assert.strictEqual(anexo.status, 403);

  // E o item do checklist continua barrado pelo setor, como antes.
  const item = checklist.doProcesso(processo.id)[0];
  const resposta = await http.post(`/checklist/${item.id}/responder`, { _csrf: token, resposta: 'Sim' });
  assert.strictEqual(resposta.status, 403);
});

test('quem participa continua agindo normalmente', async () => {
  const processo = novoProcesso();
  const http = await entrar('ana.paula'); // Fiscal, presente no checklist
  const token = await http.token(`/processos/${processo.id}`);

  const status = await http.post(`/processos/${processo.id}/status`, {
    _csrf: token,
    status: 'Aguardando Cliente',
  });
  assert.strictEqual(status.status, 302);
  assert.strictEqual(processosDom.obter(processo.id).status, 'Aguardando Cliente');
});

/* --------------------------------------------------------- quem já viu */

test('o aviso sabe quem já viu e quem ainda não', () => {
  const processo = novoProcesso();
  const avisoId = avisos.processoConcluido(processo, admin);

  const antes = avisos.leitores(avisoId);
  assert.ok(antes.total >= 2, 'o público do aviso é o quadro ativo');
  assert.strictEqual(antes.vistos, 0);
  assert.ok(antes.naoViram.some((p) => p.nome === pessoal.nome));

  avisos.marcarLido(avisoId, pessoal.id);

  const depois = avisos.leitores(avisoId);
  assert.strictEqual(depois.vistos, 1);
  assert.strictEqual(depois.total, antes.total, 'marcar como visto não muda o tamanho do público');
  const marcou = depois.viram.find((p) => p.nome === pessoal.nome);
  assert.ok(marcou, 'quem marcou precisa aparecer pelo nome');
  assert.strictEqual(marcou.setor, 'Departamento Pessoal');
  assert.ok(marcou.lido_em, 'com a hora em que viu');
  assert.ok(!depois.naoViram.some((p) => p.nome === pessoal.nome));
});

test('a leitura de vários avisos sai de uma vez só', () => {
  const processo = novoProcesso();
  const um = avisos.processoConcluido(processo, admin);
  const dois = avisos.processoImpedido(processo, null, admin);
  avisos.marcarLido(dois, fiscal.id);

  const mapa = avisos.leituraDeVarios([um, dois, 999999]);
  assert.strictEqual(mapa.get(um).vistos, 0);
  assert.strictEqual(mapa.get(dois).vistos, 1);
  assert.strictEqual(mapa.get(dois).viram[0].nome, fiscal.nome);
  assert.strictEqual(mapa.get(999999).total, 0, 'aviso inexistente não quebra a montagem');
  assert.strictEqual(avisos.leituraDeVarios([]).size, 0);
});

test('a vez do setor conta só o setor chamado como público', () => {
  const processo = novoProcesso();
  const avisoId = avisos.vezDoSetor(processo, 'Fiscal');
  const leitura = avisos.leitores(avisoId);

  assert.ok(leitura.total > 0);
  assert.ok(
    [...leitura.viram, ...leitura.naoViram].every((p) => p.setor === 'Fiscal'),
    'um chamado endereçado não cobra leitura de quem não foi chamado'
  );
});

test('"quem já viu" é do administrador — o usuário comum não vê a coluna', async () => {
  const processo = novoProcesso();
  avisos.processoConcluido(processo, admin);

  const comum = await entrar('samuel');
  const muralComum = await (await comum.get('/avisos')).text();
  assert.ok(!/Quem já viu/.test(muralComum), 'usuário comum não recebe a coluna');
  assert.ok(!/visto por/.test(muralComum));

  const gestor = await entrar('jacqueline');
  const muralAdmin = await (await gestor.get('/avisos')).text();
  assert.match(muralAdmin, /Quem já viu/);
  assert.match(muralAdmin, /visto por \d+ de \d+/);

  // E na tela do processo, o mesmo quadro para os avisos daquele processo.
  const tela = await (await gestor.get(`/processos/${processo.id}`)).text();
  assert.match(tela, /Avisos deste processo/);
  assert.match(tela, /visto por \d+ de \d+/);

  const telaComum = await (await comum.get(`/processos/${processo.id}`)).text();
  assert.ok(!/Avisos deste processo/.test(telaComum));
});
