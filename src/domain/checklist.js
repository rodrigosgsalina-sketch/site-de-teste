'use strict';

const db = require('../db');
const avisos = require('./avisos');
const ordemSetores = require('./ordem-setores');
const parametros = require('./parametros');
const { agoraISO, somarHoras } = require('../lib/datas');

const STATUS_ITEM = { PENDENTE: 'Pendente', CONCLUIDO: 'Concluído', IMPEDIDO: 'Impedido' };

/**
 * Próximo número da sequência CHK-0001.
 *
 * Sai do MAIOR número já usado, não da contagem de linhas: contar volta atrás
 * quando um processo é excluído, e os itens seguintes tentariam nascer com um
 * código que ainda existe — o banco recusa, e a abertura do próximo processo
 * falharia. O maior número só cresce, então o código nunca se repete.
 */
function proximoCodigoItem(conn) {
  const row = conn
    .prepare("SELECT MAX(CAST(substr(codigo, 5) AS INTEGER)) AS maior FROM checklist WHERE codigo LIKE 'CHK-%'")
    .get();
  return (row && row.maior ? row.maior : 0) + 1;
}

/**
 * Identidade de um item de checklist, para saber quando dois são o MESMO.
 *
 * Um processo pode ter vários subtipos, e é comum que mais de um peça a mesma
 * coisa — "Emitir certidão negativa federal" aparece tanto em "Entrada de
 * sócio" quanto em "Alteração de capital". Sem juntar, o checklist nasceria
 * com o item repetido e alguém responderia duas vezes o mesmo trabalho.
 *
 * A chave é **setor + texto do item**, não só o texto: a mesma frase em setores
 * diferentes é tarefa de gente diferente. "Conferir documentação" no Fiscal e
 * no Contábil são duas conferências, e as duas precisam acontecer.
 *
 * O texto é comparado sem acento, sem caixa, sem espaço sobrando e sem
 * pontuação no fim — "Emitir certidão negativa." e "emitir certidao negativa"
 * são a mesma coisa escrita por duas pessoas.
 */
