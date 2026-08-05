'use strict';

/**
 * Inscrição do navegador no Web Push.
 *
 * O Service Worker se inscreve no serviço de push do próprio navegador e manda
 * o resultado para cá; é por essa inscrição que o aviso chega mesmo com a
 * plataforma fechada.
 */

const express = require('express');
const pushDom = require('../domain/push');
const registro = require('../lib/registro');

const router = express.Router();

/** A tela pergunta se o push está disponível e com qual chave se inscrever. */
router.get('/chave', (req, res) => {
  res.json({
    habilitado: pushDom.habilitado(),
    chavePublica: pushDom.chavePublica(),
  });
});

router.post('/inscrever', (req, res, next) => {
  try {
    if (!pushDom.habilitado()) {
      return res.status(503).json({ ok: false, motivo: 'Web Push não está configurado no servidor.' });
    }
    const inscricao = pushDom.registrarInscricao(
      req.session.usuario.id,
      req.body && req.body.inscricao,
      req.get('user-agent')
    );
    registro.notificacao('inscrição de push registrada', {
      usuario: req.session.usuario.login,
      inscricao: inscricao.id,
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    if (/inválida|sem as chaves/i.test(err.message)) {
      return res.status(400).json({ ok: false, motivo: err.message });
    }
    next(err);
  }
});

router.post('/cancelar', (req, res) => {
  const endpoint = String((req.body && req.body.endpoint) || '');
  const removidas = endpoint ? pushDom.remover(endpoint) : 0;
  registro.notificacao('inscrição de push cancelada', {
    usuario: req.session.usuario.login,
    removidas,
  });
  res.json({ ok: true, removidas });
});

module.exports = router;
