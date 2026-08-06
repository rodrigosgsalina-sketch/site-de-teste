'use strict';

/**
 * Compressão gzip das respostas de texto.
 *
 * HTML, CSS, JavaScript e JSON encolhem entre 70% e 90% comprimidos. Numa rede
 * de escritório isso é a diferença entre a tela aparecer na hora e aparecer
 * "depois de um tempinho" — principalmente em quem acessa pelo Wi-Fi ou de fora.
 *
 * Usa o zlib que já vem no Node: nenhuma dependência nova.
 *
 * Duas coisas ficam FORA, de propósito:
 *
 *   - `text/event-stream` (o canal de avisos). Comprimir um fluxo que fica
 *     aberto significaria segurar os avisos num buffer esperando encher — o
 *     oposto do que ele existe para fazer.
 *   - o que já nasce comprimido: fontes woff2, imagens, PDF, zip. Passar gzip
 *     por cima gasta processador e chega a aumentar o arquivo.
 */

const zlib = require('zlib');

/** O que vale a pena comprimir. */
const TIPOS = /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json)|image\/svg\+xml)/i;

/** Abaixo disso o cabeçalho do gzip custa mais do que economiza. */
const MINIMO_BYTES = 1024;

/** Content-Type já declarado, seja pelo setHeader ou pelo próprio writeHead. */
function tipoDeclarado(res, cabecalhos) {
  if (cabecalhos) {
    for (const chave of Object.keys(cabecalhos)) {
      if (chave.toLowerCase() === 'content-type') return String(cabecalhos[chave]);
    }
  }
  return String(res.getHeader('Content-Type') || '');
}

function tamanhoDeclarado(res, cabecalhos) {
  if (cabecalhos) {
    for (const chave of Object.keys(cabecalhos)) {
      if (chave.toLowerCase() === 'content-length') return Number(cabecalhos[chave]);
    }
  }
  const valor = res.getHeader('Content-Length');
  return valor === undefined ? null : Number(valor);
}

module.exports = function compressao(req, res, next) {
  if (req.method === 'HEAD') return next();
  if (!/\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) return next();

  const escrever = res.write.bind(res);
  const encerrar = res.end.bind(res);
  const enviarCabecalhos = res.writeHead.bind(res);

  let gzip = null;
  let decidido = false;

  function decidir(cabecalhos) {
    if (decidido) return;
    decidido = true;

    const tipo = tipoDeclarado(res, cabecalhos);
    const tamanho = tamanhoDeclarado(res, cabecalhos);

    // "Vary" sai sempre: a resposta muda conforme o Accept-Encoding, e sem esse
    // aviso um cache intermediário entregaria conteúdo comprimido a quem não
    // aceita (ou o contrário).
    const varyAtual = String(res.getHeader('Vary') || '');
    if (!/\baccept-encoding\b/i.test(varyAtual)) {
      res.setHeader('Vary', varyAtual ? `${varyAtual}, Accept-Encoding` : 'Accept-Encoding');
    }

    if (res.getHeader('Content-Encoding')) return; // alguém já codificou
    if (!TIPOS.test(tipo)) return;
    if (/event-stream/i.test(tipo)) return; // canal de avisos: nunca
    if (tamanho !== null && Number.isFinite(tamanho) && tamanho < MINIMO_BYTES) return;
    if (res.statusCode === 204 || res.statusCode === 304) return;

    res.setHeader('Content-Encoding', 'gzip');
    // O tamanho declarado é o do texto original; depois de comprimir ele deixa
    // de valer, e um valor errado trava a resposta no navegador.
    res.removeHeader('Content-Length');

    gzip = zlib.createGzip({ level: 6 });

    /* Contrapressão nos dois sentidos. Quem escreve aqui costuma ser um
       `pipe` (é assim que o Express manda arquivo do disco), e `pipe` só
       continua quando o destino avisa que já pode receber mais. Sem repassar
       esse aviso, um arquivo grande era comprimido até encher o buffer e a
       resposta ficava pendurada para sempre — foi o que aconteceu com o
       Chart.js, de 208 KB, que travava a tela do dashboard. */
    gzip.on('data', (pedaco) => {
      // O socket está cheio: segura o compressor até ele esvaziar.
      if (escrever(pedaco) === false) {
        gzip.pause();
        res.once('drain', () => gzip.resume());
      }
    });
    gzip.on('end', () => encerrar());
    gzip.on('error', () => encerrar());
  }

  /** Repassa a folga do compressor para quem está escrevendo na resposta. */
  function avisarQuandoPuder(podeMais) {
    if (podeMais === false) gzip.once('drain', () => res.emit('drain'));
    return podeMais;
  }

  res.writeHead = function (status, ...resto) {
    // writeHead aceita (status, headers) e (status, mensagem, headers).
    const cabecalhos = resto.find((x) => x && typeof x === 'object');
    decidir(cabecalhos);
    return enviarCabecalhos(status, ...resto);
  };

  res.write = function (pedaco, codificacao, retorno) {
    decidir(null);
    if (!gzip) return escrever(pedaco, codificacao, retorno);
    if (typeof codificacao === 'function') return avisarQuandoPuder(gzip.write(pedaco, retorno || codificacao));
    return avisarQuandoPuder(gzip.write(pedaco, codificacao, retorno));
  };

  res.end = function (pedaco, codificacao, retorno) {
    decidir(null);
    if (!gzip) return encerrar(pedaco, codificacao, retorno);
    if (typeof pedaco === 'function') return gzip.end(pedaco);
    if (typeof codificacao === 'function') return gzip.end(pedaco, codificacao);
    return gzip.end(pedaco, codificacao, retorno);
  };

  next();
};