function chaveDoItem(setorId, item) {
  const texto = String(item || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // tira o acento, deixando a letra
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    // A pontuação sai DEPOIS de aparar os espaços: "federal.  " termina em
    // espaço, e a limpeza feita na ordem contrária não encontrava o ponto.
    .replace(/[.,;:!?]+$/g, '')
    .trim();
  // O separador não pode aparecer no texto, senão setor 1 + "2 x" colidiria
  // com setor 12 + "x".
  return `${setorId}\u0000${texto}`;
}

/**
 * Itens do modelo que valem para um processo: os de "Todos" (sem tipo), os do
 * tipo escolhido e os dos subtipos escolhidos — já sem repetição.
 *
 * Quando o mesmo item chega por caminhos diferentes, vence o mais exigente:
 * se um deles é obrigatório, o item entra como obrigatório. A posição é a da
 * primeira aparição, para o checklist não mudar de ordem conforme os subtipos.
 */
function modeloDoProcesso(tipoProcessoId, subtipoIds = []) {
  const conn = db.get();
  const ids = subtipoIds.map(Number).filter(Boolean);
  const marcas = ids.map(() => '?').join(', ');

  const linhas = conn
    .prepare(
      `SELECT m.id, m.setor_id, m.item, m.obrigatorio, m.ordem, m.subtipo_processo_id,
              s.nome AS setor, sub.nome AS subtipo,
              ${ordemSetores.posicaoSQL()} AS setor_ordem
         FROM checklist_modelo m
         JOIN setores s ON s.id = m.setor_id
         LEFT JOIN subtipos_processo sub ON sub.id = m.subtipo_processo_id
         ${ordemSetores.joinSQL('?', 's.id')}
        WHERE m.ativo = 1
          AND (m.tipo_processo_id = ? OR m.tipo_processo_id IS NULL)
          AND (m.subtipo_processo_id IS NULL${ids.length ? ` OR m.subtipo_processo_id IN (${marcas})` : ''})
        ORDER BY setor_ordem, (m.subtipo_processo_id IS NOT NULL), m.ordem, m.id`
    )
    .all(tipoProcessoId, tipoProcessoId, ...ids);

  const porChave = new Map();
  for (const linha of linhas) {
    const chave = chaveDoItem(linha.setor_id, linha.item);
    const jaTem = porChave.get(chave);
    if (!jaTem) {
      porChave.set(chave, { ...linha, chave, origens: [linha.subtipo || 'tipo'] });
      continue;
    }
    // Repetido: guarda de onde mais veio e sobe para obrigatório se algum for.
    jaTem.origens.push(linha.subtipo || 'tipo');
    if (linha.obrigatorio) jaTem.obrigatorio = 1;
  }

  return [...porChave.values()];
}

/**
 * Clona o CHECKLIST_MODELO para um processo recém-criado.
 * Deve rodar dentro da transação de criação do processo.
 */
function gerarParaProcesso(processoId, tipoProcessoId, aberturaISO = agoraISO(), subtipoIds = []) {
  const conn = db.get();
  const modelos = modeloDoProcesso(tipoProcessoId, subtipoIds);

  let seq = proximoCodigoItem(conn);
  const criados = [];
  modelos.forEach((m, indice) => {
    criados.push(inserirItem(conn, processoId, m, aberturaISO, seq++, indice + 1));
  });
  return criados;
}

/** Grava um item do modelo no checklist do processo. */
function inserirItem(conn, processoId, modelo, aberturaISO, sequencia, ordem) {
  const horas = parametros.prazoHorasDoSetor(modelo.setor);
  const prazo = somarHoras(aberturaISO, horas).toISOString();
  const codigo = `CHK-${String(sequencia).padStart(4, '0')}`;
  const info = conn
    .prepare(
      `INSERT INTO checklist
         (codigo, processo_id, setor_id, item, obrigatorio, status_item, prazo, data_criacao, ordem)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      codigo,
      processoId,
      modelo.setor_id,
      modelo.item,
      modelo.obrigatorio,
      STATUS_ITEM.PENDENTE,
      prazo,
      agoraISO(),
      ordem
    );
  return { id: info.lastInsertRowid, codigo, setor: modelo.setor, item: modelo.item };
}

/** Item ainda intocado: ninguém respondeu, comentou nem marcou impedimento. */
function intocado(item) {
  return (
    item.status_item === STATUS_ITEM.PENDENTE &&
    !item.resposta &&
    !item.possui_impedimento &&
    !item.descricao_impedimento &&
    !item.observacao &&
    !item.responsavel_id &&
    !item.conferido_por_id
  );
}

/**
 * Acerta o checklist depois de mudarem os subtipos do processo.
 *
 * Entra o que passou a valer; sai o que deixou de valer — **desde que ninguém
 * tenha mexido**. Item já respondido fica onde está: apagar destruiria
 * trabalho registrado, e quem respondeu não tem como saber que sumiu. Eles
 * ficam listados no retorno para a tela avisar.
 */
function sincronizarComSubtipos(processoId, tipoProcessoId, subtipoIds, aberturaISO = agoraISO()) {
  const conn = db.get();
  const esperado = modeloDoProcesso(tipoProcessoId, subtipoIds);
  const atuais = conn.prepare('SELECT * FROM checklist WHERE processo_id = ?').all(processoId);

  const chavesAtuais = new Map();
  for (const item of atuais) chavesAtuais.set(chaveDoItem(item.setor_id, item.item), item);
  const chavesEsperadas = new Set(esperado.map((m) => m.chave));

  const adicionados = [];
  const removidos = [];
  const mantidos = [];

  let seq = proximoCodigoItem(conn);
  const maiorOrdem = atuais.reduce((maior, i) => Math.max(maior, i.ordem || 0), 0);
  let ordem = maiorOrdem;

  for (const modelo of esperado) {
    if (chavesAtuais.has(modelo.chave)) continue;
    ordem += 1;
    adicionados.push(inserirItem(conn, processoId, modelo, aberturaISO, seq++, ordem));
  }

  const apagar = conn.prepare('DELETE FROM checklist WHERE id = ?');
  for (const [chave, item] of chavesAtuais) {
    if (chavesEsperadas.has(chave)) continue;
    if (intocado(item)) {
      apagar.run(item.id);
      removidos.push({ codigo: item.codigo, item: item.item });
    } else {
      mantidos.push({ codigo: item.codigo, item: item.item, status: item.status_item });
    }
  }

  return { adicionados, removidos, mantidos };
}

const SELECT_ITEM = `
  SELECT c.*, s.nome AS setor, s.auxiliar AS setor_auxiliar,
         ${ordemSetores.posicaoSQL()} AS setor_ordem,
         u.nome AS responsavel_nome, uc.nome AS conferente_nome,
         p.codigo AS processo_codigo, p.razao_social, p.data_previsao,
         t.nome AS tipo_processo
    FROM checklist c
    JOIN setores s ON s.id = c.setor_id
    JOIN processos p ON p.id = c.processo_id
    JOIN tipos_processo t ON t.id = p.tipo_processo_id
    ${ordemSetores.joinSQL('p.tipo_processo_id', 'c.setor_id')}
    LEFT JOIN usuarios u ON u.id = c.responsavel_id
    LEFT JOIN usuarios uc ON uc.id = c.conferido_por_id`;

function obterItem(id) {
  return db.get().prepare(`${SELECT_ITEM} WHERE c.id = ?`).get(id);
}

function doProcesso(processoId) {
  return db
    .get()
    .prepare(`${SELECT_ITEM} WHERE c.processo_id = ? ORDER BY setor_ordem, c.ordem, c.id`)
    .all(processoId);
}

/**
 * Um setor está **respondido** quando todo item que ele *precisa* responder já
 * tem resposta — os obrigatórios de um setor cuja aprovação é exigida.
 *
 * Duas escolhas embutidas aqui:
 *
 * - "Respondido" e não "concluído": um item impedido tem resposta, e travar o
 *   setor seguinte até o impedimento ser resolvido pararia o processo inteiro.
 *   O impedimento já aparece no status e no aviso — quem precisa agir sabe.
 * - Só os obrigatórios seguram a fila. Item opcional ninguém é obrigado a
 *   responder; se ele travasse o setor seguinte, um item que existe justamente
 *   para ser dispensável emperraria o processo sem ninguém errar nada. Vale o
 *   mesmo para setores com a aprovação desligada em PARAMETROS (por exemplo
 *   EXIGIR_APROVACAO_JURIDICA = Não): se a aprovação não é exigida para
 *   concluir, também não é exigida para a fila andar.
 */
function setorRespondido(itens) {
  return itens
    .filter((i) => i.obrigatorio && parametros.aprovacaoObrigatoria(i.setor))
    .every((i) => Boolean(i.resposta));
}

/**
 * Ordem de atendimento aplicada ao processo: um setor só abre depois que o
 * anterior foi respondido.
 *
 * Devolve, por setor, se ele está liberado e — quando não está — qual setor o
 * está segurando, para a tela poder dizer o motivo em vez de só desabilitar.
 *
 * A regra vale para todo mundo, inclusive gestores. Para desligar, existe o
 * parâmetro EXIGIR_ORDEM_SETORES: é o mesmo caminho de qualquer outra regra de
 * fluxo da plataforma, e deixa a decisão registrada em vez de embutida no
 * código.
 */
function liberacaoPorSetor(processoId) {
  const exigir = parametros.bool('EXIGIR_ORDEM_SETORES', true);

  // `doProcesso` já devolve na ordem de atendimento do tipo.
  const naOrdem = [];
  const porId = new Map();
  for (const item of doProcesso(processoId)) {
    if (!porId.has(item.setor_id)) {
      const grupo = { setor_id: item.setor_id, setor: item.setor, itens: [] };
      porId.set(item.setor_id, grupo);
      naOrdem.push(grupo);
    }
    porId.get(item.setor_id).itens.push(item);
  }

  // O primeiro setor ainda sem responder segura todos os que vêm depois.
  let segurando = null;
  for (const grupo of naOrdem) {
    grupo.respondido = setorRespondido(grupo.itens);
    grupo.liberado = !exigir || segurando === null;
    grupo.aguardando = grupo.liberado ? null : segurando;
    if (segurando === null && !grupo.respondido) segurando = grupo.setor;
  }

  return porId;
}

/** Situação do setor de um item: liberado para responder, e por quem espera. */
function setorLiberado(processoId, setorId) {
  return liberacaoPorSetor(processoId).get(Number(setorId)) || { liberado: true, aguardando: null };
}

/** Agrupa os itens por setor, com o progresso de cada grupo. */
function agrupadoPorSetor(processoId) {
  const itens = doProcesso(processoId);
  const liberacao = liberacaoPorSetor(processoId);
  const grupos = new Map();
  for (const item of itens) {
    if (!grupos.has(item.setor)) {
      grupos.set(item.setor, {
        setor: item.setor,
        setor_id: item.setor_id,
        auxiliar: item.setor_auxiliar,
        itens: [],
        total: 0,
        concluidos: 0,
        impedidos: 0,
        pendentes: 0,
        obrigatorios_pendentes: 0,
      });
    }
    const g = grupos.get(item.setor);
    g.itens.push(item);
    g.total += 1;
    if (item.status_item === STATUS_ITEM.CONCLUIDO) g.concluidos += 1;
    if (item.status_item === STATUS_ITEM.IMPEDIDO) g.impedidos += 1;
    if (item.status_item === STATUS_ITEM.PENDENTE) g.pendentes += 1;
    if (item.obrigatorio && item.status_item !== STATUS_ITEM.CONCLUIDO) g.obrigatorios_pendentes += 1;
  }
  return [...grupos.values()].map((g) => {
    const situacao = liberacao.get(g.setor_id) || { liberado: true, aguardando: null };
    return {
      ...g,
      percentual: g.total ? Math.round((g.concluidos / g.total) * 100) : 0,
      liberado: situacao.liberado,
      aguardando: situacao.aguardando,
      respondido: setorRespondido(g.itens),
    };
  });
}

function progresso(processoId) {
  const row = db
    .get()
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status_item = 'Concluído' THEN 1 ELSE 0 END) AS concluidos,
              SUM(CASE WHEN status_item = 'Impedido'  THEN 1 ELSE 0 END) AS impedidos,
              SUM(CASE WHEN status_item = 'Pendente'  THEN 1 ELSE 0 END) AS pendentes,
              SUM(CASE WHEN obrigatorio = 1 AND status_item <> 'Concluído' THEN 1 ELSE 0 END) AS obrigatorios_pendentes
         FROM checklist WHERE processo_id = ?`
    )
    .get(processoId);
  const total = row.total || 0;
  return {
    total,
    concluidos: row.concluidos || 0,
    impedidos: row.impedidos || 0,
    pendentes: row.pendentes || 0,
    obrigatorios_pendentes: row.obrigatorios_pendentes || 0,
    percentual: total ? Math.round(((row.concluidos || 0) / total) * 100) : 0,
  };
}

class ErroValidacao extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroValidacao';
    this.validacao = true;
  }
}

