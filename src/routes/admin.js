'use strict';

const express = require('express');
const db = require('../db');
const historico = require('../domain/historico');
const integracoes = require('../domain/integracoes');
const notificacoes = require('../domain/notificacoes');
const ordemSetores = require('../domain/ordem-setores');
const parametros = require('../domain/parametros');
const processos = require('../domain/processos');
const usuarios = require('../domain/usuarios');
const { ErroValidacao } = require('../domain/checklist');

const router = express.Router();

function flash(req, tipo, mensagem) {
  req.session.flash = { tipo, mensagem };
}

router.get('/', (req, res) => {
  const conn = db.get();
  const contagem = (tabela) => conn.prepare(`SELECT COUNT(*) AS t FROM ${tabela}`).get().t;
  res.render('admin/index', {
    titulo: 'Administração',
    resumo: {
      tipos: contagem('tipos_processo'),
      status: contagem('status_processo'),
      setores: contagem('setores'),
      usuarios: contagem('usuarios'),
      modelo: contagem('checklist_modelo'),
      parametros: contagem('parametros'),
      processos: contagem('processos'),
    },
    integracoes: integracoes.listar(),
  });
});

/* ------------------------------------------------------------ Parâmetros */
router.get('/parametros', (req, res) => {
  res.render('admin/parametros', {
    titulo: 'Parâmetros do sistema',
    grupos: [...parametros.porCategoria().entries()],
  });
});

router.post('/parametros', (req, res) => {
  const lista = parametros.todos();
  let alterados = 0;
  db.tx(() => {
    for (const p of lista) {
      if (!p.editavel) continue;
      let novo;
      if (p.tipo === 'booleano') {
        novo = req.body[`campo__${p.chave}`] ? 'Sim' : 'Não';
      } else if (Object.prototype.hasOwnProperty.call(req.body, `campo__${p.chave}`)) {
        novo = String(req.body[`campo__${p.chave}`]).trim();
      } else {
        continue;
      }
      if (novo !== (p.valor || '')) {
        parametros.definir(p.chave, novo);
        alterados += 1;
        historico.registrar({
          processoId: null,
          acao: 'Parâmetro Alterado',
          usuario: req.session.usuario,
          observacao: `${p.chave}: "${p.valor}" → "${novo}"`,
        });
      }
    }
  });
  flash(req, 'sucesso', alterados ? `${alterados} parâmetro(s) atualizado(s).` : 'Nenhuma alteração.');
  res.redirect('/admin/parametros');
});

/* --------------------------------------------------------------- Usuários */
router.get('/usuarios', (req, res) => {
  res.render('admin/usuarios', {
    titulo: 'Usuários',
    lista: usuarios.listar(),
    setores: db.get().prepare('SELECT id, nome, auxiliar FROM setores ORDER BY ordem').all(),
    erro: null,
  });
});

router.post('/usuarios', (req, res, next) => {
  try {
    const criado = usuarios.criar(req.body);
    historico.registrar({
      processoId: null,
      acao: 'Usuário Criado',
      usuario: req.session.usuario,
      observacao: `${criado.nome} (${criado.login}) — ${criado.setor}/${criado.perfil}`,
    });
    flash(req, 'sucesso', `Usuário ${criado.nome} criado.`);
    res.redirect('/admin/usuarios');
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect('/admin/usuarios');
    }
    next(err);
  }
});

router.post('/usuarios/:id', (req, res, next) => {
  try {
    const atualizado = usuarios.atualizar(Number(req.params.id), req.body);
    historico.registrar({
      processoId: null,
      acao: 'Usuário Atualizado',
      usuario: req.session.usuario,
      observacao: `${atualizado.nome} (${atualizado.login}) — ${atualizado.setor}/${atualizado.perfil}/${atualizado.status}`,
    });
    flash(req, 'sucesso', `Usuário ${atualizado.nome} atualizado.`);
    res.redirect('/admin/usuarios');
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect('/admin/usuarios');
    }
    next(err);
  }
});

/* ------------------------------------------------- Tipos / Status / Setores */
router.get('/tabelas', (req, res) => {
  const conn = db.get();
  res.render('admin/tabelas', {
    titulo: 'Tipos, status e setores',
    tipos: conn.prepare('SELECT * FROM tipos_processo ORDER BY ordem, nome').all(),
    status: conn.prepare('SELECT * FROM status_processo ORDER BY ordem').all(),
    setores: conn.prepare('SELECT * FROM setores ORDER BY ordem').all(),
  });
});

