'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const config = require('../config');
const csrf = require('../lib/csrf');
const db = require('../db');
const acesso = require('../domain/acesso');
const checklist = require('../domain/checklist');
const clientes = require('../domain/clientes');
const subtipos = require('../domain/subtipos');
const documentosDom = require('../domain/documentos');
const historico = require('../domain/historico');
const notificacoes = require('../domain/notificacoes');
const parametros = require('../domain/parametros');
const processos = require('../domain/processos');
const pdf = require('../lib/pdf');
const { ErroValidacao } = require('../domain/checklist');

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      // O id vem da URL: força número para não virar caminho ("../").
      const dir = path.join(config.uploadsDir, String(Number(req.params.id) || 0));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      // Nome gravado é sempre gerado aqui; o nome enviado pelo usuário só é
      // guardado no banco, para exibição e download.
      const ext = path.extname(documentosDom.nomeSeguro(file.originalname)).toLowerCase().slice(0, 12);
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: config.uploadMaxMb * 1024 * 1024, files: 1, fields: 20 },
  fileFilter: (req, file, cb) => {
    if (!documentosDom.extensaoAceita(file.originalname)) {
      return cb(new ErroValidacao(`Tipo de arquivo não aceito: ${path.extname(file.originalname) || 'sem extensão'}.`));
    }
    cb(null, true);
  },
});

function flash(req, tipo, mensagem) {
  req.session.flash = { tipo, mensagem };
}

function listasAuxiliares() {
  const conn = db.get();
  return {
    tipos: conn.prepare('SELECT id, nome, ativo FROM tipos_processo WHERE ativo = 1 ORDER BY nome').all(),
    statusLista: conn.prepare('SELECT nome, final, espera FROM status_processo ORDER BY ordem').all(),
    responsaveis: conn
      .prepare(
        `SELECT u.id, u.nome, s.nome AS setor FROM usuarios u JOIN setores s ON s.id = u.setor_id
          WHERE u.status = 'Ativo' ORDER BY u.nome`
      )
      .all(),
  };
}

/**
 * O que o seletor de cliente precisa saber ao abrir a tela: quantas empresas
 * existem (para o rótulo e para o estado "nenhuma cadastrada") e a ficha da
 * empresa já escolhida, quando houver.
 *
 * A lista inteira NÃO vai mais no HTML — ela custava 676 KB por carregamento.
 * O seletor consulta /clientes/buscar enquanto o usuário digita.
 */
function dadosDoSeletor(clienteId) {
  return {
    totalClientes: clientes.contarTodos(),
    clienteAtual: clienteId ? clientes.obter(Number(clienteId)) || null : null,
  };
}

/* ------------------------------------------------------------- Listagem */
router.get('/', (req, res) => {
  const usuario = req.session.usuario;
  const setorIds = acesso.setorIdsDoUsuario(usuario);
  const filtros = {
    status: req.query.status || '',
    tipoId: req.query.tipo || '',
    busca: (req.query.q || '').trim(),
    atrasados: req.query.atrasados === '1',
  };
  const lista = processos.listar({
    ...filtros,
    setorIds,
    usuarioId: usuario.id,
  });
  res.render('processos/lista', {
    titulo: 'Processos',
    processos: lista,
    filtros,
    ...listasAuxiliares(),
  });
});

/* --------------------------------------------------------------- Novo */
router.get('/novo', (req, res) => {
  res.render('processos/novo', {
    titulo: 'Abrir processo',
    erro: null,
    valores: { data_abertura: new Date().toISOString().slice(0, 10) },
    prazoPadrao: parametros.num('PRAZO_PADRAO_PROCESSO_DIAS', 15),
    subtiposPorTipo: subtipos.ativosPorTipo(),
    ...dadosDoSeletor(null),
    ...listasAuxiliares(),
  });
});

