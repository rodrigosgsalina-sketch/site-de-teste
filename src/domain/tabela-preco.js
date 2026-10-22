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
 * São **várias tabelas ao mesmo tempo** — abertura de empresa, mensalidade
 * contábil, certidões —, cada uma com título próprio. As publicadas aparecem
 * para todo o escritório, que escolhe qual abrir; as que saem de publicação
 * ficam guardadas, porque o preço do mês passado também é informação.
 *
 * Trocar o preço de uma tabela é enviar o arquivo novo **no lugar** dela: o
 * novo herda o título e entra publicado, o antigo sai de publicação e fica no
 * histórico. Assim o seletor nunca mostra duas "Abertura de empresa".
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

/** Título padrão: o nome do arquivo, sem a extensão. */
function tituloPadrao(nomeOriginal) {
  return String(nomeOriginal || '').replace(/\.[^.]+$/, '').trim().slice(0, 120);
}

/** As publicadas, em ordem alfabética de título — é a ordem do seletor. */
function publicadas() {
  return db
    .get()
    .prepare(`${SELECT} WHERE t.publicada = 1 ORDER BY t.titulo COLLATE NOCASE, t.id DESC`)
    .all();
}

/** Todas, publicadas primeiro, para a tela de quem administra. */
function todas(limite = 200) {
  return db
    .get()
    .prepare(`${SELECT} ORDER BY t.publicada DESC, t.titulo COLLATE NOCASE, t.id DESC LIMIT ?`)
    .all(limite)
    .map((t) => ({ ...t, semArquivo: !arquivoNoServidor(t) }));
}

/**
 * A tabela que a tela vai mostrar.
 *
 * Quem só consulta vê apenas as publicadas: um link antigo para uma tabela que
 * saiu de publicação cai na primeira publicada, em vez de abrir um preço que
 * não vale mais. Quem administra abre qualquer uma — é assim que confere um
 * arquivo antes de publicá-lo, ou consulta o que valia antes.
 *
 * Devolve `{ item, pedidaIndisponivel }`: o segundo diz se foi pedida uma
 * tabela que não pôde ser mostrada, para a tela avisar em vez de trocar calada.
 */
