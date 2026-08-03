'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const criarSessionStore = require('./lib/session-store');

const config = require('./config');
const db = require('./db');
const datas = require('./lib/datas');
const csrf = require('./lib/csrf');
const seguranca = require('./lib/seguranca');
const acesso = require('./domain/acesso');
const avisosDom = require('./domain/avisos');

const app = express();

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });

// Não anuncia a tecnologia do servidor para quem procura alvos por versão.
app.disable('x-powered-by');
// Atrás de proxy/balanceador: confia no X-Forwarded-Proto e no IP de origem.
if (config.trustProxy) app.set('trust proxy', config.trustProxy);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(seguranca.exigirHttps);
app.use(seguranca.cabecalhos);

app.use(express.urlencoded({ extended: false, limit: '1mb', parameterLimit: 2000 }));
app.use(express.json({ limit: '1mb' }));
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h', dotfiles: 'ignore', index: false }));

app.use(
  session({
    store: criarSessionStore(db.open()),
    name: 'jsgrilo.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: config.sessaoHoras * 3600 * 1000,
      // Com HTTPS o cookie nunca trafega em claro. Em desenvolvimento (http://
      // localhost) o navegador descartaria um cookie "secure", então fica solto.
      secure: config.producao || config.forcarHttps || config.httpsProprio,
    },
  })
);

app.use(csrf.proteger);

/** Cor da etiqueta conforme o status do processo. */
function classeStatus(status) {
  if (status === 'Concluído' || status === 'Liberado') return 'et-verde';
  if (status === 'Impedido' || status === 'Cancelado') return 'et-vermelho';
  if (String(status || '').startsWith('Aguardando')) return 'et-amarelo';
  if (String(status || '').startsWith('Em Análise')) return 'et-azul';
  return 'et-neutro';
}

/** Cor da etiqueta conforme a situação do item de checklist. */
function classeItem(situacao) {
  if (situacao === 'Concluído') return 'et-verde';
  if (situacao === 'Impedido') return 'et-vermelho';
  return 'et-amarelo';
}

/**
 * JSON para embutir em <script> sem risco: `</script>` dentro de um dado
 * gravado no banco não consegue fechar a tag e injetar código.
 */
function jsonSeguro(valor) {
  return JSON.stringify(valor === undefined ? null : valor)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/* Variáveis disponíveis em todas as views. */
app.use((req, res, next) => {
  res.locals.jsonSeguro = jsonSeguro;
  const usuario = req.session ? req.session.usuario : null;
  res.locals.usuario = usuario;
  res.locals.ehGestor = usuario ? acesso.ehGestor(usuario) : false;
  res.locals.ehAdmin = usuario ? usuario.perfil === 'Administrador' : false;
  res.locals.caminhoAtual = req.path;
  res.locals.fmtData = datas.formatarData;
  res.locals.fmtDataHora = datas.formatarDataHora;
  res.locals.classeStatus = classeStatus;
  res.locals.classeItem = classeItem;
  res.locals.flash = req.session ? req.session.flash : null;
  if (req.session) delete req.session.flash;

  // Avisos internos (processo concluído/impedido) valem para todos os usuários.
  if (usuario) {
    try {
      res.locals.avisos = avisosDom.naoLidos(usuario.id, 4);
      res.locals.avisosTotal = avisosDom.contarNaoLidos(usuario.id);
    } catch (err) {
      res.locals.avisos = [];
      res.locals.avisosTotal = 0;
    }
  } else {
    res.locals.avisos = [];
    res.locals.avisosTotal = 0;
  }
  next();
});

function exigirLogin(req, res, next) {
  if (req.session && req.session.usuario) return next();
  if (req.accepts('html')) {
    req.session.destinoPosLogin = req.originalUrl;
    return res.redirect('/login');
  }
  return res.status(401).json({ erro: 'Não autenticado' });
}

app.use('/', require('./routes/auth'));
app.use('/', exigirLogin, require('./routes/painel'));
app.use('/processos', exigirLogin, require('./routes/processos'));
app.use('/clientes', exigirLogin, require('./routes/clientes'));
app.use('/checklist', exigirLogin, require('./routes/checklist'));
app.use('/avisos', exigirLogin, require('./routes/avisos'));
app.use('/dashboard', exigirLogin, require('./routes/dashboard'));
app.use('/admin', exigirLogin, acesso.exigirAdministrador, require('./routes/admin'));

app.use((req, res) => {
  res.status(404).render('erro', { titulo: 'Página não encontrada', mensagem: 'O endereço acessado não existe.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.csrf) {
    return res.status(403).render('erro', { titulo: 'Requisição bloqueada', mensagem: err.message });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).render('erro', {
      titulo: 'Arquivo grande demais',
      mensagem: `O limite por arquivo é de ${config.uploadMaxMb} MB.`,
    });
  }
  if (err && err.validacao) {
    return res.status(400).render('erro', { titulo: 'Não foi possível continuar', mensagem: err.message });
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).render('erro', {
    titulo: 'Erro interno',
    mensagem: config.env === 'production' ? 'Ocorreu um erro inesperado.' : err.message,
  });
});

app.locals.db = db;

module.exports = app;
