'use strict';

const express = require('express');
const avisosDom = require('../domain/avisos');

const router = express.Router();

/** Mural completo: todos os avisos, com marcação do que já foi lido. */
router.get('/', (req, res) => {
  res.render('avisos', {
    titulo: 'Avisos',
    lista: avisosDom.listar(req.session.usuario.id, 200),
  });
});

/** Dispensa um aviso — só para quem clicou, os demais continuam vendo. */
router.post('/:id/lido', (req, res) => {
  avisosDom.marcarLido(Number(req.params.id), req.session.usuario.id);
  res.redirect(req.body.retorno || '/avisos');
});

router.post('/lidos', (req, res) => {
  avisosDom.marcarTodosLidos(req.session.usuario.id);
  res.redirect(req.body.retorno || '/avisos');
});

module.exports = router;
