'use strict';

/**
 * Ordem de atendimento dos setores dentro de um tipo de processo.
 *
 * Por padrão o checklist segue a ordem geral da tabela `setores`. Quando a
 * administração define uma ordem para um tipo ("na Baixa de Empresa, o
 * Departamento Pessoal entra antes do Paralegal"), essa posição passa a valer
 * para aquele tipo — no agrupamento do checklist, na etapa atual, no status
 * "Em Análise <setor>" e no aviso de vez do setor.
 *
 * A ordem é lida na hora do uso (não é congelada na abertura), de modo que
 * reordenar reflete também nos processos que já estão em andamento.
 */

const db = require('../db');

/**
 * Expressão SQL da posição do setor. Setores sem posição definida para o tipo
 * vão para o fim, preservando entre si a ordem geral de `setores`.
 *
 * @param {string} aliasOrdem alias da tabela ordem_setores_tipo na consulta
 * @param {string} aliasSetor alias da tabela setores na consulta
 */
function posicaoSQL(aliasOrdem = 'ost', aliasSetor = 's') {
  return `COALESCE(${aliasOrdem}.ordem, 1000 + ${aliasSetor}.ordem)`;
}

/** JOIN padrão para trazer a posição do setor no tipo de processo. */
function joinSQL(colunaTipo, colunaSetor, alias = 'ost') {
  return `LEFT JOIN ordem_setores_tipo ${alias}
            ON ${alias}.tipo_processo_id = ${colunaTipo} AND ${alias}.setor_id = ${colunaSetor}`;
}

/**
 * Setores que participam de um tipo de processo (pelo checklist modelo,
 * incluindo os itens aplicados a todos), já na ordem de atendimento.
 */
function doTipo(tipoProcessoId) {
  return db
    .get()
    .prepare(
      `SELECT s.id, s.nome, s.auxiliar,
              ${posicaoSQL()} AS posicao,
              ost.ordem IS NOT NULL AS definido,
              COUNT(m.id) AS itens
         FROM checklist_modelo m
         JOIN setores s ON s.id = m.setor_id
         ${joinSQL('?', 's.id')}
        WHERE m.ativo = 1 AND (m.tipo_processo_id = ? OR m.tipo_processo_id IS NULL)
        GROUP BY s.id
        ORDER BY posicao, s.nome`
    )
    .all(tipoProcessoId, tipoProcessoId);
}

/**
 * Grava a ordem informada (lista de IDs de setor, do primeiro ao último).
 * Setores fora da lista perdem a posição e voltam ao padrão.
 */
function definir(tipoProcessoId, setorIds) {
  const conn = db.get();
  db.tx(() => {
    conn.prepare('DELETE FROM ordem_setores_tipo WHERE tipo_processo_id = ?').run(tipoProcessoId);
    const inserir = conn.prepare(
      'INSERT INTO ordem_setores_tipo (tipo_processo_id, setor_id, ordem) VALUES (?, ?, ?)'
    );
    setorIds.forEach((setorId, indice) => inserir.run(tipoProcessoId, Number(setorId), indice + 1));
  });
  return doTipo(tipoProcessoId);
}

/** Move um setor uma posição para cima (-1) ou para baixo (+1). */
function mover(tipoProcessoId, setorId, direcao) {
  const atual = doTipo(tipoProcessoId).map((s) => s.id);
  const de = atual.indexOf(Number(setorId));
  if (de === -1) return doTipo(tipoProcessoId);
  const para = de + (direcao < 0 ? -1 : 1);
  if (para < 0 || para >= atual.length) return doTipo(tipoProcessoId);
  atual.splice(para, 0, atual.splice(de, 1)[0]);
  return definir(tipoProcessoId, atual);
}

/** Remove a ordem personalizada: o tipo volta a seguir a ordem geral. */
function limpar(tipoProcessoId) {
  db.get().prepare('DELETE FROM ordem_setores_tipo WHERE tipo_processo_id = ?').run(tipoProcessoId);
}

/** Tipos que possuem ordem personalizada (para sinalizar na listagem). */
function tiposComOrdemPropria() {
  return db
    .get()
    .prepare('SELECT DISTINCT tipo_processo_id FROM ordem_setores_tipo')
    .all()
    .map((r) => r.tipo_processo_id);
}

module.exports = { posicaoSQL, joinSQL, doTipo, definir, mover, limpar, tiposComOrdemPropria };
