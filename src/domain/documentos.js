'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const historico = require('./historico');
const integracoes = require('./integracoes');
const { ErroValidacao } = require('./checklist');

function doProcesso(processoId) {
  return db
    .get()
    .prepare(
      `SELECT d.*, u.nome AS usuario_nome
         FROM documentos d LEFT JOIN usuarios u ON u.id = d.usuario_id
        WHERE d.processo_id = ? ORDER BY d.id DESC`
    )
    .all(processoId);
}

function obter(id) {
  return db.get().prepare('SELECT * FROM documentos WHERE id = ?').get(id);
}

/**
 * Extensões aceitas nos anexos. A lista é fechada de propósito: nada de .html,
 * .svg (que carrega script) nem de executáveis dentro da pasta servida.
 */
const EXTENSOES_ACEITAS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.csv',
  '.doc', '.docx', '.xls', '.xlsx', '.ods', '.odt', '.ppt', '.pptx',
  '.xml', '.zip', '.p7s', '.rtf',
]);

/** Nome de arquivo seguro para gravar e para devolver no download. */
function nomeSeguro(original, padrao = 'arquivo') {
  const base = path
    .basename(String(original || ''))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Fora tudo que possa virar caminho ou cabeçalho HTTP forjado.
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/^[.\s]+/, '')
    .slice(0, 120)
    .trim();
  return base || padrao;
}

/** Filtro do multer: recusa a extensão antes de o arquivo chegar ao disco. */
function extensaoAceita(nomeOriginal) {
  return EXTENSOES_ACEITAS.has(path.extname(String(nomeOriginal || '')).toLowerCase());
}

/**
 * Resolve o caminho do anexo garantindo que ele fique dentro de uploads/ —
 * um nome vindo do banco não pode escapar da pasta com "../".
 */
function caminhoAbsoluto(documento) {
  const raiz = path.resolve(config.uploadsDir);
  const alvo = path.resolve(raiz, String(documento.processo_id), path.basename(String(documento.nome_arquivo || '')));
  if (alvo !== raiz && !alvo.startsWith(raiz + path.sep)) {
    throw new ErroValidacao('Caminho de arquivo inválido.');
  }
  return alvo;
}

/** Registra o upload e tenta arquivar no Drive (quando a integração estiver pronta). */
async function registrar(processo, arquivo, descricao, usuario) {
  const info = db
    .get()
    .prepare(
      `INSERT INTO documentos (processo_id, nome_original, nome_arquivo, mime, tamanho, descricao, usuario_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      processo.id,
      nomeSeguro(arquivo.originalname),
      arquivo.filename,
      arquivo.mimetype,
      arquivo.size,
      (descricao || '').trim() || null,
      usuario ? usuario.id : null
    );

  const documento = obter(Number(info.lastInsertRowid));
  historico.registrar({
    processoId: processo.id,
    acao: 'Documento Anexado',
    usuario,
    observacao: `${arquivo.originalname} (${Math.round(arquivo.size / 1024)} KB)`,
  });

  const resultado = await integracoes.googleDrive.arquivar(documento);
  if (resultado && resultado.driveFileId) {
    db.get().prepare('UPDATE documentos SET drive_file_id = ? WHERE id = ?').run(resultado.driveFileId, documento.id);
  }
  return documento;
}

function remover(id, processo, usuario) {
  const documento = obter(id);
  if (!documento || documento.processo_id !== processo.id) {
    throw new ErroValidacao('Documento não encontrado neste processo.');
  }
  const caminho = caminhoAbsoluto(documento);
  if (fs.existsSync(caminho)) fs.unlinkSync(caminho);
  db.get().prepare('DELETE FROM documentos WHERE id = ?').run(id);
  historico.registrar({
    processoId: processo.id,
    acao: 'Documento Removido',
    usuario,
    observacao: documento.nome_original,
  });
}

module.exports = {
  doProcesso,
  obter,
  caminhoAbsoluto,
  registrar,
  remover,
  nomeSeguro,
  extensaoAceita,
  EXTENSOES_ACEITAS,
};
