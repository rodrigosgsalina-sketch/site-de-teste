'use strict';

/**
 * Canal de eventos em tempo real (Server-Sent Events).
 *
 * A tela abre `GET /eventos` e deixa a conexão viva; o servidor empurra os
 * avisos assim que eles acontecem. Exige login — cada conexão só recebe o que
 * é do seu usuário.
 */

const express = require('express');
const eventos = require('../lib/eventos');
const avisosDom = require('../domain/avisos');

const router = express.Router();

router.get('/', (req, res) => {
  const usuario = req.session.usuario;

  // Nada de buffer intermediário nem cache: o fluxo tem que sair na hora.
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);

  eventos.assinar(usuario.id, req, res);

  // Primeiro quadro: estado atual, para a tela acertar o contador ao (re)conectar.
  try {
    eventos.enviarPara(usuario.id, 'conectado', {
      usuario: usuario.nome,
      naoLidos: avisosDom.contarNaoLidos(usuario.id),
      em: new Date().toISOString(),
    });
  } catch (err) {
    // Falha de leitura não pode derrubar o canal — ele segue vivo para o resto.
    // eslint-disable-next-line no-console
    console.error('[eventos] falha ao enviar o estado inicial:', err.message);
  }
});

module.exports = router;
