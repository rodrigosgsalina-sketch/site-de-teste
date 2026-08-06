'use strict';

/**
 * Versão dos arquivos estáticos no endereço.
 *
 * O CSS e o JavaScript ficam guardados no navegador para a plataforma abrir
 * rápido. Só que o HTML é montado pelo servidor a cada acesso e o arquivo
 * guardado, não: depois de uma atualização, a tela nova convivia com o
 * JavaScript velho — botão que não responde, campo que não obedece — até o
 * cache vencer. Foi exatamente o que aconteceu com o interruptor do som.
 *
 * A solução é o endereço mudar quando o arquivo muda:
 *
 *     /static/js/notificacoes.js?v=3f9a1c2b
 *
 * Endereço novo é arquivo novo para o navegador — ele busca na hora, sem
 * ninguém precisar limpar cache. E como o endereço só muda quando o conteúdo
 * muda, o arquivo pode ficar guardado por um ano (ver `src/app.js`).
 *
 * A soma é calculada na primeira vez que cada arquivo é pedido e guardada na
 * memória; a cada uso o arquivo é conferido pela data de alteração, e só é
 * lido de novo se tiver mudado. Assim vale tanto quando a atualização vem com
 * reinício do servidor quanto quando alguém apenas troca um arquivo em disco.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', 'public');

const somas = new Map();

/** Oito dígitos do sha1 do conteúdo: o bastante para distinguir versões. */
function soma(relativo) {
  const arquivo = path.join(RAIZ, relativo);

  let marca;
  try {
    const info = fs.statSync(arquivo);
    marca = `${info.mtimeMs}:${info.size}`;
  } catch (_) {
    // Arquivo ausente (o Chart.js só aparece depois do npm install): sem
    // versão o endereço continua válido, apenas sem cache longo.
    somas.delete(relativo);
    return '';
  }

  // Conferir a data custa quase nada e evita o pior caso: arquivo trocado em
  // disco sem reiniciar o processo, servindo endereço de uma versão que não
  // existe mais.
  const guardado = somas.get(relativo);
  if (guardado && guardado.marca === marca) return guardado.valor;

  let valor = '';
  try {
    valor = crypto.createHash('sha1').update(fs.readFileSync(arquivo)).digest('hex').slice(0, 8);
  } catch (_) {
    return '';
  }

  somas.set(relativo, { marca, valor });
  return valor;
}

/**
 * Endereço público de um arquivo de `src/public`, já versionado.
 * Aceita "/js/app.js" ou "js/app.js".
 */
function estatico(caminho) {
  const relativo = String(caminho || '').replace(/^\/+/, '');
  const versao = soma(relativo);
  return `/static/${relativo}${versao ? `?v=${versao}` : ''}`;
}

/** Esquece as somas — usado nos testes ao trocar um arquivo. */
function esquecer() {
  somas.clear();
}

module.exports = { estatico, esquecer };