router.post('/tabelas/tipos', (req, res, next) => {
  try {
    const conn = db.get();
    const nome = String(req.body.nome || '').trim();
    if (req.body.id) {
      if (!nome) throw new ErroValidacao('Informe o nome do tipo.');
      conn
        .prepare('UPDATE tipos_processo SET nome = ?, ativo = ? WHERE id = ?')
        .run(nome, req.body.ativo ? 1 : 0, Number(req.body.id));
    } else {
      if (!nome) throw new ErroValidacao('Informe o nome do tipo.');
      if (conn.prepare('SELECT 1 FROM tipos_processo WHERE nome = ?').get(nome)) {
        throw new ErroValidacao('Já existe um tipo com esse nome.');
      }
      const ordem = conn.prepare('SELECT COALESCE(MAX(ordem), 0) + 1 AS o FROM tipos_processo').get().o;
      conn.prepare('INSERT INTO tipos_processo (nome, ativo, ordem) VALUES (?, 1, ?)').run(nome, ordem);
    }
    historico.registrar({
      processoId: null,
      acao: 'Tipo de Processo Alterado',
      usuario: req.session.usuario,
      observacao: nome,
    });
    flash(req, 'sucesso', 'Tipo de processo salvo.');
    res.redirect('/admin/tabelas');
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect('/admin/tabelas');
    }
    next(err);
  }
});

router.post('/tabelas/setores', (req, res, next) => {
  try {
    const conn = db.get();
    const nome = String(req.body.nome || '').trim();
    if (!nome) throw new ErroValidacao('Informe o nome do setor.');
    if (req.body.id) {
      conn
        .prepare('UPDATE setores SET nome = ?, ativo = ?, auxiliar = ? WHERE id = ?')
        .run(nome, req.body.ativo ? 1 : 0, req.body.auxiliar ? 1 : 0, Number(req.body.id));
    } else {
      if (conn.prepare('SELECT 1 FROM setores WHERE nome = ?').get(nome)) {
        throw new ErroValidacao('Já existe um setor com esse nome.');
      }
      const ordem = conn.prepare('SELECT COALESCE(MAX(ordem), 0) + 1 AS o FROM setores').get().o;
      conn
        .prepare('INSERT INTO setores (nome, auxiliar, ativo, ordem) VALUES (?, ?, 1, ?)')
        .run(nome, req.body.auxiliar ? 1 : 0, ordem);
    }
    flash(req, 'sucesso', 'Setor salvo.');
    res.redirect('/admin/tabelas');
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect('/admin/tabelas');
    }
    next(err);
  }
});

/* --------------------------------------------------------- Checklist modelo */

