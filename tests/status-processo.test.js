'use strict';

/**
 * A situação do processo: quem muda, quem fica sabendo e quem pode encerrar.
 *
 *  - toda mudança de situação avisa o escritório inteiro, venha ela da mão de
 *    alguém ou do próprio checklist andando;
 *  - concluir deixou de ser privilégio de Administrador/Diretoria: quem
 *    participa conclui, desde que cumpra os requisitos que já existiam;
 *  - "Liberado para atualização/cadastro no Sistema Domínio" é a situação nova,
 *    e ela precisa sobreviver ao recálculo — é escolhida justamente quando o
 *    checklist já venceu.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgrilo-status-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'teste.db');

const db = require('../src/db');
const { carregarSeed } = require('./apoio');
const conn = carregarSeed(db);

const parametros = require('../src/domain/parametros');
const processos = require('../src/domain/processos');
const checklist = require('../src/domain/checklist');
const avisos = require('../src/domain/avisos');
const clientesDom = require('../src/domain/clientes');

const STATUS_DOMINIO = 'Liberado para atualização/cadastro no Sistema Domínio';

const usuario = (login) => conn.prepare('SELECT * FROM usuarios WHERE login = ?').get(login);
const admin = usuario('jacqueline');
const comum = conn
  .prepare("SELECT * FROM usuarios WHERE perfil = 'Usuário' AND status = 'Ativo' LIMIT 1")
  .get();

const cliente = clientesDom.criar(
  { codigo: '9001', nome: 'Empresa da Situação', razao_social: 'Empresa da Situação LTDA' },
  admin,
  'Manual'
);
const tipoCertidoes = conn.prepare("SELECT * FROM tipos_processo WHERE nome = 'Emissão de Certidões'").get();

function novoProcesso(tipoId = tipoCertidoes.id) {
  return processos.criar({ tipo_processo_id: tipoId, cliente_id: cliente.id }, admin);
}

/** Avisos publicados durante `acao`, na ordem. */
function avisosPublicadosEm(acao) {
  const antes = conn.prepare('SELECT COALESCE(MAX(id), 0) AS ultimo FROM avisos').get().ultimo;
  acao();
  return conn.prepare('SELECT * FROM avisos WHERE id > ? ORDER BY id').all(antes);
}

/** Responde todo o checklist, deixando o processo pronto para concluir. */
function responderTudo(processoId, quem) {
  for (const item of checklist.doProcesso(processoId)) {
    if (!item.resposta) checklist.responder(item.id, { resposta: 'Sim' }, quem);
  }
  processos.recalcularStatus(processoId, quem);
}

/* --------------------------------------------- 1. aviso a cada mudança */

test('mudar a situação na mão avisa todo o escritório', () => {
  const processo = novoProcesso();

  const publicados = avisosPublicadosEm(() => {
    processos.definirStatusManual(processo.id, 'Aguardando Cliente', admin, 'Faltam documentos.');
  });

  const aviso = publicados.find((a) => a.tipo === avisos.TIPOS.STATUS);
  assert.ok(aviso, 'a mudança de situação precisa publicar aviso');
  assert.strictEqual(aviso.escopo, 'todos', 'o aviso é para todos os usuários, não por setor');
  assert.match(aviso.titulo, new RegExp(processo.codigo));
  assert.match(aviso.mensagem, /Aguardando Cliente/);
  assert.match(aviso.mensagem, /Faltam documentos\./, 'a observação de quem mudou entra na mensagem');
  assert.match(aviso.mensagem, new RegExp(admin.nome), 'a mensagem diz quem mudou');
});

test('a situação que o checklist muda sozinho também avisa todo o escritório', () => {
  const processo = novoProcesso();
  const antes = processos.obter(processo.id).status;

  const publicados = avisosPublicadosEm(() => responderTudo(processo.id, admin));

  const aviso = publicados.find((a) => a.tipo === avisos.TIPOS.STATUS);
  assert.ok(aviso, 'andar o checklist até liberar o processo precisa avisar');
  assert.strictEqual(aviso.escopo, 'todos');
  assert.match(aviso.mensagem, new RegExp(antes), 'a mensagem mostra de onde saiu');
  assert.match(aviso.mensagem, /Liberado/, 'e para onde foi');
});

