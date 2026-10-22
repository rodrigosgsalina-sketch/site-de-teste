'use strict';

/**
 * Importação de empresas a partir do relatório do Domínio Sistemas.
 *
 * Dois defeitos reais guardados aqui:
 *
 *  1. O .xls que o Domínio exporta tem o índice das abas apontando para o
 *     lugar errado (células vazias soltas entre o cabeçalho e a aba). A
 *     biblioteca de planilhas lia isso como uma pasta sem conteúdo, e a tela
 *     dizia "não encontrei empresas" com o arquivo certo na mão. O teste
 *     fabrica um .xls com o mesmo defeito — a planilha real não entra no
 *     repositório, porque é o cadastro de clientes do escritório.
 *  2. Reimportar precisa cadastrar só o que falta: empresa já cadastrada não
 *     entra de novo (pelo código do Domínio), e código novo com CNPJ/CPF de
 *     uma empresa já cadastrada fica de fora como provável duplicata.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgrilo-import-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'teste.db');

const XLSX = require('xlsx');
const db = require('../src/db');
const { carregarSeed, criarCliente } = require('./apoio');
const conn = carregarSeed(db, { senha: 'teste123' });

const importacao = require('../src/domain/importacao-clientes');
const clientesDom = require('../src/domain/clientes');
const { repararXls, repararFluxo } = require('../src/lib/xls-reparo');

const app = require('../src/app');
const servidor = app.listen(0);
const base = `http://127.0.0.1:${servidor.address().port}`;
test.after(() => servidor.close());

const admin = conn.prepare("SELECT * FROM usuarios WHERE login = 'jacqueline'").get();

/* ------------------------------------------------------------- planilhas */

/**
 * Linhas no formato do relatório "Empresas · Dados cadastrais": rótulo na
 * coluna A, valor na E, e o cabeçalho de página repetido.
 */
function fichas(empresas) {
  const linhas = [];
  empresas.forEach((e, i) => {
    linhas.push(['Empresa:', '', e.nome, '', '', '', '', '', '', '', '', 'Página:', '', `${i + 1}/${empresas.length}`]);
    linhas.push(['EMPRESAS']);
    linhas.push(['DADOS CADASTRAIS']);
    linhas.push(['Código:', '', '', '', e.codigo, '', '', 'Data da inscrição:', '', '01/02/2010']);
    linhas.push(['Apelido:', '', '', '', e.apelido || '']);
    linhas.push(['Nome:', '', '', '', e.nome]);
    linhas.push(['Razão social:', '', '', '', e.nome, '', '', 'Natureza Jurídica:', '', 'Sociedade Empresária Limitada']);
    linhas.push(['Município:', '', '', '', e.municipio || 'TIBAU DO SUL', '', '', 'Situação:', '', e.situacao || 'Ativa']);
    linhas.push(['UF:', '', '', '', 'RN']);
    linhas.push(['Telefone:', '', '', '', e.telefone || '']);
    linhas.push(['CNPJ/CPF/CEI/CAEPF:', '', '', '', e.cnpj || '']);
    linhas.push([]);
  });
  return linhas;
}

/** .xls binário (BIFF8), com as células de rótulo mescladas como no Domínio. */
function xlsDoDominio(empresas) {
  const ws = XLSX.utils.aoa_to_sheet(fichas(empresas));
  ws['!merges'] = [];
  for (let r = 0; r < empresas.length * 12; r++) ws['!merges'].push({ s: { r, c: 0 }, e: { r, c: 3 } });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Empresas');
  return XLSX.write(wb, { bookType: 'biff8', type: 'buffer' });
}

/**
 * Estraga o .xls do jeito que o Domínio entrega: células vazias soltas entre
 * o fim do miolo global e o começo da aba. A posição da aba anotada no índice
 * continua a mesma — e passa a apontar para as células soltas.
 */
function comDefeitoDoDominio(xls, celulasSoltas = 3000) {
  const cfb = XLSX.CFB.read(xls, { type: 'buffer' });
  const fluxo = Buffer.from(XLSX.CFB.find(cfb, 'Workbook').content);

  // Fim do miolo global = logo depois do primeiro EOF.
  let pos = 0;
  let fimGlobal = -1;
  while (pos + 4 <= fluxo.length) {
    const tipo = fluxo.readUInt16LE(pos);
    const tamanho = fluxo.readUInt16LE(pos + 2);
    pos += 4 + tamanho;
    if (tipo === 0x000a) {
      fimGlobal = pos;
      break;
    }
  }
  const soltas = Buffer.alloc(celulasSoltas * 10);
  for (let i = 0; i < celulasSoltas; i++) {
    soltas.writeUInt16LE(0x0201, i * 10); // BLANK
    soltas.writeUInt16LE(6, i * 10 + 2);
    soltas.writeUInt16LE(i % 500, i * 10 + 4); // linha
    soltas.writeUInt16LE(i % 14, i * 10 + 6); // coluna
    soltas.writeUInt16LE(15, i * 10 + 8); // estilo
  }
  const estragado = Buffer.concat([fluxo.subarray(0, fimGlobal), soltas, fluxo.subarray(fimGlobal)]);
  const novo = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(novo, 'Workbook', estragado);
  return Buffer.from(XLSX.CFB.write(novo, { type: 'buffer', fileType: 'cfb' }));
}

