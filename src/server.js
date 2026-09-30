'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');

const app = require('./app');
const config = require('./config');
const seguranca = require('./lib/seguranca');
const db = require('./db');
const processos = require('./domain/processos');

if (config.producao) config.validarProducao();

db.open();

/** Lê certificado e chave; erro de leitura para o processo com mensagem clara. */
function credenciaisTls() {
  try {
    const credenciais = {
      cert: fs.readFileSync(config.tlsCert),
      key: fs.readFileSync(config.tlsKey),
      // TLS 1.2 é o piso; abaixo disso não há mais motivo para aceitar.
      minVersion: 'TLSv1.2',
      honorCipherOrder: true,
    };
    if (config.tlsCa) credenciais.ca = fs.readFileSync(config.tlsCa);
    if (config.tlsPassphrase) credenciais.passphrase = config.tlsPassphrase;
    return credenciais;
  } catch (err) {
    throw new Error(
      `Não consegui ler o certificado TLS (${err.path || err.message}). ` +
        'Confira TLS_CERT e TLS_KEY no .env — ou rode "npm run certificado" para gerar um de teste.'
    );
  }
}

/* O servidor sobe em HTTPS quando há certificado configurado. Sem certificado,
   sobe em HTTP — o esperado no desenvolvimento local e também atrás de um proxy
   (nginx, Caddy, Cloudflare) que já termina o TLS. */
const servidor = config.httpsProprio
  ? https.createServer(credenciaisTls(), app)
  : http.createServer(app);

/**
 * Endereços IPv4 desta máquina na rede local.
 *
 * O `localhost` da mensagem de início só serve para quem está sentado no
 * servidor. Quem abre a plataforma da sua mesa precisa do endereço da máquina
 * na rede, e procurá-lo no `ipconfig` toda vez — ou descobrir que ele mudou
 * sozinho, porque o roteador entrega IP por DHCP — é o começo de "parou de
 * funcionar". Então o próprio `npm start` diz por onde entrar.
 */
function enderecosDaRede() {
  const achados = [];
  const interfaces = os.networkInterfaces();
  for (const nome of Object.keys(interfaces)) {
    for (const rede of interfaces[nome] || []) {
      if (rede.family !== 'IPv4' && rede.family !== 4) continue;
      if (rede.internal) continue;
      achados.push({ nome, endereco: rede.address });
    }
  }
  return achados;
}

servidor.listen(config.port, () => {
  const esquema = config.httpsProprio ? 'https' : 'http';
  // eslint-disable-next-line no-console
  console.log(`JS Grilo · Processos — ${esquema}://localhost:${config.port} (${config.env})`);

  const rede = enderecosDaRede();
  if (rede.length) {
    // eslint-disable-next-line no-console
    console.log('\nNas outras máquinas da rede, abra:');
    for (const { nome, endereco } of rede) {
      // eslint-disable-next-line no-console
      console.log(`  ${esquema}://${endereco}:${config.port}   (${nome})`);
    }
    // eslint-disable-next-line no-console
    console.log(
      '\nSe não abrir de outra máquina, o servidor está de pé e quem barra é o caminho:\n' +
        '  1. o Firewall do Windows precisa liberar o Node nesta porta — na primeira vez\n' +
        '     ele pergunta, e negar (ou trocar a versão do Node) deixa a porta fechada;\n' +
        '  2. a rede precisa estar marcada como "Particular", não "Pública";\n' +
        '  3. o endereço acima muda sozinho se o roteador entregar outro IP — vale fixá-lo.\n' +
        '  Conferência completa:  npm run doutor'
    );
  } else {
    // eslint-disable-next-line no-console
    console.warn('\n[atenção] nenhuma placa de rede com IPv4 encontrada: só dá para abrir nesta máquina.');
  }

  if (config.forcarHttps && !config.httpsProprio) {
    // eslint-disable-next-line no-console
    console.warn(
      '\n[atenção] FORCE_HTTPS está ligado e não há certificado próprio: toda visita em http:// é\n' +
        '          recusada ou redirecionada para https://, inclusive as da rede local.'
    );
  }

  if (!config.httpsProprio && config.producao && !config.trustProxy) {
    // eslint-disable-next-line no-console
    console.warn('[atenção] rodando sem TLS próprio e sem proxy declarado (TRUST_PROXY).');
  }
});

/* Porta 80 respondendo só com o redirecionamento para HTTPS (e com o desafio
   do Let's Encrypt, quando houver). A lógica fica em src/lib/seguranca.js. */
let redirecionador = null;
if (config.httpsProprio && config.redirectPort > 0) {
  redirecionador = http.createServer(
    seguranca.tratadorDeRedirecionamento({
      portaHttps: config.port,
      acmeWebroot: config.acmeWebroot,
    })
  );
  redirecionador.listen(config.redirectPort, () => {
    // eslint-disable-next-line no-console
    console.log(`Redirecionando http://localhost:${config.redirectPort} → https`);
  });
}

/* Agendador simples de alertas de prazo. Em produção pode ser substituído
   por um cron externo chamando POST /admin/alertas/executar. */
if (config.alertIntervalMinutes > 0) {
  const intervalo = setInterval(
    () => {
      processos.verificarPrazos().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[alertas] falha ao verificar prazos:', err.message);
      });
    },
    config.alertIntervalMinutes * 60 * 1000
  );
  intervalo.unref();
}

function encerrar() {
  if (redirecionador) redirecionador.close();
  servidor.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
