'use strict';

const express = require('express');
const seguranca = require('../lib/seguranca');
const avisosDom = require('../domain/avisos');

const router = express.Router();

/** O pedido veio do cartão de notificação (JavaScript) e não de um formulário? */
function esperaJson(req) {
  return req.xhr || String(req.headers.accept || '').includes('application/json');
}

/** Mural completo: os avisos que o usuário pode ver, com marcação de leitura. */
router.get('/', (req, res) => {
  const lista = avisosDom.listar(req.session.usuario.id, 200);
  // Só o administrador vê quem já abriu cada aviso — para os demais a consulta
  // nem chega a ser feita.
  res.render('avisos', {
    titulo: 'Avisos',
    lista,
    leituraPorAviso: res.locals.ehAdmin ? avisosDom.leituraDeVarios(lista.map((a) => a.id)) : new Map(),
  });
});

/** Dispensa um aviso — só para quem clicou, os demais continuam vendo. */
router.post('/:id/lido', (req, res) => {
  const naoLidos = avisosDom.marcarLido(Number(req.params.id), req.session.usuario.id);
  if (esperaJson(req)) return res.json({ ok: true, naoLidos });
  res.redirect(seguranca.destinoInterno(req.body.retorno, '/avisos'));
});

router.post('/lidos', (req, res) => {
  avisosDom.marcarTodosLidos(req.session.usuario.id);
  if (esperaJson(req)) return res.json({ ok: true, naoLidos: 0 });
  res.redirect(seguranca.destinoInterno(req.body.retorno, '/avisos'));
});

module.exports = router;