/**
 * Grava a resposta de um item de checklist.
 * Regras:
 *  - impedimento exige descrição (EXIGIR_OBSERVACAO_IMPEDIMENTO);
 *  - com EXIGIR_DUPLA_CONFERENCIA ligado o item fica pendente de conferência
 *    por um segundo colaborador antes de contar como concluído.
 */
function responder(itemId, dados, usuario) {
  const conn = db.get();
  const item = obterItem(itemId);
  if (!item) throw new ErroValidacao('Item de checklist não encontrado.');

  // A ordem dos setores vale aqui, e não só na tela: quem montar a requisição
  // por fora do formulário esbarra na mesma regra.
  const liberacao = setorLiberado(item.processo_id, item.setor_id);
  if (!liberacao.liberado) {
    throw new ErroValidacao(
      `O setor ${item.setor} ainda não abriu: falta o ${liberacao.aguardando} responder os itens dele. ` +
        'O checklist é atendido na ordem definida para este tipo de processo.'
    );
  }

  const resposta = dados.resposta || null;
  const impedimento = dados.possui_impedimento === true || dados.possui_impedimento === 'Sim' || dados.possui_impedimento === '1';
  const descricao = (dados.descricao_impedimento || '').trim();
  const observacao = (dados.observacao || '').trim();

  if (!resposta) throw new ErroValidacao('Informe a resposta (Sim, Não ou N/A).');
  if (!['Sim', 'Não', 'N/A'].includes(resposta)) throw new ErroValidacao('Resposta inválida.');
  if (impedimento && parametros.bool('EXIGIR_OBSERVACAO_IMPEDIMENTO', true) && !descricao) {
    throw new ErroValidacao('Descreva o impedimento — a descrição é obrigatória.');
  }

  const dupla = parametros.bool('EXIGIR_DUPLA_CONFERENCIA', false);
  let statusItem;
  if (impedimento) statusItem = STATUS_ITEM.IMPEDIDO;
  else if (dupla) statusItem = STATUS_ITEM.PENDENTE; // aguardando conferência
  else statusItem = STATUS_ITEM.CONCLUIDO;

  conn
    .prepare(
      `UPDATE checklist
          SET resposta = ?, possui_impedimento = ?, descricao_impedimento = ?,
              responsavel_id = ?, data_resposta = ?, status_item = ?,
              observacao = ?, data_atualizacao = ?,
              conferido_por_id = NULL, data_conferencia = NULL
        WHERE id = ?`
    )
    .run(
      resposta,
      impedimento ? 1 : 0,
      impedimento ? descricao : null,
      usuario ? usuario.id : null,
      agoraISO(),
      statusItem,
      observacao || null,
      agoraISO(),
      itemId
    );

  const atualizado = { ...obterItem(itemId), aguardando_conferencia: dupla && !impedimento };

  // Impedimento gera aviso interno para todos os usuários.
  if (statusItem === STATUS_ITEM.IMPEDIDO) {
    const processo = db
      .get()
      .prepare(
        `SELECT p.id, p.codigo, p.razao_social, t.nome AS tipo_processo
           FROM processos p JOIN tipos_processo t ON t.id = p.tipo_processo_id
          WHERE p.id = ?`
      )
      .get(item.processo_id);
    if (processo) avisos.processoImpedido(processo, atualizado, usuario);
  }

  return atualizado;
}

