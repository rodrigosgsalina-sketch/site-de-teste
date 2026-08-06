'use strict';

/**
 * Subtipos de processo e exclusão de processo pelo administrador.
 *
 * O subtipo detalha o tipo ("Alteração Contratual" → "Entrada de sócio") e é
 * opcional. A exclusão de processo é definitiva e privativa do administrador —
 * o que estes testes guardam é justamente o que não pode afrouxar: a
 * permissão, a confirmação digitada, o que some junto e o que precisa
 * sobreviver.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgrilo-sub-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'teste.db');

const db = require('../src/db');
const { carregarSeed, criarCliente } = require('./apoio');
const subtipos = require('../src/domain/subtipos');
const processosDom = require('../src/domain/processos');
const clientesDom = require('../src/domain/clientes');
const checklist = require('../src/domain/checklist');
const historico = require('../src/domain/historico');
const eventos = require('../src/lib/eventos');
const config = require('../src/config');

const conn = carregarSeed(db);
const app = require('../src/app');
const servidor = app.listen(0);
const base = `http://127.0.0.1:${servidor.address().port}`;

const admin = conn.prepare("SELECT * FROM usuarios WHERE login = 'jacqueline'").get();
const comum = conn.prepare("SELECT * FROM usuarios WHERE login = 'daiane'").get();
const tipoA = conn.prepare("SELECT * FROM tipos_processo WHERE nome = 'Baixa de Empresa'").get();
const tipoB = conn.prepare("SELECT * FROM tipos_processo WHERE nome = 'Constituição de Empresa'").get();

const cliente = clientesDom.criar({ codigo: '1', nome: 'EMPRESA SUB', razao_social: 'EMPRESA SUB LTDA' }, admin);

function novoProcesso(extra = {}) {
  return processosDom.criar(
    { cliente_id: cliente.id, tipo_processo_id: tipoA.id, data_abertura: '2026-02-10', ...extra },
    admin
  );
}

/* ------------------------------------------------------------- subtipos */

test('o subtipo pertence a um tipo, e o nome só é único dentro dele', () => {
  const criado = subtipos.criar({ tipo_processo_id: tipoA.id, nome: 'Mudança de endereço' });
  assert.equal(criado.nome, 'Mudança de endereço');

  assert.throws(
    () => subtipos.criar({ tipo_processo_id: tipoA.id, nome: 'mudança de endereço' }),
    /já tem um subtipo/i,
    'repetir o nome no mesmo tipo (mesmo com outra caixa) precisa ser recusado'
  );

  // O mesmo nome em outro tipo é legítimo: são coisas diferentes.
  const outro = subtipos.criar({ tipo_processo_id: tipoB.id, nome: 'Mudança de endereço' });
  assert.notEqual(outro.id, criado.id);

  assert.throws(() => subtipos.criar({ tipo_processo_id: tipoA.id, nome: '   ' }), /nome do subtipo/i);
  assert.throws(() => subtipos.criar({ tipo_processo_id: 99999, nome: 'X' }), /tipo de processo/i);
});

test('a abertura recebe só os subtipos ativos, agrupados por tipo', () => {
  const inativo = subtipos.criar({ tipo_processo_id: tipoA.id, nome: 'Fora de uso' });
  subtipos.atualizar(inativo.id, { nome: 'Fora de uso', ativo: false });

  const mapa = subtipos.ativosPorTipo();
  const doTipoA = mapa[String(tipoA.id)] || [];
  assert.ok(doTipoA.some((s) => s.nome === 'Mudança de endereço'));
  assert.ok(!doTipoA.some((s) => s.nome === 'Fora de uso'), 'subtipo inativo não vai para a abertura');

  // Cada item leva só o que a tela usa.
  assert.deepEqual(Object.keys(doTipoA[0]).sort(), ['id', 'nome']);

  // Um tipo sem subtipo simplesmente não aparece no mapa — a tela esconde o campo.
  const semSubtipo = conn
    .prepare(
      `SELECT id FROM tipos_processo
        WHERE id NOT IN (SELECT tipo_processo_id FROM subtipos_processo) LIMIT 1`
    )
    .get();
  assert.equal(mapa[String(semSubtipo.id)], undefined);
});

test('o processo guarda o subtipo — e recusa o subtipo de outro tipo', () => {
  const sub = subtipos.doTipo(tipoA.id).find((s) => s.nome === 'Mudança de endereço');
  const processo = novoProcesso({ subtipo_processo_id: sub.id });
  assert.equal(processo.subtipo_processo_id, sub.id);
  assert.equal(processo.subtipo_processo, 'Mudança de endereço');

  // Sem subtipo continua valendo: o campo é opcional.
  const semSubtipo = novoProcesso();
  assert.equal(semSubtipo.subtipo_processo_id, null);
  assert.equal(semSubtipo.subtipo_processo, null);

  // Subtipo de OUTRO tipo é recusado — o formulário não pode misturar.
  const deOutroTipo = subtipos.doTipo(tipoB.id)[0];
  assert.throws(
    () => novoProcesso({ subtipo_processo_id: deOutroTipo.id }),
    /não pertence ao tipo/i
  );
});

