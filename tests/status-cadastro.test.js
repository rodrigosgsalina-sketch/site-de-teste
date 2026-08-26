'use strict';

/**
 * O cadastro das situações do processo.
 *
 * A parte delicada não é criar linha em tabela: é o motor de status continuar
 * de pé depois. Ele cita algumas situações pelo nome — renomear "Concluído"
 * pararia a conclusão de processo em silêncio —, e agora descobre a situação de
 * análise de cada setor pelo cadastro, no lugar da lista de quatro nomes que
 * vivia no código. Os dois lados estão testados aqui.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgrilo-situacoes-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'teste.db');

const db = require('../src/db');
const { carregarSeed, criarCliente } = require('./apoio');
const conn = carregarSeed(db, { senha: 'teste123' });

const statusDom = require('../src/domain/status-processo');
const processos = require('../src/domain/processos');
const checklist = require('../src/domain/checklist');
const clientesDom = require('../src/domain/clientes');

const app = require('../src/app');
const servidor = app.listen(0);
const base = `http://127.0.0.1:${servidor.address().port}`;
test.after(() => servidor.close());

const admin = conn.prepare("SELECT * FROM usuarios WHERE login = 'jacqueline'").get();
const cliente = clientesDom.criar(
  { codigo: '8100', nome: 'Empresa das Situações', razao_social: 'Empresa das Situações LTDA' },
  admin,
  'Manual'
);
const tipoCertidoes = conn.prepare("SELECT * FROM tipos_processo WHERE nome = 'Emissão de Certidões'").get();
const idDoSetor = (nome) => conn.prepare('SELECT id FROM setores WHERE nome = ?').get(nome).id;

/* ------------------------------------------------------------- cadastro */

test('a situação nova nasce com a cor escolhida e no fim da lista', () => {
  const criada = statusDom.criar({ nome: 'Aguardando Cartório', cor: 'roxo', espera: 1 });
  assert.strictEqual(criada.cor, 'roxo');
  assert.strictEqual(criada.espera, 1);
  assert.strictEqual(criada.sistema, 0, 'situação do escritório não é do sistema');

  const lista = statusDom.listar();
  assert.strictEqual(lista[lista.length - 1].nome, 'Aguardando Cartório');
  assert.strictEqual(statusDom.classeDaEtiqueta('Aguardando Cartório'), 'et-roxo');
});

test('cor fora da paleta e nome repetido são recusados', () => {
  assert.throws(() => statusDom.criar({ nome: 'Teste de cor', cor: '#ff00ff' }), /cores disponíveis/);
  assert.throws(() => statusDom.criar({ nome: 'Impedido' }), /Já existe uma situação/);
  assert.throws(() => statusDom.criar({ nome: '   ' }), /Informe o nome/);
});

test('encerrar o processo não combina com espera nem com escolha mantida', () => {
  assert.throws(
    () => statusDom.criar({ nome: 'Arquivado', final: 1, espera: 1 }),
    /não é espera nem escolha manual/
  );
});

test('editar troca cor, regras e nome de uma situação do escritório', () => {
  const criada = statusDom.criar({ nome: 'Em conferência', cor: 'neutro' });
  const salva = statusDom.atualizar(criada.id, {
    nome: 'Em conferência final',
    cor: 'amarelo',
    espera: 1,
  });
  assert.strictEqual(salva.nome, 'Em conferência final');
  assert.strictEqual(salva.cor, 'amarelo');
  assert.strictEqual(salva.espera, 1);
  assert.strictEqual(statusDom.classeDaEtiqueta('Em conferência final'), 'et-amarelo');
  statusDom.remover(salva.id);
});

/* --------------------------------------------- o que o motor precisa */

test('a situação do sistema muda de cor, mas não de nome nem de regra', () => {
  const concluido = statusDom.porNome('Concluído');
  assert.strictEqual(concluido.sistema, 1);

  const salva = statusDom.atualizar(concluido.id, {
    nome: 'Finalizado',        // tentativa de renomear
    cor: 'turquesa',           // esta passa
    final: 0,                  // tentativa de tirar o "encerra"
    espera: 1,
  });

  assert.strictEqual(salva.nome, 'Concluído', 'o nome é o que o motor procura');
  assert.strictEqual(salva.final, 1, 'a regra continua de pé');
  assert.strictEqual(salva.espera, 0);
  assert.strictEqual(salva.cor, 'turquesa', 'a cor é livre');

  statusDom.atualizar(concluido.id, { cor: 'verde' });
});

test('situação do sistema não pode ser excluída', () => {
  const impedido = statusDom.porNome('Impedido');
  assert.throws(() => statusDom.remover(impedido.id), /não pode ser excluída/);
});

test('situação em uso por algum processo não pode ser excluída', () => {
  const processo = processos.criar({ tipo_processo_id: tipoCertidoes.id, cliente_id: cliente.id }, admin);
  const atual = statusDom.porNome(processos.obter(processo.id).status);
  assert.ok(atual.em_uso >= 1);

  const criada = statusDom.criar({ nome: 'Situação ocupada', espera: 1 });
  processos.definirStatusManual(processo.id, criada.nome, admin);
  assert.throws(() => statusDom.remover(criada.id), /processo\(s\) estão nesta situação/);

  // liberada a situação, a exclusão passa
  processos.definirStatusManual(processo.id, 'Aguardando Cliente', admin);
  const removida = statusDom.remover(criada.id);
  assert.strictEqual(removida.nome, 'Situação ocupada');
});