/** Sem acento e sem caixa. */
function semAcento(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Reduz a palavra ao radical aproximado para que a busca não dependa de plural
 * nem de acento: "Certidões" e "certidao" chegam ambos a "certidao".
 */
function radical(palavra) {
  return palavra.replace(/(oes|aes|aos)$/, 'ao').replace(/s$/, '');
}

/** Texto comparável usado pela busca do checklist modelo. */
function paraBusca(texto) {
  return semAcento(texto)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(radical)
    .join(' ');
}

/** Lê os filtros da querystring e devolve WHERE + argumentos. */
function filtrosDoModelo(query) {
  const filtros = {
    tipo: query.tipo === undefined ? '' : String(query.tipo),
    setor: query.setor ? String(query.setor) : '',
    q: (query.q || '').trim(),
    obrigatorio: query.obrigatorio === '1' || query.obrigatorio === '0' ? query.obrigatorio : '',
    ativo: query.ativo === '1' || query.ativo === '0' ? query.ativo : '',
  };

  const condicoes = [];
  const args = [];

  if (filtros.tipo === 'todos') {
    condicoes.push('m.tipo_processo_id IS NULL');
  } else if (filtros.tipo) {
    // Um tipo específico inclui os itens aplicados a todos os processos.
    condicoes.push('(m.tipo_processo_id = ? OR m.tipo_processo_id IS NULL)');
    args.push(Number(filtros.tipo));
  }
  if (filtros.setor) {
    condicoes.push('m.setor_id = ?');
    args.push(Number(filtros.setor));
  }
  if (filtros.obrigatorio) {
    condicoes.push('m.obrigatorio = ?');
    args.push(Number(filtros.obrigatorio));
  }
  if (filtros.ativo) {
    condicoes.push('m.ativo = ?');
    args.push(Number(filtros.ativo));
  }

  return { filtros, where: condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '', args };
}

/** Mantém os filtros aplicados ao voltar para a listagem. */
function retornoDoModelo(req) {
  const filtros = String(req.body.retorno || '').replace(/[^a-zA-Z0-9=&%._-]/g, '');
  return `/admin/checklist-modelo${filtros ? `?${filtros}` : ''}`;
}

router.get('/checklist-modelo', (req, res) => {
  const conn = db.get();
  const { filtros, where, args } = filtrosDoModelo(req.query);
  const tipoSelecionado = filtros.tipo && filtros.tipo !== 'todos' ? Number(filtros.tipo) : null;

  // Com um tipo escolhido, a listagem já segue a ordem de atendimento dele.
  const posicao = tipoSelecionado
    ? `COALESCE(ost.ordem, 1000 + s.ordem)`
    : `1000 + s.ordem`;
  const juncaoOrdem = tipoSelecionado
    ? `LEFT JOIN ordem_setores_tipo ost ON ost.tipo_processo_id = ${tipoSelecionado} AND ost.setor_id = m.setor_id`
    : '';

  let itens = conn
    .prepare(
      `SELECT m.*, s.nome AS setor, t.nome AS tipo, ${posicao} AS posicao_setor
         FROM checklist_modelo m
         JOIN setores s ON s.id = m.setor_id
         LEFT JOIN tipos_processo t ON t.id = m.tipo_processo_id
         ${juncaoOrdem}
         ${where}
        ORDER BY posicao_setor, (m.tipo_processo_id IS NULL), t.ordem, m.ordem, m.id`
    )
    .all(...args);

  if (filtros.q) {
    // Busca tolerante: ignora acento, caixa e plural, e procura no item, no setor
    // e no tipo. Vários termos funcionam como "e" ("debitos federais").
    const termos = paraBusca(filtros.q).split(' ').filter(Boolean);
    itens = itens.filter((m) => {
      const alvo = paraBusca(`${m.item} ${m.setor} ${m.tipo || 'todos os processos'}`);
      return termos.every((t) => alvo.includes(t));
    });
  }

  const total = conn.prepare('SELECT COUNT(*) AS t FROM checklist_modelo').get().t;

  res.render('admin/checklist-modelo', {
    titulo: 'Checklist modelo',
    itens,
    total,
    filtros,
    tipoSelecionado,
    ordemSetores: tipoSelecionado ? ordemSetores.doTipo(tipoSelecionado) : [],
    tipos: conn.prepare('SELECT id, nome FROM tipos_processo ORDER BY nome').all(),
    tiposComOrdem: ordemSetores.tiposComOrdemPropria(),
    setores: conn.prepare('SELECT id, nome, auxiliar FROM setores WHERE ativo = 1 ORDER BY ordem').all(),
  });
});

/* Ordem de atendimento dos setores dentro de um tipo de processo. */
function voltarParaOrdem(req, res, tipoId, mensagem) {
  if (mensagem) flash(req, 'sucesso', mensagem);
  res.redirect(`/admin/checklist-modelo?tipo=${tipoId}#ordem`);
}

router.post('/checklist-modelo/ordem/mover', (req, res, next) => {
  try {
    const tipoId = Number(req.body.tipo_processo_id);
    const setorId = Number(req.body.setor_id);
    const direcao = req.body.direcao === 'cima' ? -1 : 1;
    if (!tipoId || !setorId) throw new ErroValidacao('Informe o tipo e o setor.');

    const lista = ordemSetores.mover(tipoId, setorId, direcao);
    const tipo = db.get().prepare('SELECT nome FROM tipos_processo WHERE id = ?').get(tipoId);
    historico.registrar({
      processoId: null,
      acao: 'Ordem de Setores Alterada',
      usuario: req.session.usuario,
      observacao: `${tipo ? tipo.nome : tipoId}: ${lista.map((s) => s.nome).join(' → ')}`,
    });
    voltarParaOrdem(req, res, tipoId, 'Ordem de atendimento atualizada.');
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect('/admin/checklist-modelo');
    }
    next(err);
  }
});

