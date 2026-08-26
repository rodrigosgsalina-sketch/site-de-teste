'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const config = require('../config');
const csrf = require('../lib/csrf');
const db = require('../db');
const backup = require('../domain/backup');
const subtiposDom = require('../domain/subtipos');
const historico = require('../domain/historico');
const integracoes = require('../domain/integracoes');
const notificacoes = require('../domain/notificacoes');
const ordemSetores = require('../domain/ordem-setores');
const ordemItens = require('../domain/ordem-itens');
const parametros = require('../domain/parametros');
const processos = require('../domain/processos');
const statusProcesso = require('../domain/status-processo');
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
    conferencia: req.session.backupPendente ? req.session.backupPendente.resumo : null,
    backupsSalvos: backupsNoServidor(),
  });
});

router.post('/parametros', (req, res, next) => {
  const lista = parametros.todos();
  let alterados = 0;
  try {
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
  } catch (err) {
    // Endereço em http:// (ou outra validação) desfaz o lote inteiro.
    if (err && err.validacao) {
      flash(req, 'erro', `${err.message} Nenhum parâmetro foi alterado.`);
      return res.redirect('/admin/parametros');
    }
    next(err);
  }
});

/* --------------------------------------------------------- Backup / restauração */

/* Os arquivos enviados ficam num diretório próprio até a confirmação. */
const DIR_RESTAURACOES = path.join(config.backupsDir, 'enviados');

