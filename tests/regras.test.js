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
const avisos = require('../src/domain/avisos');
const dashboard = require('../src/domain/dashboard');
const ordemSetores = require('../src/domain/ordem-setores');
const clientesDom = require('../src/domain/clientes');
const importacao = require('../src/domain/importacao-clientes');
const XLSX = require('xlsx');
const usuariosDom = require('../src/domain/usuarios');

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
      'INSERT INTO usuarios (nome, login, email, senha_hash, setor_id, perfil, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const hash = bcrypt.hashSync('teste123', 4);
    seed.USUARIOS.forEach((u) =>
      usuario.run(u.nome, u.login, u.email, hash, idSetor.get(u.setor).id, u.perfil, u.status)
    );
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

/* ------------------------------------------------- login por ID de usuário */

test('autenticação usa o ID de usuário, não o e-mail', () => {
  const entrada = usuariosDom.autenticar('ana.paula', 'teste123');
  assert.ok(entrada, 'deveria entrar com o ID de usuário');
  assert.strictEqual(entrada.nome, 'Ana Paula');
  assert.strictEqual(entrada.login, 'ana.paula');

  // ID é normalizado: maiúsculas e acentos não impedem o acesso.
  assert.ok(usuariosDom.autenticar('Ana Paula', 'teste123'), 'deveria aceitar "Ana Paula"');
  assert.ok(usuariosDom.autenticar('  ANA.PAULA ', 'teste123'), 'deveria aceitar com espaços e maiúsculas');

  assert.strictEqual(usuariosDom.autenticar('ana.paula', 'senha-errada'), null);
  assert.strictEqual(usuariosDom.autenticar('nao.existe', 'teste123'), null);
});

test('ID de usuário é único e o e-mail passa a ser opcional', () => {
  const setorFiscal = conn.prepare("SELECT id FROM setores WHERE nome = 'Fiscal'").get();
  const criado = usuariosDom.criar({
    nome: 'Teste Sem Email',
    senha: 'teste123',
    setor_id: setorFiscal.id,
    perfil: 'Usuário',
  });
  assert.strictEqual(criado.login, 'teste.sem.email'); // derivado do nome
  assert.strictEqual(criado.email, null);
  assert.ok(usuariosDom.autenticar('teste.sem.email', 'teste123'));

  assert.throws(
    () =>
      usuariosDom.criar({
        nome: 'Outro',
        login: 'ana.paula',
        senha: 'teste123',
        setor_id: setorFiscal.id,
      }),
    /já está em uso/
  );
});

/* --------------------------------------------------- avisos para todos ---- */

test('conclusão e impedimento publicam aviso visível para todos os usuários', () => {
  parametros.definir('EXIGIR_UPLOAD_DOCUMENTOS', 'Não');
  parametros.definir('EXIGIR_APROVACAO_GESTOR', 'Não');
  parametros.definir('EXIGIR_REVISAO_FINAL', 'Não');

  const antes = avisos.listar(admin.id, 500).length;

  // impedimento
  const impedido = novoProcesso(tipoBaixa.id);
  const itemFiscal = checklist.doProcesso(impedido.id).find((i) => i.setor === 'Fiscal');
  checklist.responder(
    itemFiscal.id,
    { resposta: 'Sim', possui_impedimento: 'Sim', descricao_impedimento: 'Certidão vencida.' },
    fiscal
  );

  // conclusão
  const concluido = novoProcesso(tipoCertidoes.id);
  checklist.doProcesso(concluido.id).forEach((i) => checklist.responder(i.id, { resposta: 'Sim' }, admin));
  processos.concluir(concluido.id, admin);

  const lista = avisos.listar(admin.id, 500);
  assert.strictEqual(lista.length, antes + 2);

  const avisoConclusao = lista.find((a) => a.tipo === 'concluido' && a.processo_id === concluido.id);
  const avisoImpedimento = lista.find((a) => a.tipo === 'impedido' && a.processo_id === impedido.id);
  assert.ok(avisoConclusao, 'deveria publicar aviso de conclusão');
  assert.ok(avisoImpedimento, 'deveria publicar aviso de impedimento');
  assert.match(avisoImpedimento.mensagem, /Certidão vencida/);

  // O aviso vale para qualquer usuário, não só para quem agiu.
  assert.ok(avisos.contarNaoLidos(fiscal.id) >= 2);
  assert.ok(avisos.contarNaoLidos(admin.id) >= 2);

  // Dispensar afeta apenas quem dispensou.
  avisos.marcarLido(avisoConclusao.id, fiscal.id);
  assert.ok(
    !avisos.naoLidos(fiscal.id, 50).some((a) => a.id === avisoConclusao.id),
    'o aviso deveria sumir para quem dispensou'
  );
  assert.ok(
    avisos.naoLidos(admin.id, 50).some((a) => a.id === avisoConclusao.id),
    'o aviso deveria continuar visível para os demais'
  );

  const anteriores = avisos.contarNaoLidos(fiscal.id);
  assert.ok(anteriores > 0);
  avisos.marcarTodosLidos(fiscal.id);
  assert.strictEqual(avisos.contarNaoLidos(fiscal.id), 0);

  parametros.definir('EXIGIR_REVISAO_FINAL', 'Sim');
});

