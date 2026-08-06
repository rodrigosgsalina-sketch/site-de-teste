'use strict';

/**
 * Entrega de avisos em tempo real, por Server-Sent Events.
 *
 * Cada aba aberta mantém uma conexão HTTP viva em GET /eventos; quando um
 * processo é aberto, impedido, concluído (etc.), o aviso é empurrado na hora
 * para as conexões dos usuários que devem vê-lo, sem que a tela precise ser
 * recarregada nem ficar perguntando ao servidor.
 *
 * SSE — e não WebSocket — porque o fluxo é de mão única (servidor → tela),
 * viaja no mesmo HTTPS da aplicação, reconecta sozinho e não traz dependência.
 *
 * As conexões vivem na memória deste processo. A plataforma roda em um único
 * processo Node; se um dia forem vários, este módulo é o ponto onde entra um
 * repasse entre eles (Redis, por exemplo).
 */

const INTERVALO_PULSO_MS = 25000;
const RECONEXAO_MS = 4000;
/* Com as abas dividindo uma conexão só (ver src/public/js/notificacoes.js), um
   usuário precisa de UMA. A folga aqui cobre a troca de aba líder e o navegador
   antigo que abre uma por aba; passou disso, a mais antiga sai. */
const MAX_CONEXOES_POR_USUARIO = 4;

/** usuarioId -> Set de conexões (uma por aba aberta). */
const conexoes = new Map();

function contar() {
  let total = 0;
  for (const grupo of conexoes.values()) total += grupo.size;
  return total;
}

function usuariosConectados() {
  return [...conexoes.keys()];
}

/** Formata um bloco SSE. Quebras de linha viram vários `data:`. */
function bloco({ evento, dados, id }) {
  const corpo = JSON.stringify(dados);
  return (
    (id ? `id: ${id}\n` : '') +
    (evento ? `event: ${evento}\n` : '') +
    corpo
      .split('\n')
      .map((linha) => `data: ${linha}`)
      .join('\n') +
    '\n\n'
  );
}

/**
 * Registra a resposta HTTP como um canal aberto do usuário.
 * Devolve a função que encerra o canal.
 */
function assinar(usuarioId, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Desliga o buffer de proxies (nginx), que seguraria os eventos.
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: ${RECONEXAO_MS}\n\n`);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  if (!conexoes.has(usuarioId)) conexoes.set(usuarioId, new Set());
  const grupo = conexoes.get(usuarioId);

  // Aba esquecida em segundo plano não pode acumular canais para sempre.
  while (grupo.size >= MAX_CONEXOES_POR_USUARIO) {
    const maisAntiga = grupo.values().next().value;
    grupo.delete(maisAntiga);
    try {
      maisAntiga.end();
    } catch (_) {
      /* já fechada */
    }
  }
  grupo.add(res);

  const pulso = setInterval(() => {
    try {
      res.write(': pulso\n\n'); // comentário SSE: mantém a conexão viva
    } catch (_) {
      encerrar();
    }
  }, INTERVALO_PULSO_MS);
  if (typeof pulso.unref === 'function') pulso.unref();

  function encerrar() {
    clearInterval(pulso);
    const atual = conexoes.get(usuarioId);
    if (atual) {
      atual.delete(res);
      if (!atual.size) conexoes.delete(usuarioId);
    }
    try {
      res.end();
    } catch (_) {
      /* já encerrada */
    }
  }

  req.on('close', encerrar);
  req.on('error', encerrar);
  return encerrar;
}

/**
 * Envia um evento por UMA conexão específica. É o que o estado inicial e a
 * reposição de avisos perdidos usam: eles interessam a quem acabou de conectar,
 * não às outras abas do mesmo usuário — que já receberam tudo no seu momento.
 */
function enviarNesta(res, evento, dados, id) {
  try {
    res.write(bloco({ evento, dados, id }));
    return 1;
  } catch (_) {
    return 0;
  }
}

/** Envia um evento para as abas de um usuário. */
function enviarPara(usuarioId, evento, dados, id) {
  const grupo = conexoes.get(Number(usuarioId));
  if (!grupo || !grupo.size) return 0;
  const texto = bloco({ evento, dados, id });
  let entregues = 0;
  for (const res of [...grupo]) {
    try {
      res.write(texto);
      entregues += 1;
    } catch (_) {
      grupo.delete(res);
    }
  }
  return entregues;
}

/**
 * Publica para uma lista de usuários (ou para todos os conectados quando
 * `usuarioIds` é null).
 */
function publicar(usuarioIds, evento, dados, id) {
  const alvos = usuarioIds === null ? usuariosConectados() : usuarioIds;
  let entregues = 0;
  for (const usuarioId of alvos) entregues += enviarPara(usuarioId, evento, dados, id);
  return entregues;
}

/** Fecha tudo (encerramento do servidor e testes). */
function encerrarTodas() {
  for (const grupo of conexoes.values()) {
    for (const res of grupo) {
      try {
        res.end();
      } catch (_) {
        /* já encerrada */
      }
    }
  }
  conexoes.clear();
}

module.exports = {
  assinar,
  publicar,
  enviarPara,
  enviarNesta,
  contar,
  usuariosConectados,
  encerrarTodas,
  RECONEXAO_MS,
};
