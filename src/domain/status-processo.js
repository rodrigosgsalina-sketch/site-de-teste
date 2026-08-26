'use strict';

/**
 * As situações (status) do processo, agora cadastráveis pelo escritório.
 *
 * Cada situação carrega quatro decisões, e é bom saber o que cada uma faz
 * antes de mexer:
 *
 *  - **cor** — a etiqueta que aparece na lista e na tela do processo. A escolha
 *    é entre as cores da identidade visual, e não um código de cor livre: uma
 *    etiqueta rosa-choque sobre fundo branco é escolhível, legível não é.
 *  - **encerra o processo** (`final`) — tira o processo de circulação. Só se
 *    chega nele pelas ações de concluir e cancelar, nunca pela lista de
 *    situações da tela do processo.
 *  - **espera externa** (`espera`) — pode ser escolhida na mão e resiste ao
 *    recálculo enquanto houver item pendente. É o caso de "Aguardando Cliente".
 *  - **setor de análise** (`setor_id`) — o motor aplica esta situação sozinho
 *    enquanto aquele setor tiver item pendente. Antes era uma lista de quatro
 *    nomes escrita no código; agora um setor novo ganha a sua situação pela
 *    tela, sem release.
 *  - **mantém a escolha manual** (`mantem_manual`) — a situação escolhida na
 *    mão sobrevive ao checklist completo. Sem isso, "Liberado" tomaria o lugar
 *    dela no recálculo seguinte.
 *
 * O que **não** é editável são as situações de `sistema`: o motor de status as
 * cita pelo nome, e renomear "Concluído" pararia a conclusão de processo em
 * silêncio — o mesmo tipo de armadilha que já tirou do Administrativo o direito
 * de responder um setor quando o escritório o renomeou. Cor e posição delas
 * seguem livres.
 */

const db = require('../db');
const { ErroValidacao } = require('./checklist');

/**
 * Cores possíveis para a etiqueta, com o rótulo que aparece na tela.
 *
 * São as da identidade visual (`.et-*` no CSS), e a lista é fechada de
 * propósito: assim toda situação nova já nasce legível, com contraste
 * suficiente, e o sistema continua parecendo um sistema só.
 */
const CORES = [
  { valor: 'neutro', rotulo: 'Cinza — neutro, sem urgência' },
  { valor: 'azul', rotulo: 'Azul — em andamento' },
  { valor: 'turquesa', rotulo: 'Turquesa — pronto, aguardando lançamento' },
  { valor: 'verde', rotulo: 'Verde — concluído, liberado' },
  { valor: 'amarelo', rotulo: 'Amarelo — espera, atenção' },
  { valor: 'laranja', rotulo: 'Laranja — atrasado, cobrança' },
  { valor: 'vermelho', rotulo: 'Vermelho — impedido, cancelado' },
  { valor: 'roxo', rotulo: 'Roxo — acompanhamento especial' },
];

const VALORES_DE_COR = new Set(CORES.map((c) => c.valor));

const SELECT = `
  SELECT st.*, s.nome AS setor_nome,
         (SELECT COUNT(*) FROM processos p WHERE p.status_id = st.id) AS em_uso
    FROM status_processo st
    LEFT JOIN setores s ON s.id = st.setor_id`;

/* ------------------------------------------------------------------ cache */

/**
 * Nome -> cor, guardado em memória.
 *
 * A cor da etiqueta é pedida em toda linha de toda lista de processos; ir ao
 * banco a cada uma seria uma consulta por linha. O mapa é refeito quando
 * alguma situação muda, que é o único momento em que ele pode ficar velho.
 */
let mapaDeCores = null;

function invalidarCache() {
  mapaDeCores = null;
}

function cores() {
  if (!mapaDeCores) {
    mapaDeCores = new Map(
      db.get().prepare('SELECT nome, cor FROM status_processo').all().map((s) => [s.nome, s.cor])
    );
  }
  return mapaDeCores;
}

/**
 * Classe CSS da etiqueta de um status, pelo nome.
 *
 * Antes a cor era adivinhada pelo texto ("começa com Aguardando? amarelo"),
 * o que deixava toda situação nova cinza e sem jeito de mudar. Agora vem do
 * cadastro; a adivinhação sobrou como rede de segurança para o nome que, por
 * algum motivo, não esteja na tabela.
 */
function classeDaEtiqueta(nome) {
  const cor = cores().get(nome);
  if (cor && VALORES_DE_COR.has(cor)) return `et-${cor}`;
  const texto = String(nome || '');
  if (texto === 'Concluído' || texto === 'Liberado') return 'et-verde';
  if (texto === 'Impedido' || texto === 'Cancelado') return 'et-vermelho';
  if (texto.startsWith('Aguardando')) return 'et-amarelo';
  if (texto.startsWith('Em Análise')) return 'et-azul';
  return 'et-neutro';
}

/* ------------------------------------------------------------------ leitura */

function listar() {
  return db.get().prepare(`${SELECT} ORDER BY st.ordem, st.id`).all();
}

function obter(id) {
  return db.get().prepare(`${SELECT} WHERE st.id = ?`).get(Number(id) || 0) || null;
}

function porNome(nome) {
  return db.get().prepare(`${SELECT} WHERE st.nome = ?`).get(String(nome || '')) || null;
}

