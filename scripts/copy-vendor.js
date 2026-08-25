#!/usr/bin/env node
'use strict';

/** Copia dependências de front-end para public/vendor (a aplicação não usa CDN). */

const fs = require('fs');
const path = require('path');

const destino = path.join(__dirname, '..', 'src', 'public', 'vendor');
const arquivos = [
  ['chart.js/dist/chart.umd.js', 'chart.umd.js'],
  // Leitor de PDF da tela de Tabela de preço: desenha o arquivo na própria
  // página, sem <iframe> (a CSP não permite) e sem depender do visualizador de
  // PDF de cada navegador. O worker roda o trabalho pesado fora da tela.
  //
  // É a versão `legacy` de propósito. A build moderna usa recursos de
  // JavaScript recém-chegados (`Map.prototype.getOrInsertComputed`, entre
  // outros) e quebra calada num navegador de alguns meses atrás — o PDF abre,
  // conta as páginas e desenha uma folha em branco. A legacy traz os
  // preenchimentos necessários e roda no que o escritório tiver instalado.
  ['pdfjs-dist/legacy/build/pdf.min.mjs', 'pdf.min.mjs'],
  ['pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
];

fs.mkdirSync(destino, { recursive: true });
for (const [origem, nome] of arquivos) {
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'node_modules', origem), path.join(destino, nome));
    console.log(`vendor: ${nome}`);
  } catch (err) {
    console.warn(`vendor: não foi possível copiar ${origem} (${err.message})`);
  }
}
