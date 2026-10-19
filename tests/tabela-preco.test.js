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
const backup = require('../src/domain/backup');

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
function enviar(nomeOriginal, conteudo, quem = admin, dados = {}) {
  const nomeArquivo = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}${path.extname(nomeOriginal)}`;
  fs.writeFileSync(path.join(tabelaPreco.pasta(), nomeArquivo), conteudo);
  return tabelaPreco.registrar(
    { originalname: nomeOriginal, filename: nomeArquivo, size: conteudo.length, mimetype: 'application/octet-stream' },
    dados,
    quem
  );
}

/** Títulos publicados, na ordem do seletor. */
const titulosPublicados = () => tabelaPreco.publicadas().map((t) => t.titulo);

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

test('várias tabelas ficam publicadas ao mesmo tempo, cada uma com o seu título', () => {
  const abertura = enviar('abertura.png', pngFalso(1600, 900), admin, { titulo: 'Abertura de empresa' });
  const mensal = enviar('mensal.png', pngFalso(1600, 900), financeiro, { titulo: 'Mensalidades' });
  const semTitulo = enviar('Certidões 2026.png', pngFalso(1600, 900));

  assert.strictEqual(semTitulo.item.titulo, 'Certidões 2026', 'sem título, vale o nome do arquivo');
  const titulos = titulosPublicados();
  for (const t of ['Abertura de empresa', 'Mensalidades', 'Certidões 2026']) {
    assert.ok(titulos.includes(t), `"${t}" precisa estar publicada`);
  }
  assert.deepStrictEqual(titulos, [...titulos].sort((a, b) => a.localeCompare(b, 'pt-BR')), 'em ordem alfabética');
  assert.ok(abertura.item.publicada && mensal.item.publicada);
});

test('quem lê escolhe qual tabela abrir', () => {
  const [primeira, segunda] = tabelaPreco.publicadas();
  assert.strictEqual(tabelaPreco.paraExibir(null).item.id, primeira.id, 'sem escolha, abre a primeira');
  assert.strictEqual(tabelaPreco.paraExibir(segunda.id).item.id, segunda.id, 'com escolha, abre a escolhida');
});

test('substituir põe o arquivo novo no lugar e guarda o antigo fora de publicação', () => {
  const antiga = tabelaPreco.publicadas().find((t) => t.titulo === 'Abertura de empresa');
  const nova = enviar('abertura-v2.png', pngFalso(1800, 900), financeiro, { substituiId: antiga.id });

  assert.strictEqual(nova.item.titulo, 'Abertura de empresa', 'o arquivo novo herda o título');
  assert.strictEqual(nova.substituida.id, antiga.id);
  assert.strictEqual(tabelaPreco.obter(antiga.id).publicada, 0, 'a anterior sai de publicação');
  assert.ok(tabelaPreco.obter(antiga.id), 'mas continua guardada');
  assert.strictEqual(
    titulosPublicados().filter((t) => t === 'Abertura de empresa').length,
    1,
    'o seletor nunca mostra duas com o mesmo nome'
  );
});

test('título repetido entre as publicadas é recusado — no envio, na publicação e ao renomear', () => {
  assert.throws(
    () => enviar('outra.png', pngFalso(1600, 900), admin, { titulo: '  mensalidades ' }),
    /Já existe uma tabela publicada chamada "Mensalidades"/
  );

  // A versão antiga da abertura está fora de publicação: publicá-la de volta
  // colocaria duas "Abertura de empresa" no seletor.
  const antiga = tabelaPreco.todas().find((t) => t.titulo === 'Abertura de empresa' && !t.publicada);
  assert.throws(() => tabelaPreco.definirPublicacao(antiga.id, true, admin), /Já existe uma tabela publicada/);

  const certidoes = tabelaPreco.publicadas().find((t) => t.titulo === 'Certidões 2026');
  assert.throws(() => tabelaPreco.atualizar(certidoes.id, { titulo: 'Mensalidades' }, admin), /Já existe/);

  // Fora de publicação, o título repetido não atrapalha ninguém.
  const renomeada = tabelaPreco.atualizar(antiga.id, { titulo: 'Abertura de empresa', descricao: 'até setembro' }, admin);
  assert.strictEqual(renomeada.descricao, 'até setembro');
});

test('retirar de publicação esconde de quem lê, sem apagar', () => {
  const certidoes = tabelaPreco.publicadas().find((t) => t.titulo === 'Certidões 2026');
  tabelaPreco.definirPublicacao(certidoes.id, false, admin);

  assert.ok(!titulosPublicados().includes('Certidões 2026'));
  assert.ok(tabelaPreco.obter(certidoes.id), 'continua guardada');

  // Quem só lê e pede a retirada pelo endereço cai na primeira publicada, com aviso.
  const leitura = tabelaPreco.paraExibir(certidoes.id);
  assert.notStrictEqual(leitura.item.id, certidoes.id);
  assert.ok(leitura.pedidaIndisponivel);
  // Quem administra abre, para conferir.
  assert.strictEqual(tabelaPreco.paraExibir(certidoes.id, { podeVerTodas: true }).item.id, certidoes.id);

  tabelaPreco.definirPublicacao(certidoes.id, true, admin);
  assert.ok(titulosPublicados().includes('Certidões 2026'), 'e volta quando publicada de novo');
});

test('imagem estreita demais avisa quem enviou — ampliar não cria detalhe', () => {
  const pequena = enviar('miniatura.png', pngFalso(480, 300), admin, { titulo: 'Miniatura' });
  assert.match(pequena.aviso, /480 px/);

  const grande = enviar('boa.png', pngFalso(tabelaPreco.LARGURA_CONFORTAVEL + 200, 800), admin, { titulo: 'Grande' });
  assert.strictEqual(grande.aviso, null, 'imagem grande não precisa de recado');
});

test('envio, retirada e remoção ficam no histórico do escritório', () => {
  const acoes = conn
    .prepare("SELECT DISTINCT acao FROM historico WHERE acao LIKE 'Tabela de Preço%' AND processo_id IS NULL")
    .all()
    .map((l) => l.acao);
  assert.ok(acoes.includes('Tabela de Preço Publicada'));
  assert.ok(acoes.includes('Tabela de Preço Retirada'));
});

test('apagar uma tabela tira o arquivo do disco e não mexe nas outras', () => {
  const alvo = tabelaPreco.publicadas().find((t) => t.titulo === 'Miniatura');
  const caminho = tabelaPreco.caminhoAbsoluto(alvo);
  const outras = titulosPublicados().filter((t) => t !== 'Miniatura');

  tabelaPreco.remover(alvo.id, admin);

  assert.ok(!fs.existsSync(caminho), 'o arquivo é apagado junto');
  assert.strictEqual(tabelaPreco.obter(alvo.id), null);
  assert.deepStrictEqual(titulosPublicados(), outras, 'as demais continuam publicadas');
});

test('banco da versão anterior (uma tabela "atual") vira o modelo de várias publicadas', () => {
  // Volta a tabela ao formato antigo, com uma em exibição e uma versão velha.
  conn.exec('DROP INDEX IF EXISTS idx_tabela_preco_publicada;');
  conn.exec('ALTER TABLE tabela_preco DROP COLUMN titulo;');
  conn.exec('ALTER TABLE tabela_preco RENAME COLUMN publicada TO atual;');
  conn.exec('UPDATE tabela_preco SET atual = 0;');
  const inserir = conn.prepare(
    `INSERT INTO tabela_preco (nome_original, nome_arquivo, formato, tamanho, atual)
     VALUES (?, ?, 'imagem', 10, ?)`
  );
  const velha = Number(inserir.run('precos-julho.png', 'x-velha.png', 0).lastInsertRowid);
  const vigente = Number(inserir.run('precos-agosto.png', 'x-vigente.png', 1).lastInsertRowid);

  db.migrate(conn);

  assert.strictEqual(tabelaPreco.obter(vigente).publicada, 1, 'a que estava em exibição continua publicada');
  assert.strictEqual(tabelaPreco.obter(velha).publicada, 0, 'a versão antiga continua guardada, fora do seletor');
  assert.strictEqual(tabelaPreco.obter(vigente).titulo, 'precos-agosto', 'o título nasce do nome do arquivo');
  assert.deepStrictEqual(titulosPublicados(), ['precos-agosto']);

  // Deixa o banco como os testes seguintes esperam.
  conn.prepare('DELETE FROM tabela_preco WHERE id IN (?, ?)').run(velha, vigente);
  for (const t of tabelaPreco.todas()) tabelaPreco.definirPublicacao(t.id, true, admin);
});

test('backup antigo restaura a coluna "atual" como publicação, sem publicar preço velho', () => {
  const adaptar = backup.ADAPTACOES.tabela_preco;
  const vigente = adaptar({ id: 1, nome_original: 'precos.pdf', atual: 1 });
  const velha = adaptar({ id: 2, nome_original: 'precos-antigos.pdf', atual: 0 });
  assert.strictEqual(vigente.publicada, 1);
  assert.strictEqual(velha.publicada, 0);
  assert.strictEqual(vigente.titulo, 'precos');
  assert.ok(!('atual' in vigente), 'a coluna que não existe mais não vai para o INSERT');
  // Backup novo passa sem mudança.
  const atual = adaptar({ id: 3, nome_original: 'a.pdf', titulo: 'Mensalidades', publicada: 0 });
  assert.strictEqual(atual.titulo, 'Mensalidades');
  assert.strictEqual(atual.publicada, 0);
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
  assert.match(html, /Quem publica e altera é o setor Financeiro/);
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
  const item = tabelaPreco.publicadas()[0];
  const cliente = await sessao('ana.paula');
  const resposta = await cliente.get(`/tabela-preco/arquivo/${item.id}`);
  assert.strictEqual(resposta.status, 200);
  assert.strictEqual(resposta.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(resposta.headers.get('content-type'));
});

test('o seletor mostra todas as publicadas para quem só consulta, e o endereço escolhe', async () => {
  const cliente = await sessao('ana.paula');
  const publicadas = tabelaPreco.publicadas();
  assert.ok(publicadas.length >= 2, 'o teste precisa de mais de uma publicada');

  const html = await (await cliente.get('/tabela-preco')).text();
  for (const t of publicadas) {
    assert.ok(html.includes(`href="/tabela-preco?id=${t.id}"`), `"${t.titulo}" precisa estar no seletor`);
  }

  const escolhida = publicadas[publicadas.length - 1];
  const aberta = await (await cliente.get(`/tabela-preco?id=${escolhida.id}`)).text();
  assert.match(aberta, new RegExp(`href="/tabela-preco\\?id=${escolhida.id}"\\s+class="tp-opcao ativa"`));
  assert.match(aberta, new RegExp(`window\\.TABELA_PRECO = \\{"id":${escolhida.id},`));

  // A escolha fica lembrada: voltar à aba sem endereço reabre a mesma.
  const deVolta = await (await cliente.get('/tabela-preco')).text();
  assert.match(deVolta, new RegExp(`window\\.TABELA_PRECO = \\{"id":${escolhida.id},`));
});

test('quem só consulta não abre nem baixa tabela fora de publicação', async () => {
  const retirada = tabelaPreco.publicadas()[0];
  tabelaPreco.definirPublicacao(retirada.id, false, admin);

  const leitor = await sessao('ana.paula');
  const html = await (await leitor.get(`/tabela-preco?id=${retirada.id}`)).text();
  assert.match(html, /não está mais publicada/);
  assert.ok(!html.includes(`href="/tabela-preco?id=${retirada.id}"`), 'nem aparece no seletor');
  assert.strictEqual((await leitor.get(`/tabela-preco/arquivo/${retirada.id}`)).status, 404);

  const gestor = await sessao('andreia');
  assert.strictEqual((await gestor.get(`/tabela-preco/arquivo/${retirada.id}`)).status, 200, 'o Financeiro confere');
  const conferencia = await (await gestor.get(`/tabela-preco?id=${retirada.id}`)).text();
  assert.match(conferencia, /fora de publicação/);

  tabelaPreco.definirPublicacao(retirada.id, true, admin);
});