const uploadBackup = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(DIR_RESTAURACOES, { recursive: true });
      cb(null, DIR_RESTAURACOES);
    },
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.json`),
  }),
  limits: { fileSize: 512 * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.json') {
      return cb(new ErroValidacao('Envie o arquivo .json gerado pelo botão "Baixar backup".'));
    }
    cb(null, true);
  },
});

/** Últimas cópias guardadas em data/backups (as automáticas e as manuais). */
function backupsNoServidor(limite = 5) {
  try {
    return fs
      .readdirSync(config.backupsDir)
      .filter((n) => n.endsWith('.json'))
      .map((nome) => {
        const info = fs.statSync(path.join(config.backupsDir, nome));
        return { nome, tamanho: info.size, data: info.mtime.toISOString() };
      })
      .sort((a, b) => b.data.localeCompare(a.data))
      .slice(0, limite);
  } catch (_) {
    return [];
  }
}

function apagarPendente(req) {
  const pendente = req.session.backupPendente;
  if (pendente && pendente.arquivo) {
    try {
      fs.unlinkSync(pendente.arquivo);
    } catch (_) {
      /* já removido */
    }
  }
  delete req.session.backupPendente;
}

/* Download do backup completo. */
router.post('/backup', (req, res, next) => {
  try {
    const incluirArquivos = Boolean(req.body.incluir_arquivos);
    const dados = backup.gerar({ usuario: req.session.usuario, incluirArquivos });
    const nome = backup.nomeDoArquivo();

    historico.registrar({
      processoId: null,
      acao: 'Backup Gerado',
      usuario: req.session.usuario,
      observacao:
        `${nome} — ${Object.values(dados.totais).reduce((a, b) => a + b, 0)} registro(s)` +
        (incluirArquivos ? `, ${dados.arquivos.length} anexo(s)` : ', sem anexos'),
    });

    const corpo = JSON.stringify(dados);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
    res.setHeader('Content-Length', Buffer.byteLength(corpo));
    res.setHeader('Cache-Control', 'no-store');
    res.send(corpo);
  } catch (err) {
    next(err);
  }
});

/* Etapa 1 da restauração: lê o arquivo e mostra a conferência. Nada é gravado. */
router.post('/backup/restaurar', uploadBackup.single('backup'), csrf.verificar, (req, res, next) => {
  try {
    if (!req.file) throw new ErroValidacao('Selecione o arquivo de backup (.json).');
    apagarPendente(req);

    const analise = backup.analisar(fs.readFileSync(req.file.path));
    req.session.backupPendente = {
      arquivo: req.file.path,
      resumo: {
        nomeEnviado: req.file.originalname,
        geradoEm: analise.dados.gerado_em,
        geradoPor: analise.dados.gerado_por,
        versao: analise.dados.versao,
        aplicacao: analise.dados.aplicacao,
        conteudo: analise.conteudo,
        arquivos: analise.arquivos,
        bytesArquivos: analise.bytesArquivos,
        avisos: analise.avisos,
      },
    };
    res.redirect('/admin/parametros#backup');
  } catch (err) {
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (_) {
        /* nada a fazer */
      }
    }
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect('/admin/parametros#backup');
    }
    next(err);
  }
});

/* Etapa 2: confirmação explícita — aqui a plataforma é substituída. */
router.post('/backup/confirmar', (req, res, next) => {
  const pendente = req.session.backupPendente;
  try {
    if (!pendente) throw new ErroValidacao('Nenhum backup aguardando confirmação. Envie o arquivo novamente.');
    if (String(req.body.confirmacao || '').trim().toUpperCase() !== 'RESTAURAR') {
      throw new ErroValidacao('Digite RESTAURAR para confirmar a substituição dos dados.');
    }

    const analise = backup.analisar(fs.readFileSync(pendente.arquivo));
    const usuarioAtual = req.session.usuario;
    const resultado = backup.restaurar(analise.dados, {
      usuario: usuarioAtual,
      restaurarArquivos: !(req.body.ignorar_arquivos === 'on' || req.body.ignorar_arquivos === '1'),
    });

    // O que o arquivo não tinha e foi recomposto entra no relato: a auditoria
    // precisa mostrar que a plataforma acrescentou algo por conta própria.
    const recomposto = [];
    if (resultado.completado.setoresDeUsuario) {
      recomposto.push(`${resultado.completado.setoresDeUsuario} ligação(ões) usuário–setor`);
    }
    if (resultado.completado.parametros.length) {
      recomposto.push(`${resultado.completado.parametros.length} parâmetro(s) novo(s)`);
    }
    if (resultado.completado.avisosSemDestino) {
      recomposto.push(`${resultado.completado.avisosSemDestino} aviso(s) sem destinatário passaram a valer para todos`);
    }

    historico.registrar({
      processoId: null,
      acao: 'Backup Restaurado',
      usuario: usuarioAtual,
      observacao:
        `${pendente.resumo.nomeEnviado} (gerado em ${pendente.resumo.geradoEm}) — ` +
        `${resultado.total} registro(s), ${resultado.arquivosRepostos} anexo(s). ` +
        (recomposto.length ? `Recomposto: ${recomposto.join('; ')}. ` : '') +
        `Cópia do estado anterior: ${path.basename(resultado.copiaDeSeguranca)}.`,
    });

    apagarPendente(req);

    // O usuário logado pode não existir mais no backup restaurado.
    const aindaExiste = usuarios.porLogin(usuarioAtual.login);
    if (!aindaExiste || aindaExiste.status !== 'Ativo') {
      return req.session.destroy(() => res.redirect('/login'));
    }
    req.session.usuario = {
      id: aindaExiste.id,
      nome: aindaExiste.nome,
      login: aindaExiste.login,
      email: aindaExiste.email,
      perfil: aindaExiste.perfil,
      setor: aindaExiste.setor,
      setor_id: aindaExiste.setor_id,
    };

    flash(
      req,
      'sucesso',
      `Backup restaurado: ${resultado.total} registro(s) repostos` +
        (resultado.arquivosRepostos ? ` e ${resultado.arquivosRepostos} anexo(s)` : '') +
        (recomposto.length ? `. Recomposto o que o arquivo não trazia: ${recomposto.join('; ')}` : '') +
        `. O estado anterior foi guardado em ${path.basename(resultado.copiaDeSeguranca)}.`
    );
    res.redirect('/admin/parametros#backup');
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect('/admin/parametros#backup');
    }
    next(err);
  }
});

router.post('/backup/cancelar', (req, res) => {
  apagarPendente(req);
  flash(req, 'sucesso', 'Restauração cancelada. Nenhum dado foi alterado.');
  res.redirect('/admin/parametros#backup');
});

/* --------------------------------------------------------------- Usuários */
router.get('/usuarios', (req, res) => {
  const conn = db.get();
  // Os setores de cada usuário numa consulta só, em vez de uma por linha.
  const porUsuario = new Map();
  for (const linha of conn
    .prepare(
      `SELECT u.id AS usuario_id, s.id AS setor_id
         FROM usuarios u
         JOIN setores s ON s.id = u.setor_id OR s.id IN (
                SELECT setor_id FROM usuarios_setores WHERE usuario_id = u.id)
        ORDER BY u.id, s.ordem`
    )
    .all()) {
    if (!porUsuario.has(linha.usuario_id)) porUsuario.set(linha.usuario_id, []);
    porUsuario.get(linha.usuario_id).push(linha.setor_id);
  }

  res.render('admin/usuarios', {
    titulo: 'Usuários',
    lista: usuarios.listar().map((u) => ({ ...u, setoresIds: porUsuario.get(u.id) || [u.setor_id] })),
    setores: conn.prepare('SELECT id, nome, auxiliar FROM setores ORDER BY ordem').all(),
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
      observacao: `${criado.nome} (${criado.login}) — ${criado.setores}/${criado.perfil}`,
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
      observacao:
        `${atualizado.nome} (${atualizado.login}) — ${atualizado.setores}/` +
        `${atualizado.perfil}/${atualizado.status}`,
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
    titulo: 'Tipos, subtipos, status e setores',
    tipos: conn.prepare('SELECT * FROM tipos_processo ORDER BY ordem, nome').all(),
    subtipos: subtiposDom.listar(),
    status: statusProcesso.listar(),
    coresDeStatus: statusProcesso.CORES,
    setores: conn.prepare('SELECT * FROM setores ORDER BY ordem').all(),
  });
});

/* ------------------------------------------------------ Subtipos de processo */

router.post('/tabelas/subtipos', (req, res, next) => {
  try {
    let mensagem;
    if (req.body.id) {
      const salvo = subtiposDom.atualizar(Number(req.body.id), { nome: req.body.nome, ativo: req.body.ativo });
      mensagem = `Subtipo "${salvo.nome}" salvo.`;
    } else {
      const criado = subtiposDom.criar({ tipo_processo_id: req.body.tipo_processo_id, nome: req.body.nome });
      mensagem = `Subtipo "${criado.nome}" criado em "${criado.tipo.nome}".`;
    }
    historico.registrar({
      processoId: null,
      acao: 'Subtipo de Processo Alterado',
      usuario: req.session.usuario,
      observacao: mensagem,
    });
    flash(req, 'sucesso', mensagem);
    res.redirect('/admin/tabelas');
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect('/admin/tabelas');
    }
    next(err);
  }
});

router.post('/tabelas/subtipos/:id/excluir', (req, res, next) => {
  try {
    const removido = subtiposDom.remover(Number(req.params.id));
    historico.registrar({
      processoId: null,
      acao: 'Subtipo de Processo Excluído',
      usuario: req.session.usuario,
      observacao: removido.nome,
    });
    flash(req, 'sucesso', `Subtipo "${removido.nome}" excluído.`);
    res.redirect('/admin/tabelas');
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect('/admin/tabelas');
    }
    next(err);
  }
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

/* ------------------------------------------------- Situações do processo */

/**
 * Criar, alterar e excluir as situações (status) do processo.
 *
 * O que o motor de status cita pelo nome vem marcado como `sistema`: dessas,
 * só cor e posição são livres. O domínio é que decide isso — aqui a rota
 * apenas leva o formulário e traz a mensagem de volta.
 */
router.post('/tabelas/status', (req, res, next) => {
  try {
    const editando = Boolean(req.body.id);
    const salvo = editando
      ? statusProcesso.atualizar(Number(req.body.id), req.body)
      : statusProcesso.criar(req.body);

    historico.registrar({
      processoId: null,
      acao: editando ? 'Situação de Processo Alterada' : 'Situação de Processo Criada',
      usuario: req.session.usuario,
      observacao:
        `${salvo.nome} — cor ${salvo.cor}` +
        `${salvo.final ? ', encerra o processo' : ''}` +
        `${salvo.espera ? ', espera externa' : ''}` +
        `${salvo.mantem_manual ? ', mantém a escolha manual' : ''}` +
        `${salvo.setor_nome ? `, análise do setor ${salvo.setor_nome}` : ''}.`,
    });
    flash(req, 'sucesso', `Situação "${salvo.nome}" salva.`);
    res.redirect('/admin/tabelas#situacoes');
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect('/admin/tabelas#situacoes');
    }
    next(err);
  }
});

router.post('/tabelas/status/:id/excluir', (req, res, next) => {
  try {
    const removido = statusProcesso.remover(Number(req.params.id));
    historico.registrar({
      processoId: null,
      acao: 'Situação de Processo Excluída',
      usuario: req.session.usuario,
      observacao: removido.nome,
    });
    flash(req, 'sucesso', `Situação "${removido.nome}" excluída.`);
    res.redirect('/admin/tabelas#situacoes');
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect('/admin/tabelas#situacoes');
    }
    next(err);
  }
});

/** Ordem das situações — mesma mecânica de arrastar dos setores e itens. */
router.post('/tabelas/status/ordem', (req, res, next) => {
  const querJson = String(req.headers.accept || '').includes('application/json');
  try {
    const ids = []
      .concat(req.body.status_ids || [])
      .join(',')
      .split(',')
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) throw new ErroValidacao('Informe a ordem das situações.');

    // Só a lista completa: uma lista pela metade deixaria as de fora com
    // números velhos, no meio dos novos.
    const atuais = statusProcesso.listar().map((s) => s.id);
    if (atuais.length !== ids.length || atuais.some((id) => !ids.includes(id))) {
      throw new ErroValidacao('A lista de situações não confere. Recarregue a página.');
    }

    statusProcesso.definirOrdem(ids);
    historico.registrar({
      processoId: null,
      acao: 'Ordem das Situações Alterada',
      usuario: req.session.usuario,
      observacao: statusProcesso.listar().map((s) => s.nome).join(' → '),
    });

    if (querJson) return res.json({ ok: true, ordem: ids });
    flash(req, 'sucesso', 'Ordem das situações atualizada.');
    return res.redirect('/admin/tabelas#situacoes');
  } catch (err) {
    if (err instanceof ErroValidacao) {
      if (querJson) return res.status(400).json({ ok: false, erro: err.message });
      flash(req, 'erro', err.message);
      return res.redirect('/admin/tabelas#situacoes');
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
    subtipo: query.subtipo ? String(query.subtipo) : '',
    setor: query.setor ? String(query.setor) : '',
    q: (query.q || '').trim(),
    obrigatorio: query.obrigatorio === '1' || query.obrigatorio === '0' ? query.obrigatorio : '',
    ativo: query.ativo === '1' || query.ativo === '0' ? query.ativo : '',
  };

  const condicoes = [];
  const args = [];

  if (filtros.tipo === 'todos') {
    condicoes.push('m.tipo_processo_id IS NULL');
    filtros.subtipo = ''; // subtipo mora dentro de um tipo
  } else if (filtros.tipo) {
    // Um tipo específico inclui os itens aplicados a todos os processos.
    condicoes.push('(m.tipo_processo_id = ? OR m.tipo_processo_id IS NULL)');
    args.push(Number(filtros.tipo));
  } else {
    filtros.subtipo = '';
  }

  // Filtrar por subtipo mostra o checklist COMO ELE VAI FICAR num processo
  // daquele subtipo: os itens do subtipo, mais os que valem para o tipo
  // inteiro e para todo processo. Ver só as linhas do subtipo esconderia
  // justamente o que ele herda — e é o conjunto que interessa conferir.
  if (filtros.subtipo) {
    condicoes.push('(m.subtipo_processo_id IS NULL OR m.subtipo_processo_id = ?)');
    args.push(Number(filtros.subtipo));
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

/**
 * Mantém os filtros aplicados ao voltar para a listagem — e a âncora, para
 * quem mexeu nos cartões de ordem voltar a enxergá-los, e não o topo da tela.
 */
function retornoDoModelo(req) {
  const filtros = String(req.body.retorno || '').replace(/[^a-zA-Z0-9=&%._-]/g, '');
  const ancora = String(req.body.ancora || '').replace(/[^a-zA-Z0-9-]/g, '');
  return `/admin/checklist-modelo${filtros ? `?${filtros}` : ''}${ancora ? `#${ancora}` : ''}`;
}

router.get('/checklist-modelo', (req, res) => {
  const conn = db.get();
  const { filtros, where, args } = filtrosDoModelo(req.query);
  const tipoSelecionado = filtros.tipo && filtros.tipo !== 'todos' ? Number(filtros.tipo) : null;

  // Com um tipo escolhido, a listagem sai exatamente como o checklist do
  // processo vai nascer: ordem de atendimento do setor e, dentro dele, a ordem
  // dos itens. Sem tipo, ela mistura tipos diferentes — aí vale agrupar por
  // tipo, que é o que ajuda a ler.
  const posicao = tipoSelecionado
    ? `COALESCE(ost.ordem, 1000 + s.ordem)`
    : `1000 + s.ordem`;
  const juncaoOrdem = tipoSelecionado
    ? `LEFT JOIN ordem_setores_tipo ost ON ost.tipo_processo_id = ${tipoSelecionado} AND ost.setor_id = m.setor_id`
    : '';
  const sequencia = tipoSelecionado
    ? 'posicao_setor, m.ordem, m.id'
    : 'posicao_setor, (m.tipo_processo_id IS NULL), t.ordem, m.ordem, m.id';

  let itens = conn
    .prepare(
      `SELECT m.*, s.nome AS setor, t.nome AS tipo, sub.nome AS subtipo, ${posicao} AS posicao_setor
         FROM checklist_modelo m
         JOIN setores s ON s.id = m.setor_id
         LEFT JOIN tipos_processo t ON t.id = m.tipo_processo_id
         LEFT JOIN subtipos_processo sub ON sub.id = m.subtipo_processo_id
         ${juncaoOrdem}
         ${where}
        ORDER BY ${sequencia}`
    )
    .all(...args);

  if (filtros.q) {
    // Busca tolerante: ignora acento, caixa e plural, e procura no item, no setor
    // e no tipo. Vários termos funcionam como "e" ("debitos federais").
    const termos = paraBusca(filtros.q).split(' ').filter(Boolean);
    itens = itens.filter((m) => {
      const alvo = paraBusca(`${m.item} ${m.setor} ${m.tipo || 'todos os processos'} ${m.subtipo || ''}`);
      return termos.every((t) => alvo.includes(t));
    });
  }

  const total = conn.prepare('SELECT COUNT(*) AS t FROM checklist_modelo').get().t;
  const subtipoSelecionado = filtros.subtipo ? Number(filtros.subtipo) : null;
  const setoresAtivos = conn.prepare('SELECT id, nome, auxiliar FROM setores WHERE ativo = 1 ORDER BY ordem').all();

  const listaSetores = tipoSelecionado ? ordemSetores.doTipo(tipoSelecionado) : [];
  const idsNoTipo = new Set(listaSetores.map((s) => s.id));

  res.render('admin/checklist-modelo', {
    titulo: 'Checklist modelo',
    itens,
    total,
    filtros,
    tipoSelecionado,
    subtipoSelecionado,
    ordemSetores: listaSetores,
    ordemItens: tipoSelecionado ? ordemItens.doTipo(tipoSelecionado) : [],
    // Só faz sentido "adicionar" um setor que ainda não participa do tipo.
    setoresDeFora: tipoSelecionado ? setoresAtivos.filter((s) => !idsNoTipo.has(s.id)) : [],
    // Quantos itens deste tipo cada setor tem — é o que sai ao removê-lo daqui.
    // Os de "todo processo" ficam de fora: eles valem para todos os tipos e não
    // podem ser removidos de um só.
    itensDoTipoPorSetor: tipoSelecionado
      ? conn
          .prepare(
            `SELECT setor_id, COUNT(*) AS total FROM checklist_modelo
              WHERE tipo_processo_id = ? GROUP BY setor_id`
          )
          .all(tipoSelecionado)
          .reduce((mapa, l) => Object.assign(mapa, { [l.setor_id]: l.total }), {})
      : {},
    subtiposDoTipo: tipoSelecionado ? subtiposDom.doTipo(tipoSelecionado) : [],
    tipos: conn.prepare('SELECT id, nome FROM tipos_processo ORDER BY nome').all(),
    tiposComOrdem: ordemSetores.tiposComOrdemPropria(),
    // Inclui os inativos: um item de modelo pode apontar para um subtipo que
    // saiu de circulação, e a linha dele precisa continuar legível.
    subtiposPorTipoLista: subtiposDom.listar().reduce((mapa, sub) => {
      const chave = String(sub.tipo_processo_id);
      if (!mapa[chave]) mapa[chave] = [];
      mapa[chave].push({ id: sub.id, nome: sub.nome + (sub.ativo ? '' : ' (inativo)') });
      return mapa;
    }, {}),
    setores: setoresAtivos,
  });
});

/* Ordem de atendimento dos setores dentro de um tipo de processo. */
function voltarParaOrdem(req, res, tipoId, mensagem) {
  if (mensagem) flash(req, 'sucesso', mensagem);
  res.redirect(`/admin/checklist-modelo?tipo=${tipoId}#ordem`);
}

