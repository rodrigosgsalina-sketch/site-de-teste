'use strict';

const express = require('express');
const acesso = require('../domain/acesso');
const checklist = require('../domain/checklist');
const historico = require('../domain/historico');
const notificacoes = require('../domain/notificacoes');
const processos = require('../domain/processos');
const { ErroValidacao } = require('../domain/checklist');

const router = express.Router();

function flash(req, tipo, mensagem) {
  req.session.flash = { tipo, mensagem };
}

function carregarItem(req, res, next) {
  const item = checklist.obterItem(Number(req.params.id));
  if (!item) {
    return res.status(404).render('erro', { titulo: 'Item não encontrado', mensagem: '' });
  }
  if (!acesso.podeEditarItem(req.session.usuario, item)) {
    return res.status(403).render('erro', {
      titulo: 'Acesso negado',
      mensagem: `Este item pertence ao setor ${item.setor}. Você só pode responder itens do seu setor.`,
    });
  }
  req.item = item;
  next();
}

/** Responde um item do checklist. */
router.post('/:id/responder', carregarItem, (req, res, next) => {
  const item = req.item;
  const voltarPara = req.body.retorno || `/processos/${item.processo_id}#setor-${item.setor_id}`;
  try {
    const atualizado = checklist.responder(item.id, req.body, req.session.usuario);

    historico.registrar({
      processoId: item.processo_id,
      acao: atualizado.status_item === 'Impedido' ? `Impedimento — ${item.setor}` : `Aprovação ${item.setor}`,
      usuario: req.session.usuario,
      observacao: `${item.item} → ${atualizado.resposta}` +
        (atualizado.descricao_impedimento ? ` | Impedimento: ${atualizado.descricao_impedimento}` : '') +
        (atualizado.aguardando_conferencia ? ' | Aguardando dupla conferência' : ''),
    });

    const mudanca = processos.recalcularStatus(item.processo_id, req.session.usuario);
    const processo = processos.obter(item.processo_id);

    if (atualizado.status_item === 'Impedido') {
      notificacoes.impedimento(processo, atualizado, req.session.usuario).catch(() => {});
    } else if (mudanca && mudanca.mudou) {
      const setoresPendentes = checklist.setoresPendentes(item.processo_id);
      if (setoresPendentes.length) {
        notificacoes.vezDoSetor(processo, setoresPendentes[0].nome).catch(() => {});
      }
    }

    flash(
      req,
      atualizado.status_item === 'Impedido' ? 'alerta' : 'sucesso',
      atualizado.aguardando_conferencia
        ? `${item.codigo} respondido — aguardando dupla conferência.`
        : `${item.codigo} atualizado.`
    );
    res.redirect(voltarPara);
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect(voltarPara);
    }
    next(err);
  }
});

/** Dupla conferência (EXIGIR_DUPLA_CONFERENCIA). */
router.post('/:id/conferir', carregarItem, (req, res, next) => {
  const item = req.item;
  const voltarPara = req.body.retorno || `/processos/${item.processo_id}#setor-${item.setor_id}`;
  try {
    checklist.conferir(item.id, req.session.usuario);
    historico.registrar({
      processoId: item.processo_id,
      acao: `Conferência ${item.setor}`,
      usuario: req.session.usuario,
      observacao: `${item.item} conferido.`,
    });
    processos.recalcularStatus(item.processo_id, req.session.usuario);
    flash(req, 'sucesso', `${item.codigo} conferido.`);
    res.redirect(voltarPara);
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect(voltarPara);
    }
    next(err);
  }
});

/** Reabre um item respondido. */
router.post('/:id/reabrir', carregarItem, (req, res, next) => {
  const item = req.item;
  const voltarPara = req.body.retorno || `/processos/${item.processo_id}#setor-${item.setor_id}`;
  try {
    checklist.reabrir(item.id);
    historico.registrar({
      processoId: item.processo_id,
      acao: `Item Reaberto — ${item.setor}`,
      usuario: req.session.usuario,
      observacao: `${item.item} voltou para pendente.` + (req.body.motivo ? ` Motivo: ${req.body.motivo}` : ''),
    });
    processos.recalcularStatus(item.processo_id, req.session.usuario);
    flash(req, 'sucesso', `${item.codigo} reaberto.`);
    res.redirect(voltarPara);
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect(voltarPara);
    }
    next(err);
  }
});

/** Fila completa do setor (com filtro opcional). */
router.get('/fila', (req, res) => {
  const usuario = req.session.usuario;
  const setorIds = acesso.setorIdsDoUsuario(usuario);
  const itens = checklist.fila({ setorIds, apenasPendentes: req.query.todos !== '1', limite: 500 });
  res.render('fila', {
    titulo: 'Fila do setor',
    itens,
    todos: req.query.todos === '1',
    setores: acesso.setoresDoUsuario(usuario),
  });
});

module.exports = router;
