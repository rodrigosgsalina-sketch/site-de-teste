'use strict';

const fs = require('fs');

const db = require('../db');
const parametros = require('./parametros');
const checklist = require('./checklist');
const clientes = require('./clientes');
const subtipos = require('./subtipos');
const avisos = require('./avisos');
const historico = require('./historico');
const notificacoes = require('./notificacoes');
const documentos = require('./documentos');
const { agoraISO, hojeISO, somarDias, diffDias } = require('../lib/datas');

const ErroValidacao = checklist.ErroValidacao;

const STATUS = {
  ABERTO: 'Aberto',
  IMPEDIDO: 'Impedido',
  LIBERADO: 'Liberado',
  CONCLUIDO: 'Concluído',
  CANCELADO: 'Cancelado',
};

/** Setores que possuem um status "Em Análise ..." próprio. */
const STATUS_ANALISE = {
  Fiscal: 'Em Análise Fiscal',
  'Departamento Pessoal': 'Em Análise Departamento Pessoal',
  Contábil: 'Em Análise Contábil',
  Jurídico: 'Em Análise Jurídica',
};

const SELECT_PROCESSO = `
  SELECT p.*, t.nome AS tipo_processo, sub.nome AS subtipo_processo,
         st.nome AS status, st.final AS status_final,
         st.espera AS status_espera, u.nome AS responsavel_interno, uc.nome AS criado_por,
         cl.codigo AS cliente_codigo, cl.apelido AS cliente_apelido
    FROM processos p
    JOIN tipos_processo t ON t.id = p.tipo_processo_id
    LEFT JOIN subtipos_processo sub ON sub.id = p.subtipo_processo_id
    JOIN status_processo st ON st.id = p.status_id
    LEFT JOIN usuarios u ON u.id = p.responsavel_interno_id
    LEFT JOIN usuarios uc ON uc.id = p.criado_por_id
    LEFT JOIN clientes cl ON cl.id = p.cliente_id`;

function statusId(nome) {
  const row = db.get().prepare('SELECT id FROM status_processo WHERE nome = ?').get(nome);
  if (!row) throw new Error(`Status desconhecido: ${nome}`);
  return row.id;
}

function obter(id) {
  return db.get().prepare(`${SELECT_PROCESSO} WHERE p.id = ?`).get(id);
}

function obterPorCodigo(codigo) {
  return db.get().prepare(`${SELECT_PROCESSO} WHERE p.codigo = ?`).get(codigo);
}

/* ------------------------------------------------------------------ *
 * Criação                                                            *
 * ------------------------------------------------------------------ */

/** Campos preenchidos pelo usuário no formulário do processo. */
const CAMPOS_TEXTO = ['etapa_atual', 'observacoes'];

/** Campos da empresa copiados do cadastro de clientes na abertura. */
const CAMPOS_CLIENTE = [
  'razao_social',
  'nome_fantasia',
  'cnpj',
  'inscricao_estadual',
  'inscricao_municipal',
  'municipio',
  'uf',
  'cliente_responsavel',
  'telefone',
  'email',
];

function texto(valor) {
  return valor === undefined || valor === null || String(valor).trim() === '' ? null : String(valor).trim();
}

function limpar(dados) {
  const saida = {};
  for (const campo of CAMPOS_TEXTO) saida[campo] = texto(dados[campo]);
  return saida;
}

/**
 * Localiza o cliente escolhido no formulário. O processo passou a referenciar
 * o cadastro de clientes: nada de empresa é mais digitado na abertura.
 */
function clienteSelecionado(dados) {
  const id = Number(dados.cliente_id);
  if (!id) throw new ErroValidacao('Selecione o cliente do processo.');
  const cliente = clientes.obter(id);
  if (!cliente) throw new ErroValidacao('Cliente não encontrado. Atualize a página e selecione novamente.');
  return cliente;
}

/**
 * Copia os dados da empresa para o processo. A cópia é proposital: o processo
 * guarda a foto do cadastro no momento em que foi aberto, e continua legível
 * mesmo que o cliente seja alterado ou removido depois.
 */
