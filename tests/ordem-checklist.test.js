'use strict';

/**
 * Ordem de atendimento do checklist.
 *
 * Duas regras andam juntas aqui:
 *  - um setor só pode responder depois que o setor acima dele respondeu;
 *  - a ordem dos setores é gravada de uma vez (é o que a tela envia depois de
 *    arrastar), sempre com a lista completa do tipo.
 *
 * O que estes testes guardam é o que não pode afrouxar: a recusa vem do
 * domínio (não da tela), diz quem está segurando, e nada disso trava o
 * processo por causa de item opcional ou de setor com aprovação desligada.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgrilo-ordem-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'teste.db');

const db = require('../src/db');
const { carregarSeed, criarCliente } = require('./apoio');
const checklist = require('../src/domain/checklist');
const processosDom = require('../src/domain/processos');
const clientesDom = require('../src/domain/clientes');
const ordemSetores = require('../src/domain/ordem-setores');
const parametros = require('../src/domain/parametros');

const conn = carregarSeed(db);
const app = require('../src/app');
const servidor = app.listen(0);
const base = `http://127.0.0.1:${servidor.address().port}`;

const admin = conn.prepare("SELECT * FROM usuarios WHERE login = 'jacqueline'").get();
const tipo = conn.prepare("SELECT * FROM tipos_processo WHERE nome = 'Baixa de Empresa'").get();
const cliente = clientesDom.criar({ codigo: '1', nome: 'EMPRESA ORDEM', razao_social: 'EMPRESA ORDEM LTDA' }, admin);

function novoProcesso() {
  return processosDom.criar(
    { cliente_id: cliente.id, tipo_processo_id: tipo.id, data_abertura: '2026-02-10' },
    admin
  );
}

/** Setores do processo na ordem de atendimento, sem repetir. */
function setoresNaOrdem(processoId) {
  return [...new Set(checklist.doProcesso(processoId).map((i) => i.setor))];
}

function itensDoSetor(processoId, setor) {
  return checklist.doProcesso(processoId).filter((i) => i.setor === setor);
}

test.after(() => servidor.close());

/* ------------------------------------------------ o setor de cima primeiro */

test('só o primeiro setor nasce liberado; os demais esperam quem vem antes', () => {
  const processo = novoProcesso();
  const ordem = setoresNaOrdem(processo.id);
  assert.ok(ordem.length >= 2, 'o teste precisa de um tipo com mais de um setor');

  const grupos = checklist.agrupadoPorSetor(processo.id);
  assert.equal(grupos[0].liberado, true, 'o primeiro setor abre sozinho');
  assert.equal(grupos[0].aguardando, null);

  for (const grupo of grupos.slice(1)) {
    assert.equal(grupo.liberado, false, `${grupo.setor} não podia estar liberado ainda`);
    assert.equal(grupo.aguardando, ordem[0], 'quem segura é o primeiro setor pendente');
  }
});

test('responder fora da ordem é recusado pelo domínio, com o motivo', () => {
  const processo = novoProcesso();
  const ordem = setoresNaOrdem(processo.id);
  const item = itensDoSetor(processo.id, ordem[1])[0];

  assert.throws(
    () => checklist.responder(item.id, { resposta: 'Sim' }, admin),
    (erro) =>
      erro.name === 'ErroValidacao' &&
      new RegExp(ordem[1]).test(erro.message) &&
      new RegExp(ordem[0]).test(erro.message),
    'a recusa precisa dizer qual setor está esperando e por quem'
  );

  // Nem mesmo o administrador passa na frente: a ordem é do processo, não do perfil.
  assert.equal(checklist.obterItem(item.id).resposta, null);
});

test('o setor seguinte abre assim que o de cima é respondido', () => {
  const processo = novoProcesso();
  const ordem = setoresNaOrdem(processo.id);

  itensDoSetor(processo.id, ordem[0]).forEach((i) =>
    checklist.responder(i.id, { resposta: 'Sim' }, admin)
  );

  const grupos = checklist.agrupadoPorSetor(processo.id);
  assert.equal(grupos[0].respondido, true);
  assert.equal(grupos[1].liberado, true, `${ordem[1]} devia ter aberto`);

  // E o terceiro continua esperando o segundo — a fila anda um por vez.
  if (grupos[2]) {
    assert.equal(grupos[2].liberado, false);
    assert.equal(grupos[2].aguardando, ordem[1]);
  }

  const item = itensDoSetor(processo.id, ordem[1])[0];
  assert.doesNotThrow(() => checklist.responder(item.id, { resposta: 'Sim' }, admin));
});

test('setor impedido não tranca a fila: impedimento é resposta', () => {
  const processo = novoProcesso();
  const ordem = setoresNaOrdem(processo.id);

  const itens = itensDoSetor(processo.id, ordem[0]);
  checklist.responder(
    itens[0].id,
    { resposta: 'Não', possui_impedimento: 'Sim', descricao_impedimento: 'Falta certidão.' },
    admin
  );
  itens.slice(1).forEach((i) => checklist.responder(i.id, { resposta: 'Sim' }, admin));

  processosDom.recalcularStatus(processo.id, admin, { silencioso: true });
  assert.equal(processosDom.obter(processo.id).status, 'Impedido');
  const grupos = checklist.agrupadoPorSetor(processo.id);
  assert.equal(grupos[1].liberado, true, 'travar o resto do escritório pararia o processo inteiro');
});

