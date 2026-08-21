'use strict';

/**
 * Um usuário, vários setores.
 *
 * No escritório é comum acumular — quem é do Fiscal também responde pelo
 * Paralegal. O que estes testes guardam: quem acumula responde nos dois, é
 * chamado pelos dois, e ninguém fica sem setor nenhum por engano.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgrilo-setores-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'teste.db');

const db = require('../src/db');
const { carregarSeed, criarCliente } = require('./apoio');
const acesso = require('../src/domain/acesso');
const avisos = require('../src/domain/avisos');
const checklist = require('../src/domain/checklist');
const clientesDom = require('../src/domain/clientes');
const processosDom = require('../src/domain/processos');
const usuariosDom = require('../src/domain/usuarios');

const conn = carregarSeed(db);
const app = require('../src/app');
const servidor = app.listen(0);
const base = `http://127.0.0.1:${servidor.address().port}`;

const setorId = (nome) => conn.prepare('SELECT id FROM setores WHERE nome = ?').get(nome).id;

const admin = usuariosDom.porLogin('jacqueline');
const fiscal = usuariosDom.porLogin('ana.paula'); // Fiscal
const tipo = conn.prepare("SELECT * FROM tipos_processo WHERE nome = 'Baixa de Empresa'").get();
const cliente = clientesDom.criar({ codigo: '90', nome: 'EMPRESA SETOR', razao_social: 'EMPRESA SETOR LTDA' }, admin);

test.after(() => servidor.close());

/* ------------------------------------------------------------- domínio */

test('a carga inicial deixa cada usuário com o seu setor', () => {
  const setores = usuariosDom.setoresDe(fiscal.id).map((s) => s.nome);
  assert.deepEqual(setores, ['Fiscal']);
  assert.equal(usuariosDom.obter(fiscal.id).setores, 'Fiscal');
  assert.deepEqual(acesso.setoresDoUsuario(fiscal), ['Fiscal']);
});

test('marcar dois setores vale para os dois — e o principal é o primeiro da ordem', () => {
  const alvo = usuariosDom.porLogin('cecilia'); // Fiscal
  usuariosDom.atualizar(alvo.id, {
    nome: alvo.nome,
    login: alvo.login,
    email: alvo.email,
    perfil: alvo.perfil,
    status: alvo.status,
    setor_ids: [setorId('Paralegal'), setorId('Fiscal')],
  });

  const depois = usuariosDom.obter(alvo.id);
  // Paralegal vem antes do Fiscal na ordem geral dos setores.
  assert.equal(depois.setor, 'Paralegal', 'o principal é o primeiro na ordem dos setores');
  assert.equal(depois.setores, 'Paralegal · Fiscal');
  assert.deepEqual(usuariosDom.setoresDe(alvo.id).map((s) => s.nome), ['Paralegal', 'Fiscal']);

  // E é isso que o controle de acesso enxerga.
  const comoSessao = usuariosDom.porLogin('cecilia');
  assert.deepEqual(acesso.setoresDoUsuario(comoSessao).sort(), ['Fiscal', 'Paralegal']);
  assert.equal(acesso.podeEditarItem(comoSessao, { setor: 'Fiscal' }), true);
  assert.equal(acesso.podeEditarItem(comoSessao, { setor: 'Paralegal' }), true);
  assert.equal(acesso.podeEditarItem(comoSessao, { setor: 'Contábil' }), false);
});

test('usuário sem nenhum setor é recusado', () => {
  const alvo = usuariosDom.porLogin('geilza');
  assert.throws(
    () =>
      usuariosDom.atualizar(alvo.id, {
        nome: alvo.nome,
        login: alvo.login,
        perfil: alvo.perfil,
        status: alvo.status,
        setor_ids: [],
      }),
    /ao menos um setor/i
  );
  assert.equal(usuariosDom.obter(alvo.id).setor, 'Fiscal', 'nada pode ter mudado');

  assert.throws(
    () => usuariosDom.criar({ nome: 'Sem Setor', senha: 'teste1234', setor_ids: [] }),
    /ao menos um setor/i
  );
});

test('criar já aceita a lista de setores', () => {
  const criado = usuariosDom.criar({
    nome: 'Acumula Setores',
    senha: 'teste1234',
    setor_ids: [setorId('Contábil'), setorId('Financeiro')],
  });
  assert.equal(criado.setor, 'Contábil');
  assert.equal(criado.setores, 'Contábil · Financeiro');
  assert.deepEqual(acesso.setoresDoUsuario(criado).sort(), ['Contábil', 'Financeiro']);
});

