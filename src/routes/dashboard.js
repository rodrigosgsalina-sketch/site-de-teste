'use strict';

const express = require('express');
const acesso = require('../domain/acesso');
const dashboard = require('../domain/dashboard');

const router = express.Router();

/** O dashboard gerencial é restrito a Administradores e à Diretoria. */
function exigirGestor(req, res, next) {
  if (acesso.ehGestor(req.session.usuario)) return next();
  return res.status(403).render('erro', {
    titulo: 'Acesso restrito',
    mensagem: 'O dashboard gerencial é exclusivo da Diretoria e dos administradores.',
  });
}

router.get('/', exigirGestor, (req, res) => {
  const dados = dashboard.montar({ inicio: req.query.inicio, fim: req.query.fim });
  res.render('dashboard', { titulo: 'Dashboard gerencial', ...dados });
});

/** Dados para os gráficos (consumidos pelo Chart.js). */
router.get('/dados.json', exigirGestor, (req, res) => {
  const dados = dashboard.montar({ inicio: req.query.inicio, fim: req.query.fim });
  res.json({
    porStatus: dados.porStatus,
    porTipo: dados.porTipo,
    tempoMedio: dados.tempoMedio,
    produtividade: dados.produtividade,
    indicadores: dados.indicadores,
  });
});

module.exports = router;
