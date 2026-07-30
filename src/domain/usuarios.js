'use strict';

const bcrypt = require('bcryptjs');
const db = require('../db');
const { agoraISO } = require('../lib/datas');
const { ErroValidacao } = require('./checklist');

const SELECT = `
  SELECT u.id, u.nome, u.email, u.perfil, u.status, u.setor_id, u.criado_em, u.ultimo_login,
         s.nome AS setor, s.auxiliar AS setor_auxiliar
    FROM usuarios u JOIN setores s ON s.id = u.setor_id`;

function listar({ incluirInativos = true } = {}) {
  const where = incluirInativos ? '' : "WHERE u.status = 'Ativo'";
  return db.get().prepare(`${SELECT} ${where} ORDER BY s.ordem, u.nome`).all();
}

function obter(id) {
  return db.get().prepare(`${SELECT} WHERE u.id = ?`).get(id);
}

function porEmail(email) {
  return db.get().prepare(`${SELECT} WHERE u.email = ?`).get(String(email || '').trim());
}

function autenticar(email, senha) {
  const usuario = porEmail(email);
  if (!usuario) return null;
  if (usuario.status !== 'Ativo') return { bloqueado: true };
  const linha = db.get().prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(usuario.id);
  if (!bcrypt.compareSync(String(senha || ''), linha.senha_hash)) return null;
  db.get().prepare('UPDATE usuarios SET ultimo_login = ? WHERE id = ?').run(agoraISO(), usuario.id);
  return usuario;
}

function criar({ nome, email, senha, setor_id, perfil, status }) {
  if (!nome || !nome.trim()) throw new ErroValidacao('Informe o nome.');
  if (!email || !email.trim()) throw new ErroValidacao('Informe o e-mail.');
  if (!senha || senha.length < 6) throw new ErroValidacao('A senha deve ter ao menos 6 caracteres.');
  if (porEmail(email)) throw new ErroValidacao('Já existe um usuário com este e-mail.');
  const info = db
    .get()
    .prepare(
      `INSERT INTO usuarios (nome, email, senha_hash, setor_id, perfil, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      nome.trim(),
      email.trim().toLowerCase(),
      bcrypt.hashSync(senha, 10),
      Number(setor_id),
      perfil === 'Administrador' ? 'Administrador' : 'Usuário',
      status === 'Inativo' ? 'Inativo' : 'Ativo'
    );
  return obter(Number(info.lastInsertRowid));
}

function atualizar(id, { nome, email, setor_id, perfil, status, senha }) {
  const atual = obter(id);
  if (!atual) throw new ErroValidacao('Usuário não encontrado.');
  const outro = porEmail(email);
  if (outro && outro.id !== Number(id)) throw new ErroValidacao('Já existe um usuário com este e-mail.');
  db.get()
    .prepare(
      `UPDATE usuarios SET nome = ?, email = ?, setor_id = ?, perfil = ?, status = ? WHERE id = ?`
    )
    .run(
      String(nome).trim(),
      String(email).trim().toLowerCase(),
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

module.exports = { listar, obter, porEmail, autenticar, criar, atualizar, alterarSenha };
