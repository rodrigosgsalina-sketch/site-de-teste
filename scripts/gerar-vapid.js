#!/usr/bin/env node
'use strict';

/**
 * Gera o par de chaves VAPID usado pelo Web Push.
 *
 *   npm run vapid
 *
 * Guarde a chave privada como segredo (ela vai só no .env do servidor). A
 * pública é entregue ao navegador na hora de assinar as notificações.
 *
 * Sem essas chaves a plataforma continua funcionando: os avisos aparecem em
 * tempo real enquanto a plataforma estiver aberta em alguma aba. Com elas, o
 * aviso chega também com o navegador fechado.
 */

const { gerarChaves } = require('../src/lib/webpush');

const chaves = gerarChaves();

console.log('Chaves VAPID geradas. Coloque no .env do servidor:\n');
console.log(`VAPID_PUBLIC_KEY=${chaves.publica}`);
console.log(`VAPID_PRIVATE_KEY=${chaves.privada}`);
console.log('VAPID_SUBJECT=mailto:contato@jsgrilo.com.br');
console.log('\nDepois reinicie a plataforma. A chave privada não deve ser versionada nem compartilhada.');
