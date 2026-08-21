'use strict';

/**
 * Avisos internos da plataforma.
 *
 * Diferente das notificações por e-mail (dirigidas ao setor responsável), o
 * aviso aparece dentro do sistema: em tempo real, como um cartão no canto
 * inferior direito, e depois no mural em /avisos.
 *
 * **Movimento de processo é assunto do escritório inteiro.** Abertura,
 * conclusão, impedimento, cancelamento, reabertura e alerta de prazo vão para
 * todos os usuários ativos, participem eles do checklist ou não — o mesmo
 * princípio que abriu a visualização de todos os processos: quem não é avisado
 * acaba sabendo por fora da plataforma.
 *
 * A única exceção é a **vez do setor**: "Fiscal: sua vez no PR-2026-0007" é um
 * chamado endereçado, não uma notícia. Ele continua indo só para o setor que
 * precisa agir, senão cada passagem de bastão viraria aviso para todo mundo.
 * Por isso o escopo continua existindo:
 *
 *  - `todos`   — a plataforma inteira;
 *  - `setores` — só os usuários nomeados em `avisos_destinos`.
 *
 * Cada usuário dispensa o seu aviso, sem afetar os demais.
 */

const db = require('../db');
const eventos = require('../lib/eventos');
const registro = require('../lib/registro');
const push = require('./push');

const TIPOS = {
  CONCLUIDO: 'concluido',
  IMPEDIDO: 'impedido',
  ABERTO: 'aberto',
  CANCELADO: 'cancelado',
  REABERTO: 'reaberto',
  VEZ_SETOR: 'vez_setor',
  PRAZO: 'prazo',
  DOCUMENTO: 'documento',
};

/** Rótulo curto exibido na etiqueta do aviso. */
const ROTULOS = {
  concluido: 'Concluído',
  impedido: 'Impedido',
  aberto: 'Novo processo',
  cancelado: 'Cancelado',
  reaberto: 'Reaberto',
  vez_setor: 'Sua vez',
  prazo: 'Prazo',
  documento: 'Documento',
};

/** Cor da etiqueta/cartão por tipo. */
const CORES = {
  concluido: 'verde',
  impedido: 'vermelho',
  aberto: 'azul',
  cancelado: 'vermelho',
  reaberto: 'azul',
  vez_setor: 'amarelo',
  prazo: 'amarelo',
  documento: 'neutro',
};

function rotulo(tipo) {
  return ROTULOS[tipo] || 'Aviso';
}

function cor(tipo) {
  return CORES[tipo] || 'neutro';
}

/* ------------------------------------------------------------ destinatários */

/**
 * Tipos que aparecem na faixa do topo das telas.
 *
 * Antes a faixa era "tudo que é de escopo todos" — o que dava certo enquanto
 * só conclusão e impedimento valiam para o escritório inteiro. Agora que todo
 * movimento vale, a escolha passa a ser explícita: a faixa é para o que muda o
 * rumo do processo. Abertura, prazo e vez do setor chegam pelo cartão no canto
 * e ficam no mural, sem empilhar faixa em cima de faixa.
 */
const TIPOS_DA_FAIXA = [TIPOS.CONCLUIDO, TIPOS.IMPEDIDO, TIPOS.CANCELADO];

/**
 * Usuários ativos de um setor, pelo nome — inclusive quem o tem como segundo
 * setor. Quem acumula precisa ser chamado pelos dois.
 */
function usuariosDoSetor(nomeSetor) {
  return db
    .get()
    .prepare(
      `SELECT u.id FROM usuarios u
        WHERE u.status = 'Ativo'
          AND EXISTS (
            SELECT 1 FROM setores s
             WHERE s.nome = @setor
               AND (s.id = u.setor_id
                    OR s.id IN (SELECT setor_id FROM usuarios_setores WHERE usuario_id = u.id)))`
    )
    .all({ setor: nomeSetor })
    .map((linha) => linha.id);
}

/* ------------------------------------------------------------------ publicar */

/**
 * Grava o aviso e o empurra na hora para quem está com a plataforma aberta.
 * `destinatarios` vazio/ausente = escopo 'todos'.
 */
