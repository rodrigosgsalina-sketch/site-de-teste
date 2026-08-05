'use strict';

/**
 * Canal de eventos em tempo real (Server-Sent Events).
 *
 * A tela abre `GET /eventos` e deixa a conexão viva; o servidor empurra os
 * avisos assim que eles acontecem. Exige login — cada conexão só recebe o que
 * é do seu usuário.
 *
 * Reconexão sem buraco: o navegador reenvia o `Last-Event-ID` do último aviso
 * que recebeu (e a tela manda `?desde=` ao trocar de página), e o servidor
 * repõe da base tudo o que passou no intervalo. É o que impede um aviso de se
 * perder entre uma tela e outra.
 */

const express = require('express');
const eventos = require('../lib/eventos');
const registro = require('../lib/registro');
const avisosDom = require('../domain/avisos');

const router = express.Router();

/** Último aviso que a tela já viu, pelo cabeçalho do SSE ou pela query. */
function ultimoVisto(req) {
  const doCabecalho = Number(req.headers['last-event-id']);
  const daQuery = Number(req.query.desde);
  return Math.max(Number.isFinite(doCabecalho) ? doCabecalho : 0, Number.isFinite(daQuery) ? daQuery : 0);
}

router.get('/', (req, res) => {
  const usuario = req.session.usuario;

  // Nada de buffer intermediário nem cache: o fluxo tem que sair na hora.
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);

  eventos.assinar(usuario.id, req, res);
  registro.notificacao('canal aberto', {
    usuario: usuario.login,
    canais: eventos.contar(),
    desde: ultimoVisto(req),
  });

  try {
    // Primeiro quadro: estado atual, para a tela acertar o contador.
    eventos.enviarPara(usuario.id, 'conectado', {
      usuario: usuario.nome,
      naoLidos: avisosDom.contarNaoLidos(usuario.id),
      // Marco de onde a tela deve continuar a partir da próxima navegação.
      ultimoAviso: avisosDom.ultimoIdVisivel(usuario.id),
      em: new Date().toISOString(),
    });

    // Depois, o que aconteceu enquanto esta tela estava fora do ar. Só há o
    // que repor quando a tela diz onde parou: numa primeira visita, o contador
    // e o mural já mostram o acumulado — ninguém quer dez cartões ao entrar.
    const desde = ultimoVisto(req);
    const perdidos = desde > 0 ? avisosDom.pendentesDesde(usuario.id, desde) : [];
    for (const aviso of perdidos) {
      eventos.enviarPara(
        usuario.id,
        'aviso',
        { ...aviso, naoLidos: avisosDom.contarNaoLidos(usuario.id), atrasado: true },
        aviso.id
      );
    }
    if (perdidos.length) {
      registro.notificacao('reposição na reconexão', {
        usuario: usuario.login,
        desde,
        avisos: perdidos.length,
      });
    }
  } catch (err) {
    // Falha de leitura não pode derrubar o canal — ele segue vivo para o resto.
    registro.notificacao('falha ao montar o estado inicial', { usuario: usuario.login, motivo: err.message });
    // eslint-disable-next-line no-console
    console.error('[eventos] falha ao enviar o estado inicial:', err.message);
  }
});

module.exports = router;
