'use strict';

/**
 * Ordem dos itens do modelo e atualização do checklist de um processo aberto.
 *
 * O checklist é clonado na abertura — mexer no modelo não pode reescrever
 * sozinho o trabalho em andamento. O que estes testes guardam é a outra
 * metade: quando alguém pede a atualização, ela precisa trazer o modelo
 * inteiro (itens novos, itens que saíram e a ordem) sem apagar nada que já
 * tenha resposta.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgrilo-modelo-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'teste.db');

const db = require('../src/db');
const { carregarSeed, criarCliente, liberarAteOSetor } = require('./apoio');
const checklist = require('../src/domain/checklist');
const clientesDom = require('../src/domain/clientes');
const ordemItens = require('../src/domain/ordem-itens');
const processosDom = require('../src/domain/processos');

const conn = carregarSeed(db);
const app = require('../src/app');
const servidor = app.listen(0);
const base = `http://127.0.0.1:${servidor.address().port}`;

const admin = conn.prepare("SELECT u.*, s.nome AS setor FROM usuarios u JOIN setores s ON s.id = u.setor_id WHERE u.login = 'jacqueline'").get();
const tipo = conn.prepare("SELECT * FROM tipos_processo WHERE nome = 'Baixa de Empresa'").get();
const cliente = clientesDom.criar({ codigo: '55', nome: 'EMPRESA MODELO', razao_social: 'EMPRESA MODELO LTDA' }, admin);

function novoProcesso() {
  return processosDom.criar({ cliente_id: cliente.id, tipo_processo_id: tipo.id, data_abertura: '2026-02-10' }, admin);
}

/** Primeiro setor do tipo com pelo menos dois itens — dá para reordenar. */
function setorComDoisItens() {
  return ordemItens.doTipo(tipo.id).find((g) => g.itens.length >= 2);
}

function itensDoSetor(processoId, setor) {
  return checklist.doProcesso(processoId).filter((i) => i.setor === setor);
}

test.after(() => servidor.close());

/* ------------------------------------------------------ ordem dos itens */

test('os itens de um setor saem na ordem gravada e podem ser reordenados', () => {
  const grupo = setorComDoisItens();
  assert.ok(grupo, 'o tipo precisa de um setor com dois ou mais itens');

  const antes = grupo.itens.map((i) => i.id);
  const invertida = [...antes].reverse();
  ordemItens.definir(tipo.id, grupo.setor_id, invertida);

  assert.deepEqual(ordemItens.idsDoSetor(tipo.id, grupo.setor_id), invertida);

  // E o modelo que monta o checklist enxerga a mesma ordem.
  const doModelo = checklist
    .modeloDoProcesso(tipo.id, [])
    .filter((m) => m.setor_id === grupo.setor_id)
    .map((m) => m.id);
  assert.deepEqual(doModelo, invertida, 'a ordem do modelo é a que o processo vai herdar');

  ordemItens.definir(tipo.id, grupo.setor_id, antes);
});

test('processo aberto depois já nasce com a ordem nova dos itens', () => {
  const grupo = setorComDoisItens();
  const original = grupo.itens.map((i) => i.id);
  const textos = grupo.itens.map((i) => i.item);

  ordemItens.definir(tipo.id, grupo.setor_id, [...original].reverse());
  try {
    const processo = novoProcesso();
    const noProcesso = itensDoSetor(processo.id, grupo.setor).map((i) => i.item);
    assert.deepEqual(noProcesso, [...textos].reverse());
  } finally {
    ordemItens.definir(tipo.id, grupo.setor_id, original);
  }
});

test('a rota da ordem de itens exige a lista completa do setor', async () => {
  const grupo = setorComDoisItens();
  const ids = grupo.itens.map((i) => i.id);

  const http = criarCliente(base);
  await http.entrar('jacqueline', 'teste123');
  const token = await http.token(`/admin/checklist-modelo?tipo=${tipo.id}`);

  const ok = await http.post(
    '/admin/checklist-modelo/ordem-itens',
    { _csrf: token, tipo_processo_id: tipo.id, setor_id: grupo.setor_id, item_ids: [...ids].reverse().join(',') },
    { headers: { accept: 'application/json' } }
  );
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
  assert.deepEqual(ordemItens.idsDoSetor(tipo.id, grupo.setor_id), [...ids].reverse());

  const parcial = await http.post(
    '/admin/checklist-modelo/ordem-itens',
    { _csrf: token, tipo_processo_id: tipo.id, setor_id: grupo.setor_id, item_ids: String(ids[0]) },
    { headers: { accept: 'application/json' } }
  );
  assert.equal(parcial.status, 400);
  assert.match((await parcial.json()).erro, /não confere/i);

  ordemItens.definir(tipo.id, grupo.setor_id, ids);
});