function dadosDoCliente(cliente) {
  return {
    razao_social: texto(cliente.razao_social) || texto(cliente.nome) || `Cliente ${cliente.codigo}`,
    nome_fantasia: texto(cliente.nome_fantasia) || texto(cliente.apelido),
    cnpj: texto(cliente.cnpj_cpf),
    inscricao_estadual: texto(cliente.inscricao_estadual),
    inscricao_municipal: texto(cliente.inscricao_municipal),
    municipio: texto(cliente.municipio),
    uf: texto(cliente.uf),
    cliente_responsavel: texto(cliente.responsavel_legal),
    telefone: texto(cliente.telefone),
    email: texto(cliente.email),
  };
}

/**
 * Cria o processo, gera o número automático, calcula a previsão de conclusão
 * e clona o checklist do modelo. Tudo em uma única transação.
 * As notificações são disparadas depois do commit (retorna uma promessa).
 */
function criar(dados, usuario) {
  const cliente = clienteSelecionado(dados);
  const tipo = db
    .get()
    .prepare('SELECT id, nome, ativo FROM tipos_processo WHERE id = ?')
    .get(Number(dados.tipo_processo_id));
  if (!tipo) throw new ErroValidacao('Selecione um tipo de processo válido.');
  if (!tipo.ativo) throw new ErroValidacao(`O tipo de processo "${tipo.nome}" está inativo.`);

  // Opcional: tipo sem subtipos cadastrados abre processo como sempre abriu.
  const subtipoId = subtipos.paraProcesso(tipo.id, dados.subtipo_processo_id);

  const abertura = dados.data_abertura ? String(dados.data_abertura).slice(0, 10) : hojeISO();
  const prazoDias = parametros.num('PRAZO_PADRAO_PROCESSO_DIAS', 15);
  const previsao = dados.data_previsao
    ? String(dados.data_previsao).slice(0, 10)
    : somarDias(`${abertura}T12:00:00`, prazoDias).toISOString().slice(0, 10);

  const campos = { ...limpar(dados), ...dadosDoCliente(cliente) };

  const processoId = db.tx(() => {
    const codigo = parametros.proximoCodigoProcesso(new Date(`${abertura}T12:00:00`));
    const info = db
      .get()
      .prepare(
        `INSERT INTO processos
           (codigo, data_abertura, tipo_processo_id, subtipo_processo_id, status_id, etapa_atual, cliente_id, razao_social,
            nome_fantasia, cnpj, inscricao_estadual, inscricao_municipal, municipio, uf, cliente_responsavel,
            telefone, email, responsavel_interno_id, data_previsao, observacoes, criado_por_id, criado_em, atualizado_em)
         VALUES (@codigo, @data_abertura, @tipo_processo_id, @subtipo_processo_id, @status_id, @etapa_atual, @cliente_id, @razao_social,
                 @nome_fantasia, @cnpj, @inscricao_estadual, @inscricao_municipal, @municipio, @uf,
                 @cliente_responsavel, @telefone, @email, @responsavel_interno_id, @data_previsao,
                 @observacoes, @criado_por_id, @agora, @agora)`
      )
      .run({
        codigo,
        data_abertura: abertura,
        tipo_processo_id: tipo.id,
        subtipo_processo_id: subtipoId,
        status_id: statusId(STATUS.ABERTO),
        cliente_id: cliente.id,
        responsavel_interno_id: dados.responsavel_interno_id ? Number(dados.responsavel_interno_id) : null,
        data_previsao: previsao,
        criado_por_id: usuario ? usuario.id : null,
        agora: agoraISO(),
        ...campos,
      });

    const id = Number(info.lastInsertRowid);
    const itens = checklist.gerarParaProcesso(id, tipo.id, `${abertura}T12:00:00`);

    historico.registrar({
      processoId: id,
      acao: 'Processo Criado',
      usuario,
      observacao: `${codigo} — ${tipo.nome} para ${campos.razao_social} (cliente ${cliente.codigo}). ${itens.length} itens de checklist gerados.`,
    });
    return id;
  });

  const processo = obter(processoId);
  recalcularStatus(processoId, usuario, { silencioso: true });
  return obter(processoId) || processo;
}

