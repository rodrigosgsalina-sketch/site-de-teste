#!/usr/bin/env node
'use strict';

/**
 * Carga inicial do banco a partir do modelo definido em Processos.xlsx.
 * Idempotente: pode ser executado novamente sem duplicar registros.
 *
 *   npm run seed          -> apenas as tabelas de domínio e usuários
 *   npm run seed:demo     -> também cria processos de demonstração
 */

const bcrypt = require('bcryptjs');
const db = require('../src/db');
const config = require('../src/config');
const dados = require('../src/db/seed-data');

function upsertSetores(conn) {
  const inserir = conn.prepare(
    `INSERT INTO setores (nome, auxiliar, ordem) VALUES (@nome, @auxiliar, @ordem)
     ON CONFLICT (nome) DO UPDATE SET auxiliar = excluded.auxiliar, ordem = excluded.ordem`
  );
  dados.SETORES.forEach((s) => inserir.run(s));
}

function upsertTipos(conn) {
  const inserir = conn.prepare(
    `INSERT INTO tipos_processo (nome, ativo, ordem) VALUES (@nome, @ativo, @ordem)
     ON CONFLICT (nome) DO UPDATE SET ordem = excluded.ordem`
  );
  dados.TIPOS_PROCESSO.forEach((t) => inserir.run(t));
}

function upsertStatus(conn) {
  const inserir = conn.prepare(
    `INSERT INTO status_processo (nome, ordem, final, espera) VALUES (@nome, @ordem, @final, @espera)
     ON CONFLICT (nome) DO UPDATE SET ordem = excluded.ordem, final = excluded.final, espera = excluded.espera`
  );
  dados.STATUS_PROCESSO.forEach((s) => inserir.run(s));
}

function upsertParametros(conn) {
  const existe = conn.prepare('SELECT valor FROM parametros WHERE chave = ?');
  const inserir = conn.prepare(
    `INSERT INTO parametros (chave, valor, tipo, categoria, descricao)
     VALUES (@chave, @valor, @tipo, @categoria, @descricao)`
  );
  // Metadados (tipo/categoria/descrição) são sempre atualizados; o VALOR só é
  // gravado na primeira carga, para não desfazer ajustes feitos na tela de admin.
  const atualizarMeta = conn.prepare(
    'UPDATE parametros SET tipo = @tipo, categoria = @categoria, descricao = @descricao WHERE chave = @chave'
  );
  dados.PARAMETROS.forEach((p) => {
    if (existe.get(p.chave)) atualizarMeta.run(p);
    else inserir.run(p);
  });
}

function upsertChecklistModelo(conn) {
  const idSetor = conn.prepare('SELECT id FROM setores WHERE nome = ?');
  const idTipo = conn.prepare('SELECT id FROM tipos_processo WHERE nome = ?');
  const jaExiste = conn.prepare(
    `SELECT id FROM checklist_modelo
      WHERE item = ? AND setor_id = ? AND ((tipo_processo_id IS NULL AND ? IS NULL) OR tipo_processo_id = ?)`
  );
  const inserir = conn.prepare(
    `INSERT INTO checklist_modelo (tipo_processo_id, setor_id, item, obrigatorio, ordem)
     VALUES (?, ?, ?, ?, ?)`
  );
  const contadorPorGrupo = new Map();
  dados.CHECKLIST_MODELO.forEach((m) => {
    const setor = idSetor.get(m.setor);
    if (!setor) throw new Error(`Setor inexistente no seed: ${m.setor}`);
    const tipoId = m.tipo ? idTipo.get(m.tipo).id : null;
    const chave = `${tipoId}|${setor.id}`;
    const ordem = (contadorPorGrupo.get(chave) || 0) + 1;
    contadorPorGrupo.set(chave, ordem);
    if (jaExiste.get(m.item, setor.id, tipoId, tipoId)) return;
    inserir.run(tipoId, setor.id, m.item, m.obrigatorio, ordem);
  });
}

