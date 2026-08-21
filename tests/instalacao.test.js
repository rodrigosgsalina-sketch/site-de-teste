'use strict';

/**
 * O que precisa estar de pé para a plataforma **instalar** numa máquina nova.
 *
 * Estes testes não exercitam regra de negócio: eles guardam o começo de tudo,
 * que é onde o escritório trava sem ter como se defender. Numa instalação com
 * Node 24 (npm 12), o `npm install` parou em
 * `npm error code EALLOWREMOTE` — instalar dependência apontada por URL passou
 * a ser bloqueado por padrão —, o `node_modules` ficou pela metade e os
 * comandos seguintes só sabiam dizer `Cannot find module 'express'`.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const pacote = require('../package.json');

test('as dependências por URL vêm com a autorização do npm ao lado', () => {
  const porUrl = Object.entries(pacote.dependencies || {}).filter(([, versao]) =>
    /^(https?:|git\+)/.test(String(versao))
  );
  if (!porUrl.length) return; // sem dependência de URL, nada a autorizar

  const caminho = path.join(raiz, '.npmrc');
  assert.ok(
    fs.existsSync(caminho),
    `${porUrl.map(([nome]) => nome).join(', ')} vem de URL: sem .npmrc o npm 12 recusa a instalação`
  );
  const npmrc = fs.readFileSync(caminho, 'utf8');
  assert.match(
    npmrc,
    /^\s*allow-remote\s*=\s*all\s*$/m,
    'o .npmrc precisa autorizar allow-remote=all, senão o npm install para em EALLOWREMOTE'
  );
});

test('o .npmrc é versionado — de nada adianta existir só na máquina de quem programou', () => {
  const gitignore = fs.readFileSync(path.join(raiz, '.gitignore'), 'utf8');
  const ignorado = gitignore
    .split('\n')
    .map((l) => l.trim())
    .some((l) => l === '.npmrc' || l === '/.npmrc' || l === '*.npmrc');
  assert.ok(!ignorado, 'o .npmrc não pode estar no .gitignore');
});

test('nenhuma dependência declarada está faltando no node_modules', () => {
  const faltando = Object.keys(pacote.dependencies || {}).filter((nome) => {
    try {
      require.resolve(nome);
      return false;
    } catch (_) {
      return true;
    }
  });
  assert.deepEqual(faltando, [], 'rode "npm install" — a instalação está incompleta');
});

test('a plataforma sobe mesmo sem o leitor de planilhas', () => {
  // A `xlsx` é a única dependência que vem de fora do npm, e por isso a única
  // que pode faltar numa instalação que deu errado pela metade. Carregá-la no
  // topo de um arquivo derrubava o `npm start` inteiro por causa de uma tela
  // que quase ninguém abre.
  const arquivo = fs.readFileSync(path.join(raiz, 'src/domain/importacao-clientes.js'), 'utf8');
  const noTopo = arquivo
    .split('\n')
    .filter((linha) => /^const .*= require\('xlsx'\)/.test(linha.trim()));
  assert.deepEqual(noTopo, [], "o require('xlsx') precisa ficar dentro da função que lê a planilha");

  const importacao = require('../src/domain/importacao-clientes');
  assert.equal(typeof importacao.analisar, 'function');
});

test('a carga inicial e o servidor não dependem de nada opcional', () => {
  // Um `require` que só existe em ambiente de desenvolvimento derrubaria o
  // start do escritório. Todo require de topo precisa resolver.
  for (const arquivo of ['../scripts/seed.js', '../src/server.js']) {
    const caminho = require.resolve(arquivo);
    const codigo = fs.readFileSync(caminho, 'utf8');
    const externos = [...codigo.matchAll(/require\('([^.'][^']*)'\)/g)]
      .map((m) => m[1])
      .filter((nome) => !nome.startsWith('node:'));
    for (const nome of externos) {
      assert.doesNotThrow(() => require.resolve(nome), `${path.basename(caminho)} precisa de ${nome}`);
    }
  }
});
