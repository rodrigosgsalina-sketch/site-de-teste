'use strict';

/**
 * Subtipos de processo.
 *
 * O tipo diz o que é ("Alteração Contratual"); o subtipo diz qual — "Mudança
 * de endereço", "Entrada de sócio", "Alteração de capital". Na abertura, o
 * campo aparece assim que o tipo é escolhido e mostra só os subtipos daquele
 * tipo.
 *
 * O subtipo é **opcional**: um tipo sem subtipos cadastrados abre processo
 * normalmente, como sempre abriu.
 */

const db = require('../db');
const { ErroValidacao } = require('./checklist');

/** Todos os subtipos, com o nome do tipo — para as telas de administração. */
function listar() {
  return db
    .get()
    .prepare(
      `SELECT s.*, t.nome AS tipo_processo, t.ativo AS tipo_ativo,
              (SELECT COUNT(*) FROM processos p WHERE p.subtipo_processo_id = s.id) AS processos
         FROM subtipos_processo s
         JOIN tipos_processo t ON t.id = s.tipo_processo_id
        ORDER BY t.ordem, t.nome, s.ordem, s.nome`
    )
    .all();
}

/** Subtipos ativos de um tipo — o que a abertura de processo oferece. */
function doTipo(tipoId, { somenteAtivos = true } = {}) {
  return db
    .get()
    .prepare(
      `SELECT id, tipo_processo_id, nome, ativo, ordem
         FROM subtipos_processo
        WHERE tipo_processo_id = ? ${somenteAtivos ? 'AND ativo = 1' : ''}
        ORDER BY ordem, nome`
    )
    .all(Number(tipoId));
}

/**
 * Subtipos ativos agrupados por tipo, prontos para a tela de abertura filtrar
 * sem ir ao servidor a cada troca de tipo. São poucas linhas — bem menos do
 * que uma consulta por clique custaria.
 */
function ativosPorTipo() {
  const linhas = db
    .get()
    .prepare(
      `SELECT id, tipo_processo_id, nome
         FROM subtipos_processo
        WHERE ativo = 1
        ORDER BY ordem, nome`
    )
    .all();

  const mapa = {};
  for (const linha of linhas) {
    const chave = String(linha.tipo_processo_id);
    if (!mapa[chave]) mapa[chave] = [];
    mapa[chave].push({ id: linha.id, nome: linha.nome });
  }
  return mapa;
}

function obter(id) {
  return db.get().prepare('SELECT * FROM subtipos_processo WHERE id = ?').get(Number(id));
}

function criar({ tipo_processo_id: tipoId, nome }) {
  const conn = db.get();
  const limpo = String(nome || '').trim();
  if (!limpo) throw new ErroValidacao('Informe o nome do subtipo.');

  const tipo = conn.prepare('SELECT id, nome FROM tipos_processo WHERE id = ?').get(Number(tipoId));
  if (!tipo) throw new ErroValidacao('Escolha o tipo de processo a que este subtipo pertence.');

  // O nome é único dentro do tipo: "Mudança de endereço" pode existir em
  // "Alteração Contratual" e em "Abertura de Filial" ao mesmo tempo.
  const repetido = conn
    .prepare('SELECT 1 FROM subtipos_processo WHERE tipo_processo_id = ? AND nome = ? COLLATE NOCASE')
    .get(tipo.id, limpo);
  if (repetido) throw new ErroValidacao(`"${tipo.nome}" já tem um subtipo chamado "${limpo}".`);

  const ordem = conn
    .prepare('SELECT COALESCE(MAX(ordem), 0) + 1 AS o FROM subtipos_processo WHERE tipo_processo_id = ?')
    .get(tipo.id).o;

  const info = conn
    .prepare('INSERT INTO subtipos_processo (tipo_processo_id, nome, ativo, ordem) VALUES (?, ?, 1, ?)')
    .run(tipo.id, limpo, ordem);

  return { id: Number(info.lastInsertRowid), tipo, nome: limpo };
}

function atualizar(id, { nome, ativo }) {
  const conn = db.get();
  const atual = obter(id);
  if (!atual) throw new ErroValidacao('Subtipo não encontrado.');

  const limpo = String(nome || '').trim();
  if (!limpo) throw new ErroValidacao('Informe o nome do subtipo.');

  const repetido = conn
    .prepare('SELECT 1 FROM subtipos_processo WHERE tipo_processo_id = ? AND nome = ? COLLATE NOCASE AND id <> ?')
    .get(atual.tipo_processo_id, limpo, atual.id);
  if (repetido) throw new ErroValidacao(`Este tipo já tem outro subtipo chamado "${limpo}".`);

  conn.prepare('UPDATE subtipos_processo SET nome = ?, ativo = ? WHERE id = ?').run(limpo, ativo ? 1 : 0, atual.id);
  return obter(atual.id);
}

/** Quantos processos já usam este subtipo. */
function emUso(id) {
  return db.get().prepare('SELECT COUNT(*) AS total FROM processos WHERE subtipo_processo_id = ?').get(Number(id))
    .total;
}

/**
 * Remove o subtipo.
 *
 * Se algum processo já foi aberto com ele, a exclusão é recusada: apagar
 * deixaria esses processos sem o detalhe que alguém registrou, e sem como
 * recuperar. O caminho nesse caso é desmarcar "Ativo" — o subtipo some da
 * abertura e continua legível em quem já o usa.
 */
function remover(id) {
  const atual = obter(id);
  if (!atual) throw new ErroValidacao('Subtipo não encontrado.');

  const usos = emUso(atual.id);
  if (usos) {
    throw new ErroValidacao(
      `"${atual.nome}" está em ${usos} processo(s) e não pode ser excluído. ` +
        'Desmarque "Ativo" para tirá-lo da abertura de novos processos sem perder o histórico.'
    );
  }

  db.get().prepare('DELETE FROM subtipos_processo WHERE id = ?').run(atual.id);
  return atual;
}

/**
 * Valida o subtipo escolhido no formulário do processo.
 * Devolve o id, ou null quando nenhum foi escolhido.
 */
function paraProcesso(tipoId, subtipoId) {
  if (!subtipoId) return null;
  const subtipo = obter(subtipoId);
  if (!subtipo) throw new ErroValidacao('Subtipo não encontrado. Atualize a página e escolha novamente.');
  if (Number(subtipo.tipo_processo_id) !== Number(tipoId)) {
    throw new ErroValidacao(`O subtipo "${subtipo.nome}" não pertence ao tipo de processo escolhido.`);
  }
  return subtipo.id;
}

module.exports = {
  listar,
  doTipo,
  ativosPorTipo,
  obter,
  criar,
  atualizar,
  remover,
  emUso,
  paraProcesso,
};