const EMPRESAS = [
  { codigo: '498', nome: 'ADEMILSON BARBOZA PIZZARIA', apelido: 'PIZZARIA', cnpj: '18.350.881/0001-36' },
  { codigo: '73', nome: '1.618 COMERCIO DE EXPORTACAO LTDA', cnpj: '09.553.401/0001-70' },
  { codigo: '19', nome: 'THIAGO TEIXEIRA DE PAIVA', cnpj: '059.161.644-08' },
];

/* ----------------------------------------------- 1. o .xls do Domínio */

test('o .xls com o índice das abas fora do lugar reproduz o defeito na biblioteca', () => {
  // Guarda o diagnóstico: se um dia a biblioteca passar a ler sozinha, este
  // teste avisa que o reparo pode ser revisto — e o de baixo continua valendo.
  const estragado = comDefeitoDoDominio(xlsDoDominio(EMPRESAS));
  const wb = XLSX.read(estragado, { type: 'buffer' });
  assert.deepStrictEqual(wb.SheetNames, ['Empresas']);
  assert.strictEqual(wb.Sheets.Empresas, undefined, 'a aba é listada, mas vem sem conteúdo');
});

test('o .xls do Domínio com o defeito é lido inteiro', () => {
  const analise = importacao.analisar(comDefeitoDoDominio(xlsDoDominio(EMPRESAS)));
  assert.strictEqual(analise.formato, 'ficha');
  assert.deepStrictEqual(
    analise.registros.map((r) => r.codigo),
    ['498', '73', '19']
  );
  assert.strictEqual(analise.erros.length, 0);
  const primeira = analise.registros[0];
  assert.strictEqual(primeira.nome, 'ADEMILSON BARBOZA PIZZARIA');
  assert.strictEqual(primeira.cnpj_cpf, '18.350.881/0001-36');
  assert.strictEqual(primeira.situacao, 'Ativa');
});

test('o reparo não muda os valores: lido com e sem defeito, o resultado é o mesmo', () => {
  const certo = importacao.analisar(xlsDoDominio(EMPRESAS));
  const estragado = importacao.analisar(comDefeitoDoDominio(xlsDoDominio(EMPRESAS)));
  const limpar = (a) => a.registros.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('__'))));
  assert.deepStrictEqual(limpar(estragado), limpar(certo));
});

test('planilha sem defeito e sem mescla segue como veio; arquivo que não é .xls também', () => {
  const ws = XLSX.utils.aoa_to_sheet([['Código', 'Nome'], ['1', 'A']]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Plan1');
  const xls = XLSX.write(wb, { bookType: 'biff8', type: 'buffer' });
  assert.strictEqual(repararXls(xls, XLSX), null, 'nada a reparar');
  assert.ok(repararXls(xlsDoDominio(EMPRESAS), XLSX, { descartarMesclas: true }), 'com mescla, refaz sem ela');

  assert.strictEqual(repararXls(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }), XLSX), null);
  assert.strictEqual(repararXls(Buffer.from('Código;Nome\n1;A\n'), XLSX), null);
  assert.strictEqual(repararXls(Buffer.from('<html><table></table></html>'), XLSX), null);
});

test('fluxo cortado no meio não derruba o reparo', () => {
  const cfb = XLSX.CFB.read(xlsDoDominio(EMPRESAS), { type: 'buffer' });
  const fluxo = Buffer.from(XLSX.CFB.find(cfb, 'Workbook').content);
  assert.strictEqual(repararFluxo(fluxo.subarray(0, fluxo.length - 7)), null);
  assert.strictEqual(repararFluxo(Buffer.alloc(0)), null);
});

test('arquivo que nem é planilha recebe mensagem clara', () => {
  assert.throws(() => importacao.analisar(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3])), (err) => {
    assert.ok(err.message.length > 20);
    return true;
  });
});

