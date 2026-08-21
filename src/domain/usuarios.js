'use strict';

const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db');
const { agoraISO } = require('../lib/datas');
const { ErroValidacao } = require('./checklist');

/**
 * Setores de um usuário: os da tabela de ligação **mais** o principal.
 *
 * A união é de propósito. O principal (`usuarios.setor_id`) é obrigatório e
 * está sempre valendo; somá-lo aqui faz a leitura funcionar mesmo para linhas
 * criadas fora do domínio — a carga inicial, um restore antigo — sem depender
 * de ninguém ter sincronizado as duas pontas.
 */
const SETORES_DO_USUARIO = `
  SELECT s.id, s.nome, s.auxiliar
    FROM setores s
   WHERE s.id = (SELECT setor_id FROM usuarios WHERE id = @usuario)
      OR s.id IN (SELECT setor_id FROM usuarios_setores WHERE usuario_id = @usuario)
   ORDER BY s.ordem, s.nome`;

const SELECT = `
  SELECT u.id, u.nome, u.login, u.email, u.perfil, u.status, u.setor_id, u.criado_em, u.ultimo_login,
         s.nome AS setor, s.auxiliar AS setor_auxiliar,
         (SELECT GROUP_CONCAT(x.nome, ' · ') FROM (
             SELECT s2.nome AS nome FROM setores s2
              WHERE s2.id = u.setor_id
                 OR s2.id IN (SELECT setor_id FROM usuarios_setores WHERE usuario_id = u.id)
              ORDER BY s2.ordem, s2.nome) x) AS setores
    FROM usuarios u JOIN setores s ON s.id = u.setor_id`;

/** Lista de setores (id/nome) em que o usuário atua. */
function setoresDe(usuarioId) {
  return db.get().prepare(SETORES_DO_USUARIO).all({ usuario: Number(usuarioId) });
}

/**
 * Grava o conjunto de setores do usuário.
 *
 * O **principal** é o primeiro na ordem geral de setores: é ele que aparece no
 * crachá e nas listagens, e escolher automaticamente evita mais um campo para
 * preencher. Um usuário sem nenhum setor não existe — a validação recusa.
 */