router.post('/', async (req, res, next) => {
  try {
    const processo = processos.criar(req.body, req.session.usuario);
    // Notificação fora da transação: falha de e-mail não desfaz o processo.
    processos.notificarAbertura(processo.id, req.session.usuario).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[notificações] falha ao avisar abertura:', err.message);
    });
    flash(req, 'sucesso', `Processo ${processo.codigo} criado com o checklist gerado automaticamente.`);
    res.redirect(`/processos/${processo.id}`);
  } catch (err) {
    if (err instanceof ErroValidacao) {
      return res.status(400).render('processos/novo', {
        titulo: 'Abrir processo',
        erro: err.message,
        valores: req.body,
        prazoPadrao: parametros.num('PRAZO_PADRAO_PROCESSO_DIAS', 15),
        subtiposPorTipo: subtipos.ativosPorTipo(),
        ...dadosDoSeletor(req.body.cliente_id),
        ...listasAuxiliares(),
      });
    }
    next(err);
  }
});

/* ------------------------------------------------- Carregamento comum */
function carregar(req, res, next) {
  const id = Number(req.params.id);
  const processo = processos.obter(id);
  if (!processo) {
    return res.status(404).render('erro', { titulo: 'Processo não encontrado', mensagem: 'Verifique o endereço.' });
  }
  if (!acesso.podeVerProcesso(req.session.usuario, id)) {
    return res.status(403).render('erro', {
      titulo: 'Acesso negado',
      mensagem: 'Seu setor não participa deste processo.',
    });
  }
  req.processo = processo;
  next();
}

/* ------------------------------------------------------------ Detalhe */
router.get('/:id', carregar, (req, res) => {
  const usuario = req.session.usuario;
  const processo = req.processo;
  const grupos = checklist.agrupadoPorSetor(processo.id).map((g) => ({
    ...g,
    editavel: acesso.podeEditarItem(usuario, { setor: g.setor }),
  }));
  const problemas = processos.validarConclusao(processo.id, usuario);

  res.render('processos/detalhe', {
    titulo: processo.codigo,
    processo,
    grupos,
    progresso: checklist.progresso(processo.id),
    historico: historico.doProcesso(processo.id),
    documentos: documentosDom.doProcesso(processo.id),
    notificacoes: notificacoes.doProcesso(processo.id).slice(0, 15),
    problemas,
    podeConcluir: problemas.length === 0,
    podeGerenciar: acesso.podeGerenciarProcesso(usuario, processo),
    duplaConferencia: parametros.bool('EXIGIR_DUPLA_CONFERENCIA', false),
    permitirPularEtapas: parametros.bool('PERMITIR_PULAR_ETAPAS', false),
    exigirUpload: parametros.bool('EXIGIR_UPLOAD_DOCUMENTOS', false),
    gerarPdfChecklist: parametros.bool('GERAR_PDF_CHECKLIST', true),
    gerarRelatorioFinal: parametros.bool('GERAR_RELATORIO_FINAL', true),
    ...listasAuxiliares(),
  });
});

/* ------------------------------------------------------------- Edição */
router.get('/:id/editar', carregar, (req, res) => {
  if (!acesso.podeGerenciarProcesso(req.session.usuario, req.processo)) {
    return res.status(403).render('erro', {
      titulo: 'Acesso negado',
      mensagem: 'Somente o responsável pelo processo ou um gestor pode editar o cadastro.',
    });
  }
  res.render('processos/editar', {
    titulo: `Editar ${req.processo.codigo}`,
    processo: req.processo,
    erro: null,
    subtiposDoTipo: subtipos.doTipo(req.processo.tipo_processo_id),
    ...dadosDoSeletor(req.processo.cliente_id),
    ...listasAuxiliares(),
  });
});