test('o subtipo pode ser escolhido depois, na edição', () => {
  const processo = novoProcesso();
  assert.equal(processo.subtipo_processo_id, null);

  const sub = subtipos.doTipo(tipoA.id).find((s) => s.nome === 'Mudança de endereço');
  const salvo = processosDom.atualizar(
    processo.id,
    { cliente_id: cliente.id, subtipo_processo_id: sub.id },
    admin
  );
  assert.equal(salvo.subtipo_processo, 'Mudança de endereço');

  const registro = historico.doProcesso(processo.id).find((h) => h.observacao.includes('Subtipo alterado'));
  assert.ok(registro, 'a troca de subtipo precisa ficar no histórico');

  // E pode voltar a ficar sem nenhum.
  const limpo = processosDom.atualizar(processo.id, { cliente_id: cliente.id, subtipo_processo_id: '' }, admin);
  assert.equal(limpo.subtipo_processo_id, null);
});

test('subtipo em uso não é excluído; sem uso, é', () => {
  const sub = subtipos.criar({ tipo_processo_id: tipoA.id, nome: 'Só para apagar' });
  assert.equal(subtipos.emUso(sub.id), 0);
  assert.equal(subtipos.remover(sub.id).nome, 'Só para apagar');
  assert.equal(subtipos.obter(sub.id), undefined);

  const usado = subtipos.criar({ tipo_processo_id: tipoA.id, nome: 'Em uso' });
  novoProcesso({ subtipo_processo_id: usado.id });
  assert.equal(subtipos.emUso(usado.id), 1);
  assert.throws(
    () => subtipos.remover(usado.id),
    /está em 1 processo\(s\)/i,
    'apagar deixaria o processo sem o detalhe que alguém registrou'
  );
  assert.ok(subtipos.obter(usado.id), 'o subtipo continua lá depois da recusa');
});

test('apagar o tipo leva junto os subtipos dele', () => {
  const tipo = conn
    .prepare("INSERT INTO tipos_processo (nome, ativo, ordem) VALUES ('Tipo Temporário', 1, 99)")
    .run();
  const tipoId = Number(tipo.lastInsertRowid);
  subtipos.criar({ tipo_processo_id: tipoId, nome: 'Filho A' });
  subtipos.criar({ tipo_processo_id: tipoId, nome: 'Filho B' });
  assert.equal(subtipos.doTipo(tipoId).length, 2);

  conn.prepare('DELETE FROM tipos_processo WHERE id = ?').run(tipoId);
  assert.equal(subtipos.doTipo(tipoId).length, 0, 'subtipo órfão não pode sobrar');
});

/* --------------------------------------------- exclusão de processo */

test('excluir o processo leva checklist, anexos e avisos — e deixa a auditoria', () => {
  const processo = novoProcesso();
  const itens = checklist.doProcesso(processo.id);
  assert.ok(itens.length > 0, 'o processo nasce com checklist');

  // Um anexo de verdade, com arquivo em disco.
  const dir = path.join(config.uploadsDir, String(processo.id));
  fs.mkdirSync(dir, { recursive: true });
  const arquivo = path.join(dir, 'anexo-teste.txt');
  fs.writeFileSync(arquivo, 'conteudo');
  conn
    .prepare(
      `INSERT INTO documentos (processo_id, nome_original, nome_arquivo, mime, tamanho, usuario_id)
       VALUES (?, 'anexo.txt', 'anexo-teste.txt', 'text/plain', 8, ?)`
    )
    .run(processo.id, admin.id);

  const antes = historico.doProcesso(processo.id).length;
  assert.ok(antes > 0);

  const { perdidos, arquivosApagados } = processosDom.remover(processo.id, admin, 'aberto por engano');

  assert.equal(perdidos.checklist, itens.length);
  assert.equal(perdidos.documentos, 1);
  assert.equal(arquivosApagados, 1);
  assert.equal(fs.existsSync(arquivo), false, 'o arquivo em disco precisa sair junto');

  assert.equal(processosDom.obter(processo.id), undefined);
  assert.equal(conn.prepare('SELECT COUNT(*) AS t FROM checklist WHERE processo_id = ?').get(processo.id).t, 0);
  assert.equal(conn.prepare('SELECT COUNT(*) AS t FROM documentos WHERE processo_id = ?').get(processo.id).t, 0);
  assert.equal(conn.prepare('SELECT COUNT(*) AS t FROM avisos WHERE processo_id = ?').get(processo.id).t, 0);

  // A linha da exclusão fica sem processo justamente para não sair na cascata.
  const auditoria = conn
    .prepare("SELECT * FROM historico WHERE acao = 'Processo Excluído' ORDER BY id DESC LIMIT 1")
    .get();
  assert.ok(auditoria, 'sem esse registro, ninguém saberia que o processo existiu');
  assert.equal(auditoria.processo_id, null);
  assert.match(auditoria.observacao, new RegExp(processo.codigo));
  assert.match(auditoria.observacao, /aberto por engano/);
});