/* ------------------------------------------- ordem de atendimento por tipo */

test('ordem dos setores definida por tipo governa checklist, etapa e status', () => {
  // Sem ordem própria, "Baixa de Empresa" segue a ordem geral: Paralegal antes do DP.
  const padrao = ordemSetores.doTipo(tipoBaixa.id).map((s) => s.nome);
  assert.ok(padrao.indexOf('Paralegal') < padrao.indexOf('Departamento Pessoal'));

  const processoPadrao = novoProcesso(tipoBaixa.id);
  assert.strictEqual(processos.obter(processoPadrao.id).status, 'Em Análise Fiscal');

  // Departamento Pessoal primeiro, Paralegal por último.
  const ids = ordemSetores.doTipo(tipoBaixa.id);
  const dp = ids.find((s) => s.nome === 'Departamento Pessoal');
  const paralegal = ids.find((s) => s.nome === 'Paralegal');
  const demais = ids.filter((s) => s !== dp && s !== paralegal);
  ordemSetores.definir(tipoBaixa.id, [dp.id, ...demais.map((s) => s.id), paralegal.id]);

  const nova = ordemSetores.doTipo(tipoBaixa.id).map((s) => s.nome);
  assert.strictEqual(nova[0], 'Departamento Pessoal');
  assert.strictEqual(nova.at(-1), 'Paralegal');

  // O agrupamento do checklist — inclusive de processo já aberto — acompanha.
  const grupos = checklist.agrupadoPorSetor(processoPadrao.id).map((g) => g.setor);
  assert.strictEqual(grupos[0], 'Departamento Pessoal');
  assert.strictEqual(grupos.at(-1), 'Paralegal');

  // O motor de status passa a apontar para o setor que agora vem primeiro.
  processos.recalcularStatus(processoPadrao.id, admin, { silencioso: true });
  assert.strictEqual(processos.obter(processoPadrao.id).status, 'Em Análise Departamento Pessoal');
  assert.match(processos.obter(processoPadrao.id).etapa_atual, /Departamento Pessoal/);

  // Processos abertos depois nascem com a mesma ordem.
  const novo = novoProcesso(tipoBaixa.id);
  assert.strictEqual(processos.obter(novo.id).status, 'Em Análise Departamento Pessoal');

  // "Mover" reposiciona um setor de cada vez.
  ordemSetores.mover(tipoBaixa.id, dp.id, 1);
  assert.strictEqual(ordemSetores.doTipo(tipoBaixa.id)[1].nome, 'Departamento Pessoal');
  ordemSetores.mover(tipoBaixa.id, dp.id, -1);
  assert.strictEqual(ordemSetores.doTipo(tipoBaixa.id)[0].nome, 'Departamento Pessoal');

  // Limpar devolve o tipo à ordem geral, sem afetar outros tipos.
  ordemSetores.limpar(tipoBaixa.id);
  assert.deepStrictEqual(ordemSetores.doTipo(tipoBaixa.id).map((s) => s.nome), padrao);
  processos.recalcularStatus(processoPadrao.id, admin, { silencioso: true });
  assert.strictEqual(processos.obter(processoPadrao.id).status, 'Em Análise Fiscal');
});

test('ordem personalizada de um tipo não interfere nos demais', () => {
  const antesCertidoes = ordemSetores.doTipo(tipoCertidoes.id).map((s) => s.nome);
  const baixa = ordemSetores.doTipo(tipoBaixa.id);
  ordemSetores.definir(tipoBaixa.id, [...baixa.map((s) => s.id)].reverse());

  assert.deepStrictEqual(ordemSetores.doTipo(tipoCertidoes.id).map((s) => s.nome), antesCertidoes);
  assert.deepStrictEqual(
    ordemSetores.doTipo(tipoBaixa.id).map((s) => s.nome),
    baixa.map((s) => s.nome).reverse()
  );
  ordemSetores.limpar(tipoBaixa.id);
});

/* ------------------------------------------------------- clientes/empresas */