/**
 * Grava a ordem inteira de uma vez — é o que a tela envia depois de arrastar.
 *
 * Responde JSON: a tela atualiza a numeração sem recarregar, e quem arrastou
 * vê o resultado no lugar onde soltou. Sem JavaScript o formulário comum
 * continua funcionando (o botão "Salvar ordem" faz o POST normal).
 */
router.post('/checklist-modelo/ordem', (req, res, next) => {
  const querJson = String(req.headers.accept || '').includes('application/json');
  try {
    const tipoId = Number(req.body.tipo_processo_id);
    if (!tipoId) throw new ErroValidacao('Informe o tipo de processo.');

    const ids = []
      .concat(req.body.setor_ids || [])
      .join(',')
      .split(',')
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) throw new ErroValidacao('Informe a ordem dos setores.');

    // Só aceita a lista completa dos setores do tipo: uma lista pela metade
    // faria os que ficaram de fora voltarem calados para o fim.
    const atuais = ordemSetores.doTipo(tipoId).map((s) => s.id);
    const faltando = atuais.filter((id) => !ids.includes(id));
    if (faltando.length || ids.some((id) => !atuais.includes(id))) {
      throw new ErroValidacao('A lista de setores não confere com a deste tipo. Recarregue a página.');
    }

    const lista = ordemSetores.definir(tipoId, ids);
    const tipo = db.get().prepare('SELECT nome FROM tipos_processo WHERE id = ?').get(tipoId);
    historico.registrar({
      processoId: null,
      acao: 'Ordem de Setores Alterada',
      usuario: req.session.usuario,
      observacao: `${tipo ? tipo.nome : tipoId}: ${lista.map((s) => s.nome).join(' → ')}`,
    });

    if (querJson) return res.json({ ok: true, ordem: lista.map((s) => ({ id: s.id, nome: s.nome })) });
    return voltarParaOrdem(req, res, tipoId, 'Ordem de atendimento atualizada.');
  } catch (err) {
    if (err instanceof ErroValidacao) {
      if (querJson) return res.status(400).json({ ok: false, erro: err.message });
      flash(req, 'erro', err.message);
      return res.redirect('/admin/checklist-modelo');
    }
    next(err);
  }
});

