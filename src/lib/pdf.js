'use strict';

const PDFDocument = require('pdfkit');
const { formatarData, formatarDataHora } = require('./datas');

const AZUL = '#12395b';
const CINZA = '#5b6b7a';
const VERDE = '#1d7a4c';
const VERMELHO = '#b3261e';

function cabecalho(doc, titulo, processo) {
  doc.fillColor(AZUL).fontSize(16).font('Helvetica-Bold').text('JS Grilo Contabilidade & Gestão');
  doc.fontSize(11).font('Helvetica').fillColor(CINZA).text(titulo);
  doc.moveDown(0.6);
  doc.fillColor(AZUL).fontSize(13).font('Helvetica-Bold').text(`${processo.codigo} — ${processo.razao_social}`);
  doc.moveDown(0.2);
  doc
    .fontSize(9)
    .font('Helvetica')
    .fillColor(CINZA)
    .text(
      [
        `Tipo: ${processo.tipo_processo}`,
        `Status: ${processo.status}`,
        `Abertura: ${formatarData(processo.data_abertura)}`,
        `Previsão: ${formatarData(processo.data_previsao)}`,
        processo.data_conclusao ? `Conclusão: ${formatarData(processo.data_conclusao)}` : null,
      ]
        .filter(Boolean)
        .join('   ·   ')
    );
  doc.moveDown(0.5);
  linha(doc);
  doc.moveDown(0.6);
}

function linha(doc) {
  const y = doc.y;
  doc.strokeColor('#d6dee6').lineWidth(1).moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y).stroke();
}

function rodape(doc) {
  const faixa = doc.page.height - doc.page.margins.bottom + 12;
  doc
    .fontSize(8)
    .fillColor(CINZA)
    .text(`Documento gerado pela plataforma de processos em ${formatarDataHora(new Date().toISOString())}`,
      doc.page.margins.left, faixa, { align: 'center', width: doc.page.width - doc.page.margins.left * 2 });
}

function corDoStatus(status) {
  if (status === 'Concluído') return VERDE;
  if (status === 'Impedido') return VERMELHO;
  return CINZA;
}

/** PDF do checklist preenchido, agrupado por setor. */
function checklistPDF(processo, grupos, progresso) {
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  cabecalho(doc, 'Checklist do processo', processo);

  doc.fillColor(AZUL).fontSize(10).font('Helvetica-Bold')
    .text(`Progresso: ${progresso.percentual}%  (${progresso.concluidos}/${progresso.total} itens concluídos, ` +
      `${progresso.pendentes} pendente(s), ${progresso.impedidos} impedido(s))`);
  doc.moveDown(0.8);

  for (const grupo of grupos) {
    if (doc.y > doc.page.height - 140) doc.addPage();
    doc.fillColor(AZUL).fontSize(11).font('Helvetica-Bold')
      .text(`${grupo.setor}  (${grupo.concluidos}/${grupo.total})`);
    doc.moveDown(0.3);

    for (const item of grupo.itens) {
      if (doc.y > doc.page.height - 110) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#1b2733')
        .text(`${item.codigo}  ${item.item}${item.obrigatorio ? '' : '  (opcional)'}`);
      doc.font('Helvetica').fontSize(9).fillColor(CINZA);
      doc.text(
        [
          `Resposta: ${item.resposta || '—'}`,
          `Responsável: ${item.responsavel_nome || '—'}`,
          `Data: ${item.data_resposta ? formatarDataHora(item.data_resposta) : '—'}`,
        ].join('   ·   '),
        { indent: 12 }
      );
      doc.fillColor(corDoStatus(item.status_item)).text(`Situação: ${item.status_item}`, { indent: 12 });
      if (item.descricao_impedimento) {
        doc.fillColor(VERMELHO).text(`Impedimento: ${item.descricao_impedimento}`, { indent: 12 });
      }
      if (item.observacao) doc.fillColor(CINZA).text(`Observação: ${item.observacao}`, { indent: 12 });
      doc.moveDown(0.45);
    }
    doc.moveDown(0.3);
  }

  rodape(doc);
  doc.end();
  return doc;
}

