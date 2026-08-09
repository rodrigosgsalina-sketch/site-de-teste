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

  /* Busca que filtra as opções de um <select> (data-filtra-lista="id-do-select").
     Usada onde a lista é curta e já vem inteira no HTML. */
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

  /* Busca de cliente contra o servidor (data-busca-cliente="id-do-select").

     O cadastro tem quase mil empresas; mandar todas no HTML custava 676 KB por
     carregamento da tela. A lista agora é montada com o que o servidor devolve
     para o que foi digitado — mesmas regras de antes: sem acento, sem caixa,
     CNPJ com ou sem pontuação, e seleção automática quando sobra uma só. */
  function ligarBuscaDeCliente(raiz) {
    raiz.querySelectorAll('[data-busca-cliente]').forEach(function (campo) {
      var select = document.getElementById(campo.dataset.buscaCliente);
      if (!select) return;
      var situacao = campo.parentNode.querySelector('[data-busca-situacao]');
      var relogio = null;
      var pedidoAtual = 0;

      function dizer(texto) {
        if (situacao) situacao.textContent = texto;
      }

      function montarOpcao(cliente) {
        var opcao = document.createElement('option');
        opcao.value = String(cliente.id);
        var apelido = cliente.apelido && cliente.apelido !== cliente.titulo ? ' (' + cliente.apelido + ')' : '';
        var local = cliente.local ? ' · ' + cliente.local : '';
        var marca = cliente.situacao && cliente.situacao !== 'Ativa' ? ' · ' + cliente.situacao : '';
        opcao.textContent = cliente.codigo + ' — ' + cliente.titulo + apelido + local + marca;
        opcao.dataset.razao = cliente.titulo;
        opcao.dataset.cnpj = cliente.cnpj || '—';
        opcao.dataset.local = cliente.local || '—';
        opcao.dataset.responsavel = cliente.responsavel || '—';
        opcao.dataset.telefone = cliente.telefone || '—';
        opcao.dataset.email = cliente.email || '—';
        opcao.dataset.ficha = '/clientes/' + cliente.id;
        return opcao;
      }

      function preencher(dados, termo) {
        // A empresa já escolhida não some da lista enquanto se procura outra.
        var escolhida = select.options[select.selectedIndex];
        var manter = escolhida && escolhida.value ? escolhida.cloneNode(true) : null;

        select.innerHTML = '';
        var vazia = document.createElement('option');
        vazia.value = '';
        vazia.textContent = 'Selecione…';
        select.appendChild(vazia);

        var jaTem = {};
        if (manter) {
          select.appendChild(manter);
          jaTem[manter.value] = true;
        }
        dados.itens.forEach(function (cliente) {
          if (jaTem[String(cliente.id)]) return;
          select.appendChild(montarOpcao(cliente));
        });

        if (manter) select.value = manter.value;

        // Com um único resultado, já deixa selecionado.
        if (termo && dados.itens.length === 1) {
          select.value = String(dados.itens[0].id);
        }
        select.dispatchEvent(new Event('change'));

        if (!termo) {
          dizer(dados.total + ' empresa(s) cadastrada(s). Digite para localizar.');
        } else if (!dados.total) {
          dizer('Nenhuma empresa encontrada para “' + termo + '”.');
        } else if (dados.parcial) {
          dizer(dados.total + ' encontradas — mostrando as ' + dados.itens.length + ' primeiras. Refine a busca.');
        } else {
          dizer(dados.total + ' empresa(s) encontrada(s).');
        }
      }

      function procurar() {
        var termo = campo.value.trim();
        var meu = (pedidoAtual += 1);
        fetch('/clientes/buscar?q=' + encodeURIComponent(termo), {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (dados) {
            // Resposta de uma digitação anterior não pode sobrescrever a atual.
            if (!dados || meu !== pedidoAtual) return;
            preencher(dados, termo);
          })
          .catch(function () {
            dizer('Não consegui consultar o cadastro agora. Verifique a conexão e digite de novo.');
          });
      }

      // Espera a digitação parar: uma consulta por palavra, não por tecla.
      campo.addEventListener('input', function () {
        if (relogio) clearTimeout(relogio);
        relogio = setTimeout(procurar, 180);
      });

      // Enter na busca escolhe e não envia o formulário sem querer.
      campo.addEventListener('keydown', function (evento) {
        if (evento.key !== 'Enter') return;
        evento.preventDefault();
        if (relogio) clearTimeout(relogio);
        procurar();
      });
    });
  }

  /* Subtipos que acompanham o tipo escolhido (data-subtipos-de="id-do-select").

     Vários podem ser marcados: um processo costuma resolver mais de uma coisa
     na mesma ida ao cartório, e o checklist vira a soma dos itens.

     A lista de subtipos por tipo vem junto com a tela (window.__subtiposPorTipo),
     porque são poucas linhas: uma consulta ao servidor a cada troca de tipo
     custaria mais do que mandar tudo de uma vez.

     Tipo sem subtipo cadastrado esconde o campo — não adianta mostrar uma
     lista vazia para a pessoa decidir o que fazer com ela. */
  function ligarSubtipos(raiz) {
    var porTipo = window.__subtiposPorTipo || {};

    raiz.querySelectorAll('[data-subtipos-de]').forEach(function (caixa) {
      var tipo = document.getElementById(caixa.dataset.subtiposDe);
      if (!tipo) return;
      var campo = caixa.closest('[data-campo-subtipo]') || caixa.parentNode;
      // Guarda as escolhas para reaparecerem quando o formulário volta com erro
      // de validação.
      var marcados = (caixa.dataset.selecionados || '').split(',').filter(Boolean);

      function lembrarMarcados() {
        marcados = [].slice
          .call(caixa.querySelectorAll('input[type="checkbox"]:checked'))
          .map(function (i) { return i.value; });
      }

      function montar() {
        var lista = porTipo[String(tipo.value)] || [];
        caixa.innerHTML = '';

        lista.forEach(function (sub) {
          var rotulo = document.createElement('label');
          rotulo.className = 'subtipo-opcao';

          var marca = document.createElement('input');
          marca.type = 'checkbox';
          marca.name = 'subtipo_processo_id';
          marca.value = String(sub.id);
          // Só continua marcado se o subtipo pertencer ao tipo atual.
          marca.checked = marcados.indexOf(String(sub.id)) !== -1;
          marca.addEventListener('change', lembrarMarcados);

          var texto = document.createElement('span');
          texto.textContent = sub.nome;

          rotulo.appendChild(marca);
          rotulo.appendChild(texto);
          caixa.appendChild(rotulo);
        });

        lembrarMarcados();
        campo.hidden = lista.length === 0;
      }

      tipo.addEventListener('change', montar);
      montar();
    });
  }

  /* Um <select> de subtipos que acompanha o tipo escolhido
     (data-subtipos-select-de="id-do-select-de-tipo").

     Usado no checklist modelo, onde o item pertence a UM subtipo — diferente da
     abertura de processo, em que vários podem ser marcados. */
  function ligarSubtipoUnico(raiz) {
    var porTipo = window.__subtiposPorTipo || {};

    raiz.querySelectorAll('[data-subtipos-select-de]').forEach(function (select) {
      var tipo = document.getElementById(select.dataset.subtiposSelectDe);
      if (!tipo) return;

      function montar() {
        var lista = porTipo[String(tipo.value)] || [];
        var anterior = select.value;
        select.innerHTML = '';

        var todo = document.createElement('option');
        todo.value = '';
        todo.textContent = 'Todo o tipo';
        select.appendChild(todo);

        lista.forEach(function (sub) {
          var opcao = document.createElement('option');
          opcao.value = String(sub.id);
          opcao.textContent = sub.nome;
          select.appendChild(opcao);
        });

        var cabe = lista.some(function (sub) { return String(sub.id) === String(anterior); });
        select.value = cabe ? anterior : '';
        // "Todos os processos" não tem subtipo: o campo não teria o que oferecer.
        select.disabled = lista.length === 0;
      }

      tipo.addEventListener('change', montar);
      montar();
    });
  }

  /* Ordem de atendimento dos setores: arrastar para reordenar.

     O <ol> já vem do servidor na ordem certa. Arrastar (ou ↑/↓ com o setor em
     foco) reposiciona o <li>, renumera e grava sozinho — sem recarregar a
     página, porque quem arrastou precisa ver o resultado onde soltou.

     Sem JavaScript nada disso existe e o formulário comum continua salvando
     pelo botão, que só é escondido aqui. */
  function ligarOrdenacaoArrastavel(raiz) {
    raiz.querySelectorAll('[data-ordem-setores]').forEach(function (form) {
      var lista = form.querySelector('.ordem-setores');
      var campo = form.querySelector('input[name="setor_ids"]');
      var estado = form.querySelector('[data-ordem-estado]');
      var manual = form.querySelector('[data-ordem-manual]');
      if (!lista || !campo) return;

      // Com JS o salvamento é automático: o botão manual vira ruído.
      if (manual) manual.hidden = true;

      var arrastando = null;
      var gravando = false;
      var pendente = false;
      var ultimaSalva = campo.value;

      function itens() {
        return Array.prototype.slice.call(lista.querySelectorAll('li[data-setor]'));
      }

      function renumerar() {
        var todos = itens();
        todos.forEach(function (li, i) {
          var pos = li.querySelector('.ordem-posicao');
          if (pos) pos.textContent = String(i + 1);
          var nome = li.querySelector('.ordem-nome strong');
          li.setAttribute(
            'aria-label',
            (nome ? nome.textContent.trim() : 'setor') + ', posição ' + (i + 1) + ' de ' + todos.length
          );
        });
        campo.value = todos
          .map(function (li) { return li.dataset.setor; })
          .join(',');
      }

      function dizer(texto, erro) {
        if (!estado) return;
        estado.textContent = texto;
        estado.classList.toggle('ordem-erro', Boolean(erro));
      }

      function gravar() {
        // Soltar o setor no mesmo lugar — ou um clique simples — não é mudança:
        // não vale um POST.
        if (campo.value === ultimaSalva) return;
        // Uma gravação por vez; o que chegar durante ela vira uma única
        // regravação no fim, com a ordem mais recente.
        if (gravando) { pendente = true; return; }
        gravando = true;
        var enviada = campo.value;
        dizer('salvando…', false);

        var dados = new URLSearchParams();
        dados.set('_csrf', (form.querySelector('input[name="_csrf"]') || {}).value || '');
        dados.set('tipo_processo_id', form.dataset.tipo || '');
        dados.set('setor_ids', campo.value);

        fetch(form.action, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: dados.toString(),
          credentials: 'same-origin',
        })
          .then(function (resposta) {
            return resposta.json().catch(function () { return { ok: false }; });
          })
          .then(function (corpo) {
            if (corpo && corpo.ok) {
              ultimaSalva = enviada;
              dizer('ordem salva', false);
            } else {
              dizer((corpo && corpo.erro) || 'não foi possível salvar — recarregue a página', true);
            }
          })
          .catch(function () {
            dizer('sem conexão com o servidor — a ordem não foi salva', true);
          })
          .then(function () {
            gravando = false;
            if (pendente) { pendente = false; gravar(); }
          });
      }

      /* Vizinho sob o ponteiro: o primeiro item cuja metade de cima já passou. */
      function alvoEm(y) {
        var candidatos = itens().filter(function (li) { return li !== arrastando; });
        for (var i = 0; i < candidatos.length; i++) {
          var caixa = candidatos[i].getBoundingClientRect();
          if (y < caixa.top + caixa.height / 2) return candidatos[i];
        }
        return null;
      }

      /* Arrasto por ponteiro (mouse, dedo ou caneta).

         Não é o arrastar nativo do HTML5 de propósito: aquele simplesmente não
         existe em tela sensível ao toque, e a plataforma é usada no celular.
         Pointer Events atendem os três com o mesmo código.

         O acompanhamento é feito no documento, não na lista: com o dedo o
         Chromium solta a captura no meio do caminho, e ouvir só a lista faria
         o setor escapar assim que o ponteiro passasse da borda dela. */
      function mover(evento) {
        if (!arrastando) return;
        evento.preventDefault();
        var vizinho = alvoEm(evento.clientY);
        if (vizinho) lista.insertBefore(arrastando, vizinho);
        else if (lista.lastElementChild !== arrastando) lista.appendChild(arrastando);
      }

      function largar() {
        if (!arrastando) return;
        var solto = arrastando;
        arrastando = null;
        document.removeEventListener('pointermove', mover);
        document.removeEventListener('pointerup', largar);
        document.removeEventListener('pointercancel', largar);

        solto.classList.remove('arrastando');
        solto.focus({ preventScroll: true });
        renumerar();
        gravar();
      }

      lista.addEventListener('pointerdown', function (evento) {
        if (evento.button !== undefined && evento.button !== 0) return;
        var li = evento.target.closest('li[data-setor]');
        if (!li) return;

        arrastando = li;
        li.classList.add('arrastando');
        document.addEventListener('pointermove', mover, { passive: false });
        // Soltar fora da lista, ou o sistema tomar o gesto (chamada, alt+tab),
        // termina o arrasto onde ele parou em vez de deixá-lo preso.
        document.addEventListener('pointerup', largar);
        document.addEventListener('pointercancel', largar);
        // No toque, segurar o item rolaria a página junto.
        evento.preventDefault();
      });

      /* Teclado: mesma reordenação sem mouse. */
      lista.addEventListener('keydown', function (evento) {
        if (evento.key !== 'ArrowUp' && evento.key !== 'ArrowDown') return;
        var li = evento.target.closest('li[data-setor]');
        if (!li) return;
        evento.preventDefault();

        if (evento.key === 'ArrowUp' && li.previousElementSibling) {
          lista.insertBefore(li, li.previousElementSibling);
        } else if (evento.key === 'ArrowDown' && li.nextElementSibling) {
          lista.insertBefore(li.nextElementSibling, li);
        } else {
          return;
        }
        li.focus({ preventScroll: true });
        renumerar();
        gravar();
      });

      renumerar();
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
    ligarBuscaDeCliente(document);
    ligarSubtipos(document);
    ligarSubtipoUnico(document);
    ligarOrdenacaoArrastavel(document);
    ligarResumoDeCliente(document);
    ligarTopo();
    ligarContadores();
    ligarMenuMovel();
    abrirAncora();
  });
})();
