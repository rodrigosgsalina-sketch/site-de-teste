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
const compressao = require('./lib/compressao');
const estaticos = require('./lib/estaticos');
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

/* Endereço versionado dos arquivos estáticos (ver src/lib/estaticos.js).
   Fica em app.locals, e não em res.locals: assim vale em QUALQUER render,
   inclusive na tela de erro montada antes dos middlewares de página — o CSRF
   recusa uma escrita logo no começo da fila, e ali o helper precisa existir. */
app.locals.estatico = estaticos.estatico;

app.use(seguranca.exigirHttps);
app.use(seguranca.cabecalhos);
app.use(compressao);

app.use(express.urlencoded({ extended: false, limit: '1mb', parameterLimit: 2000 }));
app.use(express.json({ limit: '1mb' }));

/* Estáticos antes da sessão: pedir uma fonte ou o CSS não precisa tocar no
   banco nem no cookie.

   O cache depende de o endereço trazer a versão do arquivo (`?v=`, ver
   src/lib/estaticos.js). Com versão, o endereço muda sempre que o conteúdo
   muda, então guardar por um ano é seguro. Sem versão — alguém que digitou o
   caminho direto —, o navegador tem que perguntar antes de reusar: guardar por
   uma hora era o que deixava a tela nova rodando com o JavaScript velho depois
   de uma atualização. */
app.use(
  '/static',
  express.static(path.join(__dirname, 'public'), {
    dotfiles: 'ignore',
    index: false,
    setHeaders(res) {
      const versionado = Boolean(res.req && res.req.query && res.req.query.v);
      res.setHeader('Cache-Control', versionado ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  })
);

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

/** A requisição vai virar uma página HTML, ou é uma chamada de dados? */
function pedeTela(req) {
  if (req.xhr) return false;
  const aceita = String(req.headers.accept || '');
  if (aceita.includes('text/event-stream')) return false;
  if (aceita.includes('application/json') && !aceita.includes('text/html')) return false;
  return true;
}

/* Variáveis disponíveis em todas as views. */
app.use((req, res, next) => {
  res.locals.jsonSeguro = jsonSeguro;
  const usuario = req.session ? req.session.usuario : null;
  res.locals.usuario = usuario;
  // Os setores vêm do banco a cada tela: mudar os setores de alguém passa a
  // valer na hora, sem a pessoa precisar sair e entrar de novo.
  res.locals.setoresDoUsuario = usuario ? acesso.setoresProprios(usuario) : [];
  res.locals.ehGestor = usuario ? acesso.ehGestor(usuario) : false;
  res.locals.ehAdmin = usuario ? usuario.perfil === 'Administrador' : false;
  res.locals.caminhoAtual = req.path;
  res.locals.fmtData = datas.formatarData;
  res.locals.fmtDataHora = datas.formatarDataHora;
  res.locals.classeStatus = classeStatus;
  res.locals.classeItem = classeItem;
  res.locals.rotuloAviso = avisosDom.rotulo;
  res.locals.corAviso = avisosDom.cor;
  // Liga os logs de diagnóstico das notificações no console da tela.
  res.locals.debugAvisos = config.logNotificacoes;
  res.locals.flash = req.session ? req.session.flash : null;
  if (req.session) delete req.session.flash;

  // A faixa no topo mostra o que muda o rumo do processo (concluído, impedido,
  // cancelado). Os demais avisos chegam como cartão no canto da tela e ficam no
  // mural em /avisos — todos eles agora valem para o escritório inteiro.
  //
  // Só quem vai desenhar uma tela precisa disso. Chamadas de JSON (dispensar
  // aviso, buscar cliente, inscrever no push) e o canal de eventos não montam
  // view nenhuma — antes elas pagavam duas consultas ao banco à toa, e são
  // justamente as mais frequentes.
  res.locals.avisos = [];
  res.locals.avisosTotal = 0;
  if (usuario && pedeTela(req)) {
    try {
      res.locals.avisos = avisosDom.naoLidos(usuario.id, 3, { faixa: true });
      res.locals.avisosTotal = avisosDom.contarNaoLidos(usuario.id);
    } catch (err) {
      /* a falta da faixa não pode derrubar a página */
    }
  }
  next();
});

function exigirLogin(req, res, next) {
  if (req.session && req.session.usuario) return next();

  // Chamada feita por JavaScript (inscrição de push, dispensar aviso) recebe
  // 401 e trata; navegação normal vai para a tela de login.
  const querJson =
    req.xhr ||
    Boolean(req.is('application/json')) ||
    String(req.headers.accept || '').includes('application/json');

  if (!querJson && req.accepts('html')) {
    req.session.destinoPosLogin = req.originalUrl;
    return res.redirect('/login');
  }
  return res.status(401).json({ erro: 'Não autenticado' });
}

/* O Service Worker precisa ser servido na raiz para valer em todas as rotas —
   um arquivo em /static/js/ só teria escopo dentro de /static/js. */
app.get('/sw.js', (req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache');
  res.type('application/javascript; charset=utf-8');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.use('/', require('./routes/auth'));
app.use('/', exigirLogin, require('./routes/painel'));
app.use('/processos', exigirLogin, require('./routes/processos'));
app.use('/clientes', exigirLogin, require('./routes/clientes'));
app.use('/checklist', exigirLogin, require('./routes/checklist'));
app.use('/avisos', exigirLogin, require('./routes/avisos'));
app.use('/eventos', exigirLogin, require('./routes/eventos'));
app.use('/push', exigirLogin, require('./routes/push'));
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
