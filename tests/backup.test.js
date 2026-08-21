'use strict';

/**
 * Testes do backup completo:
 *  - o arquivo contém todas as tabelas e uma assinatura de integridade;
 *  - a restauração repõe o retrato exato e desfaz o que veio depois;
 *  - arquivo adulterado, de outra origem ou de versão futura é recusado;
 *  - a tela de Parâmetros baixa e restaura de ponta a ponta, só para admin.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgrilo-bkp-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'teste.db');

const db = require('../src/db');
const { carregarSeed, criarCliente } = require('./apoio');
const backup = require('../src/domain/backup');
const clientesDom = require('../src/domain/clientes');
const processosDom = require('../src/domain/processos');
const checklist = require('../src/domain/checklist');
const config = require('../src/config');

const conn = carregarSeed(db);
const admin = conn
  .prepare("SELECT u.*, s.nome AS setor FROM usuarios u JOIN setores s ON s.id = u.setor_id WHERE u.perfil = 'Administrador' LIMIT 1")
  .get();
const tipo = conn.prepare("SELECT id FROM tipos_processo WHERE nome = 'Baixa de Empresa'").get();

const app = require('../src/app');
const servidor = app.listen(0);
const base = `http://127.0.0.1:${servidor.address().port}`;

function cliente(codigo, nome) {
  return clientesDom.criar({ codigo, nome, razao_social: `${nome} LTDA`, cnpj_cpf: '11.222.333/0001-44' }, admin);
}

/* ------------------------------------------------------------------ domínio */

