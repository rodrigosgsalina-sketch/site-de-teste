/* Gráficos do dashboard gerencial (Chart.js servido localmente). */
(function () {
  'use strict';

  var dados = window.DADOS_DASHBOARD || { porStatus: [], porTipo: [] };
  if (typeof Chart === 'undefined') return;

  var PALETA = ['#1d5c8f', '#1d7a4c', '#a56b00', '#b3261e', '#5b3f8f', '#0f7f8f', '#8f5a1d', '#4a6572', '#7a1d5c', '#2f7f2f'];

  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  Chart.defaults.color = '#64798c';

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
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#eef2f6' } },
          y: { grid: { display: false }, ticks: { font: { size: 11 } } }
        }
      }
    });
  }
})();