/**
 * Ordem dos ITENS dentro de um setor, no mesmo formato: a lista inteira de uma
 * vez, JSON para quem arrasta e redirecionamento para quem não tem JavaScript.
 */
router.post('/checklist-modelo/ordem-itens', (req, res, next) => {
  const querJson = String(req.headers.accept || '').includes('application/json');
  try {
    const tipoId = Number(req.body.tipo_processo_id);
    const setorId = Number(req.body.setor_id);
    if (!tipoId || !setorId) throw new ErroValidacao('Informe o tipo de processo e o setor.');

    const ids = []
      .concat(req.body.item_ids || [])
      .join(',')
      .split(',')
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) throw new ErroValidacao('Informe a ordem dos itens.');

    // Mesma regra da ordem dos setores: só a lista completa. Uma lista pela
    // metade deixaria os itens de fora com números velhos, no meio dos novos.
    const atuais = ordemItens.idsDoSetor(tipoId, setorId);
    if (atuais.length !== ids.length || atuais.some((id) => !ids.includes(id))) {
      throw new ErroValidacao('A lista de itens não confere com a deste setor. Recarregue a página.');
    }

    ordemItens.definir(tipoId, setorId, ids);
    const conn = db.get();
    const tipo = conn.prepare('SELECT nome FROM tipos_processo WHERE id = ?').get(tipoId);
    const setor = conn.prepare('SELECT nome FROM setores WHERE id = ?').get(setorId);
    historico.registrar({
      processoId: null,
      acao: 'Ordem de Itens Alterada',
      usuario: req.session.usuario,
      observacao: `${tipo ? tipo.nome : tipoId} · ${setor ? setor.nome : setorId}: ${ids.length} item(ns) reordenados.`,
    });

    if (querJson) return res.json({ ok: true, ordem: ids });
    return voltarParaOrdem(req, res, tipoId, `Ordem dos itens do setor ${setor ? setor.nome : ''} atualizada.`);
  } catch (err) {
    if (err instanceof ErroValidacao) {
      if (querJson) return res.status(400).json({ ok: false, erro: err.message });
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

    // O subtipo só faz sentido dentro de um tipo, e só do tipo escolhido.
    let subtipoId = req.body.subtipo_processo_id ? Number(req.body.subtipo_processo_id) : null;
    if (subtipoId) {
      const subtipo = subtiposDom.obter(subtipoId);
      if (!subtipo) throw new ErroValidacao('Subtipo não encontrado.');
      if (!tipoId || Number(subtipo.tipo_processo_id) !== tipoId) {
        throw new ErroValidacao(
          `O subtipo "${subtipo.nome}" pertence a outro tipo de processo. Escolha o tipo correspondente.`
        );
      }
    }

    if (req.body.id) {
      conn
        .prepare(
          `UPDATE checklist_modelo
              SET tipo_processo_id = ?, subtipo_processo_id = ?, setor_id = ?, item = ?,
                  obrigatorio = ?, ativo = ?
            WHERE id = ?`
        )
        .run(
          tipoId,
          subtipoId,
          setorId,
          item,
          req.body.obrigatorio ? 1 : 0,
          req.body.ativo ? 1 : 0,
          Number(req.body.id)
        );
    } else {
      // Nasce no fim do setor. O "fim" é medido pelo que aparece junto na tela
      // do tipo — os itens dele e os de todo processo —, senão o item novo
      // receberia um número já usado e cairia no meio da lista.
      const ordem = conn
        .prepare(
          `SELECT COALESCE(MAX(ordem), 0) + 1 AS o FROM checklist_modelo
            WHERE setor_id = ? AND (tipo_processo_id IS NULL OR ? IS NULL OR tipo_processo_id = ?)`
        )
        .get(setorId, tipoId, tipoId).o;
      conn
        .prepare(
          `INSERT INTO checklist_modelo
             (tipo_processo_id, subtipo_processo_id, setor_id, item, obrigatorio, ativo, ordem)
           VALUES (?, ?, ?, ?, ?, 1, ?)`
        )
        .run(tipoId, subtipoId, setorId, item, req.body.obrigatorio ? 1 : 0, ordem);
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
      // Volta para a mesma tela filtrada: quem estava montando o checklist de
      // um subtipo não pode perder o lugar por causa de um campo em branco.
      return res.redirect(retornoDoModelo(req));
    }
    next(err);
  }
});