test('o backup traz todas as tabelas, os totais e uma assinatura', () => {
  cliente('100', 'Empresa Um');
  processosDom.criar({ tipo_processo_id: tipo.id, cliente_id: clientesDom.porCodigo('100').id }, admin);

  const dados = backup.gerar({ usuario: admin });

  assert.strictEqual(dados.formato, 'jsgrilo-backup');
  assert.strictEqual(dados.versao, backup.VERSAO);
  assert.match(dados.gerado_por, /Administrador|Jacqueline|\(/);
  assert.deepStrictEqual(Object.keys(dados.tabelas).sort(), [...backup.TABELAS].sort());
  assert.strictEqual(dados.totais.processos, 1);
  assert.strictEqual(dados.totais.clientes, 1);
  assert.ok(dados.totais.checklist > 0, 'o checklist gerado na abertura entra no backup');
  assert.ok(dados.totais.usuarios > 0);
  assert.match(dados.checksum, /^[a-f0-9]{64}$/);
  assert.deepStrictEqual(dados.arquivos, [], 'sem anexos quando não pedidos');
});

test('restaurar repõe o retrato e desfaz o que veio depois', () => {
  const antes = backup.gerar({ usuario: admin });
  const processosAntes = antes.totais.processos;

  // vida seguindo: mais um cliente, mais um processo, um item respondido
  cliente('200', 'Empresa Dois');
  const novo = processosDom.criar({ tipo_processo_id: tipo.id, cliente_id: clientesDom.porCodigo('200').id }, admin);
  const item = checklist.doProcesso(novo.id)[0];
  checklist.responder(item.id, { resposta: 'Sim' }, admin);

  assert.strictEqual(backup.gerar({ usuario: admin }).totais.processos, processosAntes + 1);

  const resultado = backup.restaurar(antes, { usuario: admin });

  assert.strictEqual(resultado.violacoes, 0, 'nenhuma chave estrangeira quebrada depois da troca');
  assert.ok(fs.existsSync(resultado.copiaDeSeguranca), 'o estado anterior fica guardado em data/backups');

  const depois = backup.gerar({ usuario: admin });
  assert.deepStrictEqual(depois.totais, antes.totais, 'as contagens voltam a bater');
  assert.strictEqual(clientesDom.porCodigo('200'), undefined, 'o cliente criado depois some');
  assert.ok(clientesDom.porCodigo('100'), 'o cliente do backup continua lá');
  assert.strictEqual(processosDom.obter(novo.id), undefined);

  // a numeração automática continua de onde o backup parou
  const seguinte = processosDom.criar(
    { tipo_processo_id: tipo.id, cliente_id: clientesDom.porCodigo('100').id },
    admin
  );
  assert.ok(seguinte.id > 0);
  assert.strictEqual(backup.gerar({ usuario: admin }).totais.processos, processosAntes + 1);
});

test('o backup pode carregar os documentos anexados e repô-los no disco', () => {
  const pasta = path.join(config.uploadsDir, '1');
  fs.mkdirSync(pasta, { recursive: true });
  fs.writeFileSync(path.join(pasta, 'contrato.pdf'), 'conteúdo do contrato');

  const dados = backup.gerar({ usuario: admin, incluirArquivos: true });
  assert.strictEqual(dados.arquivos.length, 1);
  assert.strictEqual(dados.arquivos[0].caminho, '1/contrato.pdf');

  fs.rmSync(pasta, { recursive: true, force: true });
  const resultado = backup.restaurar(dados, { usuario: admin });

  assert.strictEqual(resultado.arquivosRepostos, 1);
  assert.strictEqual(fs.readFileSync(path.join(pasta, 'contrato.pdf'), 'utf8'), 'conteúdo do contrato');
});

test('arquivo adulterado, estranho ou de versão futura é recusado', () => {
  const dados = backup.gerar({ usuario: admin });

  const adulterado = JSON.parse(JSON.stringify(dados));
  adulterado.tabelas.usuarios.push({ id: 999, nome: 'Invasor', login: 'invasor', perfil: 'Administrador' });
  assert.throws(() => backup.analisar(Buffer.from(JSON.stringify(adulterado))), /não confere com a sua assinatura/i);

  assert.throws(() => backup.analisar(Buffer.from('{"formato":"outra-coisa"}')), /não é um backup da plataforma/i);
  assert.throws(() => backup.analisar(Buffer.from('isto não é json')), /não consegui ler/i);

  const futuro = { ...dados, versao: backup.VERSAO + 5 };
  assert.throws(() => backup.analisar(Buffer.from(JSON.stringify(futuro))), /versão mais nova/i);

  // o arquivo íntegro passa e traz a conferência para a tela
  const analise = backup.analisar(Buffer.from(JSON.stringify(dados)));
  const linhaClientes = analise.conteudo.find((l) => l.tabela === 'clientes');
  assert.strictEqual(linhaClientes.rotulo, 'Clientes (empresas)');
  assert.strictEqual(linhaClientes.doArquivo, linhaClientes.atual);
});

test('backup sem administrador ativo avisa antes de deixar restaurar', () => {
  const dados = backup.gerar({ usuario: admin });
  dados.tabelas.usuarios = dados.tabelas.usuarios.map((u) => ({ ...u, perfil: 'Usuário' }));
  dados.checksum = undefined; // sem assinatura, a análise só avisa

  const analise = backup.analisar(Buffer.from(JSON.stringify(dados)));
  assert.ok(analise.avisos.some((a) => /nenhum administrador ativo/i.test(a)));
  assert.ok(analise.avisos.some((a) => /sem assinatura/i.test(a)));
});

/* --------------------------------------------------------------- pelas telas */

test('pela tela de Parâmetros: baixar o backup e restaurá-lo de volta', async () => {
  const navegador = criarCliente(base);
  await navegador.entrar('jacqueline', 'teste123');

  const token = await navegador.token('/admin/parametros');
  const download = await navegador.post('/admin/backup', { _csrf: token });

  assert.strictEqual(download.status, 200);
  assert.match(download.headers.get('content-type'), /application\/json/);
  assert.match(download.headers.get('content-disposition'), /attachment; filename="backup-jsgrilo-.*\.json"/);

  const conteudo = await download.text();
  const dados = JSON.parse(conteudo);
  assert.strictEqual(dados.formato, 'jsgrilo-backup');

  // some um cliente depois do backup...
  cliente('300', 'Empresa Três');
  assert.ok(clientesDom.porCodigo('300'));

  // ...e o envio do arquivo mostra a conferência sem gravar nada
  const forma = new FormData();
  forma.append('_csrf', token);
  forma.append('backup', new Blob([conteudo], { type: 'application/json' }), 'backup-teste.json');
  const envio = await navegador.pedir('/admin/backup/restaurar', { method: 'POST', body: forma });
  assert.strictEqual(envio.status, 302);
  assert.ok(clientesDom.porCodigo('300'), 'o envio ainda não altera nada');

  const tela = await (await navegador.get('/admin/parametros')).text();
  assert.match(tela, /backup-teste\.json/);
  assert.match(tela, /digite <strong>RESTAURAR<\/strong>/i);

  // confirmação errada não restaura
  const semConfirmar = await navegador.post('/admin/backup/confirmar', { _csrf: token, confirmacao: 'sim' });
  assert.strictEqual(semConfirmar.status, 302);
  assert.ok(clientesDom.porCodigo('300'), 'sem a palavra certa, nada acontece');

  const confirmado = await navegador.post('/admin/backup/confirmar', { _csrf: token, confirmacao: 'restaurar' });
  assert.strictEqual(confirmado.status, 302);
  assert.strictEqual(clientesDom.porCodigo('300'), undefined, 'a restauração desfez a criação posterior');

  const depois = await navegador.get('/admin/parametros');
  assert.strictEqual(depois.status, 200, 'o administrador continua logado depois de restaurar');
  assert.match(await depois.text(), /Backup restaurado/);
});

test('backup e restauração são exclusivos do administrador', async () => {
  const comum = criarCliente(base);
  await comum.entrar('ana.paula', 'teste123');
  const token = await comum.token('/');

  assert.strictEqual((await comum.post('/admin/backup', { _csrf: token })).status, 403);
  assert.strictEqual((await comum.post('/admin/backup/confirmar', { _csrf: token, confirmacao: 'RESTAURAR' })).status, 403);

  const anonimo = criarCliente(base);
  const semLogin = await anonimo.post('/admin/backup', { _csrf: await anonimo.token('/login') });
  assert.strictEqual(semLogin.status, 302);
});

test('sem token CSRF, ninguém dispara uma restauração', async () => {
  const navegador = criarCliente(base);
  await navegador.entrar('jacqueline', 'teste123');
  const semToken = await navegador.post('/admin/backup/confirmar', { confirmacao: 'RESTAURAR' });
  assert.strictEqual(semToken.status, 403);
});

test.after(() => {
  servidor.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* -------------------------------- backup de uma versão anterior da plataforma */

/**
 * Monta um arquivo como o de uma versão que ainda não conhecia as tabelas
 * novas: elas simplesmente não estão lá, e a assinatura foi calculada sobre as
 * tabelas que existiam. É o caso do arquivo que o escritório tinha em mãos.
 */
function backupDeVersaoAnterior(semEstas = ['usuarios_setores', 'avisos_destinos']) {
  const crypto = require('crypto');
  const arquivo = backup.gerar({ usuario: admin, incluirArquivos: false });
  for (const tabela of semEstas) delete arquivo.tabelas[tabela];

  // A assinatura da versão antiga: as tabelas que ELA tinha, na ordem dela.
  const resumo = crypto.createHash('sha256');
  for (const nome of Object.keys(arquivo.tabelas)) {
    resumo.update(nome);
    resumo.update(JSON.stringify(arquivo.tabelas[nome] || []));
  }
  arquivo.checksum = resumo.digest('hex');
  return arquivo;
}

test('backup de versão anterior não é recusado como incompleto', () => {
  const arquivo = backupDeVersaoAnterior();
  assert.ok(!arquivo.tabelas.usuarios_setores, 'o arquivo antigo não tem a tabela nova');

  // Antes da correção, a assinatura era conferida contra a lista de tabelas da
  // versão ATUAL: as duas tabelas novas entravam vazias na conta, o número dava
  // diferente e o arquivo era recusado como "alterado ou incompleto".
  const analise = backup.analisar(Buffer.from(JSON.stringify(arquivo)));
  assert.ok(analise.dados, 'o arquivo precisa ser aceito');
  assert.ok(
    analise.avisos.some((a) => /versão anterior/i.test(a) && /Setores por usuário/.test(a)),
    'a conferência avisa o que o arquivo não traz'
  );
});

test('a assinatura continua pegando arquivo mexido à mão', () => {
  const arquivo = backupDeVersaoAnterior();
  arquivo.tabelas.clientes.push({ id: 999999, codigo: 'X', nome: 'Entrou de fora' });
  assert.throws(
    () => backup.analisar(Buffer.from(JSON.stringify(arquivo))),
    /não confere com a sua assinatura/i
  );
});

test('restaurar backup antigo recompõe o que ele não tinha como trazer', () => {
  // Um aviso dirigido a setores e um parâmetro que a versão antiga não conhecia.
  const avisosDom = require('../src/domain/avisos');
  const processo = processosDom.criar({ cliente_id: cliente('770', 'EMPRESA ANTIGA').id, tipo_processo_id: tipo.id }, admin);
  avisosDom.vezDoSetor(processosDom.obter(processo.id), 'Fiscal');
  conn.prepare("DELETE FROM parametros WHERE chave = 'EXIGIR_ORDEM_SETORES'").run();

  const arquivo = backupDeVersaoAnterior();
  const comEscopoSetores = arquivo.tabelas.avisos.filter((a) => a.escopo === 'setores').length;
  assert.ok(comEscopoSetores > 0, 'o teste precisa de um aviso dirigido a setores');

  const resultado = backup.restaurar(arquivo, { usuario: admin, restaurarArquivos: false });

  assert.equal(resultado.violacoes, 0, 'nada pode ficar com chave estrangeira solta');
  assert.equal(
    resultado.completado.setoresDeUsuario,
    conn.prepare('SELECT COUNT(*) AS t FROM usuarios').get().t,
    'cada usuário volta com o seu setor na tabela nova'
  );
  assert.ok(
    resultado.completado.parametros.includes('EXIGIR_ORDEM_SETORES'),
    'parâmetro criado depois do backup volta para a tela de Parâmetros'
  );
  assert.equal(
    resultado.completado.avisosSemDestino,
    comEscopoSetores,
    'aviso sem destinatário passa a valer para todos, em vez de sumir da vista'
  );

  // E a plataforma funciona depois: o acesso enxerga os setores de novo.
  const acesso = require('../src/domain/acesso');
  const usuariosDom = require('../src/domain/usuarios');
  const alguem = usuariosDom.porLogin('ana.paula');
  assert.deepEqual(acesso.setoresDoUsuario(alguem), ['Fiscal']);
  assert.equal(conn.prepare('SELECT COUNT(*) AS t FROM avisos WHERE escopo = ?').get('setores').t, 0);
});

test('backup gerado hoje continua conferindo consigo mesmo', () => {
  const arquivo = backup.gerar({ usuario: admin, incluirArquivos: false });
  const analise = backup.analisar(Buffer.from(JSON.stringify(arquivo)));
  assert.ok(!analise.avisos.some((a) => /versão anterior/i.test(a)));
  assert.ok(Object.keys(arquivo.tabelas).includes('usuarios_setores'));
});