router.post('/:id/editar', carregar, (req, res, next) => {
  try {
    if (!acesso.podeGerenciarProcesso(req.session.usuario, req.processo)) {
      throw new ErroValidacao('Sem permissão para editar este processo.');
    }
    processos.atualizar(req.processo.id, req.body, req.session.usuario);
    flash(req, 'sucesso', 'Cadastro atualizado.');
    res.redirect(`/processos/${req.processo.id}`);
  } catch (err) {
    if (err instanceof ErroValidacao) {
      return res.status(400).render('processos/editar', {
        titulo: `Editar ${req.processo.codigo}`,
        processo: { ...req.processo, ...req.body },
        erro: err.message,
        subtiposDoTipo: subtipos.doTipo(req.processo.tipo_processo_id),
        ...dadosDoSeletor(req.body.cliente_id || req.processo.cliente_id),
        ...listasAuxiliares(),
      });
    }
    next(err);
  }
});

/* -------------------------------------------------------- Ações fluxo */
router.post('/:id/status', carregar, (req, res, next) => {
  try {
    processos.definirStatusManual(req.processo.id, req.body.status, req.session.usuario, req.body.observacao);
    flash(req, 'sucesso', `Status alterado para ${req.body.status}.`);
    res.redirect(`/processos/${req.processo.id}`);
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect(`/processos/${req.processo.id}`);
    }
    next(err);
  }
});

router.post('/:id/concluir', carregar, async (req, res, next) => {
  try {
    const processo = processos.concluir(req.processo.id, req.session.usuario, req.body.observacao);
    notificacoes.processoConcluido(processo, req.session.usuario).catch(() => {});
    flash(req, 'sucesso', `Processo ${processo.codigo} concluído.`);
    res.redirect(`/processos/${processo.id}`);
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect(`/processos/${req.processo.id}`);
    }
    next(err);
  }
});

router.post('/:id/cancelar', carregar, (req, res, next) => {
  try {
    if (!acesso.ehGestor(req.session.usuario)) throw new ErroValidacao('Somente gestores podem cancelar processos.');
    processos.cancelar(req.processo.id, req.session.usuario, req.body.motivo);
    flash(req, 'sucesso', 'Processo cancelado.');
    res.redirect(`/processos/${req.processo.id}`);
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect(`/processos/${req.processo.id}`);
    }
    next(err);
  }
});

/**
 * Exclusão definitiva — privativa do administrador.
 *
 * Some tudo do processo: checklist, anexos, histórico e avisos. Por isso não
 * basta clicar: é preciso digitar o número do processo, do mesmo jeito que a
 * restauração de backup pede a palavra "RESTAURAR". Quem quer só encerrar o
 * trabalho usa "Cancelar processo", que mantém tudo legível.
 */
router.post('/:id/excluir', carregar, (req, res, next) => {
  try {
    if (!req.session.usuario || req.session.usuario.perfil !== 'Administrador') {
      throw new ErroValidacao('Somente administradores podem excluir processos.');
    }

    const confirmacao = String(req.body.confirmacao || '').trim().toUpperCase();
    if (confirmacao !== String(req.processo.codigo).toUpperCase()) {
      throw new ErroValidacao(
        `Para excluir, digite o número do processo (${req.processo.codigo}) no campo de confirmação.`
      );
    }

    const { processo, perdidos, arquivosApagados } = processos.remover(
      req.processo.id,
      req.session.usuario,
      req.body.motivo
    );

    flash(
      req,
      'sucesso',
      `Processo ${processo.codigo} excluído: ${perdidos.checklist} item(ns) de checklist, ` +
        `${perdidos.documentos} anexo(s) (${arquivosApagados} arquivo(s) em disco) e ` +
        `${perdidos.historico} registro(s) de histórico foram removidos junto.`
    );
    res.redirect('/processos');
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect(`/processos/${req.params.id}`);
    }
    next(err);
  }
});

