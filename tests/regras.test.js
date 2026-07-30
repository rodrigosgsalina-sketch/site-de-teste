'use strict';

/**
 * Testes das regras de negócio centrais:
 *  - numeração automática do processo;
 *  - clonagem do CHECKLIST_MODELO (tipo + itens "Todos");
 *  - cálculo da data de previsão;
 *  - motor de status (análise por setor, impedimento, liberado);
 *  - bloqueio de conclusão e parâmetros que o governam;
 *  - registro automático de histórico;
 *  - visibilidade por setor.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgrilo-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'teste.db');

const db = require('../src/db');
const bcrypt = require('bcryptjs');
const seed = require('../src/db/seed-data');
const parametros = require('../src/domain/parametros');
const checklist = require('../src/domain/checklist');
const processos = require('../src/domain/processos');
const historico = require('../src/domain/historico');
const acesso = require('../src/domain/acesso');
const dashboard = require('../src/domain/dashboard');

/* ----------------------------------------------------------- preparação */
function carregar() {
  const conn = db.open();
  db.tx(() => {
    const setor = conn.prepare('INSERT INTO setores (nome, auxiliar, ordem) VALUES (?, ?, ?)');
    seed.SETORES.forEach((s) => setor.run(s.nome, s.auxiliar, s.ordem));

    const tipo = conn.prepare('INSERT INTO tipos_processo (nome, ativo, ordem) VALUES (?, ?, ?)');
    seed.TIPOS_PROCESSO.forEach((t) => tipo.run(t.nome, t.ativo, t.ordem));

    const status = conn.prepare('INSERT INTO status_processo (nome, ordem, final, espera) VALUES (?, ?, ?, ?)');
    seed.STATUS_PROCESSO.forEach((s) => status.run(s.nome, s.ordem, s.final, s.espera));

    const param = conn.prepare('INSERT INTO parametros (chave, valor, tipo, categoria, descricao) VALUES (?, ?, ?, ?, ?)');
    seed.PARAMETROS.forEach((p) => param.run(p.chave, p.valor, p.tipo, p.categoria, p.descricao));

    const idSetor = conn.prepare('SELECT id FROM setores WHERE nome = ?');
    const modelo = conn.prepare(
      'INSERT INTO checklist_modelo (tipo_processo_id, setor_id, item, obrigatorio, ordem) VALUES (?, ?, ?, ?, ?)'
    );
    const idTipo = conn.prepare('SELECT id FROM tipos_processo WHERE nome = ?');
    seed.CHECKLIST_MODELO.forEach((m, i) => {
      modelo.run(m.tipo ? idTipo.get(m.tipo).id : null, idSetor.get(m.setor).id, m.item, m.obrigatorio, i);
    });

    const usuario = conn.prepare(
      'INSERT INTO usuarios (nome, email, senha_hash, setor_id, perfil, status) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const hash = bcrypt.hashSync('teste123', 4);
    seed.USUARIOS.forEach((u) => usuario.run(u.nome, u.email, hash, idSetor.get(u.setor).id, u.perfil, u.status));
  });
  return conn;
}

const conn = carregar();
const admin = conn.prepare("SELECT u.*, s.nome AS setor FROM usuarios u JOIN setores s ON s.id = u.setor_id WHERE u.perfil = 'Administrador' LIMIT 1").get();
const fiscal = conn.prepare("SELECT u.*, s.nome AS setor FROM usuarios u JOIN setores s ON s.id = u.setor_id WHERE s.nome = 'Fiscal' AND u.perfil = 'Usuário' LIMIT 1").get();
const tipoBaixa = conn.prepare("SELECT id FROM tipos_processo WHERE nome = 'Baixa de Empresa'").get();
const tipoCertidoes = conn.prepare("SELECT id FROM tipos_processo WHERE nome = 'Emissão de Certidões'").get();

function novoProcesso(tipoId = tipoBaixa.id, extra = {}) {
  return processos.criar(
    { tipo_processo_id: tipoId, razao_social: 'Empresa Teste Ltda', cnpj: '00.000.000/0001-00', ...extra },
    admin
  );
}

/* ------------------------------------------------------------------ testes */

test('numeração automática segue PREFIXO-ANO-SEQUENCIAL e incrementa PROXIMO_PROCESSO', () => {
  const anoAtual = new Date().getFullYear();
  const p1 = novoProcesso();
  const p2 = novoProcesso();
  assert.match(p1.codigo, new RegExp(`^PR-${anoAtual}-\\d{4}$`));
  const seq1 = Number(p1.codigo.split('-')[2]);
  const seq2 = Number(p2.codigo.split('-')[2]);
  assert.strictEqual(seq2, seq1 + 1);
  assert.strictEqual(parametros.num('PROXIMO_PROCESSO'), seq2 + 1);
});

test('abertura clona os itens do tipo e os itens aplicados a todos os processos', () => {
  const processo = novoProcesso(tipoBaixa.id);
  const itens = checklist.doProcesso(processo.id);
  const doTipo = seed.CHECKLIST_MODELO.filter((m) => m.tipo === 'Baixa de Empresa').length;
  const deTodos = seed.CHECKLIST_MODELO.filter((m) => m.tipo === null).length;

  assert.strictEqual(itens.length, doTipo + deTodos);
  assert.ok(itens.every((i) => i.status_item === 'Pendente'));
  assert.ok(itens.some((i) => i.setor === 'Fiscal' && i.item === 'Possui débitos federais?'));
  assert.ok(itens.some((i) => i.setor === 'Financeiro' && i.item === 'Cliente está adimplente?'));
  // Itens opcionais preservam OBRIGATORIO = Não do modelo.
  const adimplente = itens.find((i) => i.item === 'Cliente está adimplente?');
  assert.strictEqual(adimplente.obrigatorio, 0);
});

test('previsão de conclusão soma PRAZO_PADRAO_PROCESSO_DIAS à abertura', () => {
  const processo = novoProcesso(tipoBaixa.id, { data_abertura: '2026-03-02' });
  const dias = parametros.num('PRAZO_PADRAO_PROCESSO_DIAS');
  const esperado = new Date('2026-03-02T12:00:00');
  esperado.setDate(esperado.getDate() + dias);
  assert.strictEqual(processo.data_previsao, esperado.toISOString().slice(0, 10));
});

test('status inicial é Aberto e evolui para "Em Análise" do setor pendente', () => {
  const processo = novoProcesso(tipoBaixa.id);
  const atual = processos.obter(processo.id);
  // Baixa de Empresa tem itens do Fiscal, portanto entra em análise fiscal.
  assert.strictEqual(atual.status, 'Em Análise Fiscal');
});

test('impedimento exige descrição e leva o processo para Impedido', () => {
  const processo = novoProcesso(tipoBaixa.id);
  const item = checklist.doProcesso(processo.id).find((i) => i.setor === 'Fiscal');

  assert.throws(
    () => checklist.responder(item.id, { resposta: 'Sim', possui_impedimento: 'Sim' }, fiscal),
    /Descreva o impedimento/
  );

  checklist.responder(
    item.id,
    { resposta: 'Sim', possui_impedimento: 'Sim', descricao_impedimento: 'Débitos federais em aberto.' },
    fiscal
  );
  processos.recalcularStatus(processo.id, fiscal);
  assert.strictEqual(processos.obter(processo.id).status, 'Impedido');
  assert.strictEqual(checklist.obterItem(item.id).status_item, 'Impedido');
});

test('processo com todos os obrigatórios concluídos fica Liberado', () => {
  const processo = novoProcesso(tipoCertidoes.id);
  checklist.doProcesso(processo.id).forEach((item) => {
    checklist.responder(item.id, { resposta: 'Sim' }, admin);
  });
  processos.recalcularStatus(processo.id, admin);
  assert.strictEqual(processos.obter(processo.id).status, 'Liberado');
});

test('conclusão é bloqueada com item obrigatório pendente e liberada quando tudo é respondido', () => {
  parametros.definir('EXIGIR_UPLOAD_DOCUMENTOS', 'Não');
  parametros.definir('EXIGIR_APROVACAO_GESTOR', 'Não');

  const processo = novoProcesso(tipoCertidoes.id);
  const itens = checklist.doProcesso(processo.id);
  assert.ok(processos.validarConclusao(processo.id, admin).length > 0);
  assert.throws(() => processos.concluir(processo.id, admin), /obrigatório/i);

  itens.forEach((item) => checklist.responder(item.id, { resposta: 'Sim' }, admin));
  assert.deepStrictEqual(processos.validarConclusao(processo.id, admin), []);

  const concluido = processos.concluir(processo.id, admin);
  assert.strictEqual(concluido.status, 'Concluído');
  assert.strictEqual(concluido.data_conclusao, new Date().toISOString().slice(0, 10));
});

test('itens opcionais não bloqueiam a conclusão quando EXIGIR_CHECKLIST_100 está desligado', () => {
  parametros.definir('EXIGIR_CHECKLIST_100', 'Não');
  parametros.definir('EXIGIR_UPLOAD_DOCUMENTOS', 'Não');
  parametros.definir('EXIGIR_APROVACAO_GESTOR', 'Não');

  const processo = novoProcesso(tipoCertidoes.id);
  checklist
    .doProcesso(processo.id)
    .filter((i) => i.obrigatorio)
    .forEach((item) => checklist.responder(item.id, { resposta: 'Sim' }, admin));

  assert.deepStrictEqual(processos.validarConclusao(processo.id, admin), []);
  parametros.definir('EXIGIR_CHECKLIST_100', 'Sim');
  assert.ok(processos.validarConclusao(processo.id, admin).some((p) => /EXIGIR_CHECKLIST_100/.test(p)));
  parametros.definir('EXIGIR_CHECKLIST_100', 'Não');
});

test('BLOQUEAR_CONCLUSAO_COM_PENDENCIA desligado permite concluir com pendência', () => {
  parametros.definir('EXIGIR_UPLOAD_DOCUMENTOS', 'Não');
  parametros.definir('EXIGIR_APROVACAO_GESTOR', 'Não');
  parametros.definir('EXIGIR_REVISAO_FINAL', 'Não');

  const processo = novoProcesso(tipoBaixa.id);
  assert.ok(processos.validarConclusao(processo.id, admin).length > 0);

  parametros.definir('BLOQUEAR_CONCLUSAO_COM_PENDENCIA', 'Não');
  assert.deepStrictEqual(processos.validarConclusao(processo.id, admin), []);
  parametros.definir('BLOQUEAR_CONCLUSAO_COM_PENDENCIA', 'Sim');
  parametros.definir('EXIGIR_REVISAO_FINAL', 'Sim');
});

test('EXIGIR_UPLOAD_DOCUMENTOS bloqueia a conclusão sem anexos', () => {
  parametros.definir('EXIGIR_UPLOAD_DOCUMENTOS', 'Sim');
  const processo = novoProcesso(tipoCertidoes.id);
  checklist.doProcesso(processo.id).forEach((item) => checklist.responder(item.id, { resposta: 'Sim' }, admin));

  assert.ok(processos.validarConclusao(processo.id, admin).some((p) => /documento/i.test(p)));

  db.get()
    .prepare('INSERT INTO documentos (processo_id, nome_original, nome_arquivo) VALUES (?, ?, ?)')
    .run(processo.id, 'contrato.pdf', 'x.pdf');
  assert.deepStrictEqual(processos.validarConclusao(processo.id, admin), []);
  parametros.definir('EXIGIR_UPLOAD_DOCUMENTOS', 'Não');
});

test('EXIGIR_APROVACAO_JURIDICA = Não faz os itens do Jurídico não bloquearem', () => {
  const tipoRecuperacao = conn.prepare("SELECT id FROM tipos_processo WHERE nome = 'Recuperação de Empresa'").get();
  parametros.definir('EXIGIR_APROVACAO_JURIDICA', 'Não');
  parametros.definir('EXIGIR_UPLOAD_DOCUMENTOS', 'Não');
  parametros.definir('EXIGIR_APROVACAO_GESTOR', 'Não');

  const processo = novoProcesso(tipoRecuperacao.id);
  checklist
    .doProcesso(processo.id)
    .filter((i) => i.setor !== 'Jurídico')
    .forEach((item) => checklist.responder(item.id, { resposta: 'Sim' }, admin));

  assert.deepStrictEqual(processos.validarConclusao(processo.id, admin), []);

  parametros.definir('EXIGIR_APROVACAO_JURIDICA', 'Sim');
  assert.ok(processos.validarConclusao(processo.id, admin).some((p) => /Jurídico/.test(p)));
  parametros.definir('EXIGIR_APROVACAO_JURIDICA', 'Não');
});

test('toda ação relevante gera histórico automaticamente', () => {
  const processo = novoProcesso(tipoCertidoes.id);
  const item = checklist.doProcesso(processo.id)[0];
  checklist.responder(item.id, { resposta: 'Sim' }, admin);
  historico.registrar({ processoId: processo.id, acao: `Aprovação ${item.setor}`, usuario: admin });
  processos.recalcularStatus(processo.id, admin);

  const linhas = historico.doProcesso(processo.id);
  assert.ok(linhas.some((h) => h.acao === 'Processo Criado'));
  assert.ok(linhas.every((h) => h.data_hora && h.usuario_nome));
});

test('usuário comum só enxerga os setores dele; gestor enxerga tudo', () => {
  const usuarioFiscal = { ...fiscal, setor: 'Fiscal', perfil: 'Usuário' };
  assert.deepStrictEqual(acesso.setoresDoUsuario(usuarioFiscal), ['Fiscal']);
  assert.strictEqual(acesso.ehGestor(usuarioFiscal), false);
  assert.strictEqual(acesso.setorIdsDoUsuario({ ...admin, perfil: 'Administrador' }), null);

  const processoCertidoes = novoProcesso(tipoCertidoes.id);
  const itens = checklist.doProcesso(processoCertidoes.id);
  const itemFiscal = itens.find((i) => i.setor === 'Fiscal');
  const itemParalegal = itens.find((i) => i.setor === 'Paralegal');
  assert.strictEqual(acesso.podeEditarItem(usuarioFiscal, itemFiscal), true);
  assert.strictEqual(acesso.podeEditarItem(usuarioFiscal, itemParalegal), false);

  // Administrativo responde também pelos setores auxiliares.
  const administrativo = { id: -1, setor: 'Administrativo', perfil: 'Usuário' };
  assert.ok(acesso.setoresDoUsuario(administrativo).includes('Qualidade'));
});

test('status manual de espera é preservado enquanto houver pendências', () => {
  parametros.definir('PERMITIR_PULAR_ETAPAS', 'Não');
  const processo = novoProcesso(tipoBaixa.id);
  processos.definirStatusManual(processo.id, 'Aguardando Junta Comercial', admin);
  processos.recalcularStatus(processo.id, admin);
  assert.strictEqual(processos.obter(processo.id).status, 'Aguardando Junta Comercial');

  // Status que não é de espera exige PERMITIR_PULAR_ETAPAS.
  assert.throws(() => processos.definirStatusManual(processo.id, 'Em Análise Contábil', admin), /PERMITIR_PULAR_ETAPAS/);
});

test('processos atrasados aparecem no alerta de prazo', () => {
  const processo = novoProcesso(tipoBaixa.id);
  db.get().prepare("UPDATE processos SET data_previsao = date('now', '-2 day') WHERE id = ?").run(processo.id);
  const alertas = processos.comAlertaDePrazo();
  const alvo = alertas.find((p) => p.id === processo.id);
  assert.ok(alvo, 'processo vencido deveria estar na lista de alertas');
  assert.strictEqual(alvo.dias_restantes, -2);
});

test('dashboard agrega indicadores sem erro', () => {
  const dados = dashboard.montar();
  assert.ok(dados.indicadores.total > 0);
  assert.ok(Array.isArray(dados.porStatus) && dados.porStatus.length > 0);
  assert.ok(Array.isArray(dados.ranking));
  assert.strictEqual(typeof dados.indicadores.meta, 'number');
});

test.after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
