'use strict';

/**
 * A marca do escritório nas telas.
 *
 * São dois cuidados que só aparecem quando quebram, e quebram calados:
 *
 *  1. **A imagem existe.** Um caminho errado no `src` não derruba nada — a
 *     tela só abre sem o logotipo, e ninguém liga o defeito a um arquivo
 *     renomeado semanas antes.
 *  2. **Nenhum JavaScript dentro de atributo.** A política de segurança da
 *     página (CSP, com nonce) recusa `onclick="…"`. O botão do menu no celular
 *     era assim: ele existia, aparecia, respondia ao toque — e não abria nada,
 *     deixando a lateral inteira fora de alcance em tela pequena.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const telas = path.join(raiz, 'src', 'views');

/** Todos os arquivos .ejs do projeto. */
function views(pasta = telas, achados = []) {
  for (const nome of fs.readdirSync(pasta)) {
    const caminho = path.join(pasta, nome);
    if (fs.statSync(caminho).isDirectory()) views(caminho, achados);
    else if (nome.endsWith('.ejs')) achados.push(caminho);
  }
  return achados;
}

test('toda imagem citada nas telas existe em src/public', () => {
  const faltando = [];
  for (const arquivo of views()) {
    const codigo = fs.readFileSync(arquivo, 'utf8');
    for (const [, recurso] of codigo.matchAll(/estatico\('(\/[^']+)'\)/g)) {
      const caminho = path.join(raiz, 'src', 'public', recurso);
      if (!fs.existsSync(caminho)) faltando.push(`${path.relative(raiz, arquivo)} → ${recurso}`);
    }
  }
  assert.deepEqual(faltando, []);
});

test('o logotipo aparece na entrada e no menu lateral', () => {
  const login = fs.readFileSync(path.join(telas, 'login.ejs'), 'utf8');
  const cabecalho = fs.readFileSync(path.join(telas, 'partials', 'cabecalho.ejs'), 'utf8');

  assert.match(login, /img\/logo-jsgrilo\.png/, 'a tela de entrada mostra o logotipo');
  assert.match(cabecalho, /img\/logo-jsgrilo-claro\.png/, 'a lateral escura usa a versão clara');
  assert.match(cabecalho, /rel="icon"[^>]*icone-jsgrilo\.png/, 'a aba do navegador usa o ícone da marca');

  // O nome do escritório precisa continuar legível para quem não vê a imagem.
  // A tag é lida até o `>` que fecha de verdade — dentro do `src` há um `%>`
  // do EJS, que não fecha coisa nenhuma.
  for (const [nome, codigo] of [['login.ejs', login], ['cabecalho.ejs', cabecalho]]) {
    const imagens = [...codigo.matchAll(/<img\b[\s\S]*?(?<!%)>/g)]
      .map((m) => m[0])
      .filter((tag) => tag.includes('jsgrilo'));
    assert.ok(imagens.length, `${nome} deveria mostrar o logotipo`);
    for (const img of imagens) {
      assert.match(img, /\salt="[^"]*"/, `${nome}: toda imagem precisa de alt`);
    }
  }
});

test('o logotipo é servido pelo projeto, nunca de fora', () => {
  for (const arquivo of views()) {
    const codigo = fs.readFileSync(arquivo, 'utf8');
    const externas = [...codigo.matchAll(/<img[^>]+src="(https?:)?\/\//g)];
    assert.deepEqual(externas.map((m) => m[0]), [], `${path.relative(raiz, arquivo)} busca imagem de fora`);
  }
});

test('nenhuma tela usa JavaScript dentro de atributo — a CSP recusa', () => {
  const proibidos = [];
  for (const arquivo of views()) {
    const codigo = fs.readFileSync(arquivo, 'utf8');
    for (const [trecho] of codigo.matchAll(/\son(click|change|submit|input|load|focus|blur)\s*=/gi)) {
      proibidos.push(`${path.relative(raiz, arquivo)}:${trecho.trim()}`);
    }
  }
  assert.deepEqual(proibidos, [], 'ligue o evento no src/public/js/app.js');
});

test('o botão do menu no celular está ligado no JavaScript da página', () => {
  const cabecalho = fs.readFileSync(path.join(telas, 'partials', 'cabecalho.ejs'), 'utf8');
  const app = fs.readFileSync(path.join(raiz, 'src', 'public', 'js', 'app.js'), 'utf8');

  assert.match(cabecalho, /class="menu-toggle"[^>]*data-menu-lateral/, 'o botão precisa do gancho');
  assert.match(app, /\[data-menu-lateral\]/, 'o app.js precisa ligar o clique do botão');
});
