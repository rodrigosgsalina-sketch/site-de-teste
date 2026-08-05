#!/usr/bin/env node
'use strict';

/**
 * Conferência do ambiente antes de rodar a plataforma.
 *
 *   npm run doutor
 *
 * Responde, em uma tela, as perguntas que costumam travar a primeira execução:
 * a versão do Node serve? o .env existe? o OpenSSL está no caminho (ele vem com
 * o Git for Windows, então aparece no Git Bash e não no Prompt de Comando)? o
 * certificado está válido? o push está configurado?
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/config');

const VERDE = '\u001b[32m';
const AMARELO = '\u001b[33m';
const VERMELHO = '\u001b[31m';
const CINZA = '\u001b[90m';
const FIM = '\u001b[0m';

let problemas = 0;
let alertas = 0;

function linha(situacao, titulo, detalhe) {
  const marcas = { ok: `${VERDE}✓${FIM}`, alerta: `${AMARELO}!${FIM}`, erro: `${VERMELHO}✗${FIM}` };
  if (situacao === 'erro') problemas += 1;
  if (situacao === 'alerta') alertas += 1;
  console.log(`  ${marcas[situacao]} ${titulo}`);
  if (detalhe) console.log(`    ${CINZA}${detalhe}${FIM}`);
}

/** Git Bash, Prompt de Comando, PowerShell ou um terminal Unix? */
function terminal() {
  if (process.env.MSYSTEM) return `Git Bash (${process.env.MSYSTEM})`;
  if (process.platform !== 'win32') return `terminal do ${process.platform}`;
  if (process.env.PSModulePath) return 'PowerShell';
  return 'Prompt de Comando (cmd)';
}

function versaoDoNode() {
  const [maior, menor] = process.versions.node.split('.').map(Number);
  const serve = maior > 22 || (maior === 22 && menor >= 5);
  linha(
    serve ? 'ok' : 'erro',
    `Node.js ${process.versions.node}`,
    serve ? null : 'A plataforma usa o SQLite embutido no Node: é preciso 22.5 ou mais novo.'
  );
}

function opensslDisponivel() {
  try {
    const versao = execFileSync('openssl', ['version'], { encoding: 'utf8' }).trim();
    linha('ok', `OpenSSL disponível — ${versao}`, 'usado por "npm run certificado"');
  } catch (_) {
    linha(
      process.platform === 'win32' ? 'alerta' : 'erro',
      'OpenSSL não encontrado no caminho',
      process.platform === 'win32'
        ? 'Ele vem junto com o Git for Windows. Rode os comandos no Git Bash, não no Prompt de Comando.'
        : 'Instale o pacote openssl para gerar os certificados.'
    );
  }
}

function arquivoEnv() {
  const caminho = path.join(config.root, '.env');
  if (!fs.existsSync(caminho)) {
    linha('alerta', '.env ainda não existe', 'Crie a partir do exemplo:  cp .env.example .env');
    return;
  }
  linha('ok', '.env encontrado');

  if (config.producao && config.segredoPadrao) {
    linha('erro', 'SESSION_SECRET é de exemplo ou curto demais', 'Gere um novo:  openssl rand -hex 32');
  } else if (config.segredoPadrao) {
    linha(
      'alerta',
      'SESSION_SECRET ainda é o de exemplo (ou tem menos de 24 caracteres)',
      'Aceitável em desenvolvimento; troque antes de publicar:  openssl rand -hex 32'
    );
  } else {
    linha('ok', 'SESSION_SECRET próprio configurado');
  }
}

function certificados() {
  if (!config.httpsProprio) {
    linha(
      config.producao && !config.trustProxy ? 'erro' : 'alerta',
      'A plataforma vai subir em HTTP',
      config.trustProxy
        ? 'TRUST_PROXY declarado: o HTTPS termina no proxy à frente — ok.'
        : 'Sem TLS_CERT/TLS_KEY. Para HTTPS, rode: npm run certificado'
    );
    return;
  }

  for (const [rotulo, arquivo] of [['certificado', config.tlsCert], ['chave', config.tlsKey]]) {
    if (!fs.existsSync(arquivo)) {
      linha('erro', `${rotulo} não encontrado`, arquivo);
      return;
    }
  }

  try {
    const saida = execFileSync('openssl', ['x509', '-in', config.tlsCert, '-noout', '-enddate', '-subject'], {
      encoding: 'utf8',
    });
    const fim = (saida.match(/notAfter=(.+)/) || [])[1];
    const vence = fim ? new Date(fim) : null;
    const dias = vence ? Math.round((vence - Date.now()) / 86400000) : null;

    if (dias === null) linha('ok', 'Certificado TLS configurado', config.tlsCert);
    else if (dias < 0) linha('erro', `Certificado vencido há ${Math.abs(dias)} dia(s)`, 'Reemita: npm run certificado -- --forcar');
    else if (dias < 30) linha('alerta', `Certificado vence em ${dias} dia(s)`, 'Reemita: npm run certificado -- --forcar');
    else linha('ok', `Certificado TLS válido por mais ${dias} dia(s)`, config.tlsCert);
  } catch (_) {
    linha('alerta', 'Certificado presente, mas não consegui ler a validade', 'OpenSSL indisponível neste terminal.');
  }

  const autoridade = path.join(path.dirname(config.tlsCert), 'autoridade.pem');
  if (fs.existsSync(autoridade)) {
    linha('ok', 'Autoridade local presente', `Instale nos aparelhos: ${autoridade}`);
  }
}

function pastaDeDados() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const teste = path.join(config.dataDir, '.escrita-de-teste');
    fs.writeFileSync(teste, 'ok');
    fs.unlinkSync(teste);
    linha('ok', 'Pasta de dados gravável', config.dataDir);
  } catch (err) {
    linha('erro', 'Não consigo gravar na pasta de dados', `${config.dataDir} — ${err.message}`);
  }

  if (fs.existsSync(config.dbFile)) {
    const tamanho = Math.max(1, Math.round(fs.statSync(config.dbFile).size / 1024));
    linha('ok', `Banco de dados presente (${tamanho} KB)`, config.dbFile);
  } else {
    linha('alerta', 'Banco ainda não criado', 'Rode:  npm run seed');
  }
}

function notificacoes() {
  if (config.vapid.publica && config.vapid.privada) {
    linha('ok', 'Web Push configurado (VAPID)', 'notificação chega com o navegador fechado');
  } else {
    linha(
      'alerta',
      'Web Push desligado',
      'Opcional. Para ligar:  npm run vapid  (sem isso, o aviso aparece com a plataforma aberta)'
    );
  }
}

function main() {
  console.log(`\nJS Grilo · Processos — conferência do ambiente`);
  console.log(`${CINZA}  ${terminal()} · ${os.platform()} ${os.release()}${FIM}\n`);

  versaoDoNode();
  opensslDisponivel();
  arquivoEnv();
  pastaDeDados();
  certificados();
  notificacoes();

  console.log('');
  if (problemas) {
    console.log(`${VERMELHO}${problemas} problema(s) impedem a plataforma de rodar como está.${FIM}`);
    process.exitCode = 1;
  } else if (alertas) {
    console.log(`${AMARELO}Tudo funcional, com ${alertas} ponto(s) de atenção acima.${FIM}`);
  } else {
    console.log(`${VERDE}Ambiente pronto.${FIM}`);
  }
  console.log('');
}

main();
