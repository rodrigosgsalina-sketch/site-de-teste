'use strict';

/**
 * Tabela de preço: uma tela só, aberta para todo o escritório.
 *
 * Ver é de todos; enviar, trocar e apagar é do administrador e do setor
 * responsável (`SETOR_TABELA_PRECO`). O arquivo servido daqui nunca é
 * interpretado pelo navegador como página: vai com o tipo declarado e
 * `nosniff`, e PDF e planilha saem como download.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const config = require('../config');
const csrf = require('../lib/csrf');
const acesso = require('../domain/acesso');
const tabelaPreco = require('../domain/tabela-preco');
const { ErroValidacao } = require('../domain/checklist');

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, tabelaPreco.pasta()),
    filename: (req, file, cb) => {
      // O nome gravado é sempre gerado aqui; o enviado pelo usuário só é
      // guardado no banco, para exibição e download.
      const ext = path.extname(String(file.originalname || '')).toLowerCase().slice(0, 8);
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: config.uploadMaxMb * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => {
    if (!tabelaPreco.extensaoAceita(file.originalname)) {
      return cb(new ErroValidacao('A tabela de preço aceita apenas .png, .pdf ou .xlsx.'));
    }
    cb(null, true);
  },
});

function flash(req, tipo, mensagem) {
  req.session.flash = { tipo, mensagem };
}

/** Tipo declarado na resposta, por formato. */
const TIPOS = {
  imagem: 'image/png',
  pdf: 'application/pdf',
  planilha: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/* ------------------------------------------------------------------ tela */

router.get('/', (req, res) => {
  const item = tabelaPreco.atual();
  const podeEditar = acesso.podeEditarTabelaPreco(req.session.usuario);

  let planilha = null;
  let erroPlanilha = null;
  if (item && item.formato === 'planilha') {
    try {
      planilha = tabelaPreco.grade(item);
    } catch (err) {
      erroPlanilha = err.message;
    }
  }

  res.render('tabela-preco', {
    titulo: 'Tabela de preço',
    item,
    planilha,
    erroPlanilha,
    podeEditar,
    setorResponsavel: tabelaPreco.setorResponsavel(),
    versoes: podeEditar ? tabelaPreco.versoes() : [],
    larguraConfortavel: tabelaPreco.LARGURA_CONFORTAVEL,
    tamanhoMaximoMb: config.uploadMaxMb,
  });
});

/* --------------------------------------------------------------- arquivo */

router.get('/arquivo/:id', (req, res) => {
  const item = tabelaPreco.obter(req.params.id);
  if (!item) {
    return res.status(404).render('erro', { titulo: 'Arquivo não encontrado', mensagem: '' });
  }
  const caminho = tabelaPreco.caminhoAbsoluto(item);
  if (!fs.existsSync(caminho)) {
    return res.status(404).render('erro', {
      titulo: 'Arquivo indisponível',
      mensagem: 'O arquivo não está mais no servidor.',
    });
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type(TIPOS[item.formato] || 'application/octet-stream');
  // A imagem aparece na tela; PDF e planilha descem como arquivo. O leitor de
  // PDF da própria página busca este mesmo endereço e não se importa com isso.
  const comoAnexo = item.formato !== 'imagem' || req.query.baixar === '1';
  res.setHeader(
    'Content-Disposition',
    `${comoAnexo ? 'attachment' : 'inline'}; filename="${encodeURIComponent(item.nome_original)}"`
  );
  res.sendFile(caminho);
});

/* ------------------------------------------------------------- alteração */

router.post('/', acesso.exigirTabelaPreco, upload.single('arquivo'), csrf.verificar, (req, res, next) => {
  try {
    if (!req.file) throw new ErroValidacao('Escolha um arquivo .png, .pdf ou .xlsx para enviar.');
    const { item, aviso } = tabelaPreco.registrar(req.file, req.body.descricao, req.session.usuario);
    flash(req, aviso ? 'alerta' : 'sucesso', aviso || `Tabela de preço atualizada com ${item.nome_original}.`);
    res.redirect('/tabela-preco');
  } catch (err) {
    // O arquivo já está no disco quando a validação falha aqui: some com ele.
    if (req.file && req.file.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect('/tabela-preco');
    }
    next(err);
  }
});

router.post('/:id/atual', acesso.exigirTabelaPreco, (req, res, next) => {
  try {
    const item = tabelaPreco.tornarAtual(req.params.id, req.session.usuario);
    flash(req, 'sucesso', `${item.nome_original} voltou a ser a tabela em exibição.`);
    res.redirect('/tabela-preco');
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect('/tabela-preco');
    }
    next(err);
  }
});

router.post('/:id/remover', acesso.exigirTabelaPreco, (req, res, next) => {
  try {
    const item = tabelaPreco.remover(req.params.id, req.session.usuario);
    flash(req, 'sucesso', `${item.nome_original} removida.`);
    res.redirect('/tabela-preco');
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect('/tabela-preco');
    }
    next(err);
  }
});

module.exports = router;