/* ----------------------------------- 2. cadastrar só o que falta */

test('primeira importação cadastra todas', () => {
  const analise = importacao.analisar(comDefeitoDoDominio(xlsDoDominio(EMPRESAS)));
  assert.strictEqual(analise.novos, 3);
  const resultado = importacao.importar(analise.registros, admin);
  assert.strictEqual(resultado.criados, 3);
  assert.strictEqual(resultado.falhas.length, 0);
});

test('reimportar a mesma planilha não cadastra ninguém de novo', () => {
  const antes = clientesDom.contarTodos();
  const analise = importacao.analisar(comDefeitoDoDominio(xlsDoDominio(EMPRESAS)));
  assert.strictEqual(analise.novos, 0);
  assert.strictEqual(analise.existentes, 3);

  const resultado = importacao.importar(analise.registros, admin);
  assert.strictEqual(resultado.criados, 0);
  assert.strictEqual(resultado.ignorados, 3);
  assert.strictEqual(clientesDom.contarTodos(), antes);
});

test('planilha com empresas novas e já cadastradas: entram só as novas', () => {
  const antes = clientesDom.contarTodos();
  const maior = [
    ...EMPRESAS,
    { codigo: '908', nome: 'EMPRESA NOVA UM LTDA', cnpj: '10.971.909/0001-40' },
    { codigo: '909', nome: 'EMPRESA NOVA DOIS LTDA', cnpj: '' },
  ];
  const analise = importacao.analisar(xlsDoDominio(maior));
  assert.strictEqual(analise.novos, 2);
  assert.strictEqual(analise.existentes, 3);

  const resultado = importacao.importar(analise.registros, admin);
  assert.strictEqual(resultado.criados, 2);
  assert.strictEqual(resultado.ignorados, 3);
  assert.strictEqual(clientesDom.contarTodos(), antes + 2);
  assert.ok(clientesDom.porCodigo('908') && clientesDom.porCodigo('909'));
});

test('código novo com CNPJ/CPF de uma empresa já cadastrada fica de fora — a menos que se peça', () => {
  // O Domínio tem a mesma empresa em dois códigos (recadastro): o 232 é o
  // mesmo CNPJ do 908, que já está aqui.
  const planilha = [{ codigo: '232', nome: 'EMPRESA NOVA UM LTDA (RECADASTRO)', cnpj: '10971909000140' }];
  const analise = importacao.analisar(xlsDoDominio(planilha));
  assert.strictEqual(analise.novos, 0);
  assert.strictEqual(analise.mesmoDocumento.length, 1);
  const repetida = analise.mesmoDocumento[0];
  assert.strictEqual(repetida.__codigoNoSistema, '908', 'a conferência mostra com quem ela bate');

  const semPedir = importacao.importar(analise.registros, admin);
  assert.strictEqual(semPedir.criados, 0);
  assert.strictEqual(semPedir.mesmoDocumento, 1);
  assert.strictEqual(clientesDom.porCodigo('232'), undefined);

  // O Domínio também tem empresas DIFERENTES com o mesmo documento (erro de
  // digitação lá): para essas, quem confere pode mandar cadastrar.
  const pedindo = importacao.importar(analise.registros, admin, { incluirMesmoDocumento: true });
  assert.strictEqual(pedindo.criados, 1);
  assert.ok(clientesDom.porCodigo('232'));
});

test('CNPJ zerado ou incompleto não vale como identificação', () => {
  assert.strictEqual(importacao.documentoUtil('00.000.000/0000-00'), '');
  assert.strictEqual(importacao.documentoUtil('111.111.111-11'), '');
  assert.strictEqual(importacao.documentoUtil('123'), '');
  assert.strictEqual(importacao.documentoUtil('18.350.881/0001-36'), '18350881000136');
  assert.strictEqual(importacao.documentoUtil('059.161.644-08'), '05916164408');

  // No relatório real, três empresas diferentes têm CNPJ zerado: todas entram.
  const zeradas = [
    { codigo: '575', nome: 'A M CONVENIENCIA LTDA', cnpj: '00.000.000/0000-00' },
    { codigo: '715', nome: 'MODELO MEI', cnpj: '00.000.000/0000-00' },
  ];
  const primeira = importacao.analisar(xlsDoDominio(zeradas.slice(0, 1)));
  importacao.importar(primeira.registros, admin);
  const segunda = importacao.analisar(xlsDoDominio(zeradas));
  assert.strictEqual(segunda.novos, 1, 'a 715 é nova, mesmo com o mesmo CNPJ zerado da 575');
  assert.strictEqual(segunda.mesmoDocumento.length, 0);
});