/** Dispara as notificações de abertura (fora da transação). */
async function notificarAbertura(processoId, usuario) {
  const processo = obter(processoId);
  if (!processo) return [];
  const setores = checklist.setoresDoProcesso(processoId);
  // Aviso interno em tempo real para quem participa do processo.
  avisos.processoAberto(processo, setores, usuario);
  return notificacoes.processoAberto(processo, setores);
}

function atualizar(id, dados, usuario) {
  const atual = obter(id);
  if (!atual) throw new ErroValidacao('Processo não encontrado.');
  const cliente = clienteSelecionado(dados);
  const trocouCliente = Number(atual.cliente_id) !== cliente.id;
  const campos = { ...limpar(dados), ...dadosDoCliente(cliente) };

  // O tipo não muda na edição (o checklist já foi gerado a partir dele), mas o
  // subtipo sim: é só um detalhamento, e processos antigos nasceram sem nenhum.
  const subtipoId = subtipos.paraProcesso(atual.tipo_processo_id, dados.subtipo_processo_id);
  const trocouSubtipo = Number(atual.subtipo_processo_id || 0) !== Number(subtipoId || 0);

  db.get()
    .prepare(
      `UPDATE processos
          SET cliente_id = @cliente_id, razao_social = @razao_social, nome_fantasia = @nome_fantasia,
              cnpj = @cnpj, inscricao_estadual = @inscricao_estadual, inscricao_municipal = @inscricao_municipal,
              municipio = @municipio, uf = @uf, cliente_responsavel = @cliente_responsavel,
              telefone = @telefone, email = @email, etapa_atual = @etapa_atual,
              observacoes = @observacoes, responsavel_interno_id = @responsavel_interno_id,
              subtipo_processo_id = @subtipo_processo_id,
              data_previsao = @data_previsao, atualizado_em = @agora
        WHERE id = @id`
    )
    .run({
      id,
      cliente_id: cliente.id,
      subtipo_processo_id: subtipoId,
      responsavel_interno_id: dados.responsavel_interno_id ? Number(dados.responsavel_interno_id) : null,
      data_previsao: dados.data_previsao ? String(dados.data_previsao).slice(0, 10) : atual.data_previsao,
      agora: agoraISO(),
      ...campos,
    });

  historico.registrar({
    processoId: id,
    acao: 'Cadastro Atualizado',
    usuario,
    observacao: [
      trocouCliente
        ? `Cliente alterado de ${atual.razao_social} para ${campos.razao_social} (cliente ${cliente.codigo}).`
        : null,
      trocouSubtipo
        ? `Subtipo alterado de "${atual.subtipo_processo || '—'}" para "${
            subtipoId ? subtipos.obter(subtipoId).nome : '—'
          }".`
        : null,
    ]
      .filter(Boolean)
      .join(' ') || 'Dados cadastrais do processo alterados.',
  });
  return obter(id);
}

/* ------------------------------------------------------------------ *
 * Motor de status                                                    *
 * ------------------------------------------------------------------ */

/**
 * Determina o status que o processo deveria ter conforme o checklist.
 * Não altera nada — usado tanto pelo recálculo quanto pelos testes.
 */
function statusCalculado(processo, itens) {
  if (processo.status === STATUS.CONCLUIDO || processo.status === STATUS.CANCELADO) {
    return processo.status;
  }
  if (itens.some((i) => i.status_item === checklist.STATUS_ITEM.IMPEDIDO)) {
    return STATUS.IMPEDIDO;
  }

  const bloqueantes = itens.filter((i) => i.obrigatorio && parametros.aprovacaoObrigatoria(i.setor));
  const pendentesBloqueantes = bloqueantes.filter((i) => i.status_item !== checklist.STATUS_ITEM.CONCLUIDO);
  if (bloqueantes.length && pendentesBloqueantes.length === 0) {
    return STATUS.LIBERADO;
  }

  // Status de espera definido manualmente permanece enquanto houver pendências.
  if (processo.status_manual && processo.status_espera) {
    return processo.status;
  }

  const pendentes = itens.filter((i) => i.status_item !== checklist.STATUS_ITEM.CONCLUIDO);
  const candidatos = pendentes
    .filter((i) => STATUS_ANALISE[i.setor])
    .sort((a, b) => a.setor_ordem - b.setor_ordem || a.ordem - b.ordem);
  if (candidatos.length) return STATUS_ANALISE[candidatos[0].setor];

  return pendentes.length ? STATUS.ABERTO : STATUS.LIBERADO;
}

