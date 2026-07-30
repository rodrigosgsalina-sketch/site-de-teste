#!/usr/bin/env node
'use strict';

/** Apaga o banco e os uploads locais. Use com cuidado: destrói os dados. */

const fs = require('fs');
const path = require('path');
const config = require('../src/config');

for (const arquivo of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`, path.join(config.dataDir, 'sessions.db')]) {
  if (fs.existsSync(arquivo)) {
    fs.unlinkSync(arquivo);
    console.log(`removido: ${arquivo}`);
  }
}
if (fs.existsSync(config.uploadsDir)) {
  fs.rmSync(config.uploadsDir, { recursive: true, force: true });
  console.log(`removido: ${config.uploadsDir}`);
}
console.log('Banco zerado. Rode "npm run seed" para recarregar o modelo.');