test('situação parada não vira aviso — só a mudança avisa', () => {
  const processo = novoProcesso();
  responderTudo(processo.id, admin);

  const publicados = avisosPublicadosEm(() => {
    processos.recalcularStatus(processo.id, admin);
    processos.recalcularStatus(processo.id, admin);
  });

  assert.deepStrictEqual(
    publicados.filter((a) => a.tipo === avisos.TIPOS.STATUS),
    []
  );
});

test('impedimento não gera dois avisos: vale o do checklist, que traz o motivo', () => {
  const processo = novoProcesso();
  const item = checklist.doProcesso(processo.id)[0];

  const publicados = avisosPublicadosEm(() => {
    checklist.responder(
      item.id,
      { resposta: 'Não', possui_impedimento: 'Sim', descricao_impedimento: 'Certidão negada.' },
      admin
    );
    processos.recalcularStatus(processo.id, admin);
  });

  assert.strictEqual(processos.obter(processo.id).status, 'Impedido');
  assert.deepStrictEqual(
    publicados.filter((a) => a.tipo === avisos.TIPOS.STATUS),
    [],
    'o aviso genérico calaria em cima do impedimento, que diz o motivo'
  );
  const impedimento = publicados.find((a) => a.tipo === avisos.TIPOS.IMPEDIDO);
  assert.ok(impedimento);
  assert.match(impedimento.mensagem, /Certidão negada\./);
});

test('abrir e reabrir têm aviso próprio — não sai o de mudança de situação junto', () => {
  const abertura = avisosPublicadosEm(() => {
    const processo = novoProcesso();
    return processo;
  });
  assert.deepStrictEqual(abertura.filter((a) => a.tipo === avisos.TIPOS.STATUS), []);

  const processo = novoProcesso();
  parametros.definir('EXIGIR_UPLOAD_DOCUMENTOS', 'Não');
  responderTudo(processo.id, admin);
  processos.concluir(processo.id, admin);

  const reabertura = avisosPublicadosEm(() => processos.reabrir(processo.id, admin, 'Faltou uma certidão.'));
  assert.deepStrictEqual(reabertura.filter((a) => a.tipo === avisos.TIPOS.STATUS), []);
  assert.ok(reabertura.some((a) => a.tipo === avisos.TIPOS.REABERTO));
});

/* ------------------------------------------- 2. conclusão sem crachá */

test('usuário comum conclui o processo quando os requisitos estão cumpridos', () => {
  parametros.definir('EXIGIR_UPLOAD_DOCUMENTOS', 'Não');
  const processo = novoProcesso();
  responderTudo(processo.id, comum);

  assert.notStrictEqual(comum.perfil, 'Administrador', 'o teste precisa de alguém sem perfil de gestor');
  assert.deepStrictEqual(processos.validarConclusao(processo.id), []);

  const concluido = processos.concluir(processo.id, comum);
  assert.strictEqual(concluido.status, 'Concluído');
});

test('os requisitos que já existiam continuam segurando a conclusão', () => {
  parametros.definir('EXIGIR_UPLOAD_DOCUMENTOS', 'Sim');
  const processo = novoProcesso();
  responderTudo(processo.id, comum);

  const problemas = processos.validarConclusao(processo.id);
  assert.ok(problemas.some((p) => /documento/i.test(p)), 'sem anexo, ninguém conclui — nem o gestor');
  assert.throws(() => processos.concluir(processo.id, admin), /documento/i);
  parametros.definir('EXIGIR_UPLOAD_DOCUMENTOS', 'Não');
});

test('a migração apaga o parâmetro que reservava a conclusão ao gestor', () => {
  // Instalação antiga: o parâmetro está lá, e a regra que o lia já saiu do
  // código. Deixá-lo na tela seria oferecer um botão que não liga em nada.
  conn
    .prepare(
      `INSERT INTO parametros (chave, valor, tipo, categoria, descricao)
       VALUES ('EXIGIR_APROVACAO_GESTOR', 'Sim', 'booleano', 'Fluxo', 'Regra aposentada')`
    )
    .run();

  db.migrate(conn);

  const linha = conn.prepare("SELECT 1 FROM parametros WHERE chave = 'EXIGIR_APROVACAO_GESTOR'").get();
  assert.strictEqual(linha, undefined);
});