function paraExibir(idPedido, { podeVerTodas = false } = {}) {
  const lista = publicadas();
  const id = Number(idPedido) || 0;
  if (id) {
    const pedida = obter(id);
    if (pedida && (pedida.publicada || podeVerTodas)) return { item: pedida, pedidaIndisponivel: false };
    return { item: lista[0] || null, pedidaIndisponivel: true };
  }
  return { item: lista[0] || null, pedidaIndisponivel: false };
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
 * O arquivo da tabela está no disco deste servidor?
 *
 * A linha pode existir sem o arquivo — o caso típico é um backup restaurado
 * noutra máquina, gerado antes de os arquivos da tabela de preço irem junto.
 * A tela pergunta antes de tentar abrir, para explicar o que houve em vez de
 * mostrar o erro do leitor de PDF.
 */
function arquivoNoServidor(item) {
  if (!item) return false;
  try {
    return fs.existsSync(caminhoAbsoluto(item));
  } catch (_) {
    return false;
  }
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
 * Título já em uso por outra tabela publicada?
 *
 * Duas "Abertura de empresa" no seletor obrigam quem lê a adivinhar qual vale.
 * A comparação ignora maiúsculas e espaços nas pontas — "abertura de empresa "
 * é o mesmo título.
 */
function tituloEmUso(titulo, ignorarId = 0) {
  return (
    db
      .get()
      .prepare(
        `SELECT id, titulo FROM tabela_preco
          WHERE publicada = 1 AND id <> ? AND lower(trim(titulo)) = lower(trim(?))
          LIMIT 1`
      )
      .get(Number(ignorarId) || 0, String(titulo || '')) || null
  );
}

function exigirTituloLivre(titulo, ignorarId = 0) {
  const outra = tituloEmUso(titulo, ignorarId);
  if (outra) {
    throw new ErroValidacao(
      `Já existe uma tabela publicada chamada "${outra.titulo}". Para trocar o preço dela, envie o ` +
        'arquivo novo escolhendo-a em "Substitui a tabela"; para ter as duas, dê outro título.'
    );
  }
}

/**
 * Grava o envio e devolve `{ item, aviso, substituida }`.
 *
 * Com `substituiId`, o arquivo novo entra no lugar daquela tabela: herda o
 * título (se nenhum outro foi digitado) e a tira de publicação, tudo na mesma
 * transação — o seletor nunca fica um instante sem ela nem com as duas.
 *
 * `aviso` é o recado sobre a imagem ter chegado pequena demais para ser lida
 * ampliada, quando for o caso.
 */
function registrar(arquivo, dados = {}, usuario) {
  const formato = formatoDe(arquivo.originalname);
  if (!formato) throw new ErroValidacao('Envie um arquivo .png, .pdf ou .xlsx.');

  const substituida = dados.substituiId ? obter(dados.substituiId) : null;
  if (dados.substituiId && !substituida) {
    throw new ErroValidacao('A tabela a ser substituída não existe mais. Recarregue a página.');
  }

  const titulo = (
    String(dados.titulo || '').trim() ||
    (substituida ? substituida.titulo : '') ||
    tituloPadrao(arquivo.originalname)
  ).slice(0, 120);
  if (!titulo) throw new ErroValidacao('Dê um título à tabela.');
  exigirTituloLivre(titulo, substituida ? substituida.id : 0);

  const caminho = path.join(pasta(), arquivo.filename);
  const medidas = formato === 'imagem' ? medidasPNG(caminho) : null;

  const id = db.tx(() => {
    if (substituida) {
      db.get().prepare('UPDATE tabela_preco SET publicada = 0 WHERE id = ?').run(substituida.id);
    }
    const info = db
      .get()
      .prepare(
        `INSERT INTO tabela_preco
           (nome_original, nome_arquivo, formato, mime, tamanho, largura, altura,
            titulo, descricao, publicada, usuario_id)
         VALUES (@nome_original, @nome_arquivo, @formato, @mime, @tamanho, @largura, @altura,
                 @titulo, @descricao, 1, @usuario_id)`
      )
      .run({
        nome_original: String(arquivo.originalname || '').slice(0, 200),
        nome_arquivo: arquivo.filename,
        formato,
        mime: arquivo.mimetype || null,
        tamanho: arquivo.size || 0,
        largura: medidas ? medidas.largura : null,
        altura: medidas ? medidas.altura : null,
        titulo,
        descricao: String(dados.descricao || '').trim().slice(0, 200) || null,
        usuario_id: usuario ? usuario.id : null,
      });
    return Number(info.lastInsertRowid);
  });

  const item = obter(id);
  historico.registrar({
    processoId: null,
    acao: 'Tabela de Preço Publicada',
    usuario,
    observacao:
      `"${item.titulo}" — ${item.nome_original} (${Math.round((item.tamanho || 0) / 1024)} KB)` +
      (substituida ? `, no lugar da versão de ${substituida.criado_em}.` : '.'),
  });

  const aviso =
    medidas && medidas.largura < LARGURA_CONFORTAVEL
      ? `A imagem tem ${medidas.largura} px de largura. Ela será ampliada para caber na tela, mas ` +
        `ampliar não cria detalhe: se tiver uma versão maior (ou o PDF original), envie-a no lugar.`
      : null;

  return { item, aviso, substituida };
}

/** Corrige título e descrição de uma tabela. */
function atualizar(id, dados, usuario) {
  const item = obter(id);
  if (!item) throw new ErroValidacao('Tabela não encontrada.');
  const titulo = String(dados.titulo || '').trim().slice(0, 120);
  if (!titulo) throw new ErroValidacao('O título não pode ficar em branco.');
  if (item.publicada) exigirTituloLivre(titulo, item.id);

  const descricao = String(dados.descricao || '').trim().slice(0, 200) || null;
  db.get().prepare('UPDATE tabela_preco SET titulo = ?, descricao = ? WHERE id = ?').run(titulo, descricao, item.id);

  if (titulo !== item.titulo || descricao !== item.descricao) {
    historico.registrar({
      processoId: null,
      acao: 'Tabela de Preço Alterada',
      usuario,
      observacao: titulo !== item.titulo ? `"${item.titulo}" passou a se chamar "${titulo}".` : `"${titulo}": descrição alterada.`,
    });
  }
  return obter(item.id);
}

/** Põe ou tira uma tabela do seletor de todo o escritório. */
function definirPublicacao(id, publicar, usuario) {
  const item = obter(id);
  if (!item) throw new ErroValidacao('Tabela não encontrada.');
  const alvo = publicar ? 1 : 0;
  if (item.publicada === alvo) return item;
  if (alvo) exigirTituloLivre(item.titulo, item.id);

  db.get().prepare('UPDATE tabela_preco SET publicada = ? WHERE id = ?').run(alvo, item.id);
  historico.registrar({
    processoId: null,
    acao: alvo ? 'Tabela de Preço Publicada' : 'Tabela de Preço Retirada',
    usuario,
    observacao: `"${item.titulo}" (${item.nome_original}, de ${item.criado_em}).`,
  });
  return obter(item.id);
}

/** Apaga uma tabela, arquivo e tudo. As demais não são tocadas. */
function remover(id, usuario) {
  const item = obter(id);
  if (!item) throw new ErroValidacao('Tabela não encontrada.');

  const caminho = caminhoAbsoluto(item);
  db.get().prepare('DELETE FROM tabela_preco WHERE id = ?').run(item.id);
  if (fs.existsSync(caminho)) fs.unlinkSync(caminho);

  historico.registrar({
    processoId: null,
    acao: 'Tabela de Preço Removida',
    usuario,
    observacao: `"${item.titulo}" — ${item.nome_original} (de ${item.criado_em}).`,
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
  tituloPadrao,
  publicadas,
  todas,
  paraExibir,
  obter,
  caminhoAbsoluto,
  arquivoNoServidor,
  medidasPNG,
  grade,
  tituloEmUso,
  registrar,
  atualizar,
  definirPublicacao,
  remover,
};
