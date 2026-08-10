'use strict';

const express = require('express');
const db = require('../db');
const acesso = require('../domain/acesso');
const checklist = require('../domain/checklist');
const processos = require('../domain/processos');
const usuariosDom = require('../domain/usuarios');
const { ErroValidacao } = require('../domain/checklist');

const router = express.Router();

/** Início: fila de trabalho do setor do usuário. */
router.get('/', (req, res) => {
  const usuario = req.session.usuario;
  const setorIds = acesso.setorIdsDoUsuario(usuario);
  const itens = checklist.fila({ setorIds });
  const meus = processos.listar({
    setorIds,
    usuarioId: usuario.id,
    limite: 10,
  });
  // Prazo estourando é assunto do escritório inteiro, não só de quem responde.
  const alertas = processos.comAlertaDePrazo().slice(0, 8);

  const resumo = {
    pendentes: itens.filter((i) => i.status_item === 'Pendente').length,
    impedidos: itens.filter((i) => i.status_item === 'Impedido').length,
    atrasados: itens.filter((i) => i.prazo && new Date(i.prazo) < new Date()).length,
  };

  res.render('painel', {
    titulo: 'Minha fila',
    itens,
    meus,
    alertas,
    resumo,
    setores: acesso.setoresDoUsuario(usuario),
  });
});

/** Perfil do usuário logado (troca de senha). */
router.get('/perfil', (req, res) => {
  res.render('perfil', { titulo: 'Meu perfil', erro: null, sucesso: null });
});

router.post('/perfil/senha', (req, res, next) => {
  try {
    usuariosDom.alterarSenha(req.session.usuario.id, req.body.senha_atual, req.body.nova_senha);
    res.render('perfil', { titulo: 'Meu perfil', erro: null, sucesso: 'Senha alterada com sucesso.' });
  } catch (err) {
    if (err instanceof ErroValidacao) {
      return res.status(400).render('perfil', { titulo: 'Meu perfil', erro: err.message, sucesso: null });
    }
    next(err);
  }
});

module.exports = router;