test('depois de excluir, o próximo processo ainda consegue nascer', () => {
  // O código do checklist saía da CONTAGEM de linhas: excluir um processo fazia
  // a contagem voltar atrás e o item seguinte tentava nascer com um código que
  // já existia — o banco recusava e a abertura quebrava.
  // Um processo vivo, cujos códigos NÃO podem ser tocados.
  const vivo = novoProcesso();
  const codigosVivos = checklist.doProcesso(vivo.id).map((i) => i.codigo);

  const descartado = novoProcesso();
  processosDom.remover(descartado.id, admin);

  // Antes da correção, esta linha lançava "UNIQUE constraint failed".
  const novo = novoProcesso();
  const codigosNovos = checklist.doProcesso(novo.id).map((i) => i.codigo);

  assert.ok(codigosNovos.length > 0, 'o checklist do novo processo precisa ser gerado');
  assert.deepEqual(
    codigosNovos.filter((c) => codigosVivos.includes(c)),
    [],
    'o novo processo não pode invadir os códigos de um processo que existe'
  );

  const distintos = new Set(conn.prepare('SELECT codigo FROM checklist').all().map((l) => l.codigo));
  const total = conn.prepare('SELECT COUNT(*) AS t FROM checklist').get().t;
  assert.equal(distintos.size, total, 'todos os códigos de checklist continuam únicos');
});

test('excluir um processo não mexe nos outros', () => {
  const vitima = novoProcesso();
  const vizinho = novoProcesso();
  const itensVizinho = checklist.doProcesso(vizinho.id).length;

  processosDom.remover(vitima.id, admin);

  assert.ok(processosDom.obter(vizinho.id), 'o outro processo continua lá');
  assert.equal(checklist.doProcesso(vizinho.id).length, itensVizinho);
});

/* ------------------------------------------------------- pela tela */

test('só o administrador exclui, e só digitando o número do processo', async () => {
  const processo = novoProcesso();

  // Usuário comum: recusado, e o processo continua.
  const dela = criarCliente(base);
  await dela.entrar('daiane', 'teste123');
  const token = await dela.token(`/processos/${processo.id}`);
  const tentativa = await dela.post(`/processos/${processo.id}/excluir`, {
    _csrf: token,
    confirmacao: processo.codigo,
  });
  assert.equal(tentativa.status, 302);
  assert.ok(processosDom.obter(processo.id), 'usuário comum não pode excluir');

  // Administrador com a confirmação errada: também recusado.
  const dele = criarCliente(base);
  await dele.entrar('jacqueline', 'teste123');
  const tokenAdmin = await dele.token(`/processos/${processo.id}`);
  await dele.post(`/processos/${processo.id}/excluir`, { _csrf: tokenAdmin, confirmacao: 'SIM' });
  assert.ok(processosDom.obter(processo.id), 'sem digitar o número, nada acontece');

  // Com a confirmação certa: some.
  await dele.post(`/processos/${processo.id}/excluir`, {
    _csrf: tokenAdmin,
    confirmacao: processo.codigo.toLowerCase(), // a caixa não importa
  });
  assert.equal(processosDom.obter(processo.id), undefined);
});

test('a tela do processo só oferece a exclusão ao administrador', async () => {
  const processo = novoProcesso();

  const dela = criarCliente(base);
  await dela.entrar('daiane', 'teste123');
  const semPermissao = await (await dela.get(`/processos/${processo.id}`)).text();
  assert.ok(!semPermissao.includes('Excluir definitivamente'), 'quem não pode excluir não vê o botão');

  const dele = criarCliente(base);
  await dele.entrar('jacqueline', 'teste123');
  const comPermissao = await (await dele.get(`/processos/${processo.id}`)).text();
  assert.match(comPermissao, /Excluir definitivamente/);
  assert.match(comPermissao, new RegExp(`Digite <strong class="mono">${processo.codigo}`));
  // A alternativa reversível fica dita na própria tela.
  assert.match(comPermissao, /Cancelar processo/);
});

test('o backup carrega os subtipos', () => {
  const backup = require('../src/domain/backup');
  const dados = backup.gerar({ usuario: admin, incluirArquivos: false });
  assert.ok(dados.tabelas.subtipos_processo, 'sem isso, restaurar um backup perderia os subtipos');
  assert.ok(dados.tabelas.subtipos_processo.length > 0);
  assert.equal(dados.totais.subtipos_processo, dados.tabelas.subtipos_processo.length);
});

test.after(() => {
  eventos.encerrarTodas();
  servidor.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
