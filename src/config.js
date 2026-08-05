'use strict';

const path = require('path');

require('dotenv').config();

const root = path.resolve(__dirname, '..');

/** Lê uma variável booleana ("1", "true", "sim" ligam). */
function bool(nome, padrao = false) {
  const valor = process.env[nome];
  if (valor === undefined || valor === '') return padrao;
  return ['1', 'true', 'sim', 'yes', 'on'].includes(String(valor).trim().toLowerCase());
}

const env = process.env.NODE_ENV || 'development';
const producao = env === 'production';

const SEGREDO_PADRAO = 'jsgrilo-dev-secret-troque-em-producao';
const sessionSecret = process.env.SESSION_SECRET || SEGREDO_PADRAO;

/**
 * Segredo que não protege nada: o embutido aqui, o texto que vem no
 * .env.example e qualquer valor curto demais para resistir a força bruta.
 * Copiar o .env.example e esquecer de trocar é o caminho mais provável para
 * publicar com sessão forjável, então esse caso conta como padrão.
 */
const SEGREDOS_DE_EXEMPLO = [SEGREDO_PADRAO, 'troque-este-valor', 'changeme', 'secret'];

function segredoInseguro(valor) {
  const limpo = String(valor || '').trim();
  return SEGREDOS_DE_EXEMPLO.includes(limpo) || limpo.length < 24;
}

const dataDir = process.env.DATA_DIR || path.join(root, 'data');

const config = {
  root,
  env,
  producao,
  port: Number(process.env.PORT || 3000),
  sessionSecret,
  segredoPadrao: segredoInseguro(sessionSecret),
  dataDir,
  dbFile: process.env.DB_FILE || path.join(dataDir, 'processos.db'),
  uploadsDir: process.env.UPLOADS_DIR || path.join(dataDir, 'uploads'),
  backupsDir: process.env.BACKUPS_DIR || path.join(dataDir, 'backups'),
  uploadMaxMb: Number(process.env.UPLOAD_MAX_MB || 15),
  // Transporte de e-mail: 'mock' registra na tabela notificacoes e no console;
  // 'smtp' fica pronto para plugar um provedor real (ver src/domain/notificacoes.js).
  mailTransport: process.env.MAIL_TRANSPORT || 'mock',
  mailFrom: process.env.MAIL_FROM || 'plataforma@jsgrilo.com.br',
  // Verificação automática de atrasos (minutos). 0 desliga o agendador.
  alertIntervalMinutes: Number(process.env.ALERT_INTERVAL_MINUTES || 60),
  senhaPadrao: process.env.SENHA_PADRAO || 'jsgrilo@2026',

  /* ------------------------------------------------------------- segurança */

  // Custo do bcrypt. 12 é o padrão recomendado hoje; nos testes cai para 4.
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || (env === 'test' ? 4 : 12)),
  senhaMinima: Number(process.env.SENHA_MINIMA || 8),

  // TLS servido pelo próprio Node (certificado e chave em PEM).
  tlsCert: process.env.TLS_CERT || '',
  tlsKey: process.env.TLS_KEY || '',
  tlsCa: process.env.TLS_CA || '',
  tlsPassphrase: process.env.TLS_PASSPHRASE || '',
  // Porta que responde em HTTP só para redirecionar ao HTTPS (0 desliga).
  redirectPort: Number(process.env.HTTP_REDIRECT_PORT || 0),
  // Pasta onde o certbot (--webroot) deixa o desafio do Let's Encrypt. A porta
  // de redirecionamento entrega /.well-known/acme-challenge/ a partir daqui,
  // para a renovação acontecer sem tirar a plataforma do ar.
  acmeWebroot: process.env.ACME_WEBROOT || path.join(dataDir, 'acme'),

  // Atrás de proxy/balanceador (nginx, Caddy, Cloudflare) o Express precisa
  // confiar no X-Forwarded-Proto para saber que a origem era HTTPS. Fica
  // desligado até ser declarado: acreditar em X-Forwarded-* sem proxy na frente
  // deixaria qualquer visitante forjar "vim por HTTPS" e o próprio IP.
  trustProxy: process.env.TRUST_PROXY || '',
  // Recusa requisições em HTTP puro, redirecionando para HTTPS.
  forcarHttps: bool('FORCE_HTTPS', producao),
  // max-age do HSTS em segundos (0 desliga o cabeçalho).
  hstsMaxAge: Number(process.env.HSTS_MAX_AGE || 15552000), // 180 dias
  // Tentativas de login por janela, por IP e por usuário.
  loginTentativas: Number(process.env.LOGIN_TENTATIVAS || 8),
  loginJanelaMinutos: Number(process.env.LOGIN_JANELA_MINUTOS || 15),
  // Duração da sessão em horas.
  sessaoHoras: Number(process.env.SESSAO_HORAS || 12),

  /* ---------------------------------------------------------- notificações */

  // Linhas de diagnóstico dos avisos no console (evento → destinatários →
  // entrega). Ligado fora de produção, onde o log não deve conter nome de
  // cliente.
  logNotificacoes: bool('LOG_NOTIFICACOES', env !== 'production'),

  // Web Push (notificação com o navegador fechado). Sem o par de chaves a
  // plataforma não fala com nenhum serviço externo — gere com `npm run vapid`.
  vapid: {
    publica: process.env.VAPID_PUBLIC_KEY || '',
    privada: process.env.VAPID_PRIVATE_KEY || '',
    contato: process.env.VAPID_SUBJECT || 'mailto:contato@jsgrilo.com.br',
  },
};

/** Certificado e chave configurados = a aplicação sobe em HTTPS sozinha. */
config.httpsProprio = Boolean(config.tlsCert && config.tlsKey);

/**
 * Em produção, segredo de sessão fraco e senha padrão são falhas de segurança,
 * não detalhes de configuração — o processo não sobe assim.
 */
function validarProducao() {
  const problemas = [];
  if (config.segredoPadrao) {
    problemas.push(
      'defina SESSION_SECRET com um valor longo e aleatório, próprio deste servidor (gere com: openssl rand -hex 32)'
    );
  }
  if (!config.httpsProprio && !config.trustProxy) {
    problemas.push(
      'configure TLS_CERT/TLS_KEY para servir HTTPS, ou TRUST_PROXY=1 se o HTTPS termina em um proxy à frente'
    );
  }
  if (problemas.length) {
    throw new Error(
      `Configuração insegura para NODE_ENV=production:\n  - ${problemas.join('\n  - ')}\n` +
        'Veja o arquivo .env.example e a seção "Publicar na internet" do README.'
    );
  }
}

config.validarProducao = validarProducao;
config.segredoInseguro = segredoInseguro;

module.exports = config;
