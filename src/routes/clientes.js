'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const config = require('../config');
const csrf = require('../lib/csrf');
const clientes = require('../domain/clientes');
const historico = require('../domain/historico');
const importacao = require('../domain/importacao-clientes');
const { ErroValidacao } = require('../domain/checklist');

const router = express.Router();

/* Planilhas ficam num diretório próprio até a confirmação da importação. */
const DIR_IMPORTACOES = path.join(config.dataDir, 'importacoes');
fs.mkdirSync(DIR_IMPORTACOES, { recursive: true });

const EXTENSOES = ['.xlsx', '.xls', '.csv'];

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DIR_IMPORTACOES),
    filename: (req, file, cb) =>
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 40 * 1024 * 1024, files: 1, fields: 20 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!EXTENSOES.includes(ext)) {
      return cb(new ErroValidacao(`Formato não aceito (${ext || 'sem extensão'}). Envie .xlsx, .xls ou .csv.`));
    }
    cb(null, true);
  },
});

function flash(req, tipo, mensagem) {
  req.session.flash = { tipo, mensagem };
}

function ehAdmin(req) {
  return req.session.usuario && req.session.usuario.perfil === 'Administrador';
}

/** O cadastro de clientes é privativo do administrador. */
function exigirAdministrador(req, res, next) {
  if (ehAdmin(req)) return next();
  return res.status(403).render('erro', {
    titulo: 'Acesso restrito',
    mensagem: 'Somente administradores podem cadastrar, editar ou importar clientes.',
  });
}

/* ------------------------------------------------------------- listagem */
router.get('/', (req, res) => {
  const filtros = {
    busca: (req.query.q || '').trim(),
    situacao: req.query.situacao || '',
    uf: req.query.uf || '',
  };
  const pagina = Math.max(1, Number(req.query.pagina) || 1);
  const resultado = clientes.listar({ ...filtros, limite: 100, pagina });

  res.render('clientes/lista', {
    titulo: 'Clientes',
    filtros,
    lista: resultado.itens,
    total: resultado.total,
    pagina: resultado.pagina,
    paginas: Math.max(1, Math.ceil(resultado.total / resultado.limite)),
    resumo: clientes.resumo(),
    situacoes: clientes.situacoesCadastradas(),
    ufs: clientes.ufsCadastradas(),
  });
});

/* -------------------------------------------------------------- cadastro */
router.get('/novo', exigirAdministrador, (req, res) => {
  res.render('clientes/formulario', {
    titulo: 'Novo cliente',
    cliente: { situacao: 'Ativa', pais: 'BRASIL' },
    situacoes: clientes.SITUACOES,
    erro: null,
    novo: true,
  });
});

router.post('/', exigirAdministrador, (req, res, next) => {
  try {
    const criado = clientes.criar(req.body, req.session.usuario);
    historico.registrar({
      processoId: null,
      acao: 'Cliente Cadastrado',
      usuario: req.session.usuario,
      observacao: `${criado.codigo} — ${criado.nome}`,
    });
    flash(req, 'sucesso', `Cliente ${criado.nome} cadastrado.`);
    res.redirect(`/clientes/${criado.id}`);
  } catch (err) {
    if (err instanceof ErroValidacao) {
      return res.status(400).render('clientes/formulario', {
        titulo: 'Novo cliente',
        cliente: req.body,
        situacoes: clientes.SITUACOES,
        erro: err.message,
        novo: true,
      });
    }
    next(err);
  }
});

/* ------------------------------------------------------------ importação */
router.get('/importar', exigirAdministrador, (req, res) => {
  res.render('clientes/importar', {
    titulo: 'Importar empresas',
    analise: null,
    arquivo: null,
    erro: null,
  });
});

router.post('/importar', exigirAdministrador, upload.single('planilha'), csrf.verificar, (req, res, next) => {
  try {
    if (!req.file) throw new ErroValidacao('Selecione a planilha de empresas.');
    const analise = importacao.analisar(fs.readFileSync(req.file.path));

    // guarda o resultado na sessão para a confirmação, sem reenviar o arquivo
    req.session.importacaoClientes = {
      arquivo: req.file.filename,
      nomeOriginal: req.file.originalname,
      registros: analise.registros,
    };

    res.render('clientes/importar', {
      titulo: 'Importar empresas',
      analise,
      arquivo: { nome: req.file.originalname, tamanho: req.file.size },
      erro: null,
    });
  } catch (err) {
    if (req.file) fs.rm(req.file.path, { force: true }, () => {});
    if (err instanceof ErroValidacao) {
      return res.status(400).render('clientes/importar', {
        titulo: 'Importar empresas',
        analise: null,
        arquivo: null,
        erro: err.message,
      });
    }
    next(err);
  }
});