/* ----------------------------- 3. liberação para o Sistema Domínio */

test('a situação do Sistema Domínio existe e pode ser escolhida na mão', () => {
  const linha = conn.prepare('SELECT * FROM status_processo WHERE nome = ?').get(STATUS_DOMINIO);
  assert.ok(linha, 'a situação precisa estar cadastrada');
  assert.strictEqual(linha.final, 0, 'ela não encerra o processo');
  assert.strictEqual(linha.espera, 1, 'sem isto, não dá para escolhê-la sem PERMITIR_PULAR_ETAPAS');

  const processo = novoProcesso();
  const atualizado = processos.definirStatusManual(processo.id, STATUS_DOMINIO, admin);
  assert.strictEqual(atualizado.status, STATUS_DOMINIO);
});

test('a liberação para o Domínio sobrevive ao recálculo do checklist completo', () => {
  const processo = novoProcesso();
  responderTudo(processo.id, admin);
  assert.strictEqual(processos.obter(processo.id).status, 'Liberado');

  processos.definirStatusManual(processo.id, STATUS_DOMINIO, admin);
  processos.recalcularStatus(processo.id, admin);

  assert.strictEqual(
    processos.obter(processo.id).status,
    STATUS_DOMINIO,
    'o checklist completo não pode desfazer a liberação para o Domínio'
  );
});

test('um impedimento ainda passa por cima da liberação para o Domínio', () => {
  const processo = novoProcesso();
  responderTudo(processo.id, admin);
  processos.definirStatusManual(processo.id, STATUS_DOMINIO, admin);

  const item = checklist.doProcesso(processo.id)[0];
  checklist.reabrir(item.id);
  checklist.responder(
    item.id,
    { resposta: 'Não', possui_impedimento: 'Sim', descricao_impedimento: 'Certidão vencida.' },
    admin
  );
  processos.recalcularStatus(processo.id, admin);

  assert.strictEqual(processos.obter(processo.id).status, 'Impedido');
});

test('a situação nova vem antes das finais na lista da tela', () => {
  const lista = conn.prepare('SELECT nome FROM status_processo ORDER BY ordem').all().map((s) => s.nome);
  assert.ok(lista.indexOf(STATUS_DOMINIO) > lista.indexOf('Liberado'));
  assert.ok(lista.indexOf(STATUS_DOMINIO) < lista.indexOf('Concluído'));
});

test('a migração leva a situação nova para quem já tinha o banco em uso', () => {
  // Instalação anterior à mudança: a situação não existe, e a carga inicial
  // (`npm run seed`) não roda de novo num banco que já está em uso. Os
  // processos que os testes acima deixaram nela voltam para "Liberado", que é
  // onde estariam antes de a situação existir.
  conn
    .prepare(
      `UPDATE processos SET status_id = (SELECT id FROM status_processo WHERE nome = 'Liberado')
        WHERE status_id = (SELECT id FROM status_processo WHERE nome = @nome)`
    )
    .run({ nome: STATUS_DOMINIO });
  conn.prepare('DELETE FROM status_processo WHERE nome = ?').run(STATUS_DOMINIO);
  conn.prepare("UPDATE status_processo SET ordem = 13 WHERE nome = 'Concluído'").run();
  conn.prepare("UPDATE status_processo SET ordem = 14 WHERE nome = 'Cancelado'").run();

  db.migrate(conn);

  const nova = conn.prepare('SELECT * FROM status_processo WHERE nome = ?').get(STATUS_DOMINIO);
  assert.ok(nova, 'a migração precisa criar a situação');
  assert.strictEqual(nova.espera, 1);

  const lista = conn.prepare('SELECT nome FROM status_processo ORDER BY ordem').all().map((s) => s.nome);
  assert.ok(
    lista.indexOf(STATUS_DOMINIO) < lista.indexOf('Concluído'),
    'e precisa reordenar as finais, senão a nova cai no fim da lista'
  );
});
