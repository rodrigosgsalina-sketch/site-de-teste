'use strict';

/**
 * A tabela de preço do escritório.
 *
 * Todo mundo vê; quem altera é o administrador e o setor definido em
 * `SETOR_TABELA_PRECO` (Financeiro, de fábrica). O arquivo é enviado como PNG,
 * PDF ou XLSX e vira uma exibição só, grande e com zoom, para ser lida na tela
 * sem baixar nada:
 *
 *   - **PNG**  — a própria imagem, ampliada até a largura útil da tela;
 *   - **PDF**  — desenhado página a página no navegador (public/vendor/pdf),
 *                sempre nítido, porque é redesenhado a cada zoom;
 *   - **XLSX** — lido aqui e devolvido como grade de células, que a tela monta
 *                em tabela. Vem como dados, e não como HTML pronto: planilha é
 *                arquivo de terceiro, e o que ela traz é texto, nunca marcação.
 *
 * Cada envio guarda o anterior. Uma tabela de preço tem histórico, e saber o
 * que valia no mês passado é parte do trabalho.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const historico = require('./historico');
const parametros = require('./parametros');
const { ErroValidacao } = require('./checklist');

/** Extensão aceita -> como o arquivo será exibido. */
const FORMATOS = {
  '.png': 'imagem',
  '.pdf': 'pdf',
  '.xlsx': 'planilha',
};

/**
 * Largura mínima confortável para leitura, em pixels de imagem.
 *
 * Não é um limite: é o ponto a partir do qual ampliar deixa de resolver.
 * Ampliar não inventa detalhe — uma tabela fotografada a 500 px vira borrão
 * quando esticada, e é melhor quem enviou saber disso na hora do envio do que
 * o escritório inteiro descobrir depois, tentando ler.
 */
const LARGURA_CONFORTAVEL = 1000;

/** Pasta onde os arquivos da tabela de preço ficam, dentro de uploads/. */
function pasta() {
  const destino = path.join(config.uploadsDir, 'tabela-preco');
  fs.mkdirSync(destino, { recursive: true });
  return destino;
}

function formatoDe(nomeOriginal) {
  return FORMATOS[path.extname(String(nomeOriginal || '')).toLowerCase()] || null;
}

/** Filtro do multer: recusa a extensão antes de o arquivo chegar ao disco. */
function extensaoAceita(nomeOriginal) {
  return Boolean(formatoDe(nomeOriginal));
}

/** Setor que pode alterar a tabela, além do administrador. */
function setorResponsavel() {
  return parametros.texto('SETOR_TABELA_PRECO', 'Financeiro');
}

const SELECT = `
  SELECT t.*, u.nome AS usuario_nome
    FROM tabela_preco t
    LEFT JOIN usuarios u ON u.id = t.usuario_id`;

/** A versão em exibição. */
function atual() {
  return db.get().prepare(`${SELECT} WHERE t.atual = 1 ORDER BY t.id DESC LIMIT 1`).get() || null;
}

/** Todas as versões, da mais nova para a mais antiga. */
function versoes(limite = 30) {
  return db.get().prepare(`${SELECT} ORDER BY t.id DESC LIMIT ?`).all(limite);
}

function obter(id) {
  return db.get().prepare(`${SELECT} WHERE t.id = ?`).get(Number(id) || 0) || null;
}

/**
 * Caminho do arquivo no disco, preso à pasta da tabela de preço — um nome
 * vindo do banco não pode escapar dela com "../".
 */
function caminhoAbsoluto(item) {
  const raiz = path.resolve(pasta());
  const alvo = path.resolve(raiz, path.basename(String(item.nome_arquivo || '')));
  if (!alvo.startsWith(raiz + path.sep)) throw new ErroValidacao('Caminho de arquivo inválido.');
  return alvo;
}

/**
 * Largura e altura de um PNG, lidas do cabeçalho IHDR.
 *
 * São 8 bytes num lugar fixo do arquivo: os primeiros 8 são a assinatura, os
 * 8 seguintes o tamanho e o nome do bloco, e então vêm largura e altura em
 * 32 bits cada. Ler isso à mão evita trazer uma biblioteca de imagem inteira
 * para responder uma pergunta de duas linhas.
 */
function medidasPNG(caminho) {
  let descritor;
  try {
    descritor = fs.openSync(caminho, 'r');
    const cabecalho = Buffer.alloc(24);
    const lidos = fs.readSync(descritor, cabecalho, 0, 24, 0);
    if (lidos < 24) return null;
    if (cabecalho.toString('latin1', 1, 4) !== 'PNG') return null;
    if (cabecalho.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { largura: cabecalho.readUInt32BE(16), altura: cabecalho.readUInt32BE(20) };
  } catch (_) {
    return null;
  } finally {
    if (descritor !== undefined) fs.closeSync(descritor);
  }
}

/**
 * A planilha como grade de células (linhas × colunas) para a tela montar.
 *
 * A biblioteca é carregada só aqui, pelo mesmo motivo da importação de
 * empresas: ela vem de fora do npm, e a falta dela não pode derrubar uma tela
 * que a maioria abre para ver uma imagem.
 */
function grade(item, { maxLinhas = 400, maxColunas = 40 } = {}) {
  let XLSX;
  try {
    // eslint-disable-next-line global-require
    XLSX = require('xlsx');
  } catch (_) {
    throw new ErroValidacao(
      'A biblioteca de leitura de planilhas (xlsx) não está instalada. Rode "npm install" na pasta da plataforma.'
    );
  }

  const wb = XLSX.readFile(caminhoAbsoluto(item), { cellDates: false, cellFormula: false, raw: false });
  const nomeAba = wb.SheetNames[0];
  if (!nomeAba) return { aba: null, abas: [], linhas: [], truncada: false };

  const todas = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, raw: false, defval: '' });
  // Linhas e colunas totalmente vazias no fim da planilha não são conteúdo.
  const cheias = todas.map((linha) => linha.map((c) => String(c == null ? '' : c).trim()));
  while (cheias.length && !cheias[cheias.length - 1].some(Boolean)) cheias.pop();
  const colunas = Math.min(
    maxColunas,
    cheias.reduce((maior, linha) => {
      let ultima = 0;
      linha.forEach((celula, i) => {
        if (celula) ultima = i + 1;
      });
      return Math.max(maior, ultima);
    }, 0)
  );

  const linhas = cheias.slice(0, maxLinhas).map((linha) => {
    const recorte = linha.slice(0, colunas);
    while (recorte.length < colunas) recorte.push('');
    return recorte;
  });

  return {
    aba: nomeAba,
    abas: wb.SheetNames,
    linhas,
    colunas,
    truncada: cheias.length > maxLinhas,
    totalLinhas: cheias.length,
  };
}