/**
 * Recalcula e persiste o status do processo. Registra o histórico quando o
 * status muda e devolve { anterior, atual, mudou }.
 */
function recalcularStatus(processoId, usuario, { silencioso = false } = {}) {
  const processo = obter(processoId);
  if (!processo) return null;
  const itens = checklist.doProcesso(processoId);
  const novo = statusCalculado(processo, itens);
  const setoresPend = checklist.setoresPendentes(processoId);
  const etapa = setoresPend.length ? `Aguardando ${setoresPend[0].nome}` : 'Checklist concluído';

  if (novo === processo.status) {
    db.get().prepare('UPDATE processos SET etapa_atual = ?, atualizado_em = ? WHERE id = ?')
      .run(etapa, agoraISO(), processoId);
    return { anterior: processo.status, atual: novo, mudou: false };
  }

  db.get()
    .prepare('UPDATE processos SET status_id = ?, status_manual = 0, etapa_atual = ?, atualizado_em = ? WHERE id = ?')
    .run(statusId(novo), etapa, agoraISO(), processoId);

  if (!silencioso) {
    historico.registrar({
      processoId,
      acao: 'Mudança de Status',
      usuario,
      observacao: `${processo.status} → ${novo}`,
    });
  }
  return { anterior: processo.status, atual: novo, mudou: true };
}

/** Define manualmente um status (ex.: Aguardando Junta Comercial). */
function definirStatusManual(processoId, nomeStatus, usuario, observacao) {
  const processo = obter(processoId);
  if (!processo) throw new ErroValidacao('Processo não encontrado.');
  const alvo = db.get().prepare('SELECT * FROM status_processo WHERE nome = ?').get(nomeStatus);
  if (!alvo) throw new ErroValidacao('Status inválido.');
  if (alvo.final) throw new ErroValidacao('Use as ações de concluir ou cancelar para status finais.');
  if (!alvo.espera && !parametros.bool('PERMITIR_PULAR_ETAPAS', false)) {
    throw new ErroValidacao(
      'Somente status de espera podem ser definidos manualmente (PERMITIR_PULAR_ETAPAS está desativado).'
    );
  }
  db.get()
    .prepare('UPDATE processos SET status_id = ?, status_manual = 1, atualizado_em = ? WHERE id = ?')
    .run(alvo.id, agoraISO(), processoId);
  historico.registrar({
    processoId,
    acao: 'Mudança de Status',
    usuario,
    observacao: `${processo.status} → ${alvo.nome}${observacao ? ` (${observacao})` : ''}`,
  });
  return obter(processoId);
}

/* ------------------------------------------------------------------ *
 * Conclusão                                                          *
 * ------------------------------------------------------------------ */

/**
 * Avalia as regras de bloqueio de conclusão e devolve a lista de
 * impedimentos (vazia = pode concluir).
 */
