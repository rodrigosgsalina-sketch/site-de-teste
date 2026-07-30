'use strict';

const db = require('../db');
const parametros = require('./parametros');

/** Intervalo padrão: mês corrente. */
function intervaloPadrao() {
  const hoje = new Date();
  const inicio = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
  const fim = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0);
  return { inicio: inicio.toISOString().slice(0, 10), fim: fim.toISOString().slice(0, 10) };
}

function porStatus() {
  return db
    .get()
    .prepare(
      `SELECT st.nome AS status, COUNT(p.id) AS total
         FROM status_processo st
         LEFT JOIN processos p ON p.status_id = st.id
        GROUP BY st.id
        HAVING total > 0
        ORDER BY st.ordem`
    )
    .all();
}

function porTipo() {
  return db
    .get()
    .prepare(
      `SELECT t.nome AS tipo, COUNT(p.id) AS total
         FROM tipos_processo t
         JOIN processos p ON p.tipo_processo_id = t.id
        GROUP BY t.id
        ORDER BY total DESC, t.nome`
    )
    .all();
}

function impedidos() {
  return db
    .get()
    .prepare(
      `SELECT p.id, p.codigo, p.razao_social, t.nome AS tipo_processo, p.data_previsao,
              s.nome AS setor, c.item, c.descricao_impedimento, c.data_resposta,
              u.nome AS responsavel
         FROM checklist c
         JOIN processos p ON p.id = c.processo_id
         JOIN tipos_processo t ON t.id = p.tipo_processo_id
         JOIN setores s ON s.id = c.setor_id
         LEFT JOIN usuarios u ON u.id = c.responsavel_id
        WHERE c.status_item = 'Impedido'
        ORDER BY c.data_resposta DESC`
    )
    .all();
}

function concluidosNoPeriodo(inicio, fim) {
  return db
    .get()
    .prepare(
      `SELECT p.id, p.codigo, p.razao_social, t.nome AS tipo_processo, p.data_abertura, p.data_conclusao,
              julianday(p.data_conclusao) - julianday(p.data_abertura) AS dias
         FROM processos p
         JOIN tipos_processo t ON t.id = p.tipo_processo_id
         JOIN status_processo st ON st.id = p.status_id
        WHERE st.nome = 'Concluído' AND p.data_conclusao BETWEEN ? AND ?
        ORDER BY p.data_conclusao DESC`
    )
    .all(inicio, fim);
}

function tempoMedioPorTipo() {
  return db
    .get()
    .prepare(
      `SELECT t.nome AS tipo,
              COUNT(*) AS concluidos,
              ROUND(AVG(julianday(p.data_conclusao) - julianday(p.data_abertura)), 1) AS dias_medios
         FROM processos p
         JOIN tipos_processo t ON t.id = p.tipo_processo_id
         JOIN status_processo st ON st.id = p.status_id
        WHERE st.nome = 'Concluído' AND p.data_conclusao IS NOT NULL
        GROUP BY t.id
        ORDER BY dias_medios DESC`
    )
    .all();
}

function produtividadePorSetor(inicio, fim) {
  return db
    .get()
    .prepare(
      `SELECT s.nome AS setor,
              COUNT(*) AS respondidos,
              SUM(CASE WHEN c.status_item = 'Impedido' THEN 1 ELSE 0 END) AS impedimentos,
              SUM(CASE WHEN c.prazo IS NOT NULL AND c.data_resposta > c.prazo THEN 1 ELSE 0 END) AS fora_do_prazo
         FROM checklist c
         JOIN setores s ON s.id = c.setor_id
        WHERE c.data_resposta IS NOT NULL AND date(c.data_resposta) BETWEEN ? AND ?
        GROUP BY s.id
        ORDER BY respondidos DESC`
    )
    .all(inicio, fim);
}