router.post('/importar/confirmar', exigirAdministrador, (req, res, next) => {
  try {
    const pendente = req.session.importacaoClientes;
    if (!pendente || !pendente.registros || !pendente.registros.length) {
      throw new ErroValidacao('A conferência expirou. Envie a planilha novamente.');
    }
    const atualizarExistentes = req.body.atualizar === '1';
    const resultado = importacao.importar(pendente.registros, req.session.usuario, { atualizarExistentes });

    historico.registrar({
      processoId: null,
      acao: 'Clientes Importados',
      usuario: req.session.usuario,
      observacao:
        `${pendente.nomeOriginal}: ${resultado.criados} novo(s), ${resultado.atualizados} atualizado(s), ` +
        `${resultado.ignorados} ignorado(s)` + (resultado.falhas.length ? `, ${resultado.falhas.length} com falha` : ''),
    });

    fs.rm(path.join(DIR_IMPORTACOES, pendente.arquivo), { force: true }, () => {});
    delete req.session.importacaoClientes;

    flash(
      req,
      resultado.falhas.length ? 'alerta' : 'sucesso',
      `Importação concluída: ${resultado.criados} empresa(s) cadastrada(s), ` +
        `${resultado.atualizados} atualizada(s), ${resultado.ignorados} ignorada(s)` +
        (resultado.falhas.length ? ` e ${resultado.falhas.length} com falha.` : '.')
    );
    res.redirect('/clientes');
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect('/clientes/importar');
    }
    next(err);
  }
});

router.post('/importar/cancelar', exigirAdministrador, (req, res) => {
  const pendente = req.session.importacaoClientes;
  if (pendente) {
    fs.rm(path.join(DIR_IMPORTACOES, pendente.arquivo), { force: true }, () => {});
    delete req.session.importacaoClientes;
  }
  flash(req, 'sucesso', 'Importação cancelada. Nada foi gravado.');
  res.redirect('/clientes');
});

/* ------------------------------------------------------- ficha do cliente */
function carregar(req, res, next) {
  const cliente = clientes.obter(Number(req.params.id));
  if (!cliente) {
    return res.status(404).render('erro', { titulo: 'Cliente não encontrado', mensagem: 'Verifique o endereço.' });
  }
  req.cliente = cliente;
  next();
}

router.get('/:id', carregar, (req, res) => {
  res.render('clientes/ficha', {
    titulo: req.cliente.nome,
    cliente: req.cliente,
    processos: clientes.processosDoCliente(req.cliente),
    podeEditar: ehAdmin(req),
  });
});

router.get('/:id/editar', exigirAdministrador, carregar, (req, res) => {
  res.render('clientes/formulario', {
    titulo: `Editar ${req.cliente.nome}`,
    cliente: req.cliente,
    situacoes: clientes.SITUACOES,
    erro: null,
    novo: false,
  });
});

router.post('/:id/editar', exigirAdministrador, carregar, (req, res, next) => {
  try {
    const atualizado = clientes.atualizar(req.cliente.id, req.body);
    historico.registrar({
      processoId: null,
      acao: 'Cliente Atualizado',
      usuario: req.session.usuario,
      observacao: `${atualizado.codigo} — ${atualizado.nome}`,
    });
    flash(req, 'sucesso', 'Cadastro do cliente atualizado.');
    res.redirect(`/clientes/${atualizado.id}`);
  } catch (err) {
    if (err instanceof ErroValidacao) {
      return res.status(400).render('clientes/formulario', {
        titulo: `Editar ${req.cliente.nome}`,
        cliente: { ...req.cliente, ...req.body },
        situacoes: clientes.SITUACOES,
        erro: err.message,
        novo: false,
      });
    }
    next(err);
  }
});

router.post('/:id/excluir', exigirAdministrador, carregar, (req, res, next) => {
  try {
    const removido = clientes.remover(req.cliente.id);
    historico.registrar({
      processoId: null,
      acao: 'Cliente Removido',
      usuario: req.session.usuario,
      observacao: `${removido.codigo} — ${removido.nome}`,
    });
    flash(req, 'sucesso', `Cliente ${removido.nome} removido.`);
    res.redirect('/clientes');
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect(`/clientes/${req.params.id}`);
    }
    next(err);
  }
});

module.exports = router;