router.post('/:id/reabrir', carregar, (req, res, next) => {
  try {
    if (!acesso.ehGestor(req.session.usuario)) throw new ErroValidacao('Somente gestores podem reabrir processos.');
    processos.reabrir(req.processo.id, req.session.usuario, req.body.motivo);
    flash(req, 'sucesso', 'Processo reaberto.');
    res.redirect(`/processos/${req.processo.id}`);
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect(`/processos/${req.processo.id}`);
    }
    next(err);
  }
});

/* ---------------------------------------------------------- Documentos */
router.post('/:id/documentos', carregar, upload.single('arquivo'), csrf.verificar, async (req, res, next) => {
  try {
    if (!req.file) throw new ErroValidacao('Selecione um arquivo.');
    await documentosDom.registrar(req.processo, req.file, req.body.descricao, req.session.usuario);
    flash(req, 'sucesso', 'Documento anexado.');
    res.redirect(`/processos/${req.processo.id}#documentos`);
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect(`/processos/${req.processo.id}#documentos`);
    }
    next(err);
  }
});

router.get('/:id/documentos/:docId', carregar, (req, res) => {
  const doc = documentosDom.obter(Number(req.params.docId));
  if (!doc || doc.processo_id !== req.processo.id) {
    return res.status(404).render('erro', { titulo: 'Documento não encontrado', mensagem: '' });
  }
  const caminho = documentosDom.caminhoAbsoluto(doc);
  if (!fs.existsSync(caminho)) {
    return res.status(404).render('erro', { titulo: 'Arquivo indisponível', mensagem: 'O arquivo não está mais no servidor.' });
  }
  // Sempre como anexo e sem adivinhar o tipo: um arquivo enviado por um
  // usuário nunca é executado no navegador de outro.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.download(caminho, documentosDom.nomeSeguro(doc.nome_original));
});

router.post('/:id/documentos/:docId/excluir', carregar, (req, res, next) => {
  try {
    if (!acesso.podeGerenciarProcesso(req.session.usuario, req.processo)) {
      throw new ErroValidacao('Sem permissão para remover documentos deste processo.');
    }
    documentosDom.remover(Number(req.params.docId), req.processo, req.session.usuario);
    flash(req, 'sucesso', 'Documento removido.');
    res.redirect(`/processos/${req.processo.id}#documentos`);
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect(`/processos/${req.processo.id}#documentos`);
    }
    next(err);
  }
});

/* ------------------------------------------------------------ PDFs */
router.get('/:id/checklist.pdf', carregar, (req, res) => {
  if (!parametros.bool('GERAR_PDF_CHECKLIST', true)) {
    return res.status(403).render('erro', {
      titulo: 'Recurso desativado',
      mensagem: 'A geração de PDF do checklist está desativada em PARAMETROS.',
    });
  }
  const grupos = checklist.agrupadoPorSetor(req.processo.id);
  const doc = pdf.checklistPDF(req.processo, grupos, checklist.progresso(req.processo.id));
  historico.registrar({
    processoId: req.processo.id,
    acao: 'PDF do Checklist Gerado',
    usuario: req.session.usuario,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="checklist-${req.processo.codigo}.pdf"`);
  doc.pipe(res);
});

router.get('/:id/relatorio.pdf', carregar, (req, res) => {
  if (!parametros.bool('GERAR_RELATORIO_FINAL', true)) {
    return res.status(403).render('erro', {
      titulo: 'Recurso desativado',
      mensagem: 'A geração do relatório final está desativada em PARAMETROS.',
    });
  }
  const grupos = checklist.agrupadoPorSetor(req.processo.id);
  const doc = pdf.relatorioFinalPDF(
    req.processo,
    grupos,
    checklist.progresso(req.processo.id),
    historico.doProcesso(req.processo.id),
    documentosDom.doProcesso(req.processo.id)
  );
  historico.registrar({
    processoId: req.processo.id,
    acao: 'Relatório Final Gerado',
    usuario: req.session.usuario,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="relatorio-${req.processo.codigo}.pdf"`);
  doc.pipe(res);
});

module.exports = router;