function definirSetores(usuarioId, setorIds) {
  const conn = db.get();
  const pedidos = []
    .concat(setorIds || [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);

  const validos = pedidos.length
    ? conn
        .prepare(
          `SELECT id FROM setores WHERE id IN (${pedidos.map(() => '?').join(',')}) ORDER BY ordem, nome`
        )
        .all(...pedidos)
        .map((s) => s.id)
    : [];
  if (!validos.length) throw new ErroValidacao('Escolha ao menos um setor para o usuário.');

  db.tx(() => {
    conn.prepare('UPDATE usuarios SET setor_id = ? WHERE id = ?').run(validos[0], usuarioId);
    conn.prepare('DELETE FROM usuarios_setores WHERE usuario_id = ?').run(usuarioId);
    const inserir = conn.prepare(
      'INSERT INTO usuarios_setores (usuario_id, setor_id) VALUES (?, ?) ON CONFLICT DO NOTHING'
    );
    validos.forEach((id) => inserir.run(usuarioId, id));
  });
  return validos;
}

/** Setores vindos do formulário: aceita lista, valor único ou "1,2,3". */
function setoresDoFormulario(dados) {
  const bruto = dados.setor_ids !== undefined ? dados.setor_ids : dados.setor_id;
  return []
    .concat(bruto || [])
    .join(',')
    .split(',')
    .map((n) => Number(String(n).trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Normaliza o ID de usuário: minúsculas, sem acento, sem espaço.
 * "Ana Paula" -> "ana.paula"
 */
function normalizarLogin(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/^[.]+|[.]+$/g, '');
}

/** Sugere um ID livre a partir do nome (usado no cadastro de usuários). */
function loginDisponivel(nome) {
  const base = normalizarLogin(nome) || 'usuario';
  let candidato = base;
  let sufixo = 2;
  while (porLogin(candidato)) candidato = `${base}${sufixo++}`;
  return candidato;
}

function listar({ incluirInativos = true } = {}) {
  const where = incluirInativos ? '' : "WHERE u.status = 'Ativo'";
  return db.get().prepare(`${SELECT} ${where} ORDER BY s.ordem, u.nome`).all();
}

function obter(id) {
  return db.get().prepare(`${SELECT} WHERE u.id = ?`).get(id);
}

function porLogin(login) {
  return db.get().prepare(`${SELECT} WHERE u.login = ?`).get(normalizarLogin(login));
}

function porEmail(email) {
  const valor = String(email || '').trim();
  if (!valor) return undefined;
  return db.get().prepare(`${SELECT} WHERE u.email = ?`).get(valor);
}

// Hash sem dono, usado para gastar o mesmo tempo quando o ID não existe.
const HASH_FALSO = bcrypt.hashSync('senha-que-nao-e-de-ninguem', config.bcryptRounds);

/**
 * Autentica pelo ID de usuário. Por conveniência, também aceita o e-mail
 * cadastrado — quem digitar um dos dois entra.
 */
function autenticar(identificador, senha) {
  const entrada = String(identificador || '').trim();
  if (!entrada) return null;
  const usuario = porLogin(entrada) || (entrada.includes('@') ? porEmail(entrada) : undefined);
  if (!usuario) {
    // Confere contra um hash descartável: sem isso, "usuário inexistente"
    // responderia mais rápido que "senha errada" e o tempo de resposta
    // entregaria quais IDs existem.
    bcrypt.compareSync(String(senha || ''), HASH_FALSO);
    return null;
  }
  if (usuario.status !== 'Ativo') return { bloqueado: true };
  const linha = db.get().prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(usuario.id);
  if (!bcrypt.compareSync(String(senha || ''), linha.senha_hash)) return null;
  db.get().prepare('UPDATE usuarios SET ultimo_login = ? WHERE id = ?').run(agoraISO(), usuario.id);
  return usuario;
}

/**
 * Exige um tamanho mínimo (SENHA_MINIMA, 8 por padrão) e recusa as senhas que
 * qualquer lista de ataque tenta primeiro.
 */
const SENHAS_OBVIAS = new Set([
  '12345678', '123456789', 'senha123', 'password', 'password1', 'qwerty123',
  'admin123', 'jsgrilo123', 'contabilidade', '1234567890', 'abcd1234',
]);

function validarSenha(senha, rotulo = 'A senha') {
  const valor = String(senha || '');
  if (valor.length < config.senhaMinima) {
    throw new ErroValidacao(`${rotulo} deve ter ao menos ${config.senhaMinima} caracteres.`);
  }
  if (SENHAS_OBVIAS.has(valor.toLowerCase())) {
    throw new ErroValidacao(`${rotulo} é fácil demais de adivinhar. Escolha outra.`);
  }
  if (/^(.)\1+$/.test(valor)) {
    throw new ErroValidacao(`${rotulo} não pode ser um único caractere repetido.`);
  }
  return valor;
}

function validarLogin(login, idAtual = null) {
  const normalizado = normalizarLogin(login);
  if (!normalizado) throw new ErroValidacao('Informe o ID de usuário (ex.: ana.paula).');
  if (normalizado.length < 3) throw new ErroValidacao('O ID de usuário precisa ter ao menos 3 caracteres.');
  const existente = porLogin(normalizado);
  if (existente && existente.id !== Number(idAtual)) {
    throw new ErroValidacao(`O ID de usuário "${normalizado}" já está em uso.`);
  }
  return normalizado;
}

function validarEmail(email, idAtual = null) {
  const valor = String(email || '').trim().toLowerCase();
  if (!valor) return null; // e-mail é opcional
  const existente = porEmail(valor);
  if (existente && existente.id !== Number(idAtual)) {
    throw new ErroValidacao('Já existe um usuário com este e-mail.');
  }
  return valor;
}

function criar(dados) {
  const { nome, login, email, senha, perfil, status } = dados;
  if (!nome || !nome.trim()) throw new ErroValidacao('Informe o nome.');
  // Sem ID informado, deriva do nome: "Ana Paula" vira "ana.paula".
  const loginFinal = validarLogin(login && login.trim() ? login : loginDisponivel(nome));
  const emailFinal = validarEmail(email);
  validarSenha(senha);

  const setores = setoresDoFormulario(dados);
  if (!setores.length) throw new ErroValidacao('Escolha ao menos um setor para o usuário.');

  const id = db.tx(() => {
    const info = db
      .get()
      .prepare(
        `INSERT INTO usuarios (nome, login, email, senha_hash, setor_id, perfil, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        nome.trim(),
        loginFinal,
        emailFinal,
        bcrypt.hashSync(senha, config.bcryptRounds),
        setores[0],
        perfil === 'Administrador' ? 'Administrador' : 'Usuário',
        status === 'Inativo' ? 'Inativo' : 'Ativo'
      );
    const novoId = Number(info.lastInsertRowid);
    definirSetores(novoId, setores);
    return novoId;
  });
  return obter(id);
}

function atualizar(id, dados) {
  const { nome, login, email, perfil, status, senha } = dados;
  const atual = obter(id);
  if (!atual) throw new ErroValidacao('Usuário não encontrado.');
  const loginFinal = validarLogin(login && String(login).trim() ? login : atual.login, id);
  const emailFinal = validarEmail(email, id);

  // Formulário sem nenhum setor marcado é engano, não intenção de deixar o
  // usuário sem setor nenhum: a validação recusa e nada é gravado.
  const setores = setoresDoFormulario(dados);
  if (!setores.length) throw new ErroValidacao('Escolha ao menos um setor para o usuário.');

  db.get()
    .prepare(
      `UPDATE usuarios SET nome = ?, login = ?, email = ?, perfil = ?, status = ? WHERE id = ?`
    )
    .run(
      String(nome).trim(),
      loginFinal,
      emailFinal,
      perfil === 'Administrador' ? 'Administrador' : 'Usuário',
      status === 'Inativo' ? 'Inativo' : 'Ativo',
      id
    );
  definirSetores(id, setores);

  if (senha && senha.trim()) {
    validarSenha(senha);
    db.get().prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(bcrypt.hashSync(senha, config.bcryptRounds), id);
  }
  return obter(id);
}

function alterarSenha(id, senhaAtual, novaSenha) {
  const linha = db.get().prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(id);
  if (!linha) throw new ErroValidacao('Usuário não encontrado.');
  if (!bcrypt.compareSync(String(senhaAtual || ''), linha.senha_hash)) {
    throw new ErroValidacao('Senha atual incorreta.');
  }
  validarSenha(novaSenha, 'A nova senha');
  db.get().prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(bcrypt.hashSync(novaSenha, config.bcryptRounds), id);
}

module.exports = {
  listar,
  setoresDe,
  definirSetores,
  validarSenha,
  obter,
  porLogin,
  porEmail,
  autenticar,
  criar,
  atualizar,
  alterarSenha,
  normalizarLogin,
  loginDisponivel,
};