/** Monta uma planilha no formato de ficha do Domínio (rótulo: valor). */
function planilhaFicha(empresas) {
  const linhas = [];
  empresas.forEach((e, i) => {
    linhas.push(['Empresa:', '', 'J S GRILO & GALVAO', '', '', '', '', '', '', '', '', 'Página:', '', `${i + 1}/2`]);
    linhas.push(['C.N.P.J.:', '05.605.572/0001-18', '', '', '', '', '', '', '', '', '', 'Emissão:', '', '03/08/2026']);
    linhas.push(['EMPRESAS']);
    linhas.push(['DADOS CADASTRAIS']);
    linhas.push(['Código:', '', '', '', e.codigo, '', '', 'Data da inscrição:', '', '14/04/2003']);
    linhas.push(['Apelido:', '', '', '', e.apelido, '', '', 'Insc. Suframa:', '', '']);
    linhas.push(['Nome:', '', '', '', e.nome, '', '', 'Natureza Jurídica:', '', 'Sociedade Empresária Limitada']);
    linhas.push(['Razão social:', '', '', '', e.razao, '', '', 'Contador:', '', 'JACQUELINE']);
    linhas.push(['Município:', '', '', '', e.municipio, '', '', 'Situação:', '', e.situacao]);
    linhas.push(['UF:', '', '', '', e.uf, '', '', 'Início atividades:', '', '01/09/2001']);
    linhas.push(['Complemento:', '', '', '', '', '', '', 'Motivo:', '', 'Outras']);
    linhas.push(['CNPJ/CPF/CEI/CAEPF:', '', '', '', e.cnpj, '', '', 'Capital social:', '', '40.000,00']);
    linhas.push(['Insc. estadual:', '', '', '', '20.200.893-2', '', '', 'Data:', '', '09/10/2013']);
  });
  const ws = XLSX.utils.aoa_to_sheet(linhas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Empresas');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('importação lê o relatório de empresas do Domínio (formato de ficha)', () => {
  const buffer = planilhaFicha([
    { codigo: '1', apelido: 'JS GRILO', nome: 'J S GRILO & GALVAO SERVICOS CONTABEIS',
      razao: 'J S GRILO & GALVAO SERVICOS CONTABEIS LTDA', municipio: 'GOIANINHA', uf: 'RN',
      cnpj: '05.605.572/0001-18', situacao: 'Ativa' },
    { codigo: '2', apelido: 'BRANDAO', nome: 'BRANDAO MATERIAL DE CONSTRUCAO LTDA ME',
      razao: 'BRANDAO MATERIAL DE CONSTRUCAO LTDA ME', municipio: 'NATAL', uf: 'RN',
      cnpj: '11.222.333/0001-44', situacao: 'Inativa' },
  ]);

  const analise = importacao.analisar(buffer);
  assert.strictEqual(analise.formato, 'ficha');
  assert.strictEqual(analise.registros.length, 2);
  assert.strictEqual(analise.novos, 2);
  assert.strictEqual(analise.erros.length, 0);
  // o cabeçalho de página não vira empresa nem campo
  assert.deepStrictEqual(analise.naoReconhecidos, []);

  const primeiro = analise.registros[0];
  assert.strictEqual(primeiro.apelido, 'JS GRILO');
  assert.strictEqual(primeiro.razao_social, 'J S GRILO & GALVAO SERVICOS CONTABEIS LTDA');
  assert.strictEqual(primeiro.cnpj_cpf, '05.605.572/0001-18');
  assert.strictEqual(primeiro.capital_social, '40.000,00');
  // "Complemento" vazio não pode capturar o rótulo seguinte
  assert.ok(!primeiro.complemento);

  const resultado = importacao.importar(analise.registros, admin);
  assert.strictEqual(resultado.criados, 2);
  assert.strictEqual(resultado.falhas.length, 0);

  const gravado = clientesDom.porCodigo('1');
  assert.strictEqual(gravado.nome, 'J S GRILO & GALVAO SERVICOS CONTABEIS');
  assert.strictEqual(gravado.municipio, 'GOIANINHA');
  assert.strictEqual(gravado.uf, 'RN');
  assert.strictEqual(gravado.situacao, 'Ativa');
  assert.strictEqual(gravado.origem, 'Importação');
  // datas viram ISO e o capital vira número
  assert.strictEqual(gravado.inicio_atividades, '2001-09-01');
  assert.strictEqual(gravado.capital_social_valor, 40000);
});

