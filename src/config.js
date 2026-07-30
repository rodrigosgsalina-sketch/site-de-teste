'use strict';

const path = require('path');

require('dotenv').config();

const root = path.resolve(__dirname, '..');

module.exports = {
  root,
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  sessionSecret: process.env.SESSION_SECRET || 'jsgrilo-dev-secret-troque-em-producao',
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  dbFile: process.env.DB_FILE || path.join(process.env.DATA_DIR || path.join(root, 'data'), 'processos.db'),
  uploadsDir: process.env.UPLOADS_DIR || path.join(process.env.DATA_DIR || path.join(root, 'data'), 'uploads'),
  uploadMaxMb: Number(process.env.UPLOAD_MAX_MB || 15),
  // Transporte de e-mail: 'mock' registra na tabela notificacoes e no console;
  // 'smtp' fica pronto para plugar um provedor real (ver src/domain/notificacoes.js).
  mailTransport: process.env.MAIL_TRANSPORT || 'mock',
  mailFrom: process.env.MAIL_FROM || 'plataforma@jsgrilo.com.br',
  // Verificação automática de atrasos (minutos). 0 desliga o agendador.
  alertIntervalMinutes: Number(process.env.ALERT_INTERVAL_MINUTES || 60),
  senhaPadrao: process.env.SENHA_PADRAO || 'jsgrilo@2026',
};
