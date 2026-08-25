/* Visualizador da tabela de preço.
 *
 * A tela precisa entregar uma coisa só: a tabela grande o bastante para ser
 * lida. O arquivo chega em três formatos e cada um é desenhado do seu jeito —
 * imagem esticada, PDF redesenhado, planilha em grade —, mas todos obedecem à
 * mesma escala e aos mesmos botões.
 *
 * **Ao abrir, o conteúdo é ajustado à largura da tela.** É essa a regra que
 * amplia o arquivo pequeno: uma imagem de 600 px numa área de 1200 abre no
 * dobro do tamanho, e uma de 4000 px encolhe para caber inteira. Depois disso
 * a escala é de quem está lendo, e fica guardada neste navegador para a
 * próxima visita.
 *
 * É um módulo (`type="module"`) porque o leitor de PDF só é carregado quando o
 * arquivo é um PDF — são 1,7 MB que não fazem falta a quem só vai olhar uma
 * imagem.
 */

const dados = window.TABELA_PRECO;
if (dados) iniciar();

function iniciar() {
  const palco = document.querySelector('[data-tp-palco]');
  const barra = document.querySelector('[data-tp-barra]');
  if (!palco || !barra) return;

  const faixa = barra.querySelector('[data-tp-faixa]');
  const valor = barra.querySelector('[data-tp-valor]');
  // A escala guardada é por arquivo: a que servia para uma imagem pequena não
  // serve para o PDF que entrou no lugar dela.
  const CHAVE = 'tabela-preco:escala:' + dados.id;
  const MIN = 0.25;
  const MAX = 4;
  // Teto da ampliação automática. Ajustar à largura existe para o arquivo
  // pequeno abrir grande, não para transformar um recorte de 200 px num borrão
  // de tela cheia — daí em diante, quem manda é quem está lendo.
  const MAX_AJUSTE = 3;

  /* Cada formato responde a três perguntas: qual a largura natural do
     conteúdo, como ele é desenhado numa dada escala e quando está pronto. */
  const desenho = criarDesenho(palco);
  if (!desenho) return;

  let escala = 1;

  function aplicar(nova, { guardar = true } = {}) {
    escala = Math.min(MAX, Math.max(MIN, nova));
    desenho.aplicar(escala);
    faixa.value = String(Math.round(escala * 100));
    valor.textContent = Math.round(escala * 100) + '%';
    if (guardar) {
      try {
        localStorage.setItem(CHAVE, String(escala));
      } catch (_) {
        /* navegador sem armazenamento: a escala vale só para esta visita */
      }
    }
  }

  /** Escala que faz o conteúdo caber na largura útil — amplia ou reduz. */
  function escalaDeAjuste() {
    const natural = desenho.larguraNatural();
    if (!natural) return 1;
    // 2px de folga para a borda não encostar na barra de rolagem.
    const disponivel = palco.clientWidth - 2;
    if (disponivel <= 0) return 1;
    return Math.min(MAX_AJUSTE, Math.max(MIN, disponivel / natural));
  }

  function guardada() {
    try {
      const salva = parseFloat(localStorage.getItem(CHAVE));
      return Number.isFinite(salva) && salva >= MIN && salva <= MAX ? salva : null;
    } catch (_) {
      return null;
    }
  }

  barra.querySelector('[data-tp-menos]').addEventListener('click', () => aplicar(escala - passo(escala, -1)));
  barra.querySelector('[data-tp-mais]').addEventListener('click', () => aplicar(escala + passo(escala, 1)));
  barra.querySelector('[data-tp-ajustar]').addEventListener('click', () => aplicar(escalaDeAjuste()));
  barra.querySelector('[data-tp-natural]').addEventListener('click', () => aplicar(1));
  faixa.addEventListener('input', () => aplicar(Number(faixa.value) / 100));

  // Ctrl + roda do mouse é como se amplia qualquer coisa: aqui também.
  palco.addEventListener(
    'wheel',
    (evento) => {
      if (!evento.ctrlKey) return;
      evento.preventDefault();
      aplicar(escala * (evento.deltaY < 0 ? 1.1 : 1 / 1.1));
    },
    { passive: false }
  );

  document.addEventListener('keydown', (evento) => {
    if (evento.target.closest('input, textarea, select')) return;
    if (evento.key === '+' || evento.key === '=') aplicar(escala + passo(escala, 1));
    else if (evento.key === '-' || evento.key === '_') aplicar(escala - passo(escala, -1));
    else if (evento.key === '0') aplicar(escalaDeAjuste());
    else return;
    evento.preventDefault();
  });

  // Redimensionar a janela não mexe na escala escolhida; só refaz o desenho,
  // que no PDF depende do tamanho do canvas.
  let refazer;
  window.addEventListener('resize', () => {
    clearTimeout(refazer);
    refazer = setTimeout(() => aplicar(escala, { guardar: false }), 200);
  });

  desenho
    .pronto()
    .then(() => {
      barra.hidden = false;
      // A escala guardada é a preferência de quem lê; sem ela, ajusta à
      // largura — que é o que faz o arquivo pequeno abrir grande.
      aplicar(guardada() || escalaDeAjuste(), { guardar: false });
    })
    .catch((erro) => {
      palco.innerHTML = '';
      const recado = document.createElement('p');
      recado.className = 'aviso aviso-erro';
      recado.textContent =
        'Não foi possível abrir o arquivo nesta tela: ' + (erro && erro.message ? erro.message : 'erro desconhecido') +
        '. Use "Baixar arquivo" para abri-lo no computador.';
      palco.appendChild(recado);
      barra.hidden = false;
    });
}

