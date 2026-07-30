'use strict';

const bcrypt = require('bcryptjs');
const db = require('../db');
const { agoraISO } = require('../lib/datas');
const { ErroValidacao } = require('./checklist');

const SELECT = `
  SELECT u.id, u.nome, u.login, u.email, u.perfil, u.status, u.setor_id, u.criado_em, u.ultimo_login,
         s.nome AS setor, s.auxiliar AS setor_auxiliar
    FROM usuarios u JOIN setores s ON s.id = u.setor_id`;

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

/**
 * Autentica pelo ID de usuário. Por conveniência, também aceita o e-mail
 * cadastrado — quem digitar um dos dois entra.
 */
function autenticar(identificador, senha) {
  const entrada = String(identificador || '').trim();
  if (!entrada) return null;
  const usuario = porLogin(entrada) || (entrada.includes('@') ? porEmail(entrada) : undefined);
  if (!usuario) return null;
  if (usuario.status !== 'Ativo') return { bloqueado: true };
  const linha = db.get().prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(usuario.id);
  if (!bcrypt.compareSync(String(senha || ''), linha.senha_hash)) return null;
  db.get().prepare('UPDATE usuarios SET ultimo_login = ? WHERE id = ?').run(agoraISO(), usuario.id);
  return usuario;
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

function criar({ nome, login, email, senha, setor_id, perfil, status }) {
  if (!nome || !nome.trim()) throw new ErroValidacao('Informe o nome.');
  // Sem ID informado, deriva do nome: "Ana Paula" vira "ana.paula".
  const loginFinal = validarLogin(login && login.trim() ? login : loginDisponivel(nome));
  const emailFinal = validarEmail(email);
  if (!senha || senha.length < 6) throw new ErroValidacao('A senha deve ter ao menos 6 caracteres.');

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
      bcrypt.hashSync(senha, 10),
      Number(setor_id),
      perfil === 'Administrador' ? 'Administrador' : 'Usuário',
      status === 'Inativo' ? 'Inativo' : 'Ativo'
    );
  return obter(Number(info.lastInsertRowid));
}

function atualizar(id, { nome, login, email, setor_id, perfil, status, senha }) {
  const atual = obter(id);
  if (!atual) throw new ErroValidacao('Usuário não encontrado.');
  const loginFinal = validarLogin(login && String(login).trim() ? login : atual.login, id);
  const emailFinal = validarEmail(email, id);

  db.get()
    .prepare(
      `UPDATE usuarios SET nome = ?, login = ?, email = ?, setor_id = ?, perfil = ?, status = ? WHERE id = ?`
    )
    .run(
      String(nome).trim(),
      loginFinal,
      emailFinal,
      Number(setor_id),
      perfil === 'Administrador' ? 'Administrador' : 'Usuário',
      status === 'Inativo' ? 'Inativo' : 'Ativo',
      id
    );

  if (senha && senha.trim()) {
    if (senha.length < 6) throw new ErroValidacao('A senha deve ter ao menos 6 caracteres.');
    db.get().prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(bcrypt.hashSync(senha, 10), id);
  }
  return obter(id);
}

function alterarSenha(id, senhaAtual, novaSenha) {
  const linha = db.get().prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(id);
  if (!linha) throw new ErroValidacao('Usuário não encontrado.');
  if (!bcrypt.compareSync(String(senhaAtual || ''), linha.senha_hash)) {
    throw new ErroValidacao('Senha atual incorreta.');
  }
  if (!novaSenha || novaSenha.length < 6) throw new ErroValidacao('A nova senha deve ter ao menos 6 caracteres.');
  db.get().prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(bcrypt.hashSync(novaSenha, 10), id);
}

module.exports = {
  listar,
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
