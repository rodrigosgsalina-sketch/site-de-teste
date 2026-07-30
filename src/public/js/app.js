/* Pequenos comportamentos de interface. Nenhuma dependência externa. */
(function () {
  'use strict';

  /* Impedimento: revela e torna obrigatória a descrição. */
  function ligarImpedimentos(raiz) {
    raiz.querySelectorAll('[data-impedimento]').forEach(function (select) {
      var alvo = document.getElementById(select.dataset.impedimento);
      if (!alvo) return;
      var campo = alvo.querySelector('textarea, input');
      function atualizar() {
        var ativo = select.value === 'Sim';
        alvo.hidden = !ativo;
        if (campo) campo.required = ativo;
      }
      select.addEventListener('change', atualizar);
      atualizar();
    });
  }

  /* Confirmação em ações destrutivas. */
  function ligarConfirmacoes(raiz) {
    raiz.querySelectorAll('[data-confirmar]').forEach(function (el) {
      el.addEventListener('submit', function (evento) {
        if (!window.confirm(el.dataset.confirmar)) evento.preventDefault();
      });
      el.addEventListener('click', function (evento) {
        if (el.tagName === 'A' && !window.confirm(el.dataset.confirmar)) evento.preventDefault();
      });
    });
  }

  /* Abre a seção do setor referenciada na URL (#setor-3). */
  function abrirAncora() {
    if (!location.hash) return;
    var alvo = document.querySelector(location.hash);
    if (alvo && alvo.tagName === 'DETAILS') {
      alvo.open = true;
      alvo.scrollIntoView({ block: 'center' });
    }
  }

  /* Filtro rápido de tabelas (campo com data-filtra="#id-da-tabela"). */
  function ligarFiltros(raiz) {
    raiz.querySelectorAll('[data-filtra]').forEach(function (campo) {
      var tabela = document.querySelector(campo.dataset.filtra);
      if (!tabela) return;
      campo.addEventListener('input', function () {
        var termo = campo.value.toLowerCase();
        tabela.querySelectorAll('tbody tr').forEach(function (linha) {
          linha.hidden = termo && linha.textContent.toLowerCase().indexOf(termo) === -1;
        });
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    ligarImpedimentos(document);
    ligarConfirmacoes(document);
    ligarFiltros(document);
    abrirAncora();
  });
})();