/** Passo do zoom: fino perto de 100%, largo quando já está grande. */
function passo(escala, direcao) {
  const base = escala < 1 ? 0.1 : escala < 2 ? 0.25 : 0.5;
  return direcao > 0 ? base : Math.min(base, escala - 0.25 > 0 ? base : 0.05);
}

/* ------------------------------------------------------------- formatos */

function criarDesenho(palco) {
  if (dados.formato === 'imagem') return desenhoDeImagem(palco);
  if (dados.formato === 'pdf') return desenhoDePdf(palco);
  return desenhoDePlanilha(palco);
}

/** Imagem: a largura em CSS é a natural multiplicada pela escala. */
function desenhoDeImagem(palco) {
  const img = palco.querySelector('[data-tp-imagem]');
  if (!img) return null;

  return {
    larguraNatural: () => img.naturalWidth || dados.largura || 0,
    aplicar(escala) {
      const natural = img.naturalWidth || dados.largura || 0;
      if (!natural) return;
      img.style.width = Math.round(natural * escala) + 'px';
      img.style.height = 'auto';
    },
    pronto() {
      if (img.complete && img.naturalWidth) return Promise.resolve();
      return new Promise((resolve, reject) => {
        img.addEventListener('load', () => resolve());
        img.addEventListener('error', () => reject(new Error('a imagem não pôde ser carregada')));
      });
    },
  };
}

/**
 * Planilha: a grade é montada pelo servidor e aqui só recebe escala.
 *
 * O `transform` escala sem reescrever a tabela, mas não ocupa espaço: quem
 * reserva a área para a rolagem funcionar é o quadro em volta, com o tamanho
 * já multiplicado.
 */