function validarConclusao(processoId, usuario) {
  const processo = obter(processoId);
  const problemas = [];
  if (!processo) return ['Processo não encontrado.'];
  if (processo.status === STATUS.CONCLUIDO) return ['O processo já está concluído.'];
  if (processo.status === STATUS.CANCELADO) return ['O processo está cancelado.'];

  const itens = checklist.doProcesso(processoId);

  if (parametros.bool('BLOQUEAR_CONCLUSAO_COM_PENDENCIA', true)) {
    const impedidos = itens.filter((i) => i.status_item === checklist.STATUS_ITEM.IMPEDIDO);
    if (impedidos.length) {
      problemas.push(
        `Existem ${impedidos.length} item(ns) com impedimento: ${impedidos
          .map((i) => `${i.setor} — ${i.item}`)
          .join('; ')}.`
      );
    }
    const obrigatoriosPendentes = itens.filter(
      (i) =>
        i.obrigatorio &&
        i.status_item === checklist.STATUS_ITEM.PENDENTE &&
        parametros.aprovacaoObrigatoria(i.setor)
    );
    if (obrigatoriosPendentes.length) {
      problemas.push(
        `Existem ${obrigatoriosPendentes.length} item(ns) obrigatório(s) pendente(s): ${obrigatoriosPendentes
          .map((i) => `${i.setor} — ${i.item}`)
          .join('; ')}.`
      );
    }
    if (parametros.bool('EXIGIR_CHECKLIST_100', false)) {
      const pendentes = itens.filter((i) => i.status_item !== checklist.STATUS_ITEM.CONCLUIDO);
      if (pendentes.length) {
        problemas.push(
          `EXIGIR_CHECKLIST_100 está ativo: os ${pendentes.length} item(ns) restante(s), inclusive os opcionais, precisam ser respondidos.`
        );
      }
    }
  }

  if (parametros.bool('EXIGIR_REVISAO_FINAL', false)) {
    const revisao = itens.filter((i) => i.setor === 'Qualidade');
    if (revisao.length && revisao.some((i) => i.status_item !== checklist.STATUS_ITEM.CONCLUIDO)) {
      problemas.push('A revisão final (setor Qualidade) ainda não foi concluída.');
    }
  }

  if (parametros.bool('EXIGIR_UPLOAD_DOCUMENTOS', false)) {
    const docs = db
      .get()
      .prepare('SELECT COUNT(*) AS total FROM documentos WHERE processo_id = ?')
      .get(processoId);
    if (!docs.total) problemas.push('É obrigatório anexar ao menos um documento ao processo.');
  }

  if (parametros.bool('EXIGIR_APROVACAO_GESTOR', false) && usuario) {
    const gestor = usuario.perfil === 'Administrador' || usuario.setor === 'Diretoria';
    if (!gestor) problemas.push('A conclusão exige aprovação de um gestor (Administrador ou Diretoria).');
  }

  return problemas;
}

function podeConcluir(processoId, usuario) {
  return validarConclusao(processoId, usuario).length === 0;
}

function concluir(processoId, usuario, observacao) {
  const problemas = validarConclusao(processoId, usuario);
  if (problemas.length) {
    const erro = new ErroValidacao(problemas.join(' '));
    erro.problemas = problemas;
    throw erro;
  }
  const hoje = hojeISO();
  db.get()
    .prepare(
      `UPDATE processos SET status_id = ?, status_manual = 0, data_conclusao = ?,
              etapa_atual = 'Concluído', atualizado_em = ? WHERE id = ?`
    )
    .run(statusId(STATUS.CONCLUIDO), hoje, agoraISO(), processoId);
  historico.registrar({
    processoId,
    acao: 'Processo Concluído',
    usuario,
    observacao: observacao || 'Checklist finalizado e processo liberado para arquivamento.',
  });

  const concluido = obter(processoId);
  // Aviso interno visível para todos os usuários da plataforma.
  avisos.processoConcluido(concluido, usuario);
  return concluido;
}

function cancelar(processoId, usuario, motivo) {
  const processo = obter(processoId);
  if (!processo) throw new ErroValidacao('Processo não encontrado.');
  if (!motivo || !motivo.trim()) throw new ErroValidacao('Informe o motivo do cancelamento.');
  db.get()
    .prepare(`UPDATE processos SET status_id = ?, status_manual = 1, etapa_atual = 'Cancelado', atualizado_em = ? WHERE id = ?`)
    .run(statusId(STATUS.CANCELADO), agoraISO(), processoId);
  historico.registrar({ processoId, acao: 'Processo Cancelado', usuario, observacao: motivo.trim() });
  const cancelado = obter(processoId);
  avisos.processoCancelado(cancelado, motivo.trim(), usuario);
  return cancelado;
}

