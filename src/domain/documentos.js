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

function caminhoAbsoluto(documento) {
  return path.join(config.uploadsDir, String(documento.processo_id), documento.nome_arquivo);
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
      arquivo.originalname,
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

module.exports = { doProcesso, obter, caminhoAbsoluto, registrar, remover };
