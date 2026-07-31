/* Gráficos do dashboard gerencial (Chart.js servido localmente). */
(function () {
  'use strict';

  var dados = window.DADOS_DASHBOARD || { porStatus: [], porTipo: [] };
  if (typeof Chart === 'undefined') return;

  var PALETA = ['#1d5c8f', '#2f9e6e', '#c58a1a', '#c9503f', '#6d5aa8', '#128a9a', '#9a6a2f', '#5b7183', '#a3437f', '#3f8f4f'];

  Chart.defaults.font.family = "'Manrope', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  Chart.defaults.font.weight = 500;
  Chart.defaults.color = '#8698a8';
  Chart.defaults.animation.duration = 700;
  Chart.defaults.animation.easing = 'easeOutQuart';

  var alvoStatus = document.getElementById('grafico-status');
  if (alvoStatus && dados.porStatus.length) {
    new Chart(alvoStatus, {
      type: 'doughnut',
      data: {
        labels: dados.porStatus.map(function (d) { return d.status; }),
        datasets: [{
          data: dados.porStatus.map(function (d) { return d.total; }),
          backgroundColor: dados.porStatus.map(function (d, i) { return PALETA[i % PALETA.length]; }),
          borderWidth: 2,
          borderColor: '#fff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } } }
      }
    });
  }

  var alvoTipo = document.getElementById('grafico-tipo');
  if (alvoTipo && dados.porTipo.length) {
    new Chart(alvoTipo, {
      type: 'bar',
      data: {
        labels: dados.porTipo.map(function (d) { return d.tipo; }),
        datasets: [{
          label: 'Processos',
          data: dados.porTipo.map(function (d) { return d.total; }),
          backgroundColor: '#1d5c8f',
          hoverBackgroundColor: '#2c7cb8',
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#eef3f8' } },
          y: { grid: { display: false }, ticks: { font: { size: 11 } } }
        }
      }
    });
  }
})();
