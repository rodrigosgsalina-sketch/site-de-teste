'use strict';

const express = require('express');
const dashboard = require('../domain/dashboard');

const router = express.Router();

/**
 * O dashboard é de todo mundo.
 *
 * Ele mostra o andamento do escritório — quantos processos, em que status, com
 * que prazo — e isso é exatamente o que qualquer usuário já enxerga um a um na
 * lista de processos. Guardá-lo para a Diretoria só escondia a soma de quem
 * fazia as parcelas.
 */
router.get('/', (req, res) => {
  const dados = dashboard.montar({ inicio: req.query.inicio, fim: req.query.fim });
  res.render('dashboard', { titulo: 'Dashboard gerencial', ...dados });
});

/** Dados para os gráficos (consumidos pelo Chart.js). */
router.get('/dados.json', (req, res) => {
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
