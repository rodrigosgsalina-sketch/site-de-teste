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
              (SELECT COUNT(*) FROM processos_subtipos ps WHERE ps.subtipo_id = s.id) AS processos
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
  return db
    .get()
    .prepare('SELECT COUNT(*) AS total FROM processos_subtipos WHERE subtipo_id = ?')
    .get(Number(id)).total;
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
 * Valida os subtipos escolhidos no formulário do processo.
 *
 * O campo do formulário pode chegar como um valor só, como lista (várias
 * caixas marcadas com o mesmo nome) ou vazio. Devolve sempre uma lista de ids,
 * sem repetição e na ordem de cadastro.
 */
function paraProcesso(tipoId, escolhidos) {
  const bruto = escolhidos === undefined || escolhidos === null ? [] : [].concat(escolhidos);
  const ids = [...new Set(bruto.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return [];

  const validos = [];
  for (const id of ids) {
    const subtipo = obter(id);
    if (!subtipo) throw new ErroValidacao('Subtipo não encontrado. Atualize a página e escolha novamente.');
    if (Number(subtipo.tipo_processo_id) !== Number(tipoId)) {
      throw new ErroValidacao(`O subtipo "${subtipo.nome}" não pertence ao tipo de processo escolhido.`);
    }
    validos.push(subtipo);
  }

  // A ordem de cadastro deixa o checklist estável, não a ordem de clique.
  validos.sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome, 'pt-BR'));
  return validos.map((s) => s.id);
}

/** Subtipos de um processo, na ordem de cadastro. */
function doProcesso(processoId) {
  return db
    .get()
    .prepare(
      `SELECT s.*
         FROM processos_subtipos ps
         JOIN subtipos_processo s ON s.id = ps.subtipo_id
        WHERE ps.processo_id = ?
        ORDER BY s.ordem, s.nome`
    )
    .all(Number(processoId));
}

/** Regrava a lista de subtipos do processo. Devolve o que mudou. */
function definirDoProcesso(processoId, subtipoIds) {
  const conn = db.get();
  const antes = doProcesso(processoId);
  const antesIds = new Set(antes.map((s) => s.id));
  const depoisIds = new Set(subtipoIds.map(Number));

  conn.prepare('DELETE FROM processos_subtipos WHERE processo_id = ?').run(Number(processoId));
  const inserir = conn.prepare('INSERT INTO processos_subtipos (processo_id, subtipo_id) VALUES (?, ?)');
  for (const id of subtipoIds) inserir.run(Number(processoId), Number(id));

  const depois = doProcesso(processoId);
  return {
    antes,
    depois,
    entraram: depois.filter((s) => !antesIds.has(s.id)),
    sairam: antes.filter((s) => !depoisIds.has(s.id)),
    mudou: antes.length !== depois.length || antes.some((s) => !depoisIds.has(s.id)),
  };
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
  doProcesso,
  definirDoProcesso,
};
