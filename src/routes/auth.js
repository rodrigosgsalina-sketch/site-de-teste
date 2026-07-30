'use strict';

const express = require('express');
const usuarios = require('../domain/usuarios');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.usuario) return res.redirect('/');
  res.render('login', { titulo: 'Entrar', erro: null, login: '' });
});

// A autenticação é feita pelo ID de usuário (ex.: ana.paula), não pelo e-mail.
router.post('/login', (req, res) => {
  const { login, senha } = req.body;
  const resultado = usuarios.autenticar(login, senha);
  if (!resultado) {
    return res.status(401).render('login', {
      titulo: 'Entrar',
      erro: 'ID de usuário ou senha inválidos.',
      login: login || '',
    });
  }
  if (resultado.bloqueado) {
    return res.status(403).render('login', {
      titulo: 'Entrar',
      erro: 'Usuário inativo. Procure um administrador.',
      login: login || '',
    });
  }
  req.session.usuario = {
    id: resultado.id,
    nome: resultado.nome,
    login: resultado.login,
    email: resultado.email,
    perfil: resultado.perfil,
    setor: resultado.setor,
    setor_id: resultado.setor_id,
  };
  const destino = req.session.destinoPosLogin || '/';
  delete req.session.destinoPosLogin;
  res.redirect(destino);
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