/** Segunda conferência (EXIGIR_DUPLA_CONFERENCIA). */
function conferir(itemId, usuario) {
  const item = obterItem(itemId);
  if (!item) throw new ErroValidacao('Item de checklist não encontrado.');
  if (!item.resposta) throw new ErroValidacao('O item ainda não foi respondido.');
  if (item.status_item === STATUS_ITEM.IMPEDIDO) throw new ErroValidacao('Item impedido não pode ser conferido.');
  if (item.responsavel_id && usuario && item.responsavel_id === usuario.id) {
    throw new ErroValidacao('A conferência deve ser feita por um colaborador diferente de quem respondeu.');
  }
  db.get()
    .prepare(
      `UPDATE checklist
          SET status_item = ?, conferido_por_id = ?, data_conferencia = ?, data_atualizacao = ?
        WHERE id = ?`
    )
    .run(STATUS_ITEM.CONCLUIDO, usuario ? usuario.id : null, agoraISO(), agoraISO(), itemId);
  return obterItem(itemId);
}

/** Reabre um item já respondido (volta para Pendente). */
function reabrir(itemId) {
  db.get()
    .prepare(
      `UPDATE checklist
          SET status_item = 'Pendente', resposta = NULL, possui_impedimento = 0,
              descricao_impedimento = NULL, conferido_por_id = NULL, data_conferencia = NULL,
              data_atualizacao = ?
        WHERE id = ?`
    )
    .run(agoraISO(), itemId);
  return obterItem(itemId);
}

