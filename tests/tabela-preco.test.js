'use strict';

/**
 * A tabela de preço do escritório.
 *
 *  - todo mundo vê; quem altera é o administrador e o setor responsável;
 *  - o arquivo aceito é .png, .pdf ou .xlsx, e mais nada;
 *  - cada envio guarda o anterior, e apagar a exibida promove a mais recente
 *    que sobrou — a tela nunca fica vazia tendo tabela;
 *  - imagem pequena demais é sinalizada no envio: ampliar não cria detalhe.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgrilo-preco-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'teste.db');

const db = require('../src/db');
const { carregarSeed, criarCliente } = require('./apoio');
const conn = carregarSeed(db, { senha: 'teste123' });

const acesso = require('../src/domain/acesso');
const parametros = require('../src/domain/parametros');
const tabelaPreco = require('../src/domain/tabela-preco');

const app = require('../src/app');
const servidor = app.listen(0);
const base = `http://127.0.0.1:${servidor.address().port}`;

const usuario = (login) => conn.prepare('SELECT * FROM usuarios WHERE login = ?').get(login);
const admin = usuario('jacqueline'); // Diretoria/Administrador
const financeiro = usuario('andreia'); // Financeiro/Usuário
const fiscal = usuario('ana.paula'); // Fiscal/Usuário

test.after(() => servidor.close());

/* -------------------------------------------------------------- apoio */

/** PNG mínimo, com a largura pedida gravada no cabeçalho. */
function pngFalso(largura, altura = 100) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8; // profundidade
  ihdr[9] = 6; // RGBA
  const bloco = Buffer.concat([Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdr, Buffer.alloc(4)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), bloco]);
}

