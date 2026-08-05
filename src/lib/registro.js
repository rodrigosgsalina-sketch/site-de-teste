'use strict';

/**
 * Registro de diagnóstico das notificações.
 *
 * Quando um aviso não aparece na tela de alguém, a pergunta é sempre a mesma:
 * o evento foi publicado? para quem? chegou a sair? Estas linhas respondem
 * isso no console do servidor, em desenvolvimento e em homologação
 * (LOG_NOTIFICACOES liga/desliga; em produção fica desligado por padrão para
 * não vazar nome de cliente no log).
 */

const config = require('../config');

function ativo() {
  return config.logNotificacoes;
}

function agora() {
  return new Date().toISOString();
}

/** Uma linha por etapa: publicação, entrega, push, falha. */
function notificacao(etapa, dados = {}) {
  if (!ativo()) return;
  const detalhes = Object.entries(dados)
    .filter(([, valor]) => valor !== undefined && valor !== null)
    .map(([chave, valor]) => `${chave}=${Array.isArray(valor) ? valor.length : valor}`)
    .join(' ');
  // eslint-disable-next-line no-console
  console.log(`[avisos] ${agora()} ${etapa}${detalhes ? ` · ${detalhes}` : ''}`);
}

module.exports = { notificacao, ativo };
