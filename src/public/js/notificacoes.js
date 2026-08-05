/* Notificações em tempo real.

   Mantém uma conexão aberta com /eventos (Server-Sent Events) e, a cada aviso,
   mostra um cartão no canto inferior direito — o mesmo formato de uma
   notificação de desktop: título, texto, tempo e um "×" para dispensar.

   O EventSource reconecta sozinho quando a rede cai ou o servidor reinicia;
   ao reconectar, o servidor manda o total de não lidos e o contador do menu
   volta a bater. */
(function () {
  'use strict';

  if (!('EventSource' in window)) return;

  var TEMPO_VISIVEL = 12000; // ms que o cartão fica na tela
  var MAXIMO_NA_TELA = 4;
  var reduzirMovimento = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var pilha = null;
  var abertas = [];

  function areaDeNotificacoes() {
    if (pilha) return pilha;
    pilha = document.createElement('div');
    pilha.className = 'notificacoes';
    pilha.setAttribute('role', 'status');
    pilha.setAttribute('aria-live', 'polite');
    document.body.appendChild(pilha);
    return pilha;
  }

  function token() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : '';
  }

  /** Atualiza o número ao lado de "Avisos" no menu. */
  function atualizarContador(total) {
    var alvo = document.querySelector('[data-contador-avisos]');
    if (!alvo) return;
    if (total > 0) {
      alvo.textContent = total;
      alvo.hidden = false;
    } else {
      alvo.hidden = true;
    }
  }

  function iniciais(texto) {
    var partes = String(texto || 'JS').trim().split(/\s+/);
    var letras = (partes[0] || '').charAt(0) + (partes.length > 1 ? partes[partes.length - 1].charAt(0) : '');
    return letras.toUpperCase() || 'JS';
  }

  function fechar(cartao) {
    if (!cartao || cartao.dataset.fechando) return;
    cartao.dataset.fechando = '1';
    var indice = abertas.indexOf(cartao);
    if (indice >= 0) abertas.splice(indice, 1);
    if (reduzirMovimento) {
      cartao.remove();
      return;
    }
    cartao.classList.add('saindo');
    setTimeout(function () {
      cartao.remove();
    }, 220);
  }

  /** Dispensa no servidor também, para o aviso não voltar na próxima página. */
  function marcarLido(id) {
    if (!id) return;
    fetch('/avisos/' + id + '/lido', {
      method: 'POST',
      headers: { 'x-csrf-token': token(), accept: 'application/json' },
      credentials: 'same-origin',
    })
      .then(function (r) {
        return r.ok ? r.json().catch(function () { return null; }) : null;
      })
      .then(function (dados) {
        if (dados && typeof dados.naoLidos === 'number') atualizarContador(dados.naoLidos);
      })
      .catch(function () {
        /* sem rede: o aviso continua no mural, nada se perde */
      });
  }

  function montar(aviso) {
    var cartao = document.createElement('div');
    cartao.className = 'notificacao notificacao-' + (aviso.cor || 'neutro');

    var icone = document.createElement('div');
    icone.className = 'notificacao-icone';
    icone.textContent = iniciais(aviso.autor === 'Sistema' ? 'JS' : aviso.autor);
    cartao.appendChild(icone);

    var titulo;
    if (aviso.url) {
      titulo = document.createElement('a');
      titulo.href = aviso.url;
    } else {
      titulo = document.createElement('p');
    }
    titulo.className = 'notificacao-titulo';
    titulo.textContent = aviso.titulo;
    cartao.appendChild(titulo);

    var fecharBotao = document.createElement('button');
    fecharBotao.className = 'notificacao-fechar';
    fecharBotao.type = 'button';
    fecharBotao.setAttribute('aria-label', 'Dispensar notificação');
    fecharBotao.innerHTML = '&times;';
    fecharBotao.addEventListener('click', function () {
      marcarLido(aviso.id);
      fechar(cartao);
    });
    cartao.appendChild(fecharBotao);

    var corpo = document.createElement('p');
    corpo.className = 'notificacao-corpo';
    corpo.textContent = aviso.mensagem;
    cartao.appendChild(corpo);

    var rodape = document.createElement('div');
    rodape.className = 'notificacao-rodape';
    var etiqueta = document.createElement('span');
    etiqueta.className = 'notificacao-etiqueta';
    etiqueta.textContent = aviso.rotulo || 'Aviso';
    rodape.appendChild(etiqueta);
    var origem = document.createElement('span');
    origem.textContent = (aviso.processoCodigo ? aviso.processoCodigo + ' · ' : '') + 'agora';
    rodape.appendChild(origem);
    cartao.appendChild(rodape);

    var progresso = document.createElement('div');
    progresso.className = 'notificacao-progresso';
    progresso.style.animationDuration = TEMPO_VISIVEL + 'ms';
    cartao.appendChild(progresso);

    // Passar o mouse segura o cartão: ninguém perde um aviso lendo devagar.
    var relogio = setTimeout(function () {
      fechar(cartao);
    }, TEMPO_VISIVEL);
    cartao.addEventListener('mouseenter', function () {
      clearTimeout(relogio);
      progresso.style.animationPlayState = 'paused';
    });
    cartao.addEventListener('mouseleave', function () {
      progresso.style.animationPlayState = 'running';
      relogio = setTimeout(function () {
        fechar(cartao);
      }, 4000);
    });

    return cartao;
  }

  function mostrar(aviso) {
    var area = areaDeNotificacoes();
    var cartao = montar(aviso);
    area.appendChild(cartao);
    abertas.push(cartao);
    while (abertas.length > MAXIMO_NA_TELA) fechar(abertas[0]);
    espelharNoSistema(aviso);
  }

  /**
   * Com permissão concedida, repete o aviso como notificação do próprio
   * navegador — útil quando a plataforma está em outra aba.
   */
  function espelharNoSistema(aviso) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!document.hidden) return;
    try {
      var nativa = new Notification(aviso.titulo, {
        body: aviso.mensagem,
        tag: 'jsgrilo-aviso-' + aviso.id,
        badge: '/static/img/notificacao.svg',
        icon: '/static/img/notificacao.svg',
      });
      nativa.onclick = function () {
        window.focus();
        if (aviso.url) window.location.href = aviso.url;
        nativa.close();
      };
    } catch (_) {
      /* alguns navegadores exigem service worker; o cartão na tela já cobre */
    }
  }

  /** Botão opcional "Ativar avisos do navegador". */
  function ligarPermissao() {
    var botao = document.querySelector('[data-permitir-notificacoes]');
    if (!botao) return;
    if (!('Notification' in window)) {
      botao.hidden = true;
      return;
    }
    function pintar() {
      var estado = Notification.permission;
      botao.textContent =
        estado === 'granted'
          ? 'Avisos do navegador ativados'
          : estado === 'denied'
            ? 'Avisos bloqueados no navegador'
            : 'Ativar avisos do navegador';
      botao.disabled = estado !== 'default';
    }
    botao.addEventListener('click', function () {
      Notification.requestPermission().then(pintar);
    });
    pintar();
  }

  function conectar() {
    var fonte = new EventSource('/eventos', { withCredentials: true });

    fonte.addEventListener('conectado', function (evento) {
      try {
        atualizarContador(JSON.parse(evento.data).naoLidos);
      } catch (_) {
        /* quadro malformado: ignora */
      }
    });

    fonte.addEventListener('aviso', function (evento) {
      var aviso;
      try {
        aviso = JSON.parse(evento.data);
      } catch (_) {
        return;
      }
      atualizarContador(aviso.naoLidos);
      mostrar(aviso);
    });

    // O próprio EventSource reabre a conexão; nada a fazer no erro além de
    // deixar o navegador tentar de novo (retry vem do servidor).
    fonte.addEventListener('error', function () {});
  }

  document.addEventListener('DOMContentLoaded', function () {
    ligarPermissao();
    conectar();
  });
})();
