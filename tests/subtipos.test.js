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

test('o processo guarda os subtipos — e recusa o subtipo de outro tipo', () => {
  const sub = subtipos.doTipo(tipoA.id).find((s) => s.nome === 'Mudança de endereço');
  const processo = novoProcesso({ subtipo_processo_id: sub.id });
  assert.deepEqual(subtipos.doProcesso(processo.id).map((s) => s.nome), ['Mudança de endereço']);
  assert.equal(processo.subtipos_processo, 'Mudança de endereço');

  // Sem subtipo continua valendo: o campo é opcional.
  const semSubtipo = novoProcesso();
  assert.deepEqual(subtipos.doProcesso(semSubtipo.id), []);
  assert.equal(semSubtipo.subtipos_processo, null);

  // Subtipo de OUTRO tipo é recusado — o formulário não pode misturar.
  const deOutroTipo = subtipos.doTipo(tipoB.id)[0];
  assert.throws(
    () => novoProcesso({ subtipo_processo_id: deOutroTipo.id }),
    /não pertence ao tipo/i
  );
  // E também quando vem junto com um válido.
  assert.throws(
    () => novoProcesso({ subtipo_processo_id: [sub.id, deOutroTipo.id] }),
    /não pertence ao tipo/i
  );
});

test('os subtipos podem ser escolhidos e trocados depois, na edição', () => {
  const processo = novoProcesso();
  assert.deepEqual(subtipos.doProcesso(processo.id), []);

  const sub = subtipos.doTipo(tipoA.id).find((s) => s.nome === 'Mudança de endereço');
  processosDom.atualizar(processo.id, { cliente_id: cliente.id, subtipo_processo_id: sub.id }, admin);
  assert.deepEqual(subtipos.doProcesso(processo.id).map((s) => s.nome), ['Mudança de endereço']);

  const registro = historico.doProcesso(processo.id).find((h) => h.observacao.includes('Subtipos:'));
  assert.ok(registro, 'a troca de subtipos precisa ficar no histórico');

  // E pode voltar a ficar sem nenhum.
  processosDom.atualizar(processo.id, { cliente_id: cliente.id, subtipo_processo_id: '' }, admin);
  assert.deepEqual(subtipos.doProcesso(processo.id), []);
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


/* ------------------------------- checklist por subtipo (com deduplicação) */

/** Item de modelo direto no banco, para montar os cenários. */
function itemModelo({ tipo = null, subtipo = null, setor, item, obrigatorio = 1 }) {
  const setorId = conn.prepare('SELECT id FROM setores WHERE nome = ?').get(setor).id;
  const info = conn
    .prepare(
      `INSERT INTO checklist_modelo (tipo_processo_id, subtipo_processo_id, setor_id, item, obrigatorio, ativo, ordem)
       VALUES (?, ?, ?, ?, ?, 1, 500)`
    )
    .run(tipo, subtipo, setorId, item, obrigatorio);
  return Number(info.lastInsertRowid);
}

const tipoC = conn.prepare("SELECT * FROM tipos_processo WHERE nome = 'Alteração Contratual'").get();
const subEndereco = subtipos.criar({ tipo_processo_id: tipoC.id, nome: 'Mudança de endereço' });
const subCapital = subtipos.criar({ tipo_processo_id: tipoC.id, nome: 'Alteração de capital' });

// O item de cada subtipo, e um que os DOIS pedem — escrito diferente de
// propósito, como duas pessoas cadastrariam.
itemModelo({ tipo: tipoC.id, subtipo: subEndereco.id, setor: 'Paralegal', item: 'Comprovante de endereço novo' });
itemModelo({ tipo: tipoC.id, subtipo: subCapital.id, setor: 'Paralegal', item: 'Demonstrativo de integralização' });
itemModelo({ tipo: tipoC.id, subtipo: subEndereco.id, setor: 'Paralegal', item: 'Emitir certidão negativa federal' });
itemModelo({
  tipo: tipoC.id,
  subtipo: subCapital.id,
  setor: 'Paralegal',
  item: 'emitir certidao negativa federal.',
  obrigatorio: 0,
});
// Mesmo texto, OUTRO setor: são duas tarefas de gente diferente.
itemModelo({ tipo: tipoC.id, subtipo: subCapital.id, setor: 'Contábil', item: 'Emitir certidão negativa federal' });

function novoDeAlteracao(subtipoIds) {
  return processosDom.criar(
    {
      cliente_id: cliente.id,
      tipo_processo_id: tipoC.id,
      data_abertura: '2026-03-01',
      subtipo_processo_id: subtipoIds,
    },
    admin
  );
}

const textos = (processoId) => checklist.doProcesso(processoId).map((i) => i.item);

test('o checklist traz os itens do tipo mais os dos subtipos escolhidos', () => {
  const semSubtipo = novoDeAlteracao([]);
  const soEndereco = novoDeAlteracao([subEndereco.id]);

  assert.ok(!textos(semSubtipo.id).includes('Comprovante de endereço novo'),
    'item de subtipo não entra em quem não escolheu o subtipo');
  assert.ok(textos(soEndereco.id).includes('Comprovante de endereço novo'));
  assert.ok(!textos(soEndereco.id).includes('Demonstrativo de integralização'),
    'item do outro subtipo não pode vazar');

  // Os itens gerais do tipo continuam entrando nos dois.
  const gerais = checklist
    .doProcesso(semSubtipo.id)
    .filter((i) => i.item !== 'Comprovante de endereço novo');
  assert.ok(gerais.length > 0, 'o processo continua recebendo os itens do tipo e de "Todos"');
});

test('item pedido por dois subtipos aparece uma vez só', () => {
  const dois = novoDeAlteracao([subEndereco.id, subCapital.id]);
  const lista = textos(dois.id);

  const certidoes = lista.filter((t) => /certid(ã|a)o negativa federal/i.test(t));
  assert.equal(
    certidoes.length,
    2,
    `esperava 2 (uma por setor), veio ${certidoes.length}: ${certidoes.join(' | ')}`
  );

  // Os dois subtipos trouxeram os seus itens próprios.
  assert.ok(lista.includes('Comprovante de endereço novo'));
  assert.ok(lista.includes('Demonstrativo de integralização'));

  // O mesmo texto em setores diferentes NÃO é o mesmo item.
  const porSetor = checklist
    .doProcesso(dois.id)
    .filter((i) => /certid/i.test(i.item))
    .map((i) => i.setor)
    .sort();
  assert.deepEqual(porSetor, ['Contábil', 'Paralegal']);
});

test('quando um dos repetidos é obrigatório, o item entra como obrigatório', () => {
  // "Emitir certidão negativa federal" é obrigatório em Mudança de endereço e
  // opcional em Alteração de capital: vence o mais exigente.
  const dois = novoDeAlteracao([subEndereco.id, subCapital.id]);
  const certidao = checklist
    .doProcesso(dois.id)
    .find((i) => /certid/i.test(i.item) && i.setor === 'Paralegal');
  assert.equal(certidao.obrigatorio, 1, 'quem é obrigatório em algum caminho entra obrigatório');
});

test('a comparação ignora acento, caixa e pontuação no fim', () => {
  assert.equal(
    checklist.chaveDoItem(1, 'Emitir certidão negativa federal'),
    checklist.chaveDoItem(1, '  emitir  CERTIDAO negativa federal.  ')
  );
  assert.notEqual(
    checklist.chaveDoItem(1, 'Emitir certidão'),
    checklist.chaveDoItem(2, 'Emitir certidão'),
    'setores diferentes são tarefas diferentes'
  );
});

test('trocar os subtipos acerta o checklist do processo já aberto', () => {
  const processo = novoDeAlteracao([subEndereco.id]);
  assert.ok(textos(processo.id).includes('Comprovante de endereço novo'));
  assert.ok(!textos(processo.id).includes('Demonstrativo de integralização'));

  // Passa a ter os dois: entra o item do subtipo novo, sem duplicar a certidão.
  const comDois = processosDom.atualizar(
    processo.id,
    { cliente_id: cliente.id, subtipo_processo_id: [subEndereco.id, subCapital.id] },
    admin
  );
  assert.ok(textos(processo.id).includes('Demonstrativo de integralização'));
  assert.equal(comDois.ajusteChecklist.adicionados.length, 2, 'entram o item próprio e a certidão do Contábil');
  assert.equal(
    textos(processo.id).filter((t) => /certid(ã|a)o negativa federal/i.test(t) ).length,
    2
  );

  // Tira o de capital: o item dele sai, porque ninguém respondeu.
  const soEndereco = processosDom.atualizar(
    processo.id,
    { cliente_id: cliente.id, subtipo_processo_id: [subEndereco.id] },
    admin
  );
  assert.ok(!textos(processo.id).includes('Demonstrativo de integralização'));
  assert.equal(soEndereco.ajusteChecklist.removidos.length, 2);
  assert.equal(soEndereco.ajusteChecklist.mantidos.length, 0);
});

test('item já respondido NÃO some ao desmarcar o subtipo', () => {
  const processo = novoDeAlteracao([subEndereco.id, subCapital.id]);
  const alvo = checklist.doProcesso(processo.id).find((i) => i.item === 'Demonstrativo de integralização');
  assert.ok(alvo, 'o item do subtipo precisa estar lá');

  checklist.responder(alvo.id, { resposta: 'Sim' }, admin);

  const salvo = processosDom.atualizar(
    processo.id,
    { cliente_id: cliente.id, subtipo_processo_id: [subEndereco.id] },
    admin
  );

  assert.ok(
    textos(processo.id).includes('Demonstrativo de integralização'),
    'apagar um item respondido destruiria trabalho registrado'
  );
  assert.equal(salvo.ajusteChecklist.mantidos.length, 1);
  assert.equal(salvo.ajusteChecklist.mantidos[0].item, 'Demonstrativo de integralização');
});

test('o histórico conta o que mudou nos subtipos e no checklist', () => {
  const processo = novoDeAlteracao([subEndereco.id]);
  processosDom.atualizar(
    processo.id,
    { cliente_id: cliente.id, subtipo_processo_id: [subEndereco.id, subCapital.id] },
    admin
  );

  const registro = historico.doProcesso(processo.id).find((h) => h.observacao.includes('Subtipos:'));
  assert.ok(registro);
  assert.match(registro.observacao, /entrou: Alteração de capital/);
  assert.match(registro.observacao, /Checklist: 2 item\(ns\) adicionado\(s\)/);
});

test('o backup carrega a ligação processo-subtipo', () => {
  const backup = require('../src/domain/backup');
  const dados = backup.gerar({ usuario: admin, incluirArquivos: false });
  assert.ok(dados.tabelas.processos_subtipos, 'sem isso, restaurar perderia os subtipos dos processos');
  assert.ok(dados.tabelas.processos_subtipos.length > 0);
});

test.after(() => {
  eventos.encerrarTodas();
  servidor.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