/**
 * Grava o envio como a versão em exibição e devolve
 * `{ item, aviso }` — `aviso` é o recado sobre a imagem ter chegado pequena
 * demais para ser lida ampliada, quando for o caso.
 */
function registrar(arquivo, descricao, usuario) {
  const formato = formatoDe(arquivo.originalname);
  if (!formato) throw new ErroValidacao('Envie um arquivo .png, .pdf ou .xlsx.');

  const caminho = path.join(pasta(), arquivo.filename);
  const medidas = formato === 'imagem' ? medidasPNG(caminho) : null;

  const id = db.tx(() => {
    db.get().prepare('UPDATE tabela_preco SET atual = 0 WHERE atual = 1').run();
    const info = db
      .get()
      .prepare(
        `INSERT INTO tabela_preco
           (nome_original, nome_arquivo, formato, mime, tamanho, largura, altura, descricao, atual, usuario_id)
         VALUES (@nome_original, @nome_arquivo, @formato, @mime, @tamanho, @largura, @altura, @descricao, 1, @usuario_id)`
      )
      .run({
        nome_original: String(arquivo.originalname || '').slice(0, 200),
        nome_arquivo: arquivo.filename,
        formato,
        mime: arquivo.mimetype || null,
        tamanho: arquivo.size || 0,
        largura: medidas ? medidas.largura : null,
        altura: medidas ? medidas.altura : null,
        descricao: (descricao || '').trim() || null,
        usuario_id: usuario ? usuario.id : null,
      });
    return Number(info.lastInsertRowid);
  });

  const item = obter(id);
  historico.registrar({
    processoId: null,
    acao: 'Tabela de Preço Atualizada',
    usuario,
    observacao: `${item.nome_original} (${Math.round((item.tamanho || 0) / 1024)} KB)`,
  });

  const aviso =
    medidas && medidas.largura < LARGURA_CONFORTAVEL
      ? `A imagem tem ${medidas.largura} px de largura. Ela será ampliada para caber na tela, mas ` +
        `ampliar não cria detalhe: se tiver uma versão maior (ou o PDF original), envie-a no lugar.`
      : null;

  return { item, aviso };
}

/** Escolhe uma versão anterior para voltar a ser a exibida. */
function tornarAtual(id, usuario) {
  const item = obter(id);
  if (!item) throw new ErroValidacao('Versão não encontrada.');
  if (item.atual) return item;

  db.tx(() => {
    db.get().prepare('UPDATE tabela_preco SET atual = 0 WHERE atual = 1').run();
    db.get().prepare('UPDATE tabela_preco SET atual = 1 WHERE id = ?').run(item.id);
  });

  historico.registrar({
    processoId: null,
    acao: 'Tabela de Preço Atualizada',
    usuario,
    observacao: `Versão de ${item.criado_em} (${item.nome_original}) voltou a ser a exibida.`,
  });
  return obter(id);
}

/**
 * Apaga uma versão, arquivo e tudo. Some a que estava em exibição, quem assume
 * é a mais recente das que sobraram — a tela nunca fica sem tabela tendo uma.
 */
function remover(id, usuario) {
  const item = obter(id);
  if (!item) throw new ErroValidacao('Versão não encontrada.');

  const caminho = caminhoAbsoluto(item);
  db.tx(() => {
    db.get().prepare('DELETE FROM tabela_preco WHERE id = ?').run(item.id);
    if (item.atual) {
      const proxima = db.get().prepare('SELECT id FROM tabela_preco ORDER BY id DESC LIMIT 1').get();
      if (proxima) db.get().prepare('UPDATE tabela_preco SET atual = 1 WHERE id = ?').run(proxima.id);
    }
  });
  if (fs.existsSync(caminho)) fs.unlinkSync(caminho);

  historico.registrar({
    processoId: null,
    acao: 'Tabela de Preço Removida',
    usuario,
    observacao: `${item.nome_original} (versão de ${item.criado_em}).`,
  });
  return item;
}

module.exports = {
  FORMATOS,
  LARGURA_CONFORTAVEL,
  extensaoAceita,
  formatoDe,
  setorResponsavel,
  pasta,
  atual,
  versoes,
  obter,
  caminhoAbsoluto,
  medidasPNG,
  grade,
  registrar,
  tornarAtual,
  remover,
};