test('empresas novas da mesma planilha com o mesmo documento entram as duas, e a conferência mostra', () => {
  const planilha = [
    { codigo: '141', nome: 'BARBARA ANDREA CAAMANO ME', cnpj: '10.661.688/0001-04' },
    { codigo: '388', nome: 'NATIVOS PIPA CAFE BAR LTDA', cnpj: '10.661.688/0001-04' },
  ];
  const analise = importacao.analisar(xlsDoDominio(planilha));
  assert.strictEqual(analise.novos, 2);
  assert.strictEqual(analise.repetidasNaPlanilha.length, 1);
  assert.strictEqual(analise.repetidasNaPlanilha[0].documento, '10661688000104');

  const resultado = importacao.importar(analise.registros, admin);
  assert.strictEqual(resultado.criados, 2, 'uma não anula a outra');
});

test('empresa cadastrada por outra pessoa entre a conferência e a confirmação não duplica', () => {
  const analise = importacao.analisar(xlsDoDominio([{ codigo: '5001', nome: 'CORRIDA LTDA', cnpj: '' }]));
  assert.strictEqual(analise.novos, 1);
  clientesDom.criar({ codigo: '5001', nome: 'CORRIDA LTDA' }, admin, 'Manual');

  const resultado = importacao.importar(analise.registros, admin);
  assert.strictEqual(resultado.criados, 0);
  assert.strictEqual(resultado.falhas.length, 0, 'não vira erro de código repetido');
  assert.strictEqual(resultado.ignorados, 1);
});

test('atualizar as já cadastradas só troca o que veio preenchido', () => {
  const cliente = clientesDom.porCodigo('498');
  clientesDom.atualizar(cliente.id, {
    ...cliente,
    situacao: 'Ativo - Sem Movimento',
    email: 'contato@pizzaria.com.br',
    observacoes: 'Cliente pede contato por WhatsApp.',
  });

  // Planilha em tabela, só com código, nome e telefone.
  const ws = XLSX.utils.aoa_to_sheet([
    ['Código', 'Nome', 'Telefone'],
    ['498', 'ADEMILSON BARBOZA PIZZARIA', '(84) 3246-2156'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Plan1');
  const analise = importacao.analisar(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
  const resultado = importacao.importar(analise.registros, admin, { atualizarExistentes: true });
  assert.strictEqual(resultado.atualizados, 1);

  const depois = clientesDom.porCodigo('498');
  assert.strictEqual(depois.telefone, '(84) 3246-2156', 'o que veio, entrou');
  assert.strictEqual(depois.email, 'contato@pizzaria.com.br', 'o que não veio, ficou');
  assert.strictEqual(depois.situacao, 'Ativo - Sem Movimento', 'a situação não volta para "Ativa"');
  assert.strictEqual(depois.cnpj_cpf, '18.350.881/0001-36');
  assert.strictEqual(depois.observacoes, 'Cliente pede contato por WhatsApp.');
});

/* ---------------------------------------------------------------- tela */

test('pela tela: enviar o .xls do Domínio, conferir e cadastrar só as que faltam', async () => {
  const http = criarCliente(base);
  await http.entrar('jacqueline', 'teste123');
  const token = await http.token('/clientes/importar');

  const planilha = [
    ...EMPRESAS, // já cadastradas
    { codigo: '7001', nome: 'PELA TELA COMERCIO LTDA', cnpj: '11.222.333/0001-81' },
  ];
  const form = new FormData();
  form.append('_csrf', token);
  form.append('planilha', new Blob([comDefeitoDoDominio(xlsDoDominio(planilha))]), 'Empresas.xls');
  const conferencia = await http.pedir('/clientes/importar', { method: 'POST', body: form });
  const html = await conferencia.text();
  assert.strictEqual(conferencia.status, 200, html.slice(0, 300));
  assert.match(html, /Conferência antes de importar/);
  assert.match(html, /Cadastrar 1 empresa\(s\) nova\(s\)/);
  assert.ok(!/name="atualizar" value="1" checked/.test(html), 'atualizar as existentes vem desmarcado');

  const confirmacao = await http.post('/clientes/importar/confirmar', { _csrf: token });
  assert.strictEqual(confirmacao.status, 302);
  assert.ok(clientesDom.porCodigo('7001'), 'a nova entrou');

  const lista = await (await http.get('/clientes')).text();
  assert.match(lista, /1 empresa\(s\) nova\(s\) cadastrada\(s\)/);
  assert.match(lista, /3 já cadastrada\(s\), mantida\(s\) como estavam/);
});