/** Fila de trabalho: itens pendentes/impedidos, ordenados por urgência. */
function fila({ setorIds = null, apenasPendentes = true, limite = 200 } = {}) {
  const filtros = ["p.status_id NOT IN (SELECT id FROM status_processo WHERE final = 1)"];
  const args = [];
  if (apenasPendentes) filtros.push("c.status_item <> 'Concluído'");
  if (setorIds && setorIds.length) {
    filtros.push(`c.setor_id IN (${setorIds.map(() => '?').join(',')})`);
    args.push(...setorIds);
  }
  args.push(limite);
  const itens = db
    .get()
    .prepare(
      `${SELECT_ITEM}
        WHERE ${filtros.join(' AND ')}
        ORDER BY CASE c.status_item WHEN 'Impedido' THEN 0 ELSE 1 END,
                 c.prazo IS NULL, c.prazo, c.id
        LIMIT ?`
    )
    .all(...args);

  // Marca o que ainda não abriu: aparecer na fila um item que não pode ser
  // respondido é pior do que não aparecer — a pessoa clica, tenta e leva um
  // erro. Aqui ela já vê de quem depende.
  const porProcesso = new Map();
  return itens.map((item) => {
    if (!porProcesso.has(item.processo_id)) {
      porProcesso.set(item.processo_id, liberacaoPorSetor(item.processo_id));
    }
    const situacao = porProcesso.get(item.processo_id).get(item.setor_id);
    return {
      ...item,
      liberado: situacao ? situacao.liberado : true,
      aguardando: situacao ? situacao.aguardando : null,
    };
  });
}