router.post('/checklist-modelo/:id/excluir', (req, res) => {
  const conn = db.get();
  const item = conn
    .prepare(
      `SELECT m.item, s.nome AS setor, t.nome AS tipo
         FROM checklist_modelo m
         JOIN setores s ON s.id = m.setor_id
         LEFT JOIN tipos_processo t ON t.id = m.tipo_processo_id
        WHERE m.id = ?`
    )
    .get(Number(req.params.id));

  conn.prepare('DELETE FROM checklist_modelo WHERE id = ?').run(Number(req.params.id));
  historico.registrar({
    processoId: null,
    acao: 'Checklist Modelo Alterado',
    usuario: req.session.usuario,
    observacao: item
      ? `Item removido de ${item.tipo || 'todos os processos'} · ${item.setor}: "${item.item}".`
      : `Item ${req.params.id} removido.`,
  });
  flash(req, 'sucesso', 'Item removido do modelo (processos já abertos não são afetados).');
  res.redirect(retornoDoModelo(req));
});

/**
 * Tira um setor inteiro de um tipo de processo.
 *
 * "Setor do tipo" não é um cadastro: o setor participa porque tem itens ali.
 * Remover o setor é, portanto, remover os itens dele **daquele tipo** — os
 * itens de "todo processo" ficam, porque valem para todos os tipos e não dá
 * para tirá-los de um só. A tela diz isso antes de confirmar.
 */
