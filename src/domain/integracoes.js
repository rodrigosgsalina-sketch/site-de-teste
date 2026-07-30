'use strict';

/**
 * Registro de integrações externas.
 *
 * Cada adaptador expõe { chave, rotulo, disponivel(), enviar(evento, processo, dados) }.
 * Somente as integrações previstas em PARAMETROS ficam ativas; as demais são
 * stubs declarados para que a arquitetura já contemple o plug futuro
 * (WhatsApp, Onvio, Domínio Sistemas, e-CAC) sem alterar o núcleo.
 */

const parametros = require('./parametros');
const config = require('../config');

function stub(chave, rotulo, parametroChave, observacao) {
  return {
    chave,
    rotulo,
    parametroChave,
    observacao,
    implementado: false,
    habilitado: () => parametros.bool(parametroChave, false),
    async enviar() {
      return { enviado: false, motivo: `Integração ${rotulo} ainda não implementada.` };
    },
  };
}

const googleChat = {
  chave: 'google_chat',
  rotulo: 'Google Chat',
  parametroChave: 'INTEGRAR_GOOGLE_CHAT',
  observacao: 'Envia um card simples para o webhook do espaço configurado.',
  implementado: true,
  habilitado: () => parametros.bool('INTEGRAR_GOOGLE_CHAT', false),
  async enviar(evento, processo, dados) {
    const url = parametros.texto('WEBHOOK_GOOGLE_CHAT', '');
    if (!url) return { enviado: false, motivo: 'WEBHOOK_GOOGLE_CHAT não configurado' };
    try {
      const resposta = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: dados.texto }),
      });
      return { enviado: resposta.ok, motivo: resposta.ok ? null : `HTTP ${resposta.status}` };
    } catch (err) {
      return { enviado: false, motivo: err.message };
    }
  },
};

const googleDrive = {
  chave: 'google_drive',
  rotulo: 'Google Drive',
  parametroChave: 'SALVAR_DOCUMENTOS_DRIVE',
  observacao: 'Arquiva os documentos do processo na pasta PASTA_DRIVE_PROCESSOS. Requer credenciais de serviço.',
  implementado: false,
  habilitado: () => parametros.bool('SALVAR_DOCUMENTOS_DRIVE', false),
  async enviar() {
    return { enviado: false, motivo: 'Credenciais do Google Drive não configuradas.' };
  },
  /** Ponto de extensão usado pelo upload de documentos. */
  async arquivar(documento) {
    if (!this.habilitado()) return { enviado: false, motivo: 'SALVAR_DOCUMENTOS_DRIVE desativado' };
    const pasta = parametros.texto('PASTA_DRIVE_PROCESSOS', '');
    if (!pasta || pasta === 'ID_DA_PASTA') {
      return { enviado: false, motivo: 'PASTA_DRIVE_PROCESSOS não configurada' };
    }
    return { enviado: false, motivo: 'Credenciais do Google Drive não configuradas.', documento: documento.id };
  },
};

const adaptadores = [
  googleChat,
  googleDrive,
  stub('whatsapp', 'WhatsApp', 'INTEGRAR_WHATSAPP', 'Aviso ao cliente por WhatsApp Business API.'),
  stub('onvio', 'Onvio', 'INTEGRAR_ONVIO', 'Sincronização de clientes e documentos.'),
  stub('dominio', 'Domínio Sistemas', 'INTEGRAR_DOMINIO', 'Importação de dados cadastrais e débitos.'),
  stub('ecac', 'e-CAC', 'INTEGRAR_ECAC', 'Consulta automática de situação fiscal e certidões.'),
];

/** Dispara o evento para todas as integrações habilitadas e implementadas. */
async function avisar(evento, processo, dados) {
  const resultados = [];
  for (const adaptador of adaptadores) {
    if (!adaptador.implementado || !adaptador.habilitado()) continue;
    if (adaptador.chave === 'google_drive') continue; // não é canal de aviso
    try {
      resultados.push({ integracao: adaptador.chave, ...(await adaptador.enviar(evento, processo, dados)) });
    } catch (err) {
      resultados.push({ integracao: adaptador.chave, enviado: false, motivo: err.message });
    }
  }
  if (config.env !== 'test' && resultados.length) {
    // eslint-disable-next-line no-console
    console.log('[integrações]', evento, JSON.stringify(resultados));
  }
  return resultados;
}

function listar() {
  return adaptadores.map((a) => ({
    chave: a.chave,
    rotulo: a.rotulo,
    parametroChave: a.parametroChave,
    observacao: a.observacao,
    implementado: a.implementado,
    habilitado: a.habilitado(),
  }));
}

module.exports = { avisar, listar, adaptadores, googleDrive };