test('o segundo setor entra na fila e no aviso de vez do setor', () => {
  const alvo = usuariosDom.porLogin('andreia'); // Financeiro
  usuariosDom.atualizar(alvo.id, {
    nome: alvo.nome,
    login: alvo.login,
    email: alvo.email,
    perfil: alvo.perfil,
    status: alvo.status,
    setor_ids: [setorId('Financeiro'), setorId('Contábil')],
  });
  const comDois = usuariosDom.porLogin('andreia');

  const processo = processosDom.criar({ cliente_id: cliente.id, tipo_processo_id: tipo.id }, admin);
  const itens = checklist.fila({ setorIds: acesso.setorIdsDoUsuario(comDois) });
  const setoresNaFila = new Set(itens.map((i) => i.setor));
  assert.ok(setoresNaFila.has('Contábil'), 'a fila passa a trazer o setor acumulado');

  // O chamado "sua vez" também alcança quem acumula.
  const antes = avisos.contarNaoLidos(comDois.id);
  avisos.vezDoSetor(processosDom.obter(processo.id), 'Contábil');
  assert.equal(avisos.contarNaoLidos(comDois.id), antes + 1);
});

test('o Administrativo continua respondendo pelos auxiliares mesmo como segundo setor', () => {
  const alvo = usuariosDom.porLogin('nayara'); // Contábil
  usuariosDom.atualizar(alvo.id, {
    nome: alvo.nome,
    login: alvo.login,
    email: alvo.email,
    perfil: alvo.perfil,
    status: alvo.status,
    setor_ids: [setorId('Contábil'), setorId('Administrativo')],
  });
  const comDois = usuariosDom.porLogin('nayara');
  const setores = acesso.setoresDoUsuario(comDois);

  assert.ok(setores.includes('Administrativo'));
  for (const auxiliar of acesso.SETORES_AUXILIARES_DO_ADMINISTRATIVO) {
    assert.ok(setores.includes(auxiliar), `o Administrativo responde pelo ${auxiliar}`);
  }
});

test('quem ganha a Diretoria como segundo setor vira gestor', () => {
  const alvo = usuariosDom.porLogin('lala'); // Departamento Pessoal, perfil Usuário
  assert.equal(acesso.ehGestor(usuariosDom.porLogin('lala')), false);

  usuariosDom.atualizar(alvo.id, {
    nome: alvo.nome,
    login: alvo.login,
    email: alvo.email,
    perfil: 'Usuário',
    status: alvo.status,
    setor_ids: [setorId('Departamento Pessoal'), setorId('Diretoria')],
  });
  assert.equal(acesso.ehGestor(usuariosDom.porLogin('lala')), true);
  assert.equal(acesso.setorIdsDoUsuario(usuariosDom.porLogin('lala')), null, 'gestor enxerga todos os setores');

  usuariosDom.atualizar(alvo.id, {
    nome: alvo.nome,
    login: alvo.login,
    email: alvo.email,
    perfil: 'Usuário',
    status: alvo.status,
    setor_ids: [setorId('Departamento Pessoal')],
  });
  assert.equal(acesso.ehGestor(usuariosDom.porLogin('lala')), false, 'e volta ao normal ao tirar');
});

/* ----------------------------------------------------------------- tela */

test('a tela de usuários traz as caixas de setor e salva a escolha', async () => {
  const http = criarCliente(base);
  await http.entrar('jacqueline', 'teste123');

  const html = await (await http.get('/admin/usuarios')).text();
  assert.match(html, /name="setor_ids"/, 'as caixas de setor');
  assert.match(html, /class="setores-celula"/, 'a lista dobrada na linha da tabela');
  assert.ok(!/name="setor_id"/.test(html), 'o campo antigo de setor único não existe mais');

  const alvo = usuariosDom.porLogin('crislane');
  const token = await http.token('/admin/usuarios');
  const resposta = await http.post(`/admin/usuarios/${alvo.id}`, {
    _csrf: token,
    nome: alvo.nome,
    login: alvo.login,
    email: alvo.email || '',
    perfil: 'Usuário',
    status: 'Ativo',
    setor_ids: [String(setorId('Departamento Pessoal')), String(setorId('Jurídico'))],
  });
  assert.equal(resposta.status, 302);

  const depois = usuariosDom.obter(alvo.id);
  assert.equal(depois.setores, 'Departamento Pessoal · Jurídico');

  // O histórico registra os dois setores, não só um.
  const linha = conn
    .prepare("SELECT * FROM historico WHERE acao = 'Usuário Atualizado' ORDER BY id DESC LIMIT 1")
    .get();
  assert.match(linha.observacao, /Departamento Pessoal · Jurídico/);
});

test('o crachá mostra os setores de quem acumula', async () => {
  const alvo = usuariosDom.porLogin('samuel');
  usuariosDom.atualizar(alvo.id, {
    nome: alvo.nome,
    login: alvo.login,
    email: alvo.email,
    perfil: alvo.perfil,
    status: alvo.status,
    setor_ids: [setorId('Departamento Pessoal'), setorId('Contábil')],
  });

  const http = criarCliente(base);
  await http.entrar('samuel', 'teste123');
  const html = await (await http.get('/processos')).text();
  assert.match(html, /Departamento Pessoal · Contábil/, 'o crachá lista os dois setores');
});

test('o backup leva a ligação usuário–setor', () => {
  const backup = require('../src/domain/backup');
  const dados = backup.gerar({ usuario: admin, incluirArquivos: false });
  assert.ok(Array.isArray(dados.tabelas.usuarios_setores), 'a tabela precisa estar no acervo');
  assert.ok(dados.tabelas.usuarios_setores.length > 0);
});