function rankingColaboradores(inicio, fim) {
  return db
    .get()
    .prepare(
      `SELECT u.nome AS colaborador, s.nome AS setor,
              COUNT(*) AS itens_respondidos,
              SUM(CASE WHEN c.status_item = 'Concluído' THEN 1 ELSE 0 END) AS concluidos,
              SUM(CASE WHEN c.status_item = 'Impedido' THEN 1 ELSE 0 END) AS impedimentos,
              SUM(CASE WHEN c.prazo IS NOT NULL AND c.data_resposta <= c.prazo THEN 1 ELSE 0 END) AS no_prazo
         FROM checklist c
         JOIN usuarios u ON u.id = c.responsavel_id
         JOIN setores s ON s.id = u.setor_id
        WHERE c.data_resposta IS NOT NULL AND date(c.data_resposta) BETWEEN ? AND ?
        GROUP BY u.id
        ORDER BY itens_respondidos DESC, concluidos DESC`
    )
    .all(inicio, fim);
}

function indicadores(inicio, fim) {
  const conn = db.get();
  const totais = conn
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN st.final = 0 THEN 1 ELSE 0 END) AS em_andamento,
              SUM(CASE WHEN st.nome = 'Impedido' THEN 1 ELSE 0 END) AS impedidos,
              SUM(CASE WHEN st.nome = 'Concluído' THEN 1 ELSE 0 END) AS concluidos,
              SUM(CASE WHEN st.final = 0 AND p.data_previsao IS NOT NULL AND p.data_previsao < date('now')
                       THEN 1 ELSE 0 END) AS atrasados
         FROM processos p JOIN status_processo st ON st.id = p.status_id`
    )
    .get();
  const concluidosPeriodo = conn
    .prepare(
      `SELECT COUNT(*) AS total,
              ROUND(AVG(julianday(p.data_conclusao) - julianday(p.data_abertura)), 1) AS dias_medios
         FROM processos p JOIN status_processo st ON st.id = p.status_id
        WHERE st.nome = 'Concluído' AND p.data_conclusao BETWEEN ? AND ?`
    )
    .get(inicio, fim);
  const meta = parametros.num('META_PROCESSOS_MES', 0);
  return {
    ...totais,
    concluidos_periodo: concluidosPeriodo.total || 0,
    dias_medios_periodo: concluidosPeriodo.dias_medios || 0,
    meta,
    meta_percentual: meta ? Math.round(((concluidosPeriodo.total || 0) / meta) * 100) : null,
  };
}

/** Monta todos os blocos respeitando as preferências de exibição. */
function montar({ inicio, fim } = {}) {
  const periodo = inicio && fim ? { inicio, fim } : intervaloPadrao();
  const prefs = {
    graficos: parametros.bool('EXIBIR_GRAFICOS', true),
    tempoMedio: parametros.bool('EXIBIR_TEMPO_MEDIO', true),
    impedidos: parametros.bool('EXIBIR_PROCESSOS_IMPEDIDOS', true),
    concluidos: parametros.bool('EXIBIR_PROCESSOS_CONCLUIDOS', true),
    produtividade: parametros.bool('EXIBIR_PRODUTIVIDADE', true),
    ranking: parametros.bool('EXIBIR_RANKING_COLABORADORES', true),
  };
  return {
    periodo,
    prefs,
    indicadores: indicadores(periodo.inicio, periodo.fim),
    porStatus: porStatus(),
    porTipo: porTipo(),
    impedidos: prefs.impedidos ? impedidos() : [],
    concluidos: prefs.concluidos ? concluidosNoPeriodo(periodo.inicio, periodo.fim) : [],
    tempoMedio: prefs.tempoMedio ? tempoMedioPorTipo() : [],
    produtividade: prefs.produtividade ? produtividadePorSetor(periodo.inicio, periodo.fim) : [],
    ranking: prefs.ranking ? rankingColaboradores(periodo.inicio, periodo.fim) : [],
  };
}

module.exports = {
  montar,
  intervaloPadrao,
  porStatus,
  porTipo,
  impedidos,
  concluidosNoPeriodo,
  tempoMedioPorTipo,
  produtividadePorSetor,
  rankingColaboradores,
  indicadores,
};