/**
 * Apaga o processo definitivamente. Só o administrador chega aqui.
 *
 * Diferente de **cancelar**, que encerra o processo e mantém tudo legível:
 * aqui somem o checklist, os anexos, o histórico e os avisos daquele processo.
 * Existe para o que não deveria ter sido aberto — engano de digitação, teste,
 * duplicado — e não para encerrar trabalho.
 *
 * O que fica é uma linha de auditoria sem processo (`processoId: null`), que
 * por isso sobrevive: quem apagou, quando, qual era o número, de que cliente e
 * quanto se perdeu junto.
 */
function remover(processoId, usuario, motivo) {
  const processo = obter(processoId);
  if (!processo) throw new ErroValidacao('Processo não encontrado.');

  const conn = db.get();
  const contar = (tabela) =>
    conn.prepare(`SELECT COUNT(*) AS total FROM ${tabela} WHERE processo_id = ?`).get(processo.id).total;
  const perdidos = {
    checklist: contar('checklist'),
    documentos: contar('documentos'),
    historico: contar('historico'),
    avisos: contar('avisos'),
  };

  // Os anexos vivem em disco; a linha do banco sai por cascata, o arquivo não.
  // A lista é montada antes de apagar, porque depois não há como saber quais
  // eram.
  const anexos = conn.prepare('SELECT * FROM documentos WHERE processo_id = ?').all(processo.id);

  db.tx(() => {
    // As tabelas filhas saem por ON DELETE CASCADE (checklist, documentos,
    // histórico, notificações e avisos do processo).
    conn.prepare('DELETE FROM processos WHERE id = ?').run(processo.id);
  });

  let arquivosApagados = 0;
  for (const anexo of anexos) {
    try {
      const caminho = documentos.caminhoAbsoluto(anexo);
      if (fs.existsSync(caminho)) {
        fs.unlinkSync(caminho);
        arquivosApagados += 1;
      }
    } catch (_) {
      // Arquivo já sumido ou caminho recusado: o registro já saiu do banco, e
      // um anexo órfão em disco não pode impedir a exclusão de terminar.
    }
  }

  historico.registrar({
    processoId: null, // sem isso a própria auditoria sairia junto, por cascata
    acao: 'Processo Excluído',
    usuario,
    observacao:
      `${processo.codigo} — ${processo.tipo_processo} de ${processo.razao_social}. ` +
      `Removidos: ${perdidos.checklist} item(ns) de checklist, ${perdidos.documentos} anexo(s) ` +
      `(${arquivosApagados} arquivo(s) em disco), ${perdidos.historico} registro(s) de histórico e ` +
      `${perdidos.avisos} aviso(s).` +
      (motivo && motivo.trim() ? ` Motivo: ${motivo.trim()}` : ''),
  });

  return { processo, perdidos, arquivosApagados };
}

function reabrir(processoId, usuario, motivo) {
  const processo = obter(processoId);
  if (!processo) throw new ErroValidacao('Processo não encontrado.');
  if (!processo.status_final) throw new ErroValidacao('O processo não está encerrado.');
  db.get()
    .prepare('UPDATE processos SET status_id = ?, status_manual = 0, data_conclusao = NULL, atualizado_em = ? WHERE id = ?')
    .run(statusId(STATUS.ABERTO), agoraISO(), processoId);
  historico.registrar({
    processoId,
    acao: 'Processo Reaberto',
    usuario,
    observacao: motivo || 'Reabertura solicitada.',
  });
  recalcularStatus(processoId, usuario, { silencioso: true });
  const reaberto = obter(processoId);
  avisos.processoReaberto(reaberto, motivo, usuario);
  return reaberto;
}

/* ------------------------------------------------------------------ *
 * Consultas                                                          *
 * ------------------------------------------------------------------ */

/**
 * Lista processos com filtros. `setorIds` restringe aos processos que possuem
 * itens de checklist do(s) setor(es) do usuário (visibilidade por setor).
 */