test('a ordem da lista é gravada como veio do arrastar', () => {
  const antes = statusDom.listar().map((s) => s.id);
  const invertida = [...antes].reverse();
  statusDom.definirOrdem(invertida);
  assert.deepStrictEqual(statusDom.listar().map((s) => s.id), invertida);

  statusDom.definirOrdem(antes);
  assert.deepStrictEqual(statusDom.listar().map((s) => s.id), antes);
});

/* --------------------------------------- situação de análise por setor */

test('cada setor tem no máximo uma situação de análise', () => {
  const fiscal = idDoSetor('Fiscal');
  assert.throws(
    () => statusDom.criar({ nome: 'Outra análise fiscal', setor_id: fiscal }),
    /já tem a situação de análise/
  );
});

test('o motor aplica a situação de análise que o escritório cadastrou', () => {
  // Setor novo, criado como o escritório criaria na tela de Tipos e setores.
  conn.prepare("INSERT INTO setores (nome, auxiliar, ativo, ordem) VALUES ('Societário', 0, 1, 0)").run();
  const societario = idDoSetor('Societário');

  const processo = processos.criar({ tipo_processo_id: tipoCertidoes.id, cliente_id: cliente.id }, admin);
  conn
    .prepare(
      `INSERT INTO checklist (processo_id, setor_id, codigo, item, obrigatorio, ordem, status_item)
       VALUES (?, ?, 'CHK-SOC', 'Contrato societário conferido?', 1, 0, 'Pendente')`
    )
    .run(processo.id, societario);

  // Sem situação cadastrada para o setor, o motor simplesmente o pula.
  processos.recalcularStatus(processo.id, admin);
  assert.notStrictEqual(processos.obter(processo.id).status, 'Em Análise Societária');

  const criada = statusDom.criar({ nome: 'Em Análise Societária', cor: 'roxo', setor_id: societario });
  assert.strictEqual(criada.setor_nome, 'Societário');

  processos.recalcularStatus(processo.id, admin);
  const depois = processos.obter(processo.id);
  assert.strictEqual(depois.status, 'Em Análise Societária', 'o setor novo passou a ter situação própria');
  assert.strictEqual(depois.status_cor, 'roxo');

  // E some quando o item do setor é respondido.
  const item = checklist
    .doProcesso(processo.id)
    .find((i) => i.setor === 'Societário');
  checklist.responder(item.id, { resposta: 'Sim' }, admin);
  processos.recalcularStatus(processo.id, admin);
  assert.notStrictEqual(processos.obter(processo.id).status, 'Em Análise Societária');
});

test('"mantém a escolha manual" é uma marca da situação, não um nome no código', () => {
  const dominio = statusDom.porNome('Liberado para atualização/cadastro no Sistema Domínio');
  assert.strictEqual(dominio.mantem_manual, 1);

  const processo = processos.criar({ tipo_processo_id: tipoCertidoes.id, cliente_id: cliente.id }, admin);
  for (const item of checklist.doProcesso(processo.id)) {
    if (!item.resposta) checklist.responder(item.id, { resposta: 'Sim' }, admin);
  }
  processos.recalcularStatus(processo.id, admin);
  assert.strictEqual(processos.obter(processo.id).status, 'Liberado');

  processos.definirStatusManual(processo.id, dominio.nome, admin);
  processos.recalcularStatus(processo.id, admin);
  assert.strictEqual(processos.obter(processo.id).status, dominio.nome, 'o checklist completo não a desfaz');

  // A mesma marca, ligada numa situação criada pelo escritório, faz o mesmo.
  const criada = statusDom.criar({ nome: 'Aguardando protocolo do contador', espera: 1, mantem_manual: 1 });
  processos.definirStatusManual(processo.id, criada.nome, admin);
  processos.recalcularStatus(processo.id, admin);
  assert.strictEqual(processos.obter(processo.id).status, criada.nome);

  processos.definirStatusManual(processo.id, 'Aguardando Cliente', admin);
  statusDom.remover(criada.id);
});

/* ------------------------------------------------------------------ HTTP */

test('o cadastro de situações é área de administrador', async () => {
  const comum = criarCliente(base);
  await comum.entrar('ana.paula', 'teste123');
  const resposta = await comum.get('/admin/tabelas');
  assert.strictEqual(resposta.status, 403);

  const token = await comum.token('/');
  const escrita = await comum.post('/admin/tabelas/status', { _csrf: token, nome: 'Intrusa' });
  assert.strictEqual(escrita.status, 403);
  assert.strictEqual(statusDom.porNome('Intrusa'), null);
});

test('o administrador vê a lista e o formulário na tela de Tipos e setores', async () => {
  const cliente2 = criarCliente(base);
  await cliente2.entrar('jacqueline', 'teste123');
  const html = await (await cliente2.get('/admin/tabelas')).text();

  assert.match(html, /Situações do processo/);
  assert.match(html, /name="cor"/, 'a cor é escolhida na tela');
  assert.match(html, /name="setor_id"/, 'a situação de análise por setor também');
  assert.match(html, /data-ordem-arrastavel/, 'a ordem é arrastável, como a dos setores');
  // A situação do sistema não oferece o botão de excluir.
  assert.ok(!/excluir-situacao-\d+" method="post"[\s\S]{0,400}Concluído/.test(html));
});