router.post('/checklist-modelo/ordem/limpar', (req, res) => {
  const tipoId = Number(req.body.tipo_processo_id);
  ordemSetores.limpar(tipoId);
  const tipo = db.get().prepare('SELECT nome FROM tipos_processo WHERE id = ?').get(tipoId);
  historico.registrar({
    processoId: null,
    acao: 'Ordem de Setores Alterada',
    usuario: req.session.usuario,
    observacao: `${tipo ? tipo.nome : tipoId}: ordem personalizada removida (volta ao padrão).`,
  });
  voltarParaOrdem(req, res, tipoId, 'O tipo voltou a seguir a ordem geral dos setores.');
});

router.post('/checklist-modelo', (req, res, next) => {
  try {
    const conn = db.get();
    const item = String(req.body.item || '').trim();
    if (!item) throw new ErroValidacao('Descreva o item do checklist.');
    const tipoId = req.body.tipo_processo_id === 'todos' || !req.body.tipo_processo_id
      ? null
      : Number(req.body.tipo_processo_id);
    const setorId = Number(req.body.setor_id);
    if (!setorId) throw new ErroValidacao('Selecione o setor responsável.');

    if (req.body.id) {
      conn
        .prepare(
          `UPDATE checklist_modelo
              SET tipo_processo_id = ?, setor_id = ?, item = ?, obrigatorio = ?, ativo = ?
            WHERE id = ?`
        )
        .run(tipoId, setorId, item, req.body.obrigatorio ? 1 : 0, req.body.ativo ? 1 : 0, Number(req.body.id));
    } else {
      const ordem = conn
        .prepare(
          `SELECT COALESCE(MAX(ordem), 0) + 1 AS o FROM checklist_modelo
            WHERE setor_id = ? AND ((tipo_processo_id IS NULL AND ? IS NULL) OR tipo_processo_id = ?)`
        )
        .get(setorId, tipoId, tipoId).o;
      conn
        .prepare(
          `INSERT INTO checklist_modelo (tipo_processo_id, setor_id, item, obrigatorio, ativo, ordem)
           VALUES (?, ?, ?, ?, 1, ?)`
        )
        .run(tipoId, setorId, item, req.body.obrigatorio ? 1 : 0, ordem);
    }
    historico.registrar({
      processoId: null,
      acao: 'Checklist Modelo Alterado',
      usuario: req.session.usuario,
      observacao: item,
    });
    flash(req, 'sucesso', 'Item do checklist modelo salvo. Novos processos já usarão a alteração.');
    res.redirect(retornoDoModelo(req));
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect('/admin/checklist-modelo');
    }
    next(err);
  }
});

router.post('/checklist-modelo/:id/excluir', (req, res) => {
  db.get().prepare('DELETE FROM checklist_modelo WHERE id = ?').run(Number(req.params.id));
  historico.registrar({
    processoId: null,
    acao: 'Checklist Modelo Alterado',
    usuario: req.session.usuario,
    observacao: `Item ${req.params.id} removido.`,
  });
  flash(req, 'sucesso', 'Item removido do modelo (processos já abertos não são afetados).');
  res.redirect(retornoDoModelo(req));
});

/* ------------------------------------------------ Notificações e auditoria */
router.get('/notificacoes', (req, res) => {
  res.render('admin/notificacoes', {
    titulo: 'Notificações',
    lista: notificacoes.listar(200),
    integracoes: integracoes.listar(),
  });
});

router.post('/alertas/executar', async (req, res, next) => {
  try {
    const resultado = await processos.verificarPrazos();
    flash(
      req,
      'sucesso',
      `Verificação concluída: ${resultado.avaliados} processo(s) em alerta, ${resultado.notificados} notificação(ões) enviada(s).`
    );
    res.redirect('/admin/notificacoes');
  } catch (err) {
    next(err);
  }
});

router.get('/auditoria', (req, res) => {
  res.render('admin/auditoria', { titulo: 'Auditoria', lista: historico.recentes(300) });
});

module.exports = router;