function listar({
  status,
  tipoId,
  busca,
  setorIds = null,
  usuarioId = null,
  responsavelId,
  atrasados,
  limite = 300,
} = {}) {
  const filtros = [];
  const args = [];
  if (status) {
    filtros.push('st.nome = ?');
    args.push(status);
  }
  if (tipoId) {
    filtros.push('p.tipo_processo_id = ?');
    args.push(Number(tipoId));
  }
  if (responsavelId) {
    filtros.push('p.responsavel_interno_id = ?');
    args.push(Number(responsavelId));
  }
  if (busca) {
    filtros.push('(p.codigo LIKE ? OR p.razao_social LIKE ? OR p.nome_fantasia LIKE ? OR p.cnpj LIKE ?)');
    const termo = `%${busca}%`;
    args.push(termo, termo, termo, termo);
  }
  if (atrasados) {
    filtros.push("st.final = 0 AND p.data_previsao IS NOT NULL AND p.data_previsao < date('now')");
  }
  if (setorIds && setorIds.length) {
    // Visibilidade por setor: o usuário enxerga os processos em que seu setor
    // tem itens de checklist, além dos que ele mesmo abriu ou conduz.
    filtros.push(
      `(p.criado_por_id = ? OR p.responsavel_interno_id = ?
        OR EXISTS (SELECT 1 FROM checklist c WHERE c.processo_id = p.id AND c.setor_id IN (${setorIds
          .map(() => '?')
          .join(',')})))`
    );
    args.push(usuarioId || -1, usuarioId || -1, ...setorIds);
  }
  args.push(limite);

  const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
  return db
    .get()
    .prepare(
      `${SELECT_PROCESSO}
       ${where}
       ORDER BY p.data_abertura DESC, p.id DESC
       LIMIT ?`
    )
    .all(...args);
}

/** Processos vencidos ou a X dias do vencimento (DIAS_ALERTA_ATRASO). */
function comAlertaDePrazo() {
  const dias = parametros.num('DIAS_ALERTA_ATRASO', 3);
  const hoje = hojeISO();
  const processos = db
    .get()
    .prepare(
      `${SELECT_PROCESSO}
        WHERE st.final = 0 AND p.data_previsao IS NOT NULL
        ORDER BY p.data_previsao`
    )
    .all();
  return processos
    .map((p) => ({ ...p, dias_restantes: diffDias(hoje, p.data_previsao) }))
    .filter((p) => p.dias_restantes <= dias);
}

/** Executa a varredura de prazos e dispara as notificações de atraso. */
async function verificarPrazos() {
  if (!parametros.bool('ALERTAR_PROCESSO_ATRASADO', true)) return { avaliados: 0, notificados: 0 };
  const alvos = comAlertaDePrazo();
  let notificados = 0;
  for (const processo of alvos) {
    const jaAvisado = db
      .get()
      .prepare(
        `SELECT 1 FROM notificacoes
          WHERE processo_id = ? AND evento IN ('processo_atrasado','processo_a_vencer')
            AND date(criado_em) = date('now')`
      )
      .get(processo.id);
    if (jaAvisado) continue;
    await notificacoes.processoAtrasado(processo, processo.dias_restantes);
    avisos.prazoDoProcesso(processo, processo.dias_restantes);
    historico.registrar({
      processoId: processo.id,
      acao: 'Alerta de Prazo',
      usuario: null,
      observacao:
        processo.dias_restantes < 0
          ? `Processo atrasado há ${Math.abs(processo.dias_restantes)} dia(s).`
          : `Vence em ${processo.dias_restantes} dia(s).`,
    });
    notificados += 1;
  }
  return { avaliados: alvos.length, notificados };
}

module.exports = {
  STATUS,
  STATUS_ANALISE,
  ErroValidacao,
  criar,
  atualizar,
  obter,
  obterPorCodigo,
  listar,
  statusCalculado,
  recalcularStatus,
  definirStatusManual,
  validarConclusao,
  podeConcluir,
  concluir,
  cancelar,
  reabrir,
  remover,
  notificarAbertura,
  comAlertaDePrazo,
  verificarPrazos,
  statusId,
};