function desenhoDePlanilha(palco) {
  const quadro = palco.querySelector('[data-tp-planilha]');
  if (!quadro) return null;
  const tabela = quadro.querySelector('table');
  let natural = 0;

  /**
   * Mede a tabela sem escala nenhuma.
   *
   * A medida sai do retângulo do elemento, e não de `scrollWidth`: numa tabela
   * os dois não coincidem, e usar o número errado faz o "ajustar à largura"
   * parar antes da borda. A conta também espera a fonte da plataforma chegar —
   * medir com a fonte do sistema é medir outra tabela.
   */
  function medir() {
    quadro.style.width = '';
    quadro.style.height = '';
    tabela.style.transform = 'none';
    natural = Math.round(tabela.getBoundingClientRect().width) || tabela.offsetWidth || 0;
  }

  return {
    larguraNatural: () => natural,
    aplicar(escala) {
      if (!natural) medir();
      const altura = tabela.offsetHeight;
      tabela.style.transformOrigin = 'top left';
      tabela.style.transform = `scale(${escala})`;
      quadro.style.width = Math.round(natural * escala) + 'px';
      quadro.style.height = Math.round(altura * escala) + 'px';
    },
    pronto() {
      const fontes = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
      return fontes.then(() => medir());
    },
  };
}

/**
 * PDF: cada página é redesenhada na escala pedida.
 *
 * Redesenhar em vez de esticar é o que mantém o texto nítido em qualquer
 * tamanho — e é justamente o caso da tabela de preço, que existe para ser
 * lida. O desenho é adiado um instante a cada mudança para o arrastar da
 * barra não disparar uma renderização por pixel.
 */
function desenhoDePdf(palco) {
  const area = palco.querySelector('[data-tp-paginas]');
  if (!area) return null;

  const config = window.TABELA_PRECO_PDFJS || {};
  const pixels = Math.min(window.devicePixelRatio || 1, 2);
  let documento = null;
  let paginas = [];
  let natural = 0;
  let agendado;
  let escalaAtual = 1;

  async function carregar() {
    const pdfjs = await import(config.biblioteca);
    if (config.worker) pdfjs.GlobalWorkerOptions.workerSrc = config.worker;

    documento = await pdfjs.getDocument({ url: dados.url }).promise;
    area.innerHTML = '';
    paginas = [];

    for (let numero = 1; numero <= documento.numPages; numero++) {
      const pagina = await documento.getPage(numero);
      const medida = pagina.getViewport({ scale: 1 });
      natural = Math.max(natural, medida.width);
      const tela = document.createElement('canvas');
      tela.className = 'tp-pagina';
      area.appendChild(tela);
      paginas.push({ pagina, tela, medida, tarefa: null });
    }
  }

  async function desenhar(escala) {
    for (const p of paginas) {
      if (p.tarefa) p.tarefa.cancel();
      const viewport = p.pagina.getViewport({ scale: escala * pixels });
      p.tela.width = Math.round(viewport.width);
      p.tela.height = Math.round(viewport.height);
      p.tela.style.width = Math.round(p.medida.width * escala) + 'px';
      p.tela.style.height = Math.round(p.medida.height * escala) + 'px';
      p.tarefa = p.pagina.render({ canvasContext: p.tela.getContext('2d'), viewport });
      try {
        await p.tarefa.promise;
      } catch (erro) {
        if (!erro || erro.name !== 'RenderingCancelledException') throw erro;
      }
      p.tarefa = null;
    }
  }

  return {
    larguraNatural: () => natural,
    aplicar(escala) {
      escalaAtual = escala;
      clearTimeout(agendado);
      agendado = setTimeout(() => {
        // Cancelamento é rotina (uma escala nova atropela a anterior) e já foi
        // tratado no desenho. O que chegar aqui é falha de verdade, e falha de
        // verdade tem de aparecer: foi engolindo este erro que a tela passou a
        // mostrar uma folha em branco sem dizer por quê.
        desenhar(escalaAtual).catch((erro) => {
          // eslint-disable-next-line no-console
          console.error('[tabela de preço] falha ao desenhar o PDF', erro);
          area.innerHTML =
            '<p class="aviso aviso-erro">Não foi possível desenhar o PDF nesta tela. ' +
            'Use “Baixar arquivo” para abri-lo no computador.</p>';
        });
      }, 90);
    },
    pronto: () => carregar(),
  };
}
