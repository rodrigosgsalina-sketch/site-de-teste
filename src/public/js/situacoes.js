/* Editor das situações do processo (Administração → Tipos e setores).
 *
 * O formulário é um só: em branco ele cria, carregado com uma situação ele
 * altera. Duas telas para o mesmo cadastro só dariam duas chances de divergir.
 *
 * A ordem das situações usa o mesmo arrastar dos setores e dos itens do
 * checklist, que já está no app.js — aqui não há nada disso. */

(function () {
  'use strict';

  var situacoes = window.SITUACOES || [];

  document.addEventListener('DOMContentLoaded', function () {
    var form = document.querySelector('[data-form-situacao]');
    if (!form) return;

    var titulo = document.querySelector('[data-titulo-situacao]');
    var campoId = form.querySelector('[data-campo-id]');
    var campoNome = form.querySelector('[data-campo-nome]');
    var campoCor = form.querySelector('[data-campo-cor]');
    var campoSetor = form.querySelector('[data-campo-setor]');
    var campoFinal = form.querySelector('[data-campo-final]');
    var campoEspera = form.querySelector('[data-campo-espera]');
    var campoMantem = form.querySelector('[data-campo-mantem]');
    var avisoSistema = form.querySelector('[data-aviso-sistema]');
    var previa = form.querySelector('[data-previa-cor]');
    var cancelar = form.querySelector('[data-cancelar-situacao]');

    /** Mostra na etiqueta de exemplo a cor escolhida agora. */
    function atualizarPrevia() {
      previa.className = 'etiqueta et-' + campoCor.value;
      previa.textContent = campoNome.value.trim() || 'exemplo';
    }

    /**
     * "Encerra o processo" não convive com as outras duas marcas: a situação
     * final é o fim da linha, não uma espera nem uma escolha que se mantém.
     * A tela desliga as duas em vez de deixar salvar e receber erro depois.
     */
    function ajustarMarcadores() {
      var final = campoFinal.checked;
      [campoEspera, campoMantem].forEach(function (campo) {
        campo.disabled = final;
        if (final) campo.checked = false;
        campo.closest('.campo').classList.toggle('desligado', final);
      });
      campoSetor.disabled = final;
      campoSetor.closest('.campo').classList.toggle('desligado', final);
      if (final) campoSetor.value = '';
    }

    /** Trava o que o motor de status espera encontrar, numa situação dele. */
    function aplicarTravaDeSistema(ehDoSistema) {
      campoNome.readOnly = ehDoSistema;
      [campoFinal, campoEspera, campoMantem].forEach(function (campo) {
        campo.disabled = ehDoSistema || campo.disabled;
        campo.closest('.campo').classList.toggle('desligado', campo.disabled);
      });
      avisoSistema.hidden = !ehDoSistema;
    }

    function limpar() {
      campoId.value = '';
      campoNome.value = '';
      campoNome.readOnly = false;
      campoCor.value = 'neutro';
      campoSetor.value = '';
      [campoFinal, campoEspera, campoMantem].forEach(function (campo) {
        campo.checked = false;
        campo.disabled = false;
        campo.closest('.campo').classList.remove('desligado');
      });
      campoSetor.disabled = false;
      campoSetor.closest('.campo').classList.remove('desligado');
      avisoSistema.hidden = true;
      titulo.textContent = 'Nova situação';
      cancelar.hidden = true;
      atualizarPrevia();
    }

    function carregar(id) {
      var s = situacoes.filter(function (x) { return String(x.id) === String(id); })[0];
      if (!s) return;
      limpar();
      campoId.value = s.id;
      campoNome.value = s.nome;
      campoCor.value = s.cor || 'neutro';
      campoSetor.value = s.setor_id ? String(s.setor_id) : '';
      campoFinal.checked = Boolean(s.final);
      campoEspera.checked = Boolean(s.espera);
      campoMantem.checked = Boolean(s.mantem_manual);
      ajustarMarcadores();
      aplicarTravaDeSistema(Boolean(s.sistema));
      titulo.textContent = 'Editando: ' + s.nome;
      cancelar.hidden = false;
      atualizarPrevia();
      campoNome.focus();
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    document.addEventListener('click', function (evento) {
      var botao = evento.target.closest('[data-editar-situacao]');
      if (!botao) return;
      evento.preventDefault();
      carregar(botao.getAttribute('data-editar-situacao'));
    });

    cancelar.addEventListener('click', limpar);
    campoCor.addEventListener('change', atualizarPrevia);
    campoNome.addEventListener('input', atualizarPrevia);
    campoFinal.addEventListener('change', ajustarMarcadores);

    /* Campo desligado não é enviado pelo navegador, e uma situação do sistema
       perderia as marcas dela ao ser salva só para trocar de cor. O servidor
       já protege isso — ele ignora o que vier para uma situação de sistema —,
       mas devolver os valores certos evita que a tela minta sobre o que está
       enviando. */
    form.addEventListener('submit', function () {
      [campoFinal, campoEspera, campoMantem, campoSetor].forEach(function (campo) {
        campo.disabled = false;
      });
    });

    limpar();
  });
})();
