#!/usr/bin/env node
'use strict';

/** Copia dependências de front-end para public/vendor (a aplicação não usa CDN). */

const fs = require('fs');
const path = require('path');

const destino = path.join(__dirname, '..', 'src', 'public', 'vendor');
const arquivos = [['chart.js/dist/chart.umd.js', 'chart.umd.js']];

fs.mkdirSync(destino, { recursive: true });
for (const [origem, nome] of arquivos) {
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'node_modules', origem), path.join(destino, nome));
    console.log(`vendor: ${nome}`);
  } catch (err) {
    console.warn(`vendor: não foi possível copiar ${origem} (${err.message})`);
  }
}
