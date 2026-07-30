'use strict';

const app = require('./app');
const config = require('./config');
const db = require('./db');
const processos = require('./domain/processos');

db.open();

const servidor = app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`JS Grilo · Processos — http://localhost:${config.port} (${config.env})`);
});

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
  servidor.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
