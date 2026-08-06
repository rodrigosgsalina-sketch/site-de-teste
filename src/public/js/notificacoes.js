/* Notificações da plataforma — ponto único, válido em todas as telas.

   Este arquivo é carregado no rodapé de toda página autenticada, então o
   listener existe em qualquer rota; nada aqui depende da tela aberta.

   Três caminhos de entrega, do mais forte para o mais fraco:

     1. Web Push + Service Worker — chega mesmo com a plataforma fechada.
        Exige permissão do navegador e chave VAPID no servidor.
     2. Service Worker acionado pela aba — a aba recebe o aviso pelo canal SSE
        e pede ao Service Worker que mostre a notificação do sistema. É o que
        funciona no Android, onde `new Notification()` na página é proibido.
     3. Cartão dentro da página — sempre acontece, com ou sem permissão.

   Nenhum aviso se perde no caminho: ao (re)conectar, a tela informa o último
   aviso que viu e o servidor repõe o que passou nesse intervalo. */
(function () {
  'use strict';

  var TEMPO_VISIVEL = 12000; // ms que o cartão fica na tela
  var MAXIMO_NA_TELA = 4;
  var DIAS_PARA_PERGUNTAR_DE_NOVO = 7;

  var CHAVES = {
    ultimoId: 'jsgrilo.avisos.ultimoId',
    convitAdiado: 'jsgrilo.avisos.conviteAdiadoEm',
    bloqueioOculto: 'jsgrilo.avisos.bloqueioOculto',
  };

  var reduzirMovimento = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var depuracao = document.body && document.body.dataset.avisosDebug === '1';

  var registroSw = null;
  var pilha = null;
  var abertas = [];

  /* ------------------------------------------------------------------ apoio */

  function log(etapa, detalhe) {
    if (!depuracao) return;
    // eslint-disable-next-line no-console
    console.info('[avisos] ' + etapa, detalhe === undefined ? '' : detalhe);
  }

  function guardar(chave, valor) {
    try {
      window.localStorage.setItem(chave, String(valor));
    } catch (_) {
      /* navegação privativa: seguimos sem memória */
    }
  }

  function ler(chave) {
    try {
      return window.localStorage.getItem(chave);
    } catch (_) {
      return null;
    }
  }

  function token() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : '';
  }

  function suportaNotificacao() {
    return 'Notification' in window;
  }

  /** Service Worker e Notification exigem contexto seguro (HTTPS ou localhost). */
  function contextoSeguro() {
    return window.isSecureContext !== false;
  }

  function permissao() {
    return suportaNotificacao() ? Notification.permission : 'indisponivel';
  }

  /* ------------------------------------------------------- cartão na página */

  function areaDeNotificacoes() {
    if (pilha) return pilha;
    pilha = document.createElement('div');
    pilha.className = 'notificacoes';
    pilha.setAttribute('role', 'status');
    pilha.setAttribute('aria-live', 'polite');
    document.body.appendChild(pilha);
    return pilha;
  }

  function atualizarContador(total) {
    var alvo = document.querySelector('[data-contador-avisos]');
    if (!alvo || typeof total !== 'number') return;
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
        if (dados && typeof dados.naoLidos === 'number') {
          atualizarContador(dados.naoLidos);
          // As outras abas acertam o contador sem precisar recarregar.
          espalhar({ tipo: 'lido', naoLidos: dados.naoLidos });
        }
      })
      .catch(function () {
        /* sem rede: o aviso continua no mural, nada se perde */
      });
  }

  function montarCartao(aviso) {
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
    origem.textContent =
      (aviso.processoCodigo ? aviso.processoCodigo + ' · ' : '') + (aviso.atrasado ? 'enquanto você navegava' : 'agora');
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

  /* -------------------------------------------------- notificação do sistema */

  /**
   * Mostra a notificação do sistema operacional. Sempre pelo Service Worker
   * quando ele existe: no Android o construtor `new Notification()` lança
   * "Illegal constructor", e era esse o motivo de a notificação nunca aparecer
   * em parte dos aparelhos.
   */
  function mostrarNoSistema(aviso) {
    if (permissao() !== 'granted') {
      log('sistema ignorado (sem permissão)', permissao());
      return false;
    }
    // Com a plataforma na frente do usuário, o cartão já basta.
    if (!document.hidden) {
      log('sistema ignorado (aba visível)', aviso.id);
      return false;
    }

    if (registroSw && registroSw.showNotification) {
      registroSw
        .showNotification(aviso.titulo, {
          body: aviso.mensagem || '',
          icon: '/static/img/notificacao.svg',
          badge: '/static/img/notificacao.svg',
          tag: 'jsgrilo-aviso-' + aviso.id,
          data: { url: aviso.url || '/avisos', id: aviso.id },
        })
        .then(function () {
          log('notificação do sistema exibida', aviso.id);
        })
        .catch(function (erro) {
          log('falha ao exibir pelo Service Worker', erro && erro.message);
        });
      return true;
    }

    try {
      var nativa = new Notification(aviso.titulo, {
        body: aviso.mensagem || '',
        icon: '/static/img/notificacao.svg',
        tag: 'jsgrilo-aviso-' + aviso.id,
      });
      nativa.onclick = function () {
        window.focus();
        if (aviso.url) window.location.href = aviso.url;
        nativa.close();
      };
      log('notificação do sistema exibida (sem Service Worker)', aviso.id);
      return true;
    } catch (erro) {
      log('navegador recusou new Notification()', erro && erro.message);
      return false;
    }
  }

  /** Entrada única: todo aviso passa por aqui, venha de onde vier. */
  function mostrar(aviso) {
    if (!aviso || !aviso.id) return;
    log('aviso recebido', aviso.id + ' · ' + aviso.tipo);

    var visto = Number(ler(CHAVES.ultimoId) || 0);
    if (aviso.id > visto) guardar(CHAVES.ultimoId, aviso.id);

    var area = areaDeNotificacoes();
    var cartao = montarCartao(aviso);
    area.appendChild(cartao);
    abertas.push(cartao);
    while (abertas.length > MAXIMO_NA_TELA) fechar(abertas[0]);
    log('cartão exibido na tela', aviso.id);

    // A notificação do sistema fica a cargo de quem segura a conexão (ver
    // "canal SSE" abaixo): assim ela não sai repetida em cada aba aberta.
  }

  /* ------------------------------------------------------------- permissão */

  function navegadorProvavel() {
    var ua = navigator.userAgent;
    var ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios) return 'ios';
    if (/Edg\//.test(ua)) return 'edge';
    if (/OPR\//.test(ua)) return 'opera';
    if (/Firefox\//.test(ua)) return 'firefox';
    if (/Chrome\//.test(ua)) return /Android/.test(ua) ? 'android' : 'chrome';
    if (/Safari\//.test(ua)) return 'safari';
    return 'outro';
  }

  var INSTRUCOES = {
    chrome:
      'No Chrome: clique no cadeado (ou no ícone de ajustes) à esquerda do endereço → Notificações → ' +
      'Permitir. Depois recarregue esta página.',
    edge:
      'No Edge: clique no cadeado à esquerda do endereço → Permissões para este site → Notificações → ' +
      'Permitir. Depois recarregue esta página.',
    firefox:
      'No Firefox: clique no cadeado à esquerda do endereço → Conexão/Permissões → remova o bloqueio de ' +
      '"Enviar notificações". Depois recarregue esta página.',
    opera:
      'No Opera: clique no cadeado à esquerda do endereço → Configurações do site → Notificações → ' +
      'Permitir. Depois recarregue esta página.',
    safari:
      'No Safari: menu Safari → Ajustes → Sites → Notificações → localize este site e escolha Permitir.',
    android:
      'No Chrome do Android: toque nos três pontinhos → Informações do site (ou o cadeado) → Permissões → ' +
      'Notificações → Permitir.',
    ios:
      'No iPhone/iPad: adicione a plataforma à Tela de Início (botão Compartilhar → "Adicionar à Tela de ' +
      'Início") e abra por lá. O iOS só entrega notificações web assim, a partir do iOS 16.4.',
    outro:
      'Abra as configurações de site do seu navegador, encontre este endereço e libere as notificações.',
  };

  function removerFaixa() {
    var atual = document.querySelector('[data-faixa-notificacoes]');
    if (atual) atual.remove();
  }

  /**
   * Faixa discreta no topo do conteúdo. `tipo` decide o texto e os botões:
   * 'convite' (permissão nunca pedida) ou 'bloqueado' (usuário negou).
   */
  function mostrarFaixa(tipo) {
    removerFaixa();
    var conteudo = document.querySelector('.conteudo');
    if (!conteudo) return;

    var faixa = document.createElement('div');
    faixa.className = 'aviso ' + (tipo === 'bloqueado' ? 'aviso-alerta' : 'aviso-info') + ' faixa-notificacoes';
    faixa.setAttribute('data-faixa-notificacoes', tipo);

    var texto = document.createElement('div');
    texto.className = 'faixa-notificacoes-texto';

    if (tipo === 'convite') {
      texto.innerHTML =
        '<strong>Ative as notificações.</strong> Com a permissão do navegador, os avisos de processo ' +
        'aparecem mesmo quando a plataforma está em outra aba ou minimizada.';
    } else {
      texto.innerHTML =
        '<strong>As notificações estão bloqueadas neste navegador.</strong> Os avisos continuam ' +
        'aparecendo dentro da plataforma e no mural, mas não chegam quando ela está em segundo plano. ' +
        '<span class="faixa-notificacoes-passos">' +
        INSTRUCOES[navegadorProvavel()] +
        '</span>';
    }
    faixa.appendChild(texto);

    var acoes = document.createElement('div');
    acoes.className = 'faixa-notificacoes-acoes';

    if (tipo === 'convite') {
      var ativar = document.createElement('button');
      ativar.type = 'button';
      ativar.className = 'botao botao-pequeno';
      ativar.textContent = 'Ativar notificações';
      // A permissão só é pedida a partir deste clique — nunca no carregamento.
      ativar.addEventListener('click', function () {
        pedirPermissao().then(function (estado) {
          if (estado === 'granted') removerFaixa();
          else if (estado === 'denied') mostrarFaixa('bloqueado');
        });
      });
      acoes.appendChild(ativar);
    }

    var dispensar = document.createElement('button');
    dispensar.type = 'button';
    dispensar.className = 'botao botao-secundario botao-pequeno';
    dispensar.textContent = tipo === 'convite' ? 'Agora não' : 'Não mostrar de novo';
    dispensar.addEventListener('click', function () {
      if (tipo === 'convite') guardar(CHAVES.convitAdiado, Date.now());
      else guardar(CHAVES.bloqueioOculto, '1');
      removerFaixa();
    });
    acoes.appendChild(dispensar);

    faixa.appendChild(acoes);
    conteudo.insertBefore(faixa, conteudo.children[1] || null);
    log('faixa de permissão exibida', tipo);
  }

  function conviteAdiadoRecentemente() {
    var quando = Number(ler(CHAVES.convitAdiado) || 0);
    if (!quando) return false;
    return Date.now() - quando < DIAS_PARA_PERGUNTAR_DE_NOVO * 24 * 3600 * 1000;
  }

  /** Pede a permissão. Sempre chamado a partir de um clique do usuário. */
  function pedirPermissao() {
    if (!suportaNotificacao()) return Promise.resolve('indisponivel');
    return Notification.requestPermission()
      .then(function (estado) {
        log('permissão respondida', estado);
        atualizarBotoes();
        if (estado === 'granted') inscreverNoPush();
        return estado;
      })
      .catch(function () {
        return permissao();
      });
  }

  /** Estado atual nos botões "Ativar avisos do navegador" (tela de Avisos). */
  function atualizarBotoes() {
    var botoes = document.querySelectorAll('[data-permitir-notificacoes]');
    for (var i = 0; i < botoes.length; i += 1) {
      var botao = botoes[i];
      var estado = permissao();
      if (estado === 'indisponivel' || !contextoSeguro()) {
        botao.textContent = 'Notificações indisponíveis neste navegador';
        botao.disabled = true;
      } else if (estado === 'granted') {
        botao.textContent = 'Avisos do navegador ativados';
        botao.disabled = true;
      } else if (estado === 'denied') {
        botao.textContent = 'Avisos bloqueados — ver como liberar';
        botao.disabled = false;
      } else {
        botao.textContent = 'Ativar avisos do navegador';
        botao.disabled = false;
      }
    }
  }

  function ligarBotoes() {
    var botoes = document.querySelectorAll('[data-permitir-notificacoes]');
    for (var i = 0; i < botoes.length; i += 1) {
      botoes[i].addEventListener('click', function () {
        if (permissao() === 'denied') {
          guardar(CHAVES.bloqueioOculto, '');
          mostrarFaixa('bloqueado');
          return;
        }
        pedirPermissao();
      });
    }
    atualizarBotoes();
  }

  /** Decide o que fazer com o estado da permissão, em qualquer tela. */
  function avaliarPermissao() {
    var estado = permissao();
    log('permissão atual', estado + (contextoSeguro() ? '' : ' (contexto inseguro)'));

    if (!suportaNotificacao() || !contextoSeguro()) return;
    if (estado === 'granted') {
      inscreverNoPush();
      return;
    }
    if (estado === 'denied') {
      if (ler(CHAVES.bloqueioOculto) !== '1') mostrarFaixa('bloqueado');
      return;
    }
    // 'default': convida, sem pedir nada de imediato.
    if (!conviteAdiadoRecentemente()) mostrarFaixa('convite');
  }

  /* ----------------------------------------------------- Service Worker/push */

  function registrarServiceWorker() {
    if (!('serviceWorker' in navigator) || !contextoSeguro()) {
      log('Service Worker indisponível', contextoSeguro() ? 'sem suporte' : 'contexto inseguro (use HTTPS)');
      return Promise.resolve(null);
    }
    return navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then(function (registro) {
        log('Service Worker registrado', registro.scope);
        return navigator.serviceWorker.ready;
      })
      .then(function (pronto) {
        registroSw = pronto;
        return pronto;
      })
      .catch(function (erro) {
        log('falha ao registrar o Service Worker', erro && erro.message);
        return null;
      });
  }

  function base64ParaUint8(base64) {
    var normalizado = (base64 + '==='.slice((base64.length + 3) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    var bruto = window.atob(normalizado);
    var saida = new Uint8Array(bruto.length);
    for (var i = 0; i < bruto.length; i += 1) saida[i] = bruto.charCodeAt(i);
    return saida;
  }

  /** Inscreve o navegador no Web Push (só com permissão concedida). */
  function inscreverNoPush() {
    if (!registroSw || !registroSw.pushManager || permissao() !== 'granted') return;

    fetch('/push/chave', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (dados) {
        if (!dados || !dados.habilitado || !dados.chavePublica) {
          log('push não configurado no servidor', 'seguindo só com o canal da aba');
          return null;
        }
        return registroSw.pushManager.getSubscription().then(function (atual) {
          if (atual) return atual;
          return registroSw.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: base64ParaUint8(dados.chavePublica),
          });
        });
      })
      .then(function (inscricao) {
        if (!inscricao) return null;
        return fetch('/push/inscrever', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'x-csrf-token': token(),
          },
          body: JSON.stringify({ inscricao: inscricao.toJSON ? inscricao.toJSON() : inscricao }),
        }).then(function (r) {
          log('inscrição de push enviada ao servidor', r.status);
        });
      })
      .catch(function (erro) {
        log('falha ao inscrever no push', erro && erro.message);
      });
  }

  /* ------------------------------------------------------------ canal SSE

     UMA conexão por navegador, não uma por aba.

     O canal SSE é uma conexão HTTP que fica aberta. Em HTTP/1.1 o navegador
     permite apenas SEIS conexões simultâneas por endereço — e esse limite vale
     para o navegador inteiro, somando todas as abas. Com uma conexão por aba, a
     sexta aba consumia a última vaga e a plataforma parava de carregar: as
     telas seguintes ficavam esperando uma vaga que não vinha.

     Agora as abas elegem uma líder. Só ela abre `/eventos`; as demais recebem
     os avisos por `BroadcastChannel`, que não usa rede. Sobram cinco vagas
     livres, tenha o usuário quantas abas tiver. Se a aba líder fecha ou trava,
     outra assume em poucos segundos.

     Sem `BroadcastChannel` (navegador antigo), cada aba abre a sua conexão,
     como antes — nada deixa de funcionar. */

  var NOME_DO_CANAL = 'jsgrilo.avisos';
  var CHAVE_LIDER = 'jsgrilo.avisos.lider';
  var RENOVAR_MS = 2000; // de quanto em quanto a líder renova o posto
  var ABANDONO_MS = 7000; // sem renovar por este tempo, outra aba assume

  var minhaEtiqueta = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
  var canal = null;
  var fonte = null;
  var souLider = false;
  var desdeQuandoLidero = 0;
  var relogioLideranca = null;

  function suportaCanal() {
    return typeof window.BroadcastChannel === 'function';
  }

  /** Quem é a líder agora, segundo o localStorage (compartilhado entre abas). */
  function liderancaAtual() {
    try {
      return JSON.parse(ler(CHAVE_LIDER) || 'null');
    } catch (_) {
      return null;
    }
  }

  function anotarLideranca() {
    desdeQuandoLidero = Date.now();
    guardar(CHAVE_LIDER, JSON.stringify({ etiqueta: minhaEtiqueta, em: desdeQuandoLidero }));
  }

  function largarLideranca() {
    if (!souLider) return;
    souLider = false;
    var atual = liderancaAtual();
    // Só apaga se o posto ainda for meu: não atrapalha quem já assumiu.
    if (atual && atual.etiqueta === minhaEtiqueta) guardar(CHAVE_LIDER, '');
    fecharFonte();
    log('liderança do canal devolvida', minhaEtiqueta);
  }

  function fecharFonte() {
    if (!fonte) return;
    try {
      fonte.close();
    } catch (_) {
      /* já fechada */
    }
    fonte = null;
  }

  /** Assume o canal se ninguém o estiver segurando (ou se quem segurava sumiu). */
  function conferirLideranca() {
    if (!suportaCanal()) return; // sem canal entre abas, cada uma cuida da sua
    var atual = liderancaAtual();
    var vago = !atual || !atual.em || Date.now() - atual.em > ABANDONO_MS;

    if (souLider) {
      // Outra aba assumiu enquanto esta estava congelada em segundo plano.
      if (atual && atual.etiqueta !== minhaEtiqueta && atual.em > desdeQuandoLidero) {
        souLider = false;
        fecharFonte();
        log('outra aba assumiu o canal', atual.etiqueta);
        return;
      }
      anotarLideranca();
      if (!fonte) abrirFonte();
      return;
    }

    if (vago) {
      souLider = true;
      anotarLideranca();
      abrirFonte();
      if (canal) canal.postMessage({ tipo: 'lider', etiqueta: minhaEtiqueta, em: desdeQuandoLidero });
      log('esta aba assumiu o canal', minhaEtiqueta);
    }
  }

  /** Repassa o que chegou do servidor para as outras abas. */
  function espalhar(mensagem) {
    if (canal) {
      try {
        canal.postMessage(mensagem);
      } catch (_) {
        /* aba fechando */
      }
    }
  }

  function tratarConectado(dados) {
    atualizarContador(dados.naoLidos);
    // Primeira visita neste navegador: marca o ponto de partida para não
    // despejar de uma vez tudo o que já estava acumulado no mural.
    if (ler(CHAVES.ultimoId) === null && typeof dados.ultimoAviso === 'number') {
      guardar(CHAVES.ultimoId, dados.ultimoAviso);
    }
    log('canal conectado', dados.usuario + ' · ' + dados.naoLidos + ' não lido(s)');
  }

  function abrirFonte() {
    if (fonte) return;
    if (!('EventSource' in window)) {
      log('EventSource indisponível', 'sem tempo real neste navegador');
      return;
    }
    // `desde` cobre o intervalo entre uma tela e outra: o servidor repõe o que
    // aconteceu enquanto a página anterior estava sendo trocada.
    var desde = Number(ler(CHAVES.ultimoId) || 0);
    fonte = new EventSource('/eventos?desde=' + desde, { withCredentials: true });

    fonte.addEventListener('conectado', function (evento) {
      var dados;
      try {
        dados = JSON.parse(evento.data);
      } catch (_) {
        return; // quadro malformado: ignora
      }
      tratarConectado(dados);
      espalhar({ tipo: 'conectado', dados: dados });
    });

    fonte.addEventListener('aviso', function (evento) {
      var aviso;
      try {
        aviso = JSON.parse(evento.data);
      } catch (erro) {
        log('aviso malformado', erro && erro.message);
        return;
      }
      atualizarContador(aviso.naoLidos);
      mostrar(aviso);
      // A notificação do sistema sai só daqui: as outras abas mostram o cartão,
      // mas não repetem o alerta do sistema operacional.
      mostrarNoSistema(aviso);
      espalhar({ tipo: 'aviso', aviso: aviso });
    });

    fonte.addEventListener('open', function () {
      log('canal aberto', '/eventos (uma conexão para todas as abas)');
    });

    // O EventSource reabre sozinho (o servidor manda o intervalo em `retry`).
    fonte.addEventListener('error', function () {
      log('canal caiu', 'reconectando — nada se perde, o servidor repõe');
    });
  }

  function ouvirOutrasAbas() {
    canal = new window.BroadcastChannel(NOME_DO_CANAL);
    canal.addEventListener('message', function (evento) {
      var mensagem = evento.data || {};

      if (mensagem.tipo === 'aviso') {
        atualizarContador(mensagem.aviso && mensagem.aviso.naoLidos);
        mostrar(mensagem.aviso);
        return;
      }
      if (mensagem.tipo === 'conectado') {
        tratarConectado(mensagem.dados || {});
        return;
      }
      if (mensagem.tipo === 'lido') {
        atualizarContador(mensagem.naoLidos);
        return;
      }
      // Outra aba assumiu o canal: esta solta a conexão na hora, sem esperar o
      // prazo de abandono.
      if (mensagem.tipo === 'lider' && mensagem.etiqueta !== minhaEtiqueta) {
        if (souLider && mensagem.em > desdeQuandoLidero) {
          souLider = false;
          fecharFonte();
          log('cedi o canal para outra aba', mensagem.etiqueta);
        }
      }
    });
  }

  function conectar() {
    if (!suportaCanal()) {
      // Navegador sem BroadcastChannel: volta ao comportamento de uma conexão
      // por aba. Funciona igual; só não divide a conexão.
      log('BroadcastChannel indisponível', 'cada aba abre a sua conexão');
      souLider = true;
      abrirFonte();
      return;
    }

    ouvirOutrasAbas();
    conferirLideranca();
    relogioLideranca = setInterval(conferirLideranca, RENOVAR_MS);

    // Sair da página devolve o posto imediatamente: a próxima aba assume sem
    // esperar, e a conexão some da conta do navegador na hora.
    window.addEventListener('pagehide', function () {
      if (relogioLideranca) clearInterval(relogioLideranca);
      largarLideranca();
    });

    // Página restaurada do cache de voltar/avançar: reassume se couber.
    window.addEventListener('pageshow', function (evento) {
      if (!evento.persisted) return;
      if (!relogioLideranca) relogioLideranca = setInterval(conferirLideranca, RENOVAR_MS);
      conferirLideranca();
    });
  }

  /* --------------------------------------------------------------- partida */

  function iniciar() {
    depuracao = document.body && document.body.dataset.avisosDebug === '1';
    log('iniciando', window.location.pathname);

    ligarBotoes();
    registrarServiceWorker().then(function () {
      avaliarPermissao();
    });
    conectar();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