function publicar({ tipo, titulo, mensagem, processoId, usuario, destinatarios = null }) {
  const escopo = Array.isArray(destinatarios) ? 'setores' : 'todos';

  const avisoId = db.tx(() => {
    const info = db
      .get()
      .prepare(
        `INSERT INTO avisos (tipo, escopo, titulo, mensagem, processo_id, usuario_id, usuario_nome)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        tipo,
        escopo,
        titulo,
        mensagem,
        processoId || null,
        usuario ? usuario.id : null,
        usuario ? usuario.nome : 'Sistema'
      );
    const id = Number(info.lastInsertRowid);

    if (escopo === 'setores') {
      const inserir = db
        .get()
        .prepare('INSERT INTO avisos_destinos (aviso_id, usuario_id) VALUES (?, ?) ON CONFLICT DO NOTHING');
      for (const usuarioId of new Set(destinatarios)) inserir.run(id, usuarioId);
    }
    return id;
  });

  entregarEmTempoReal(avisoId, escopo, destinatarios);
  return avisoId;
}

/** Dados que viajam para a tela (SSE) e para o Service Worker (push). */
function cargaDoAviso(aviso) {
  return {
    id: aviso.id,
    tipo: aviso.tipo,
    rotulo: rotulo(aviso.tipo),
    cor: cor(aviso.tipo),
    titulo: aviso.titulo,
    mensagem: aviso.mensagem,
    processoId: aviso.processo_id,
    processoCodigo: aviso.processo_codigo,
    url: aviso.processo_id ? `/processos/${aviso.processo_id}` : '/avisos',
    autor: aviso.usuario_nome || 'Sistema',
    criadoEm: aviso.criado_em,
  };
}

/** Todos os usuários ativos — alvo dos avisos de escopo 'todos'. */
function todosOsUsuarios() {
  return db
    .get()
    .prepare("SELECT id FROM usuarios WHERE status = 'Ativo'")
    .all()
    .map((linha) => linha.id);
}

/**
 * Empurra o aviso recém-gravado: para as abas abertas (SSE) e para os
 * navegadores inscritos em push — estes recebem mesmo com a plataforma
 * fechada. Os dois caminhos são independentes; nenhum depende da tela em que
 * o usuário está.
 */
function entregarEmTempoReal(avisoId, escopo, destinatarios) {
  const aviso = obter(avisoId);
  if (!aviso) return 0;
  const carga = cargaDoAviso(aviso);

  // 'todos' vale para a plataforma inteira, esteja quem estiver conectado.
  const alvos = escopo === 'todos' ? todosOsUsuarios() : [...new Set(destinatarios)];

  registro.notificacao('publicado', {
    aviso: aviso.id,
    tipo: aviso.tipo,
    escopo,
    destinatarios: alvos.length,
    processo: aviso.processo_codigo,
  });

  let entregues = 0;
  let semCanal = 0;
  for (const usuarioId of alvos) {
    const enviados = eventos.enviarPara(
      usuarioId,
      'aviso',
      { ...carga, naoLidos: contarNaoLidos(usuarioId) },
      aviso.id
    );
    entregues += enviados;
    if (!enviados) semCanal += 1;
  }

  registro.notificacao('entregue por SSE', {
    aviso: aviso.id,
    canais: entregues,
    usuariosSemAbaAberta: semCanal,
  });

  // Push é assíncrono e não pode segurar (nem derrubar) quem publicou o aviso.
  if (push.habilitado()) {
    push
      .enviarPara(alvos, carga)
      .catch((err) => registro.notificacao('push falhou', { aviso: aviso.id, motivo: err.message }));
  }

  return entregues;
}

/**
 * Avisos que o usuário deveria ter recebido e não recebeu — usados quando a
 * tela (re)conecta: troca de página, rede que caiu, servidor reiniciado.
 * É o que garante que nenhum evento se perca entre uma tela e outra.
 */
function pendentesDesde(usuarioId, ultimoId = 0, limite = 10) {
  return db
    .get()
    .prepare(
      `${SELECT}
        WHERE ${CONDICAO_DESTINO} AND ${CONDICAO_NAO_LIDO} AND a.id > @desde
        ORDER BY a.id
        LIMIT @limite`
    )
    .all({ usuario: usuarioId, desde: Number(ultimoId) || 0, limite })
    .map(cargaDoAviso);
}

/** Maior id de aviso que este usuário pode ver — marco inicial da tela. */
function ultimoIdVisivel(usuarioId) {
  const linha = db
    .get()
    .prepare(`SELECT MAX(a.id) AS ultimo FROM avisos a WHERE ${CONDICAO_DESTINO}`)
    .get({ usuario: usuarioId });
  return (linha && linha.ultimo) || 0;
}

/* ------------------------------------------------- avisos de cada evento */

/** Processo aberto — o escritório inteiro fica sabendo. */
function processoAberto(processo, setores, usuario) {
  const nomes = (setores || []).map((s) => s.nome || s).filter(Boolean);
  return publicar({
    tipo: TIPOS.ABERTO,
    titulo: `Processo ${processo.codigo} aberto`,
    mensagem:
      `${processo.tipo_processo} de ${processo.razao_social}` +
      `${usuario ? ` aberto por ${usuario.nome}` : ''}` +
      `${nomes.length ? `. Setores no checklist: ${nomes.join(', ')}.` : '.'}`,
    processoId: processo.id,
    usuario,
  });
}

/** Processo concluído com sucesso — vale para todo o escritório. */
function processoConcluido(processo, usuario) {
  return publicar({
    tipo: TIPOS.CONCLUIDO,
    titulo: `Processo ${processo.codigo} concluído`,
    mensagem:
      `${processo.tipo_processo} de ${processo.razao_social} foi concluído com sucesso` +
      `${usuario ? ` por ${usuario.nome}` : ''}.`,
    processoId: processo.id,
    usuario,
  });
}

/** Processo impedido — o motivo entra na mensagem. Vale para todos. */
function processoImpedido(processo, item, usuario) {
  const motivo = (item && item.descricao_impedimento) || 'motivo não informado';
  return publicar({
    tipo: TIPOS.IMPEDIDO,
    titulo: `Processo ${processo.codigo} impedido`,
    mensagem:
      `${processo.tipo_processo} de ${processo.razao_social} está impedido` +
      `${item ? ` no setor ${item.setor}` : ''}: ${motivo}`,
    processoId: processo.id,
    usuario,
  });
}

function processoCancelado(processo, motivo, usuario) {
  return publicar({
    tipo: TIPOS.CANCELADO,
    titulo: `Processo ${processo.codigo} cancelado`,
    mensagem:
      `${processo.tipo_processo} de ${processo.razao_social} foi cancelado` +
      `${usuario ? ` por ${usuario.nome}` : ''}${motivo ? `: ${motivo}` : '.'}`,
    processoId: processo.id,
    usuario,
  });
}

function processoReaberto(processo, motivo, usuario) {
  return publicar({
    tipo: TIPOS.REABERTO,
    titulo: `Processo ${processo.codigo} reaberto`,
    mensagem:
      `${processo.tipo_processo} de ${processo.razao_social} voltou a tramitar` +
      `${usuario ? ` (reaberto por ${usuario.nome})` : ''}${motivo ? `: ${motivo}` : '.'}`,
    processoId: processo.id,
    usuario,
  });
}

/** Chegou a vez de um setor responder — avisa só esse setor. */
function vezDoSetor(processo, nomeSetor) {
  const alvos = usuariosDoSetor(nomeSetor);
  if (!alvos.length) return null;
  return publicar({
    tipo: TIPOS.VEZ_SETOR,
    titulo: `${nomeSetor}: sua vez no ${processo.codigo}`,
    mensagem: `${processo.tipo_processo} de ${processo.razao_social} está aguardando o setor ${nomeSetor}.`,
    processoId: processo.id,
    usuario: null,
    destinatarios: alvos,
  });
}

/** Prazo estourado ou perto de estourar. */
function prazoDoProcesso(processo, diasRestantes) {
  const atrasado = diasRestantes < 0;
  return publicar({
    tipo: TIPOS.PRAZO,
    titulo: atrasado
      ? `Processo ${processo.codigo} atrasado`
      : `Processo ${processo.codigo} vence em ${diasRestantes} dia(s)`,
    mensagem:
      `${processo.tipo_processo} de ${processo.razao_social} — previsão ${processo.data_previsao}` +
      `${atrasado ? `, atrasado há ${Math.abs(diasRestantes)} dia(s).` : '.'}`,
    processoId: processo.id,
    usuario: null,
  });
}

/* ------------------------------------------------------------------ leitura */

const SELECT = `
  SELECT a.*, p.codigo AS processo_codigo
    FROM avisos a
    LEFT JOIN processos p ON p.id = a.processo_id`;

/** O aviso é para este usuário? ('todos' ou nomeado em avisos_destinos) */
const CONDICAO_DESTINO = `(a.escopo = 'todos'
   OR EXISTS (SELECT 1 FROM avisos_destinos d WHERE d.aviso_id = a.id AND d.usuario_id = @usuario))`;

const CONDICAO_NAO_LIDO = `NOT EXISTS
  (SELECT 1 FROM avisos_lidos l WHERE l.aviso_id = a.id AND l.usuario_id = @usuario)`;

function obter(avisoId) {
  return db.get().prepare(`${SELECT} WHERE a.id = ?`).get(avisoId);
}

/**
 * Avisos que o usuário ainda não dispensou.
 *
 * `faixa: true` devolve só o que merece a faixa no topo das telas
 * (TIPOS_DA_FAIXA); os demais chegam como cartão no canto e ficam no mural.
 */
function naoLidos(usuarioId, limite = 5, { faixa = false } = {}) {
  const args = { usuario: usuarioId, limite };
  let filtroTipo = '';
  if (faixa) {
    filtroTipo = ` AND a.tipo IN (${TIPOS_DA_FAIXA.map((_, i) => `@tipo${i}`).join(',')})`;
    TIPOS_DA_FAIXA.forEach((tipo, i) => {
      args[`tipo${i}`] = tipo;
    });
  }
  return db
    .get()
    .prepare(
      `${SELECT}
        WHERE ${CONDICAO_DESTINO} AND ${CONDICAO_NAO_LIDO}${filtroTipo}
        ORDER BY a.id DESC
        LIMIT @limite`
    )
    .all(args);
}

function contarNaoLidos(usuarioId) {
  return db
    .get()
    .prepare(
      `SELECT COUNT(*) AS total FROM avisos a
        WHERE ${CONDICAO_DESTINO} AND ${CONDICAO_NAO_LIDO}`
    )
    .get({ usuario: usuarioId }).total;
}

/** Histórico do que o usuário pode ver, marcando o que já leu. */
function listar(usuarioId, limite = 100) {
  return db
    .get()
    .prepare(
      `SELECT a.*, p.codigo AS processo_codigo,
              (SELECT l.lido_em FROM avisos_lidos l WHERE l.aviso_id = a.id AND l.usuario_id = @usuario) AS lido_em
         FROM avisos a
         LEFT JOIN processos p ON p.id = a.processo_id
        WHERE ${CONDICAO_DESTINO}
        ORDER BY a.id DESC
        LIMIT @limite`
    )
    .all({ usuario: usuarioId, limite });
}

/* --------------------------------------------------------- quem já viu */

/**
 * Público de um aviso: quem deveria vê-lo.
 *
 * Vale a mesma regra da entrega — 'todos' é o quadro de usuários ativos;
 * 'setores' são os nomeados em `avisos_destinos`. Usuários inativados depois
 * do aviso continuam contando se já tinham marcado como visto: apagá-los da
 * conta apagaria uma leitura que aconteceu.
 */
const PUBLICO_DO_AVISO = `
  SELECT u.id, u.nome, s.nome AS setor, l.lido_em
    FROM avisos a
    JOIN usuarios u ON (
           (a.escopo = 'todos' AND u.status = 'Ativo')
        OR EXISTS (SELECT 1 FROM avisos_destinos d WHERE d.aviso_id = a.id AND d.usuario_id = u.id))
    LEFT JOIN setores s ON s.id = u.setor_id
    LEFT JOIN avisos_lidos l ON l.aviso_id = a.id AND l.usuario_id = u.id
   WHERE a.id = @aviso`;

/**
 * Quem viu e quem ainda não viu um aviso.
 *
 * É o que o administrador precisa para saber se a informação circulou: não
 * basta o aviso ter sido publicado, alguém precisa tê-lo aberto.
 */
function leitores(avisoId) {
  const linhas = db
    .get()
    .prepare(`${PUBLICO_DO_AVISO} ORDER BY l.lido_em IS NULL, l.lido_em, u.nome`)
    .all({ aviso: avisoId });

  const viram = linhas.filter((l) => l.lido_em);
  return {
    viram,
    naoViram: linhas.filter((l) => !l.lido_em),
    total: linhas.length,
    vistos: viram.length,
  };
}

/**
 * Contagem de leitura de vários avisos de uma vez — duas consultas no total,
 * não duas por linha. É o que permite a coluna "visto por" no mural sem
 * transformar a tela numa enxurrada de consultas.
 */
function leituraDeVarios(avisoIds) {
  const ids = [...new Set((avisoIds || []).map(Number).filter(Boolean))];
  const mapa = new Map();
  if (!ids.length) return mapa;

  const marcas = ids.map(() => '?').join(',');
  const publico = db
    .get()
    .prepare(
      `SELECT a.id AS aviso_id, u.nome, s.nome AS setor, l.lido_em
         FROM avisos a
         JOIN usuarios u ON (
                (a.escopo = 'todos' AND u.status = 'Ativo')
             OR EXISTS (SELECT 1 FROM avisos_destinos d WHERE d.aviso_id = a.id AND d.usuario_id = u.id))
         LEFT JOIN setores s ON s.id = u.setor_id
         LEFT JOIN avisos_lidos l ON l.aviso_id = a.id AND l.usuario_id = u.id
        WHERE a.id IN (${marcas})
        ORDER BY l.lido_em IS NULL, l.lido_em, u.nome`
    )
    .all(...ids);

  for (const id of ids) mapa.set(id, { viram: [], naoViram: [], total: 0, vistos: 0 });
  for (const linha of publico) {
    const entrada = mapa.get(linha.aviso_id);
    if (!entrada) continue;
    entrada.total += 1;
    if (linha.lido_em) {
      entrada.vistos += 1;
      entrada.viram.push(linha);
    } else {
      entrada.naoViram.push(linha);
    }
  }
  return mapa;
}

/** Avisos de um processo, do mais novo para o mais antigo. */
function doProcesso(processoId, limite = 50) {
  return db
    .get()
    .prepare(
      `${SELECT} WHERE a.processo_id = @processo ORDER BY a.id DESC LIMIT @limite`
    )
    .all({ processo: processoId, limite });
}

function marcarLido(avisoId, usuarioId) {
  db.get()
    .prepare(
      `INSERT INTO avisos_lidos (aviso_id, usuario_id) VALUES (?, ?)
       ON CONFLICT (aviso_id, usuario_id) DO NOTHING`
    )
    .run(avisoId, usuarioId);
  return contarNaoLidos(usuarioId);
}

function marcarTodosLidos(usuarioId) {
  db.get()
    .prepare(
      `INSERT INTO avisos_lidos (aviso_id, usuario_id)
       SELECT a.id, @usuario FROM avisos a
        WHERE ${CONDICAO_DESTINO} AND ${CONDICAO_NAO_LIDO}`
    )
    .run({ usuario: usuarioId });
  return 0;
}

module.exports = {
  TIPOS,
  TIPOS_DA_FAIXA,
  cargaDoAviso,
  pendentesDesde,
  ultimoIdVisivel,
  ROTULOS,
  CORES,
  rotulo,
  cor,
  publicar,
  usuariosDoSetor,
  leitores,
  leituraDeVarios,
  doProcesso,
  processoAberto,
  processoConcluido,
  processoImpedido,
  processoCancelado,
  processoReaberto,
  vezDoSetor,
  prazoDoProcesso,
  obter,
  naoLidos,
  contarNaoLidos,
  listar,
  marcarLido,
  marcarTodosLidos,
};
