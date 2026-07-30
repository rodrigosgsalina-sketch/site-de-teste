'use strict';

/** Utilitários de data. Tudo é gravado em ISO (UTC) no banco. */

function agoraISO() {
  return new Date().toISOString();
}

function hojeISO(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function somarDias(base, dias) {
  const d = base instanceof Date ? new Date(base.getTime()) : new Date(base);
  d.setDate(d.getDate() + Number(dias || 0));
  return d;
}

function somarHoras(base, horas) {
  const d = base instanceof Date ? new Date(base.getTime()) : new Date(base);
  d.setTime(d.getTime() + Number(horas || 0) * 3600 * 1000);
  return d;
}

function diffDias(a, b) {
  const d1 = new Date(a);
  const d2 = new Date(b);
  return Math.round((d2.getTime() - d1.getTime()) / 86400000);
}

/** dd/mm/aaaa */
function formatarData(valor) {
  if (!valor) return '—';
  const d = new Date(valor.length === 10 ? `${valor}T00:00:00` : valor);
  if (Number.isNaN(d.getTime())) return String(valor);
  return d.toLocaleDateString('pt-BR');
}

/** dd/mm/aaaa hh:mm */
function formatarDataHora(valor) {
  if (!valor) return '—';
  const d = new Date(valor.length === 10 ? `${valor}T00:00:00` : valor);
  if (Number.isNaN(d.getTime())) return String(valor);
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

module.exports = { agoraISO, hojeISO, somarDias, somarHoras, diffDias, formatarData, formatarDataHora };
