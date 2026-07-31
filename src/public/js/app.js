/* Comportamentos de interface. Sem dependências externas.
   Todo movimento respeita a preferência "reduzir animações" do sistema. */
(function () {
  'use strict';

  var reduzirMovimento = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
      alvo.scrollIntoView({ block: 'center', behavior: reduzirMovimento ? 'auto' : 'smooth' });
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

  /* O cabeçalho ganha borda e sombra assim que a página sai do topo. */
  function ligarTopo() {
    var topo = document.querySelector('.topo');
    if (!topo) return;
    function atualizar() {
      topo.classList.toggle('deslocado', window.scrollY > 4);
    }
    window.addEventListener('scroll', atualizar, { passive: true });
    atualizar();
  }

  /* Indicadores contam do zero até o valor final quando entram na tela. */
  function ligarContadores() {
    var alvos = [].slice.call(document.querySelectorAll('.indicador .valor'));
    if (!alvos.length) return;

    if (reduzirMovimento || !('IntersectionObserver' in window)) return;

    function animar(el) {
      var texto = el.textContent.trim();
      var casa = texto.match(/^(\d+)(%?)$/);
      if (!casa) return; // ignora "—" e valores com decimais
      var destino = parseInt(casa[1], 10);
      var sufixo = casa[2] || '';
      if (destino === 0) return;

      var duracao = Math.min(900, 260 + destino * 22);
      var inicio = null;
      el.style.minWidth = el.offsetWidth + 'px';

      function passo(agora) {
        if (inicio === null) inicio = agora;
        var t = Math.min(1, (agora - inicio) / duracao);
        var suave = 1 - Math.pow(1 - t, 3);
        el.textContent = Math.round(destino * suave) + sufixo;
        if (t < 1) requestAnimationFrame(passo);
      }
      el.textContent = '0' + sufixo;
      requestAnimationFrame(passo);
    }

    var observador = new IntersectionObserver(
      function (entradas) {
        entradas.forEach(function (entrada) {
          if (!entrada.isIntersecting) return;
          observador.unobserve(entrada.target);
          animar(entrada.target);
        });
      },
      { threshold: 0.4 }
    );
    alvos.forEach(function (el) { observador.observe(el); });
  }

  /* Fecha o menu lateral ao tocar fora dele, no celular. */
  function ligarMenuMovel() {
    var lateral = document.getElementById('lateral');
    if (!lateral) return;
    document.addEventListener('click', function (evento) {
      if (!lateral.classList.contains('aberta')) return;
      if (lateral.contains(evento.target) || evento.target.closest('.menu-toggle')) return;
      lateral.classList.remove('aberta');
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    ligarImpedimentos(document);
    ligarConfirmacoes(document);
    ligarFiltros(document);
    ligarTopo();
    ligarContadores();
    ligarMenuMovel();
    abrirAncora();
  });
})();