/** Grava um arquivo na pasta da tabela de preço, como o multer faria. */
function enviar(nomeOriginal, conteudo, quem = admin, descricao = null) {
  const nomeArquivo = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}${path.extname(nomeOriginal)}`;
  fs.writeFileSync(path.join(tabelaPreco.pasta(), nomeArquivo), conteudo);
  return tabelaPreco.registrar(
    { originalname: nomeOriginal, filename: nomeArquivo, size: conteudo.length, mimetype: 'application/octet-stream' },
    descricao,
    quem
  );
}

/* -------------------------------------------------------- permissões */

test('ver é de todos; alterar é do administrador e do setor responsável', () => {
  assert.ok(acesso.podeEditarTabelaPreco(admin), 'administrador altera');
  assert.ok(acesso.podeEditarTabelaPreco(financeiro), 'o Financeiro altera');
  assert.ok(!acesso.podeEditarTabelaPreco(fiscal), 'o Fiscal só consulta');
  assert.ok(!acesso.podeEditarTabelaPreco(null));
});

test('o setor responsável sai de um parâmetro, e não de um nome preso no código', () => {
  parametros.definir('SETOR_TABELA_PRECO', 'Contábil');
  assert.strictEqual(tabelaPreco.setorResponsavel(), 'Contábil');
  assert.ok(acesso.podeEditarTabelaPreco(usuario('daiane')), 'o Contábil passou a alterar');
  assert.ok(!acesso.podeEditarTabelaPreco(financeiro), 'e o Financeiro deixou de alterar');
  parametros.definir('SETOR_TABELA_PRECO', 'Financeiro');
  assert.ok(acesso.podeEditarTabelaPreco(financeiro));
});

/* ------------------------------------------------------------ arquivo */

test('aceita png, pdf e xlsx — e nada além disso', () => {
  assert.ok(tabelaPreco.extensaoAceita('precos.png'));
  assert.ok(tabelaPreco.extensaoAceita('PRECOS.PDF'));
  assert.ok(tabelaPreco.extensaoAceita('tabela 2026.xlsx'));
  for (const nome of ['precos.svg', 'precos.html', 'precos.xls', 'precos.exe', 'precos']) {
    assert.ok(!tabelaPreco.extensaoAceita(nome), `${nome} não pode entrar`);
  }
});

test('as medidas do PNG saem do cabeçalho do próprio arquivo', () => {
  const arquivo = path.join(tmp, 'medida.png');
  fs.writeFileSync(arquivo, pngFalso(1234, 567));
  assert.deepStrictEqual(tabelaPreco.medidasPNG(arquivo), { largura: 1234, altura: 567 });

  fs.writeFileSync(arquivo, Buffer.from('isto não é um png'));
  assert.strictEqual(tabelaPreco.medidasPNG(arquivo), null);
});

test('o caminho do arquivo não escapa da pasta da tabela de preço', () => {
  const raiz = path.resolve(tabelaPreco.pasta());
  for (const nome of ['../../../etc/passwd', '/etc/passwd', '..\\..\\windows\\system32\\config', 'a/b/../../fora.png']) {
    const resolvido = tabelaPreco.caminhoAbsoluto({ nome_arquivo: nome });
    assert.ok(
      resolvido.startsWith(raiz + path.sep),
      `"${nome}" resolveu para fora da pasta: ${resolvido}`
    );
    assert.strictEqual(path.dirname(resolvido), raiz, 'o arquivo fica na pasta, sem subpasta nenhuma');
  }
});

/* ------------------------------------------------------------- envio */

test('o envio vira a versão exibida e guarda a anterior', () => {
  const primeira = enviar('precos-janeiro.png', pngFalso(1600, 900), admin, 'vigência de janeiro');
  assert.strictEqual(primeira.item.formato, 'imagem');
  assert.strictEqual(primeira.item.largura, 1600);
  assert.strictEqual(tabelaPreco.atual().id, primeira.item.id);

  const segunda = enviar('precos-fevereiro.png', pngFalso(1800, 900), financeiro);
  assert.strictEqual(tabelaPreco.atual().id, segunda.item.id, 'a nova assume a exibição');
  assert.strictEqual(tabelaPreco.obter(primeira.item.id).atual, 0, 'a anterior sai de exibição');

  const nomes = tabelaPreco.versoes().map((v) => v.nome_original);
  assert.ok(nomes.includes('precos-janeiro.png') && nomes.includes('precos-fevereiro.png'));
});

test('imagem estreita demais avisa quem enviou — ampliar não cria detalhe', () => {
  const pequena = enviar('miniatura.png', pngFalso(480, 300));
  assert.match(pequena.aviso, /480 px/);

  const grande = enviar('boa.png', pngFalso(tabelaPreco.LARGURA_CONFORTAVEL + 200, 800));
  assert.strictEqual(grande.aviso, null, 'imagem grande não precisa de recado');
});

test('o envio fica no histórico do escritório', () => {
  const linha = conn
    .prepare("SELECT * FROM historico WHERE acao = 'Tabela de Preço Atualizada' ORDER BY id DESC LIMIT 1")
    .get();
  assert.ok(linha, 'o envio precisa deixar rastro');
  assert.strictEqual(linha.processo_id, null, 'a tabela de preço não pertence a processo nenhum');
});

test('uma versão anterior pode voltar a ser a exibida', () => {
  const anteriores = tabelaPreco.versoes().filter((v) => !v.atual);
  const escolhida = anteriores[anteriores.length - 1];
  tabelaPreco.tornarAtual(escolhida.id, admin);
  assert.strictEqual(tabelaPreco.atual().id, escolhida.id);
  assert.strictEqual(tabelaPreco.versoes().filter((v) => v.atual).length, 1, 'só uma fica em exibição');
});

test('apagar a exibida promove a mais recente que sobrou, e o arquivo some do disco', () => {
  const exibida = tabelaPreco.atual();
  const caminho = tabelaPreco.caminhoAbsoluto(exibida);
  assert.ok(fs.existsSync(caminho));

  tabelaPreco.remover(exibida.id, admin);

  assert.ok(!fs.existsSync(caminho), 'o arquivo é apagado junto');
  assert.strictEqual(tabelaPreco.obter(exibida.id), null);
  const nova = tabelaPreco.atual();
  assert.ok(nova, 'sobrando versão, a tela não fica sem tabela');
  assert.strictEqual(nova.id, Math.max(...tabelaPreco.versoes().map((v) => v.id)));
});

/* --------------------------------------------------- leitor de PDF */

test('o leitor de PDF vem na versão legacy — a moderna desenha folha em branco', () => {
  // A build moderna do pdf.js usa recursos de JavaScript recém-chegados e
  // falha calada em navegador de alguns meses atrás: o arquivo abre, conta as
  // páginas e não desenha nada. O defeito não aparece em erro nenhum, então
  // fica guardado aqui.
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'copy-vendor.js'), 'utf8');
  const linhas = script.split('\n').filter((l) => l.includes('pdfjs-dist') && l.includes("'"));
  assert.ok(linhas.length >= 2, 'o leitor de PDF e o worker precisam ser copiados para public/vendor');
  for (const linha of linhas) {
    assert.match(linha, /pdfjs-dist\/legacy\/build\//, 'use a build legacy do pdf.js');
  }
});

/* ---------------------------------------------------------- planilha */

test('a planilha é lida como grade de células, não como HTML pronto', () => {
  let XLSX;
  try {
    XLSX = require('xlsx');
  } catch (_) {
    return; // sem a biblioteca, a leitura de planilha não é exercitada
  }

  const linhas = [
    ['Serviço', 'Porte I', '<b>Porte II</b>'],
    ['Abertura', 'R$ 900,00', 'R$ 1.400,00'],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), 'Preços');
  const bruto = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const { item } = enviar('precos.xlsx', bruto);
  assert.strictEqual(item.formato, 'planilha');

  const grade = tabelaPreco.grade(item);
  assert.strictEqual(grade.aba, 'Preços');
  assert.deepStrictEqual(grade.linhas[0], ['Serviço', 'Porte I', '<b>Porte II</b>']);
  assert.deepStrictEqual(grade.linhas[1], ['Abertura', 'R$ 900,00', 'R$ 1.400,00']);
  // O conteúdo volta como texto: quem escapa é a tela, e uma planilha não
  // consegue injetar marcação por vir de fora.
  assert.ok(grade.linhas.every((linha) => linha.every((celula) => typeof celula === 'string')));
});

/* ---------------------------------------------------------------- HTTP */

async function sessao(login) {
  const cliente = criarCliente(base);
  await cliente.entrar(login, 'teste123');
  return cliente;
}

test('a tela abre para quem só consulta, sem o formulário de envio', async () => {
  const cliente = await sessao('ana.paula');
  const resposta = await cliente.get('/tabela-preco');
  assert.strictEqual(resposta.status, 200);

  const html = await resposta.text();
  assert.match(html, /Tabela de preço/);
  assert.ok(!/name="arquivo"/.test(html), 'quem só consulta não recebe o formulário');
  assert.match(html, /alterada pelo|Quem altera é o setor/i);
});

test('a aba aparece no menu de todo mundo', async () => {
  const cliente = await sessao('ana.paula');
  const html = await (await cliente.get('/')).text();
  assert.match(html, /href="\/tabela-preco"/);
});

test('sem permissão, o envio é recusado no servidor — não só escondido na tela', async () => {
  const cliente = await sessao('ana.paula');
  const token = await cliente.token('/tabela-preco');
  const resposta = await cliente.post('/tabela-preco', { _csrf: token });
  assert.strictEqual(resposta.status, 403);
});

test('o arquivo é servido com o tipo declarado e sem adivinhação do navegador', async () => {
  const item = tabelaPreco.atual();
  const cliente = await sessao('ana.paula');
  const resposta = await cliente.get(`/tabela-preco/arquivo/${item.id}`);
  assert.strictEqual(resposta.status, 200);
  assert.strictEqual(resposta.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(resposta.headers.get('content-type'));
});