/** Setores com itens ainda pendentes, na ordem de atendimento. */
function setoresPendentes(processoId) {
  return db
    .get()
    .prepare(
      `SELECT s.id, s.nome, ${ordemSetores.posicaoSQL()} AS ordem, COUNT(*) AS pendentes,
              SUM(CASE WHEN c.status_item = 'Impedido' THEN 1 ELSE 0 END) AS impedidos
         FROM checklist c
         JOIN processos p ON p.id = c.processo_id
         JOIN setores s ON s.id = c.setor_id
         ${ordemSetores.joinSQL('p.tipo_processo_id', 'c.setor_id')}
        WHERE c.processo_id = ? AND c.status_item <> 'Concluído'
        GROUP BY s.id
        ORDER BY ordem`
    )
    .all(processoId);
}

function setoresDoProcesso(processoId) {
  return db
    .get()
    .prepare(
      `SELECT s.nome, MIN(${ordemSetores.posicaoSQL()}) AS ordem
         FROM checklist c
         JOIN processos p ON p.id = c.processo_id
         JOIN setores s ON s.id = c.setor_id
         ${ordemSetores.joinSQL('p.tipo_processo_id', 'c.setor_id')}
        WHERE c.processo_id = ?
        GROUP BY s.id
        ORDER BY ordem`
    )
    .all(processoId)
    .map((r) => r.nome);
}

module.exports = {
  STATUS_ITEM,
  ErroValidacao,
  gerarParaProcesso,
  modeloDoProcesso,
  liberacaoPorSetor,
  setorLiberado,
  sincronizarComSubtipos,
  chaveDoItem,
  obterItem,
  doProcesso,
  agrupadoPorSetor,
  progresso,
  responder,
  conferir,
  reabrir,
  fila,
  setoresPendentes,
  setoresDoProcesso,
};