function upsertUsuarios(conn) {
  const idSetor = conn.prepare('SELECT id FROM setores WHERE nome = ?');
  const existe = conn.prepare('SELECT id FROM usuarios WHERE login = ? OR email = ?');
  const inserir = conn.prepare(
    `INSERT INTO usuarios (nome, login, email, senha_hash, setor_id, perfil, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const hash = bcrypt.hashSync(config.senhaPadrao, 10);
  dados.USUARIOS.forEach((u) => {
    if (existe.get(u.login, u.email)) return;
    const setor = idSetor.get(u.setor);
    if (!setor) throw new Error(`Setor inexistente para o usuário ${u.nome}: ${u.setor}`);
    inserir.run(u.nome, u.login, u.email, hash, setor.id, u.perfil, u.status);
  });
}

function demo(conn) {
  const processos = require('../src/domain/processos');
  const checklist = require('../src/domain/checklist');
  const clientes = require('../src/domain/clientes');
  const usuarios = require('../src/domain/usuarios');

  if (conn.prepare('SELECT COUNT(*) AS t FROM processos').get().t > 0) {
    console.log('• Processos de demonstração já existem — nada a fazer.');
    return;
  }
  const admin = usuarios.porLogin('jacqueline') || usuarios.listar()[0];
  const tipos = conn.prepare('SELECT id, nome FROM tipos_processo ORDER BY id').all();
  const porNome = (n) => tipos.find((t) => t.nome === n);

  // O processo é sempre aberto para um cliente do cadastro: as empresas de
  // demonstração entram primeiro em CLIENTES.
  const amostras = [
    { tipo: 'Baixa de Empresa', codigo: '9001', nome: 'Padaria Pão Quente', razao_social: 'Padaria Pão Quente Ltda', nome_fantasia: 'Pão Quente', cnpj_cpf: '12.345.678/0001-90', municipio: 'Teresina', uf: 'PI', responsavel_legal: 'Marcos Andrade', telefone: '(86) 99999-1010', email: 'marcos@paoquente.com.br' },
    { tipo: 'Constituição de Empresa', codigo: '9002', nome: 'Studio Vega Arquitetura', razao_social: 'Studio Vega Arquitetura Ltda', nome_fantasia: 'Studio Vega', cnpj_cpf: '', municipio: 'Teresina', uf: 'PI', responsavel_legal: 'Renata Vega', telefone: '(86) 98888-2020', email: 'renata@studiovega.com.br' },
    { tipo: 'Alteração de Endereço', codigo: '9003', nome: 'Transportes Rio Norte', razao_social: 'Transportes Rio Norte S.A.', nome_fantasia: 'Rio Norte', cnpj_cpf: '98.765.432/0001-10', municipio: 'Timon', uf: 'MA', responsavel_legal: 'Paulo Rocha', telefone: '(99) 97777-3030', email: 'paulo@rionorte.com.br' },
    { tipo: 'Entrada de Sócio', codigo: '9004', nome: 'Clínica Bem Viver', razao_social: 'Clínica Bem Viver Ltda', nome_fantasia: 'Bem Viver', cnpj_cpf: '11.222.333/0001-44', municipio: 'Teresina', uf: 'PI', responsavel_legal: 'Dra. Helena Lima', telefone: '(86) 96666-4040', email: 'helena@bemviver.com.br' },
    { tipo: 'Emissão de Certidões', codigo: '9005', nome: 'Mercantil Sertão', razao_social: 'Mercantil Sertão Eireli', nome_fantasia: 'Sertão Distribuidora', cnpj_cpf: '22.333.444/0001-55', municipio: 'Picos', uf: 'PI', responsavel_legal: 'Antônio Barros', telefone: '(89) 95555-5050', email: 'antonio@sertao.com.br' },
  ];

  amostras.forEach((a) => {
    const cliente = clientes.porCodigo(a.codigo) || clientes.criar(a, admin);
    const criado = processos.criar(
      { tipo_processo_id: porNome(a.tipo).id, cliente_id: cliente.id, responsavel_interno_id: admin.id },
      admin
    );
    console.log(`  • ${criado.codigo} — ${criado.razao_social}`);
  });

  // Dá andamento ao primeiro processo para o dashboard não nascer vazio.
  const primeiro = processos.listar({ limite: 5 }).at(-1);
  if (primeiro) {
    const itens = checklist.doProcesso(primeiro.id);
    itens.slice(0, Math.max(1, itens.length - 2)).forEach((item) => {
      checklist.responder(item.id, { resposta: 'Sim' }, admin);
    });
    const alvo = itens.at(-1);
    checklist.responder(
      alvo.id,
      { resposta: 'Sim', possui_impedimento: true, descricao_impedimento: 'Cliente não enviou o contrato assinado.' },
      admin
    );
    processos.recalcularStatus(primeiro.id, admin, { silencioso: true });
  }
}

function main() {
  const conn = db.open();
  db.tx(() => {
    upsertSetores(conn);
    upsertTipos(conn);
    upsertStatus(conn);
    upsertParametros(conn);
    upsertChecklistModelo(conn);
    upsertUsuarios(conn);
  });

  console.log('Carga inicial concluída:');
  for (const tabela of ['setores', 'tipos_processo', 'status_processo', 'parametros', 'checklist_modelo', 'usuarios']) {
    const { t } = conn.prepare(`SELECT COUNT(*) AS t FROM ${tabela}`).get();
    console.log(`  • ${tabela}: ${t} registro(s)`);
  }
  console.log(`\nAcesso pelo ID de usuário. Senha padrão: ${config.senhaPadrao}`);
  console.log('Exemplo: usuário "jacqueline" (Diretoria/Administrador)');

  if (process.argv.includes('--demo')) {
    console.log('\nCriando processos de demonstração...');
    demo(conn);
  }
  db.close();
}

main();