test('usuário comum não reordena itens', async () => {
  const grupo = setorComDoisItens();
  const ids = grupo.itens.map((i) => i.id);

  const http = criarCliente(base);
  await http.entrar('daiane', 'teste123');
  const token = await http.token('/processos');
  const resposta = await http.post('/admin/checklist-modelo/ordem-itens', {
    _csrf: token,
    tipo_processo_id: tipo.id,
    setor_id: grupo.setor_id,
    item_ids: [...ids].reverse().join(','),
  });

  assert.ok(resposta.status === 302 || resposta.status === 403);
  assert.deepEqual(ordemItens.idsDoSetor(tipo.id, grupo.setor_id), ids, 'nada pode ter mudado');
});

/* ---------------------------------------- atualizar o checklist do processo */

test('processo recém-aberto já está igual ao modelo — não há o que atualizar', () => {
  const processo = novoProcesso();
  const previa = checklist.previaDoModelo(processo.id);
  assert.equal(previa.semMudanca, true);
  assert.equal(previa.entram.length, 0);
  assert.equal(previa.saem.length, 0);
  assert.equal(previa.reordenam, 0);
});

test('a prévia conta o que vai entrar, sair e mudar de lugar — sem tocar em nada', () => {
  const processo = novoProcesso();
  const setorId = setorComDoisItens().setor_id;

  const novo = conn
    .prepare(
      `INSERT INTO checklist_modelo (tipo_processo_id, setor_id, item, obrigatorio, ativo, ordem)
       VALUES (?, ?, 'Item criado depois da abertura?', 1, 1, 999)`
    )
    .run(tipo.id, setorId);
  const antesDaPrevia = checklist.doProcesso(processo.id).length;

  try {
    const previa = checklist.previaDoModelo(processo.id);
    assert.equal(previa.semMudanca, false);
    assert.equal(previa.entram.length, 1);
    assert.match(previa.entram[0].item, /criado depois/);
    assert.equal(
      checklist.doProcesso(processo.id).length,
      antesDaPrevia,
      'a prévia não pode ter escrito nada'
    );
  } finally {
    conn.prepare('DELETE FROM checklist_modelo WHERE id = ?').run(Number(novo.lastInsertRowid));
  }
});

test('atualizar traz item novo, tira o intocado e mantém o que já foi respondido', () => {
  const processo = novoProcesso();
  const setorId = setorComDoisItens().setor_id;

  // Um item do modelo some; o do processo correspondente já foi respondido.
  // (O checklist é atendido em ordem, então os setores acima respondem antes.)
  const setorDoTeste = setorComDoisItens().setor;
  liberarAteOSetor(processo.id, setorDoTeste, admin);
  const respondido = checklist.doProcesso(processo.id).find((i) => i.setor_id === setorId);
  checklist.responder(respondido.id, { resposta: 'Sim' }, admin);
  const linhaDoModelo = conn
    .prepare('SELECT * FROM checklist_modelo WHERE setor_id = ? AND item = ?')
    .get(setorId, respondido.item);
  assert.ok(linhaDoModelo, 'o item respondido precisa vir do modelo');
  conn.prepare('DELETE FROM checklist_modelo WHERE id = ?').run(linhaDoModelo.id);

  // Um item intocado também sai do modelo.
  const intocado = checklist.doProcesso(processo.id).find((i) => i.setor_id === setorId && i.id !== respondido.id);
  const linhaIntocada = conn
    .prepare('SELECT * FROM checklist_modelo WHERE setor_id = ? AND item = ?')
    .get(setorId, intocado.item);
  if (linhaIntocada) conn.prepare('DELETE FROM checklist_modelo WHERE id = ?').run(linhaIntocada.id);

  // E entra um item novo.
  conn
    .prepare(
      `INSERT INTO checklist_modelo (tipo_processo_id, setor_id, item, obrigatorio, ativo, ordem)
       VALUES (?, ?, 'Item novo do modelo?', 1, 1, 1)`
    )
    .run(tipo.id, setorId);

  const ajuste = processosDom.atualizarChecklist(processo.id, admin);
  const depois = checklist.doProcesso(processo.id);

  assert.equal(ajuste.adicionados.length, 1);
  assert.ok(depois.some((i) => i.item === 'Item novo do modelo?'));

  assert.ok(
    depois.some((i) => i.id === respondido.id),
    'item já respondido não pode sumir, mesmo tendo saído do modelo'
  );
  assert.equal(ajuste.mantidos.length, 1);

  if (linhaIntocada) {
    assert.ok(!depois.some((i) => i.id === intocado.id), 'o intocado que saiu do modelo é removido');
    assert.equal(ajuste.removidos.length, 1);
  }

  // A auditoria registra o que foi feito.
  const linha = conn
    .prepare("SELECT * FROM historico WHERE processo_id = ? AND acao = 'Checklist Atualizado' ORDER BY id DESC")
    .get(processo.id);
  assert.ok(linha);
  assert.match(linha.observacao, /adicionado/);

  // Limpeza: devolve o modelo ao que era.
  conn.prepare("DELETE FROM checklist_modelo WHERE item = 'Item novo do modelo?'").run();
  conn
    .prepare(
      `INSERT INTO checklist_modelo (id, tipo_processo_id, subtipo_processo_id, setor_id, item, obrigatorio, ativo, ordem)
       VALUES (@id, @tipo_processo_id, @subtipo_processo_id, @setor_id, @item, @obrigatorio, @ativo, @ordem)`
    )
    .run(linhaDoModelo);
  if (linhaIntocada) {
    conn
      .prepare(
        `INSERT INTO checklist_modelo (id, tipo_processo_id, subtipo_processo_id, setor_id, item, obrigatorio, ativo, ordem)
         VALUES (@id, @tipo_processo_id, @subtipo_processo_id, @setor_id, @item, @obrigatorio, @ativo, @ordem)`
      )
      .run(linhaIntocada);
  }
});

