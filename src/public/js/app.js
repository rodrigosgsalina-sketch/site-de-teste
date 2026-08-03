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

  /* Texto comparável: sem acento e sem caixa. */
  function semAcento(texto) {
    return String(texto || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  /* Busca que filtra as opções de um <select> (data-filtra-lista="id-do-select"). */
  function ligarFiltroDeLista(raiz) {
    raiz.querySelectorAll('[data-filtra-lista]').forEach(function (campo) {
      var select = document.getElementById(campo.dataset.filtraLista);
      if (!select) return;
      var opcoes = [].slice.call(select.options).map(function (opcao) {
        return {
          elemento: opcao,
          texto: semAcento(opcao.dataset.busca || opcao.textContent),
          digitos: opcao.dataset.digitos || '',
        };
      });

      campo.addEventListener('input', function () {
        var termo = campo.value.trim();
        var digitos = termo.replace(/\D+/g, '');
        var partes = semAcento(termo).split(/\s+/).filter(Boolean);
        var visiveis = 0;

        opcoes.forEach(function (opcao) {
          if (!opcao.elemento.value) return; // "Selecione…" permanece
          var casa =
            !partes.length ||
            partes.every(function (p) { return opcao.texto.indexOf(p) !== -1; }) ||
            (digitos.length >= 3 && opcao.digitos.indexOf(digitos) !== -1);
          opcao.elemento.hidden = !casa;
          if (casa) visiveis += 1;
        });

        // Com um único resultado, já deixa selecionado.
        if (termo && visiveis === 1) {
          var unico = opcoes.filter(function (o) { return o.elemento.value && !o.elemento.hidden; })[0];
          if (unico) {
            select.value = unico.elemento.value;
            select.dispatchEvent(new Event('change'));
          }
        }
      });
    });
  }

  /* Mostra o resumo do cliente escolhido (data-resumo-cliente="id-do-painel"). */
  function ligarResumoDeCliente(raiz) {
    raiz.querySelectorAll('[data-resumo-cliente]').forEach(function (select) {
      var painel = document.getElementById(select.dataset.resumoCliente);
      if (!painel) return;

      function atualizar() {
        var opcao = select.options[select.selectedIndex];
        if (!opcao || !opcao.value) {
          painel.hidden = true;
          return;
        }
        painel.querySelectorAll('[data-campo]').forEach(function (el) {
          var valor = opcao.dataset[el.dataset.campo] || '—';
          if (el.tagName === 'A') el.href = valor;
          else el.textContent = valor;
        });
        painel.hidden = false;
      }

      select.addEventListener('change', atualizar);
      atualizar();
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
    ligarFiltroDeLista(document);
    ligarResumoDeCliente(document);
    ligarTopo();
    ligarContadores();
    ligarMenuMovel();
    abrirAncora();
  });
})();