/** Situação de análise de um setor, quando houver. */
function doSetor(setorId) {
  if (!setorId) return null;
  return (
    db
      .get()
      .prepare('SELECT nome FROM status_processo WHERE setor_id = ? ORDER BY ordem, id LIMIT 1')
      .get(Number(setorId)) || null
  );
}

/* --------------------------------------------------------------- validação */

function normalizar(dados, { atual = null } = {}) {
  const nome = String(dados.nome || '').trim().slice(0, 120);
  if (!nome) throw new ErroValidacao('Informe o nome da situação.');

  const repetido = db
    .get()
    .prepare('SELECT id FROM status_processo WHERE nome = ? AND id <> ?')
    .get(nome, atual ? atual.id : 0);
  if (repetido) throw new ErroValidacao(`Já existe uma situação chamada "${nome}".`);

  const cor = String(dados.cor || 'neutro');
  if (!VALORES_DE_COR.has(cor)) throw new ErroValidacao('Escolha uma das cores disponíveis.');

  const final = dados.final ? 1 : 0;
  const espera = dados.espera ? 1 : 0;
  const mantemManual = dados.mantem_manual ? 1 : 0;

  if (final && (espera || mantemManual)) {
    throw new ErroValidacao(
      'Uma situação que encerra o processo não é espera nem escolha manual: chega-se a ela pelas ' +
        'ações de concluir e cancelar.'
    );
  }

  let setorId = dados.setor_id ? Number(dados.setor_id) : null;
  if (setorId) {
    const setor = db.get().prepare('SELECT id, nome FROM setores WHERE id = ?').get(setorId);
    if (!setor) throw new ErroValidacao('Setor de análise inválido.');
    if (final) throw new ErroValidacao('Situação de análise de setor não pode encerrar o processo.');
    const jaTem = db
      .get()
      .prepare('SELECT nome FROM status_processo WHERE setor_id = ? AND id <> ?')
      .get(setorId, atual ? atual.id : 0);
    if (jaTem) {
      throw new ErroValidacao(
        `O setor ${setor.nome} já tem a situação de análise "${jaTem.nome}". Solte-a antes de ligar outra.`
      );
    }
  } else {
    setorId = null;
  }

  return { nome, cor, final, espera, mantem_manual: mantemManual, setor_id: setorId };
}

/* ---------------------------------------------------------------- escrita */

function criar(dados) {
  const campos = normalizar(dados);
  const ordem = db.get().prepare('SELECT COALESCE(MAX(ordem), 0) + 1 AS o FROM status_processo').get().o;
  const info = db
    .get()
    .prepare(
      `INSERT INTO status_processo (nome, ordem, final, espera, cor, sistema, setor_id, mantem_manual)
       VALUES (@nome, @ordem, @final, @espera, @cor, 0, @setor_id, @mantem_manual)`
    )
    .run({ ...campos, ordem });
  invalidarCache();
  return obter(Number(info.lastInsertRowid));
}

function atualizar(id, dados) {
  const atual = obter(id);
  if (!atual) throw new ErroValidacao('Situação não encontrada.');

  // Nas situações do sistema, só cor e posição são livres: o resto é o que o
  // motor de status espera encontrar.
  const entrada = atual.sistema
    ? {
        ...dados,
        nome: atual.nome,
        final: atual.final,
        espera: atual.espera,
        mantem_manual: atual.mantem_manual,
      }
    : dados;

  const campos = normalizar(entrada, { atual });
  db.get()
    .prepare(
      `UPDATE status_processo
          SET nome = @nome, final = @final, espera = @espera, cor = @cor,
              setor_id = @setor_id, mantem_manual = @mantem_manual
        WHERE id = @id`
    )
    .run({ ...campos, id: atual.id });
  invalidarCache();
  return obter(atual.id);
}

function remover(id) {
  const atual = obter(id);
  if (!atual) throw new ErroValidacao('Situação não encontrada.');
  if (atual.sistema) {
    throw new ErroValidacao(
      `"${atual.nome}" faz parte do funcionamento do sistema e não pode ser excluída. ` +
        'A cor e a posição dela continuam livres.'
    );
  }
  if (atual.em_uso) {
    throw new ErroValidacao(
      `${atual.em_uso} processo(s) estão nesta situação. Mova-os para outra antes de excluí-la.`
    );
  }
  db.get().prepare('DELETE FROM status_processo WHERE id = ?').run(atual.id);
  invalidarCache();
  return atual;
}

/** Grava a ordem de exibição a partir da lista de ids. */
function definirOrdem(ids) {
  const lista = (Array.isArray(ids) ? ids : String(ids || '').split(','))
    .map((n) => Number(String(n).trim()))
    .filter(Boolean);
  if (!lista.length) return 0;

  const atualizar1 = db.get().prepare('UPDATE status_processo SET ordem = ? WHERE id = ?');
  db.tx(() => lista.forEach((id, i) => atualizar1.run(i + 1, id)));
  invalidarCache();
  return lista.length;
}

module.exports = {
  CORES,
  VALORES_DE_COR,
  classeDaEtiqueta,
  invalidarCache,
  listar,
  obter,
  porNome,
  doSetor,
  criar,
  atualizar,
  remover,
  definirOrdem,
};
