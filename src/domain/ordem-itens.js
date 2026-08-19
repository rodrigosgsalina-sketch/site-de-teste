'use strict';

/**
 * Ordem dos itens do checklist modelo dentro de cada setor.
 *
 * A ordem de atendimento (`ordem-setores.js`) decide quem responde primeiro;
 * esta decide em que sequência os itens de um setor aparecem para ele. Juntas,
 * as duas definem o checklist inteiro do processo — é a mesma sequência que
 * `checklist.modeloDoProcesso` monta.
 *
 * **Um detalhe que a tela precisa dizer em voz alta:** a posição mora na
 * própria linha do modelo (`checklist_modelo.ordem`). Para o item de um tipo
 * isso é exatamente o esperado. Já o item aplicado a *todos os processos*
 * existe uma vez só e aparece em todo tipo — mover ele aqui move em todos os
 * tipos. É o preço de não duplicar o item, e a tela avisa com uma etiqueta.
 */

const db = require('../db');
const ordemSetores = require('./ordem-setores');

/**
 * Itens do modelo que compõem um tipo de processo — os do tipo, os dos
 * subtipos dele e os aplicados a todos —, agrupados por setor e já na ordem em
 * que vão aparecer no checklist.
 */
function doTipo(tipoProcessoId) {
  const linhas = db
    .get()
    .prepare(
      `SELECT m.id, m.item, m.obrigatorio, m.ativo, m.ordem, m.tipo_processo_id, m.subtipo_processo_id,
              s.id AS setor_id, s.nome AS setor, s.auxiliar,
              sub.nome AS subtipo,
              ${ordemSetores.posicaoSQL()} AS setor_ordem
         FROM checklist_modelo m
         JOIN setores s ON s.id = m.setor_id
         LEFT JOIN subtipos_processo sub ON sub.id = m.subtipo_processo_id
         ${ordemSetores.joinSQL('?', 's.id')}
        WHERE (m.tipo_processo_id = ? OR m.tipo_processo_id IS NULL)
        ORDER BY setor_ordem, m.ordem, m.id`
    )
    .all(tipoProcessoId, tipoProcessoId);

  const porSetor = [];
  const indice = new Map();
  for (const linha of linhas) {
    if (!indice.has(linha.setor_id)) {
      const grupo = { setor_id: linha.setor_id, setor: linha.setor, auxiliar: linha.auxiliar, itens: [] };
      indice.set(linha.setor_id, grupo);
      porSetor.push(grupo);
    }
    indice.get(linha.setor_id).itens.push(linha);
  }
  return porSetor;
}

/** IDs dos itens de um setor dentro de um tipo, na ordem atual. */
function idsDoSetor(tipoProcessoId, setorId) {
  const grupo = doTipo(tipoProcessoId).find((g) => g.setor_id === Number(setorId));
  return grupo ? grupo.itens.map((i) => i.id) : [];
}

/**
 * Grava a ordem de um setor inteiro de uma vez — é o que a tela envia depois
 * de arrastar. A numeração é reescrita de 1 a N, o que também acerta as
 * sequências antigas, que nasceram em escopos separados e se sobrepunham.
 */
function definir(tipoProcessoId, setorId, itemIds) {
  const conn = db.get();
  db.tx(() => {
    const gravar = conn.prepare('UPDATE checklist_modelo SET ordem = ? WHERE id = ?');
    itemIds.forEach((id, indice) => gravar.run(indice + 1, Number(id)));
  });
  return idsDoSetor(tipoProcessoId, setorId);
}

module.exports = { doTipo, idsDoSetor, definir };