test('reimportar atualiza pelo código e preserva a observação interna', () => {
  const buffer = planilhaFicha([
    { codigo: '1', apelido: 'JS GRILO', nome: 'NOME ATUALIZADO', razao: 'RAZAO ATUALIZADA',
      municipio: 'TERESINA', uf: 'PI', cnpj: '05.605.572/0001-18', situacao: 'Ativa' },
  ]);

  const antes = clientesDom.porCodigo('1');
  clientesDom.atualizar(antes.id, { ...antes, observacoes: 'Anotação do escritório.' });

  const analise = importacao.analisar(buffer);
  assert.strictEqual(analise.novos, 0);
  assert.strictEqual(analise.existentes, 1);

  // sem autorização para atualizar, nada muda
  const ignorado = importacao.importar(analise.registros, admin, { atualizarExistentes: false });
  assert.strictEqual(ignorado.ignorados, 1);
  assert.strictEqual(clientesDom.porCodigo('1').nome, 'J S GRILO & GALVAO SERVICOS CONTABEIS');

  const atualizado = importacao.importar(analise.registros, admin, { atualizarExistentes: true });
  assert.strictEqual(atualizado.atualizados, 1);
  const depois = clientesDom.porCodigo('1');
  assert.strictEqual(depois.nome, 'NOME ATUALIZADO');
  assert.strictEqual(depois.municipio, 'TERESINA');
  assert.strictEqual(depois.observacoes, 'Anotação do escritório.');
  assert.strictEqual(clientesDom.resumo().total, 2, 'não pode duplicar o cadastro');
});

test('importação aceita também planilha em tabela e recusa arquivo sem empresas', () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Código', 'Apelido', 'Nome', 'Razão Social', 'CNPJ', 'Cidade', 'UF', 'Situação'],
    ['500', 'PADARIA', 'Padaria Pão Quente', 'PADARIA PAO QUENTE LTDA', '12.345.678/0001-90', 'Teresina', 'PI', 'Ativa'],
    ['501', '', '', '', '', '', '', ''],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Empresas');
  const analise = importacao.analisar(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

  assert.strictEqual(analise.formato, 'tabela');
  assert.strictEqual(analise.registros.length, 1);
  assert.strictEqual(analise.erros.length, 1, 'linha sem nome é descartada com motivo');
  assert.match(analise.erros[0].motivo, /sem nome/);

  importacao.importar(analise.registros, admin);
  const gravado = clientesDom.porCodigo('500');
  assert.strictEqual(gravado.municipio, 'Teresina'); // "Cidade" é sinônimo de município
  assert.strictEqual(gravado.cnpj_cpf, '12.345.678/0001-90');

  const vazia = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(vazia, XLSX.utils.aoa_to_sheet([['Relatório qualquer'], ['sem empresas']]), 'X');
  assert.throws(
    () => importacao.analisar(XLSX.write(vazia, { type: 'buffer', bookType: 'xlsx' })),
    /Não encontrei empresas/
  );
});

test('cadastro de cliente valida código único e localiza por nome, CNPJ ou código', () => {
  const criado = clientesDom.criar(
    { codigo: '900', nome: 'Clínica Bem Viver', razao_social: 'CLINICA BEM VIVER LTDA',
      cnpj_cpf: '11.222.333/0001-44', municipio: 'Teresina', uf: 'pi', situacao: 'Ativa' },
    admin
  );
  assert.strictEqual(criado.uf, 'PI', 'UF é normalizada para maiúsculas');

  assert.throws(() => clientesDom.criar({ codigo: '900', nome: 'Outra' }, admin), /já existe/i);
  assert.throws(() => clientesDom.criar({ codigo: '', nome: 'Sem código' }, admin), /código/i);
  assert.throws(() => clientesDom.criar({ codigo: '901' }, admin), /nome ou a razão social/i);

  // busca tolerante: acento, caixa e CNPJ com ou sem pontuação
  assert.ok(clientesDom.listar({ busca: 'clinica' }).itens.some((c) => c.codigo === '900'));
  assert.ok(clientesDom.listar({ busca: 'BEM VIVER' }).itens.some((c) => c.codigo === '900'));
  assert.ok(clientesDom.listar({ busca: '11222333' }).itens.some((c) => c.codigo === '900'));
  assert.ok(clientesDom.listar({ busca: '900' }).itens.some((c) => c.codigo === '900'));
  assert.strictEqual(clientesDom.listar({ busca: 'inexistente-xyz' }).itens.length, 0);

  // filtro por situação e UF
  assert.ok(clientesDom.listar({ uf: 'PI' }).itens.every((c) => c.uf === 'PI'));
  assert.ok(clientesDom.listar({ situacao: 'Ativa' }).itens.every((c) => c.situacao === 'Ativa'));
});

test('ficha do cliente lista os processos da empresa pelo CNPJ', () => {
  const cliente = clientesDom.criar(
    { codigo: '950', nome: 'Transportes Rio Norte', cnpj_cpf: '98.765.432/0001-10' },
    admin
  );
  assert.deepStrictEqual(clientesDom.processosDoCliente(cliente), []);

  // o processo grava o CNPJ com pontuação diferente — o vínculo ignora a máscara
  const processo = novoProcesso(tipoCertidoes.id, {
    razao_social: 'Transportes Rio Norte S.A.',
    cnpj: '98765432000110',
  });
  const vinculados = clientesDom.processosDoCliente(cliente);
  assert.strictEqual(vinculados.length, 1);
  assert.strictEqual(vinculados[0].codigo, processo.codigo);
});

test.after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
