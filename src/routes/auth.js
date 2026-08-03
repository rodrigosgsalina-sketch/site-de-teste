'use strict';

const express = require('express');
const seguranca = require('../lib/seguranca');
const usuarios = require('../domain/usuarios');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.usuario) return res.redirect('/');
  res.render('login', { titulo: 'Entrar', erro: null, login: '' });
});

// A autenticação é feita pelo ID de usuário (ex.: ana.paula), não pelo e-mail.
router.post('/login', seguranca.freioDeLogin, (req, res, next) => {
  const { login, senha } = req.body;
  const resultado = usuarios.autenticar(login, senha);

  if (!resultado) {
    seguranca.registrarFalha(req);
    return res.status(401).render('login', {
      titulo: 'Entrar',
      // Mensagem única para senha errada e usuário inexistente: quem tenta
      // adivinhar não descobre quais IDs existem.
      erro: 'ID de usuário ou senha inválidos.',
      login: login || '',
    });
  }
  if (resultado.bloqueado) {
    seguranca.registrarFalha(req);
    return res.status(403).render('login', {
      titulo: 'Entrar',
      erro: 'Usuário inativo. Procure um administrador.',
      login: login || '',
    });
  }

  seguranca.limparFalhas(req);
  const destino = req.session.destinoPosLogin || '/';

  // Sessão nova a cada login: um identificador capturado antes da entrada
  // (fixação de sessão) deixa de valer no instante em que a senha confere.
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.usuario = {
      id: resultado.id,
      nome: resultado.nome,
      login: resultado.login,
      email: resultado.email,
      perfil: resultado.perfil,
      setor: resultado.setor,
      setor_id: resultado.setor_id,
    };
    req.session.save((erroGravacao) => {
      if (erroGravacao) return next(erroGravacao);
      // O destino guardado antes do login nunca leva para fora do site.
      res.redirect(seguranca.destinoInterno(destino, '/'));
    });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('jsgrilo.sid');
    res.redirect('/login');
  });
});

module.exports = router;