test('item opcional não segura o setor seguinte', () => {
  const processo = novoProcesso();
  const ordem = setoresNaOrdem(processo.id);
  const itens = itensDoSetor(processo.id, ordem[0]);

  const opcional = itens.find((i) => !i.obrigatorio);
  if (!opcional) return; // o tipo não tem item opcional no primeiro setor

  itens.filter((i) => i.obrigatorio).forEach((i) => checklist.responder(i.id, { resposta: 'Sim' }, admin));

  assert.equal(checklist.obterItem(opcional.id).resposta, null, 'o opcional continua sem resposta');
  assert.equal(checklist.agrupadoPorSetor(processo.id)[1].liberado, true);
});

test('EXIGIR_ORDEM_SETORES = Não devolve o checklist ao atendimento livre', () => {
  const processo = novoProcesso();
  const ordem = setoresNaOrdem(processo.id);
  const item = itensDoSetor(processo.id, ordem[1])[0];

  parametros.definir('EXIGIR_ORDEM_SETORES', 'Não');
  try {
    assert.doesNotThrow(() => checklist.responder(item.id, { resposta: 'Sim' }, admin));
    assert.ok(
      checklist.agrupadoPorSetor(processo.id).every((g) => g.liberado),
      'com a regra desligada nenhum setor fica preso'
    );
  } finally {
    parametros.definir('EXIGIR_ORDEM_SETORES', 'Sim');
  }
});

test('mudar a ordem dos setores muda quem espera quem, no processo já aberto', () => {
  const processo = novoProcesso();
  const antes = setoresNaOrdem(processo.id);

  // Inverte os dois primeiros — é o que o administrador faz arrastando.
  const ids = ordemSetores.doTipo(tipo.id).map((s) => s.id);
  ids.splice(1, 0, ids.splice(0, 1)[0]);
  ordemSetores.definir(tipo.id, ids);

  try {
    const depois = setoresNaOrdem(processo.id);
    assert.equal(depois[0], antes[1], 'a ordem nova vale para quem já está em andamento');

    const grupos = checklist.agrupadoPorSetor(processo.id);
    assert.equal(grupos[0].setor, antes[1]);
    assert.equal(grupos[0].liberado, true);
    assert.equal(grupos[1].aguardando, antes[1], 'quem era o primeiro agora espera');
  } finally {
    ordemSetores.limpar(tipo.id);
  }
});

/* ----------------------------------------------------- a tela e a rota */

test('a tela do setor bloqueado explica a espera em vez de só sumir com o formulário', async () => {
  const processo = novoProcesso();
  const ordem = setoresNaOrdem(processo.id);

  const cliente = criarCliente(base);
  await cliente.entrar('jacqueline', 'teste123');
  const html = await (await cliente.get(`/processos/${processo.id}`)).text();

  assert.match(html, /setor-bloqueado/, 'o setor preso precisa aparecer marcado');
  assert.match(html, new RegExp(`aguardando[\\s\\S]{0,120}${ordem[0]}`, 'i'));
});

test('a rota da ordem grava a lista inteira e recusa lista pela metade', async () => {
  const cliente = criarCliente(base);
  await cliente.entrar('jacqueline', 'teste123');
  const token = await cliente.token(`/admin/checklist-modelo?tipo=${tipo.id}`);

  const ids = ordemSetores.doTipo(tipo.id).map((s) => s.id);
  const invertida = [...ids].reverse();

  const resposta = await cliente.post(
    '/admin/checklist-modelo/ordem',
    { _csrf: token, tipo_processo_id: tipo.id, setor_ids: invertida.join(',') },
    { headers: { accept: 'application/json' } }
  );
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();
  assert.equal(corpo.ok, true);
  assert.deepEqual(corpo.ordem.map((s) => s.id), invertida);
  assert.deepEqual(ordemSetores.doTipo(tipo.id).map((s) => s.id), invertida);

  // Uma lista incompleta mandaria os setores que ficaram de fora para o fim
  // calados: melhor recusar e pedir para recarregar.
  const parcial = await cliente.post(
    '/admin/checklist-modelo/ordem',
    { _csrf: token, tipo_processo_id: tipo.id, setor_ids: invertida.slice(0, 1).join(',') },
    { headers: { accept: 'application/json' } }
  );
  assert.equal(parcial.status, 400);
  assert.match((await parcial.json()).erro, /não confere/i);
  assert.deepEqual(ordemSetores.doTipo(tipo.id).map((s) => s.id), invertida, 'a ordem boa continua de pé');

  ordemSetores.limpar(tipo.id);
});

test('a ordem só muda pelas mãos de um administrador', async () => {
  const cliente = criarCliente(base);
  await cliente.entrar('daiane', 'teste123');
  const token = await cliente.token('/processos');

  const ids = ordemSetores.doTipo(tipo.id).map((s) => s.id);
  const resposta = await cliente.post('/admin/checklist-modelo/ordem', {
    _csrf: token,
    tipo_processo_id: tipo.id,
    setor_ids: [...ids].reverse().join(','),
  });

  assert.ok(resposta.status === 302 || resposta.status === 403, 'usuário comum não entra no admin');
  assert.deepEqual(ordemSetores.doTipo(tipo.id).map((s) => s.id), ids, 'nada pode ter mudado');
});