/** Relatório final: cadastro, checklist resumido, documentos e histórico. */
function relatorioFinalPDF(processo, grupos, progresso, historico, documentos) {
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  cabecalho(doc, 'Relatório final do processo', processo);

  const dados = [
    ['Nome fantasia', processo.nome_fantasia],
    ['CNPJ', processo.cnpj],
    ['Inscrição estadual', processo.inscricao_estadual],
    ['Inscrição municipal', processo.inscricao_municipal],
    ['Município / UF', [processo.municipio, processo.uf].filter(Boolean).join(' / ')],
    ['Cliente responsável', processo.cliente_responsavel],
    ['Telefone', processo.telefone],
    ['E-mail', processo.email],
    ['Responsável interno', processo.responsavel_interno],
    ['Etapa atual', processo.etapa_atual],
  ];
  doc.fontSize(11).font('Helvetica-Bold').fillColor(AZUL).text('Dados cadastrais');
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica');
  for (const [rotulo, valor] of dados) {
    doc.fillColor(CINZA).text(`${rotulo}: `, { continued: true }).fillColor('#1b2733').text(valor || '—');
  }
  if (processo.observacoes) {
    doc.moveDown(0.3).fillColor(CINZA).text('Observações: ', { continued: true })
      .fillColor('#1b2733').text(processo.observacoes);
  }
  doc.moveDown(0.8);

  doc.fontSize(11).font('Helvetica-Bold').fillColor(AZUL)
    .text(`Checklist — ${progresso.percentual}% concluído`);
  doc.moveDown(0.3).fontSize(9).font('Helvetica');
  for (const grupo of grupos) {
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.fillColor('#1b2733').font('Helvetica-Bold')
      .text(`${grupo.setor} — ${grupo.concluidos}/${grupo.total} concluídos` +
        (grupo.impedidos ? `, ${grupo.impedidos} impedido(s)` : ''));
    doc.font('Helvetica');
    for (const item of grupo.itens) {
      if (doc.y > doc.page.height - 90) doc.addPage();
      doc.fillColor(corDoStatus(item.status_item))
        .text(`[${item.status_item}] ${item.item} — ${item.resposta || 'sem resposta'}` +
          (item.descricao_impedimento ? ` (${item.descricao_impedimento})` : ''), { indent: 12 });
    }
    doc.moveDown(0.35);
  }

  doc.moveDown(0.4);
  if (doc.y > doc.page.height - 160) doc.addPage();
  doc.fontSize(11).font('Helvetica-Bold').fillColor(AZUL).text('Documentos anexados');
  doc.moveDown(0.3).fontSize(9).font('Helvetica').fillColor(CINZA);
  if (!documentos.length) doc.text('Nenhum documento anexado.');
  documentos.forEach((d) =>
    doc.text(`• ${d.nome_original} — ${formatarDataHora(d.criado_em)}${d.descricao ? ` (${d.descricao})` : ''}`)
  );

  doc.moveDown(0.8);
  if (doc.y > doc.page.height - 160) doc.addPage();
  doc.fontSize(11).font('Helvetica-Bold').fillColor(AZUL).text('Histórico / auditoria');
  doc.moveDown(0.3).fontSize(9).font('Helvetica').fillColor(CINZA);
  [...historico].reverse().forEach((h) => {
    if (doc.y > doc.page.height - 80) doc.addPage();
    doc.text(`${formatarDataHora(h.data_hora)} — ${h.acao} — ${h.usuario_nome || 'Sistema'}` +
      (h.observacao ? `: ${h.observacao}` : ''));
  });

  rodape(doc);
  doc.end();
  return doc;
}

module.exports = { checklistPDF, relatorioFinalPDF };