router.post('/checklist-modelo/setor/remover', (req, res, next) => {
  try {
    const conn = db.get();
    const tipoId = Number(req.body.tipo_processo_id);
    const setorId = Number(req.body.setor_id);
    if (!tipoId || !setorId) throw new ErroValidacao('Informe o tipo de processo e o setor.');

    const alvo = conn
      .prepare('SELECT COUNT(*) AS total FROM checklist_modelo WHERE tipo_processo_id = ? AND setor_id = ?')
      .get(tipoId, setorId).total;
    if (!alvo) {
      throw new ErroValidacao(
        'Este setor não tem itens próprios deste tipo. Os itens de "todo processo" precisam ser ' +
          'removidos na listagem, porque valem para todos os tipos.'
      );
    }

    conn.prepare('DELETE FROM checklist_modelo WHERE tipo_processo_id = ? AND setor_id = ?').run(tipoId, setorId);
    // A posição guardada do setor sai junto: mantê-la deixaria um lugar
    // reservado para quem não está mais na fila.
    conn
      .prepare('DELETE FROM ordem_setores_tipo WHERE tipo_processo_id = ? AND setor_id = ?')
      .run(tipoId, setorId);

    const tipo = conn.prepare('SELECT nome FROM tipos_processo WHERE id = ?').get(tipoId);
    const setor = conn.prepare('SELECT nome FROM setores WHERE id = ?').get(setorId);
    historico.registrar({
      processoId: null,
      acao: 'Checklist Modelo Alterado',
      usuario: req.session.usuario,
      observacao: `Setor ${setor ? setor.nome : setorId} removido de ${tipo ? tipo.nome : tipoId}: ${alvo} item(ns).`,
    });
    flash(
      req,
      'sucesso',
      `Setor ${setor ? setor.nome : ''} removido deste tipo (${alvo} item(ns)). Processos já abertos não são afetados.`
    );
    res.redirect(retornoDoModelo(req));
  } catch (err) {
    if (err instanceof ErroValidacao) {
      flash(req, 'erro', err.message);
      return res.redirect(retornoDoModelo(req));
    }
    next(err);
  }
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
