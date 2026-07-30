'use strict';

const db = require('../db');
const config = require('../config');
const parametros = require('./parametros');
const integracoes = require('./integracoes');
const { formatarData } = require('../lib/datas');

/* ------------------------------------------------------------------ *
 * Transportes de e-mail                                              *
 * ------------------------------------------------------------------ *
 * 'mock'  -> apenas persiste na tabela notificacoes + log no console. *
 * 'smtp'  -> ponto de extensão: instale nodemailer e implemente aqui. *
 * ------------------------------------------------------------------ */
const transportes = {
  async mock(mensagem) {
    if (config.env !== 'test') {
      // eslint-disable-next-line no-console
      console.log(`[e-mail simulado] para=${mensagem.destinatario} assunto="${mensagem.assunto}"`);
    }
    return { ok: true };
  },

  async smtp(mensagem) {
    // Integração real de SMTP entra aqui (nodemailer/Resend/SendGrid).
    // Enquanto não configurada, cai no transporte simulado para não perder o registro.
    return transportes.mock(mensagem);
  },
};

function registrar(mensagem, status, erro) {
  db.get()
    .prepare(
      `INSERT INTO notificacoes (canal, destinatario, setor, assunto, corpo, processo_id, evento, status, erro)
       VALUES (@canal, @destinatario, @setor, @assunto, @corpo, @processo_id, @evento, @status, @erro)`
    )
    .run({
      canal: mensagem.canal || 'email',
      destinatario: mensagem.destinatario,
      setor: mensagem.setor || null,
      assunto: mensagem.assunto,
      corpo: mensagem.corpo,
      processo_id: mensagem.processoId || null,
      evento: mensagem.evento || null,
      status,
      erro: erro || null,
    });
}

/** Envia (ou suprime) uma notificação, sempre deixando rastro no banco. */
async function enviar(mensagem) {
  const ligado = parametros.bool('EMAIL_NOTIFICACAO', true);
  if (!ligado) {
    registrar(mensagem, 'Suprimida', 'EMAIL_NOTIFICACAO desativado');
    return { enviado: false, motivo: 'EMAIL_NOTIFICACAO desativado' };
  }
  if (mensagem.setor && !parametros.notificaSetor(mensagem.setor)) {
    registrar(mensagem, 'Suprimida', `Notificações desativadas para ${mensagem.setor}`);
    return { enviado: false, motivo: 'setor sem notificação' };
  }
  if (!mensagem.destinatario) {
    registrar(mensagem, 'Falha', 'Destinatário não configurado em PARAMETROS');
    return { enviado: false, motivo: 'sem destinatário' };
  }

  const transporte = transportes[config.mailTransport] || transportes.mock;
  try {
    await transporte({ ...mensagem, remetente: config.mailFrom });
    registrar(mensagem, 'Enviada');
    return { enviado: true };
  } catch (err) {
    registrar(mensagem, 'Falha', err.message);
    return { enviado: false, motivo: err.message };
  }
}

/* ------------------------------------------------------------------ *
 * Eventos de negócio                                                 *
 * ------------------------------------------------------------------ */

function linkProcesso(processo) {
  return `/processos/${processo.id}`;
}

function corpoBase(processo, linhas) {
  return [
    `Processo: ${processo.codigo} — ${processo.razao_social}`,
    `Tipo: ${processo.tipo_processo || ''}`,
    `Previsão de conclusão: ${formatarData(processo.data_previsao)}`,
    '',
    ...linhas,
    '',
    `Acesse: ${linkProcesso(processo)}`,
  ].join('\n');
}

/** Notifica todos os setores que possuem itens pendentes no processo. */
async function processoAberto(processo, setoresEnvolvidos) {
  const resultados = [];
  for (const setor of setoresEnvolvidos) {
    resultados.push(
      await enviar({
        destinatario: parametros.emailDoSetor(setor),
        setor,
        assunto: `[${processo.codigo}] Novo processo aberto — ${processo.tipo_processo}`,
        corpo: corpoBase(processo, [
          `O setor ${setor} possui itens de checklist a responder neste processo.`,
        ]),
        processoId: processo.id,
        evento: 'processo_aberto',
      })
    );
  }
  await integracoes.avisar('processo_aberto', processo, {
    texto: `Novo processo ${processo.codigo} (${processo.tipo_processo}) aberto para ${processo.razao_social}.`,
  });
  return resultados;
}