test('atualizar reaplica a ordem no processo já aberto', () => {
  const processo = novoProcesso();
  const grupo = setorComDoisItens();
  const original = grupo.itens.map((i) => i.id);
  const textosAntes = itensDoSetor(processo.id, grupo.setor).map((i) => i.item);

  ordemItens.definir(tipo.id, grupo.setor_id, [...original].reverse());
  try {
    assert.equal(checklist.previaDoModelo(processo.id).semMudanca, false, 'a ordem nova precisa aparecer na prévia');

    const ajuste = processosDom.atualizarChecklist(processo.id, admin);
    assert.ok(ajuste.reordenados > 0);

    const textosDepois = itensDoSetor(processo.id, grupo.setor).map((i) => i.item);
    assert.deepEqual(textosDepois, [...textosAntes].reverse());
    assert.equal(checklist.previaDoModelo(processo.id).semMudanca, true, 'depois de atualizar, nada mais a fazer');
  } finally {
    ordemItens.definir(tipo.id, grupo.setor_id, original);
  }
});

test('a tela oferece o botão com confirmação — e só para quem conduz o processo', async () => {
  const processo = novoProcesso();
  const grupo = setorComDoisItens();
  const original = grupo.itens.map((i) => i.id);
  ordemItens.definir(tipo.id, grupo.setor_id, [...original].reverse());

  try {
    const gestor = criarCliente(base);
    await gestor.entrar('jacqueline', 'teste123');
    const html = await (await gestor.get(`/processos/${processo.id}`)).text();
    assert.match(html, /Atualizar checklist pelo modelo/);
    assert.match(html, /data-confirmar="[^"]*Atualizar o checklist/, 'o botão precisa perguntar antes');
    assert.match(html, /checklist\/atualizar/);

    const comum = criarCliente(base);
    await comum.entrar('daiane', 'teste123');
    const htmlComum = await (await comum.get(`/processos/${processo.id}`)).text();
    assert.ok(!/Atualizar checklist pelo modelo/.test(htmlComum), 'usuário comum não recebe o bloco');

    const token = await comum.token(`/processos/${processo.id}`);
    const recusa = await comum.post(`/processos/${processo.id}/checklist/atualizar`, { _csrf: token });
    assert.equal(recusa.status, 403);
  } finally {
    ordemItens.definir(tipo.id, grupo.setor_id, original);
  }
});

/* ------------------------------------------------------------- dashboard */

test('o dashboard é de todos os usuários', async () => {
  const http = criarCliente(base);
  await http.entrar('daiane', 'teste123');

  const tela = await http.get('/dashboard');
  assert.equal(tela.status, 200);
  assert.match(await tela.text(), /Dashboard/);

  const dados = await http.get('/dashboard/dados.json');
  assert.equal(dados.status, 200);
  assert.ok((await dados.json()).indicadores, 'os gráficos também precisam responder');
});

test('o menu abre pelo Dashboard, com Minha fila logo depois', async () => {
  const http = criarCliente(base);
  await http.entrar('daiane', 'teste123');
  const html = await (await http.get('/processos')).text();

  const nav = html.slice(html.indexOf('<nav>'), html.indexOf('</nav>'));
  const ordem = [...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ordem.slice(0, 4), ['/dashboard', '/', '/processos', '/clientes']);
});