/** Notifica um setor de que chegou a vez dele. */
async function vezDoSetor(processo, setor) {
  return enviar({
    destinatario: parametros.emailDoSetor(setor),
    setor,
    assunto: `[${processo.codigo}] Aguardando análise — ${setor}`,
    corpo: corpoBase(processo, [`O processo está aguardando a análise do setor ${setor}.`]),
    processoId: processo.id,
    evento: 'vez_do_setor',
  });
}

async function impedimento(processo, item, usuario) {
  if (!parametros.bool('ENVIAR_EMAIL_IMPEDIMENTO', true)) {
    return { enviado: false, motivo: 'ENVIAR_EMAIL_IMPEDIMENTO desativado' };
  }
  const destinos = [parametros.emailDoSetor('Diretoria'), parametros.emailDoSetor('Administrativo')].filter(Boolean);
  const resultados = [];
  for (const destinatario of destinos) {
    resultados.push(
      await enviar({
        destinatario,
        assunto: `[${processo.codigo}] IMPEDIMENTO registrado — ${item.setor}`,
        corpo: corpoBase(processo, [
          `Item: ${item.item}`,
          `Setor: ${item.setor}`,
          `Responsável: ${usuario ? usuario.nome : 'Sistema'}`,
          `Motivo: ${item.descricao_impedimento || '(não informado)'}`,
        ]),
        processoId: processo.id,
        evento: 'impedimento',
      })
    );
  }
  await integracoes.avisar('impedimento', processo, {
    texto: `Impedimento no processo ${processo.codigo} (${item.setor}): ${item.descricao_impedimento || ''}`,
  });
  return resultados;
}

async function processoConcluido(processo, usuario) {
  if (!parametros.bool('ENVIAR_EMAIL_CONCLUSAO', true)) {
    return { enviado: false, motivo: 'ENVIAR_EMAIL_CONCLUSAO desativado' };
  }
  const resultado = await enviar({
    destinatario: parametros.emailDoSetor('Diretoria'),
    assunto: `[${processo.codigo}] Processo concluído`,
    corpo: corpoBase(processo, [
      `Concluído por: ${usuario ? usuario.nome : 'Sistema'}`,
      `Cliente: ${processo.razao_social}`,
    ]),
    processoId: processo.id,
    evento: 'processo_concluido',
  });
  await integracoes.avisar('processo_concluido', processo, {
    texto: `Processo ${processo.codigo} concluído.`,
  });
  return resultado;
}

async function processoAtrasado(processo, diasRestantes) {
  const atrasado = diasRestantes < 0;
  const assunto = atrasado
    ? `[${processo.codigo}] Processo ATRASADO há ${Math.abs(diasRestantes)} dia(s)`
    : `[${processo.codigo}] Vence em ${diasRestantes} dia(s)`;
  const destinos = new Set([parametros.emailDoSetor('Diretoria'), parametros.emailDoSetor('Administrativo')]);
  const resultados = [];
  for (const destinatario of destinos) {
    if (!destinatario) continue;
    resultados.push(
      await enviar({
        destinatario,
        assunto,
        corpo: corpoBase(processo, [
          atrasado
            ? `A previsão de conclusão venceu em ${formatarData(processo.data_previsao)}.`
            : `Faltam ${diasRestantes} dia(s) para o vencimento.`,
          `Status atual: ${processo.status}`,
        ]),
        processoId: processo.id,
        evento: atrasado ? 'processo_atrasado' : 'processo_a_vencer',
      })
    );
  }
  return resultados;
}

function listar(limite = 100) {
  return db
    .get()
    .prepare(
      `SELECT n.*, p.codigo AS processo_codigo
         FROM notificacoes n
         LEFT JOIN processos p ON p.id = n.processo_id
        ORDER BY n.id DESC
        LIMIT ?`
    )
    .all(limite);
}

function doProcesso(processoId) {
  return db
    .get()
    .prepare('SELECT * FROM notificacoes WHERE processo_id = ? ORDER BY id DESC')
    .all(processoId);
}

module.exports = {
  enviar,
  processoAberto,
  vezDoSetor,
  impedimento,
  processoConcluido,
  processoAtrasado,
  listar,
  doProcesso,
};
