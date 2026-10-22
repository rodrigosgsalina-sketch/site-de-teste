'use strict';

/**
 * Backup e restauração da plataforma.
 *
 * O backup é um único arquivo `.json` com o conteúdo de todas as tabelas —
 * processos, checklists, clientes, usuários, parâmetros, histórico, avisos — e,
 * opcionalmente, os documentos anexados. O mesmo arquivo é lido de volta pela
 * tela de Parâmetros para repor a plataforma exatamente como estava.
 *
 * Duas decisões importantes:
 *  - o formato é JSON, e não uma cópia do arquivo do banco: assim o backup
 *    continua restaurável mesmo depois de o esquema ganhar colunas novas;
 *  - a restauração é total (apaga e repõe), porque um backup vale como retrato
 *    de um momento — mesclar dois momentos criaria um terceiro que nunca existiu.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = require('../config');
const db = require('../db');
const { agoraISO } = require('../lib/datas');
const { ErroValidacao } = require('./checklist');

const FORMATO = 'jsgrilo-backup';
const VERSAO = 1;

/**
 * Ordem importa: as tabelas são gravadas (e repostas) das que ninguém depende
 * para as que dependem de todas, para as chaves estrangeiras fecharem.
 * `sessoes` fica de fora de propósito — sessão aberta é do navegador, não do
 * acervo do escritório.
 */
const TABELAS = [
  'setores',
  'tipos_processo',
  'subtipos_processo',
  'status_processo',
  'usuarios',
  'usuarios_setores',
  'parametros',
  'checklist_modelo',
  'ordem_setores_tipo',
  'clientes',
  'processos',
  'processos_subtipos',
  'checklist',
  'historico',
  'documentos',
  'notificacoes',
  'avisos',
  'avisos_destinos',
  'avisos_lidos',
  'tabela_preco',
];

/**
 * Tabelas que ficam de fora do backup de propósito.
 *
 * `sessoes` é quem está logado agora, e `push_inscricoes` é o endereço de push
 * de cada navegador: as duas dizem respeito ao aparelho, não ao escritório.
 * Restaurá-las noutra máquina não faria sentido — e a de sessões derrubaria
 * quem estivesse usando a plataforma no momento da restauração.
 */
const TABELAS_DE_FORA = ['sessoes', 'push_inscricoes'];

/**
 * Linhas de backups antigos que precisam ser traduzidas para as colunas de hoje.
 *
 * A restauração aproveita só as colunas que ainda existem, o que basta para
 * coluna nova (ela entra com o padrão) — mas não para coluna **renomeada**: o
 * valor dela seria jogado fora em silêncio. É o caso da tabela de preço, em que
 * `atual` virou `publicada` quando passaram a ser várias; sem esta tradução,
 * toda versão antiga voltaria publicada e o seletor se encheria de preço velho.
 */
const ADAPTACOES = {
  tabela_preco(linha) {
    const nova = { ...linha };
    if (nova.publicada === undefined && nova.atual !== undefined) nova.publicada = nova.atual;
    delete nova.atual;
    if (!nova.titulo) {
      nova.titulo = String(nova.nome_original || '').replace(/\.[^.]+$/, '') || `Tabela ${nova.id}`;
    }
    return nova;
  },
};

/** Rótulos usados na tela de conferência. */
const ROTULOS = {
  setores: 'Setores',
  tipos_processo: 'Tipos de processo',
  subtipos_processo: 'Subtipos de processo',
  status_processo: 'Status',
  usuarios: 'Usuários',
  usuarios_setores: 'Setores por usuário',
  parametros: 'Parâmetros',
  checklist_modelo: 'Checklist modelo',
  ordem_setores_tipo: 'Ordem de atendimento',
  clientes: 'Clientes (empresas)',
  processos: 'Processos',
  processos_subtipos: 'Subtipos por processo',
  checklist: 'Itens de checklist',
  historico: 'Histórico / auditoria',
  documentos: 'Documentos anexados',
  notificacoes: 'Notificações',
  avisos: 'Avisos internos',
  avisos_destinos: 'Destinatários dos avisos',
  avisos_lidos: 'Avisos lidos',
  tabela_preco: 'Tabela de preço',
};

function colunas(tabela) {
  return db
    .get()
    .prepare(`PRAGMA table_info(${tabela})`)
    .all()
    .map((c) => c.name);
}

function tabelaExiste(nome) {
  return Boolean(
    db.get().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(nome)
  );
}

/**
 * Impressão digital do conteúdo — detecta arquivo truncado ou editado à mão.
 *
 * Percorre as tabelas **que estão no próprio arquivo**, na ordem em que estão,
 * e não a lista da versão atual. É o que mantém a assinatura estável ao longo
 * do tempo: acrescentar uma tabela nova à plataforma não pode invalidar os
 * backups já gerados.
 *
 * Foi exatamente o que aconteceu quando `usuarios_setores` e `avisos_destinos`
 * entraram na lista: a conferência passou a somar duas tabelas vazias que o
 * arquivo antigo não tinha, o número deu diferente e todo backup anterior foi
 * recusado como "alterado ou incompleto". A assinatura precisa falar do
 * conteúdo do arquivo, não da versão de quem o lê.
 */
function impressao(tabelas, arquivos) {
  const resumo = crypto.createHash('sha256');
  for (const nome of Object.keys(tabelas || {})) {
    resumo.update(nome);
    resumo.update(JSON.stringify(tabelas[nome] || []));
  }
  for (const arquivo of arquivos || []) {
    resumo.update(arquivo.caminho);
    resumo.update(arquivo.sha256 || '');
  }
  return resumo.digest('hex');
}

/* ------------------------------------------------------------------ gerar */

/**
 * Pasta dos arquivos da tabela de preço dentro de uploads/ (a mesma de
 * src/domain/tabela-preco.js — um teste confere que as duas não se separam).
 *
 * Os anexos de processo ficam em pastas numeradas (`uploads/<id do processo>/`)
 * e só vão no backup quando se pede, porque pesam. A tabela de preço é outra
 * coisa: sem o arquivo, a linha restaurada aponta para o nada e a aba mostra
 * erro. Por isso os arquivos dela vão **sempre**.
 */
const PASTA_TABELA_PRECO = 'tabela-preco';

/** Pastas de uploads/ que podem voltar numa restauração, além das numeradas. */
const PASTAS_FIXAS = new Set([PASTA_TABELA_PRECO]);

/** Lê um arquivo de uploads/ no formato em que ele viaja no backup. */
function empacotar(relativo, completo) {
  const conteudo = fs.readFileSync(completo);
  return {
    caminho: relativo,
    tamanho: conteudo.length,
    sha256: crypto.createHash('sha256').update(conteudo).digest('hex'),
    conteudo: conteudo.toString('base64'),
  };
}

/**
 * Arquivos das tabelas de preço cadastradas — só os que o banco cita, e não a
 * pasta inteira. Devolve também as linhas cujo arquivo já não estava no disco,
 * para a tela avisar quem baixa o backup.
 */
function arquivosDaTabelaDePreco() {
  if (!tabelaExiste('tabela_preco')) return { arquivos: [], semArquivo: [] };
  const raiz = path.resolve(config.uploadsDir, PASTA_TABELA_PRECO);
  const arquivos = [];
  const semArquivo = [];
  const vistos = new Set();
  for (const linha of db.get().prepare('SELECT id, titulo, nome_arquivo FROM tabela_preco').all()) {
    const nome = path.basename(String(linha.nome_arquivo || ''));
    const completo = path.join(raiz, nome);
    if (!nome || !fs.existsSync(completo)) {
      semArquivo.push(linha.titulo || `Tabela ${linha.id}`);
      continue;
    }
    if (vistos.has(nome)) continue;
    vistos.add(nome);
    arquivos.push(empacotar(`${PASTA_TABELA_PRECO}/${nome}`, completo));
  }
  return { arquivos, semArquivo };
}

/** Percorre uploads/ devolvendo os caminhos relativos dos anexos de processo. */
function listarArquivos() {
  const raiz = path.resolve(config.uploadsDir);
  if (!fs.existsSync(raiz)) return [];
  const encontrados = [];
  for (const pasta of fs.readdirSync(raiz)) {
    // Só as pastas de processo: a da tabela de preço tem caminho próprio.
    if (!/^\d+$/.test(pasta)) continue;
    const caminhoPasta = path.join(raiz, pasta);
    if (!fs.statSync(caminhoPasta).isDirectory()) continue;
    for (const arquivo of fs.readdirSync(caminhoPasta)) {
      const completo = path.join(caminhoPasta, arquivo);
      const info = fs.statSync(completo);
      if (info.isFile()) {
        encontrados.push({ relativo: `${pasta}/${arquivo}`, completo, tamanho: info.size });
      }
    }
  }
  return encontrados;
}

/**
 * Monta o backup. Os arquivos da tabela de preço vão sempre; `incluirArquivos`
 * acrescenta os anexos dos processos, em base64 — o arquivo cresce, mas passa
 * a ser autossuficiente.
 */
function gerar({ usuario = null, incluirArquivos = false, limiteArquivosMb = 200 } = {}) {
  const conn = db.get();
  const tabelas = {};
  const totais = {};

  for (const nome of TABELAS) {
    if (!tabelaExiste(nome)) {
      tabelas[nome] = [];
      totais[nome] = 0;
      continue;
    }
    const linhas = conn.prepare(`SELECT * FROM ${nome}`).all();
    tabelas[nome] = linhas;
    totais[nome] = linhas.length;
  }

  // A tabela de preço vai inteira e não entra no limite: sem os arquivos, as
  // linhas restauradas apontariam para o nada.
  const precos = arquivosDaTabelaDePreco();
  const arquivos = [...precos.arquivos];
  let bytesArquivos = 0;
  let arquivosIgnorados = 0;

  if (incluirArquivos) {
    const limite = limiteArquivosMb * 1024 * 1024;
    for (const anexo of listarArquivos()) {
      if (bytesArquivos + anexo.tamanho > limite) {
        arquivosIgnorados += 1;
        continue;
      }
      arquivos.push(empacotar(anexo.relativo, anexo.completo));
      bytesArquivos += anexo.tamanho;
    }
  }

  return {
    formato: FORMATO,
    versao: VERSAO,
    aplicacao: require('../../package.json').version,
    gerado_em: agoraISO(),
    gerado_por: usuario ? `${usuario.nome} (${usuario.login})` : 'sistema',
    inclui_arquivos: incluirArquivos,
    inclui_tabelas_preco: true,
    tabelas_preco_sem_arquivo: precos.semArquivo,
    arquivos_ignorados: arquivosIgnorados,
    totais,
    checksum: impressao(tabelas, arquivos),
    tabelas,
    arquivos,
  };
}

/** Nome sugerido para o download. */
function nomeDoArquivo(data = new Date()) {
  const iso = data.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `backup-jsgrilo-${iso}.json`;
}

/** Grava uma cópia em data/backups (usado antes de toda restauração). */
function gravarNoDisco(backup, prefixo = 'backup') {
  fs.mkdirSync(config.backupsDir, { recursive: true });
  const destino = path.join(config.backupsDir, `${prefixo}-${nomeDoArquivo()}`);
  fs.writeFileSync(destino, JSON.stringify(backup));
  return destino;
}

/* ------------------------------------------------------------------ ler */

/**
 * Lê e confere o arquivo enviado, sem gravar nada. Devolve o conteúdo e um
 * resumo para a tela de conferência.
 */
function analisar(buffer) {
  let dados;
  try {
    dados = JSON.parse(Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer));
  } catch (_) {
    throw new ErroValidacao('O arquivo não é um backup válido (não consegui ler o conteúdo JSON).');
  }
  if (!dados || dados.formato !== FORMATO) {
    throw new ErroValidacao('Este arquivo não é um backup da plataforma JS Grilo.');
  }
  if (Number(dados.versao) > VERSAO) {
    throw new ErroValidacao(
      `O backup foi gerado por uma versão mais nova da plataforma (formato ${dados.versao}). Atualize a plataforma antes de restaurar.`
    );
  }
  if (!dados.tabelas || typeof dados.tabelas !== 'object') {
    throw new ErroValidacao('O backup está sem a seção de tabelas.');
  }

  const tabelas = dados.tabelas;
  const arquivos = Array.isArray(dados.arquivos) ? dados.arquivos : [];

  const avisos = [];
  if (dados.checksum && dados.checksum !== impressao(tabelas, arquivos)) {
    throw new ErroValidacao(
      'O conteúdo do backup não confere com a sua assinatura — o arquivo foi alterado ou chegou incompleto.'
    );
  }
  if (!dados.checksum) avisos.push('Backup antigo, sem assinatura de integridade.');

  const desconhecidas = Object.keys(tabelas).filter((t) => !TABELAS.includes(t));
  if (desconhecidas.length) {
    avisos.push(`Tabelas não reconhecidas serão ignoradas: ${desconhecidas.join(', ')}.`);
  }

  // Backup de uma versão anterior não conhece as tabelas que vieram depois.
  // Isso não impede a restauração — o que falta é recomposto a partir do
  // próprio conteúdo —, mas quem confirma merece saber disso antes.
  const ausentes = TABELAS.filter((t) => !Object.prototype.hasOwnProperty.call(tabelas, t));
  if (ausentes.length) {
    avisos.push(
      `Backup de uma versão anterior: ele não traz ${ausentes
        .map((t) => ROTULOS[t] || t)
        .join(', ')}. Essas tabelas serão recompostas a partir do conteúdo restaurado.`
    );
  }

  const conteudo = TABELAS.map((nome) => ({
    tabela: nome,
    rotulo: ROTULOS[nome] || nome,
    doArquivo: Array.isArray(tabelas[nome]) ? tabelas[nome].length : 0,
    atual: tabelaExiste(nome) ? db.get().prepare(`SELECT COUNT(*) AS t FROM ${nome}`).get().t : 0,
  }));

  // Tabelas de preço: o arquivo precisa vir no backup ou já estar neste
  // servidor. Um backup gerado antes desta correção não trazia os arquivos —
  // restaurá-lo noutra máquina deixava a aba com erro, sem aviso nenhum.
  const linhasDePreco = Array.isArray(tabelas.tabela_preco) ? tabelas.tabela_preco : [];
  const caminhosNoBackup = new Set(arquivos.map((a) => String(a.caminho || '')));
  const raizPrecos = path.resolve(config.uploadsDir, PASTA_TABELA_PRECO);
  const precosSemArquivo = linhasDePreco
    .filter((t) => {
      const nome = path.basename(String(t.nome_arquivo || ''));
      return !caminhosNoBackup.has(`${PASTA_TABELA_PRECO}/${nome}`) && !fs.existsSync(path.join(raizPrecos, nome));
    })
    .map((t) => t.titulo || t.nome_original || `Tabela ${t.id}`);
  if (precosSemArquivo.length) {
    avisos.push(
      `${precosSemArquivo.length} tabela(s) de preço vêm sem o arquivo neste backup e o arquivo também não ` +
        `está neste servidor: ${precosSemArquivo.join(', ')}. Elas voltam cadastradas, mas será preciso ` +
        'enviar o arquivo de novo (Tabela de preço → Substitui a tabela). Isso acontece com backups gerados ' +
        'antes desta versão; os novos já levam os arquivos.'
    );
  }

  const usuariosNoArquivo = Array.isArray(tabelas.usuarios) ? tabelas.usuarios : [];
  if (!usuariosNoArquivo.some((u) => u.perfil === 'Administrador' && u.status === 'Ativo')) {
    avisos.push(
      'Atenção: o backup não contém nenhum administrador ativo. Depois de restaurar, ninguém conseguirá entrar na Administração.'
    );
  }

  return {
    dados,
    conteudo,
    arquivos: arquivos.filter((a) => !String(a.caminho || '').startsWith(`${PASTA_TABELA_PRECO}/`)).length,
    bytesArquivos: arquivos.reduce((soma, a) => soma + Number(a.tamanho || 0), 0),
    tabelasPreco: {
      total: linhasDePreco.length,
      arquivos: arquivos.filter((a) => String(a.caminho || '').startsWith(`${PASTA_TABELA_PRECO}/`)).length,
      semArquivo: precosSemArquivo,
    },
    avisos,
  };
}

/* ------------------------------------------------------------ restaurar */

/**
 * Repõe os arquivos em uploads/, sem deixar o caminho escapar da pasta.
 *
 * Aceita as pastas numeradas dos processos e as pastas fixas (a da tabela de
 * preço). Antes só as numeradas passavam, e os arquivos da tabela de preço
 * eram pulados em silêncio mesmo quando vinham no backup — a tabela voltava
 * e o arquivo dela não.
 *
 * `anexosDeProcesso: false` repõe só a tabela de preço: é a opção "não repor
 * os documentos anexados" da tela, que fala dos documentos dos processos.
 */
function restaurarArquivos(arquivos, { anexosDeProcesso = true } = {}) {
  const raiz = path.resolve(config.uploadsDir);
  const contagem = { anexos: 0, tabelasPreco: 0 };
  for (const arquivo of arquivos || []) {
    const partes = String(arquivo.caminho || '').split('/');
    if (partes.length !== 2) continue;
    const fixa = PASTAS_FIXAS.has(partes[0]);
    const pasta = fixa ? partes[0] : String(Number(partes[0]) || 0);
    const nome = path.basename(partes[1]);
    if (pasta === '0' || !nome) continue;
    if (!fixa && !anexosDeProcesso) continue;

    const destino = path.resolve(raiz, pasta, nome);
    if (!destino.startsWith(raiz + path.sep)) continue;

    const conteudo = Buffer.from(String(arquivo.conteudo || ''), 'base64');
    if (arquivo.sha256 && crypto.createHash('sha256').update(conteudo).digest('hex') !== arquivo.sha256) {
      continue; // anexo corrompido: melhor não gravar
    }
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, conteudo);
    if (pasta === PASTA_TABELA_PRECO) contagem.tabelasPreco += 1;
    else contagem.anexos += 1;
  }
  return contagem;
}

/**
 * Tabelas de preço do banco cujo arquivo não está no disco. Depois de uma
 * restauração, é o que ainda precisa ser reenviado.
 */
function tabelasDePrecoSemArquivo() {
  if (!tabelaExiste('tabela_preco')) return [];
  const raiz = path.resolve(config.uploadsDir, PASTA_TABELA_PRECO);
  return db
    .get()
    .prepare('SELECT id, titulo, nome_arquivo FROM tabela_preco ORDER BY titulo')
    .all()
    .filter((t) => !fs.existsSync(path.join(raiz, path.basename(String(t.nome_arquivo || '')))))
    .map((t) => t.titulo || `Tabela ${t.id}`);
}

/**
 * Recompõe o que um backup antigo não tinha como trazer.
 *
 * Um arquivo gerado por uma versão anterior não conhece as tabelas que vieram
 * depois. Restaurar sem mais nada deixaria buracos silenciosos — e o silêncio
 * é o problema: a plataforma parece inteira e falta coisa. Aqui cada buraco é
 * fechado a partir do próprio conteúdo restaurado, e o que foi feito volta no
 * resumo para a tela contar.
 */
function completarDepoisDeRestaurar(conn) {
  const feito = { setoresDeUsuario: 0, parametros: [], avisosSemDestino: 0 };

  // 1. Setores por usuário: antes o setor era um só, na própria linha do
  //    usuário. Ele vira a primeira (e por ora única) ligação.
  if (tabelaExiste('usuarios') && tabelaExiste('usuarios_setores')) {
    const info = conn
      .prepare(
        `INSERT INTO usuarios_setores (usuario_id, setor_id)
         SELECT u.id, u.setor_id FROM usuarios u
          WHERE u.setor_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM usuarios_setores us
                             WHERE us.usuario_id = u.id AND us.setor_id = u.setor_id)`
      )
      .run();
    feito.setoresDeUsuario = Number(info.changes || 0);
  }

  // 2. Parâmetros criados depois do backup: sem isso eles sumiriam da tela de
  //    Parâmetros e a regra passaria a valer só pelo padrão do código.
  if (tabelaExiste('parametros')) {
    const seed = require('../db/seed-data');
    const existe = conn.prepare('SELECT 1 FROM parametros WHERE chave = ?');
    const inserir = conn.prepare(
      `INSERT INTO parametros (chave, valor, tipo, categoria, descricao)
       VALUES (@chave, @valor, @tipo, @categoria, @descricao)`
    );
    for (const p of seed.PARAMETROS) {
      if (existe.get(p.chave)) continue;
      inserir.run(p);
      feito.parametros.push(p.chave);
    }
  }

  // 3. Aviso dirigido a setores sem nenhum destinatário: o backup antigo não
  //    guardava a lista, e um aviso sem destinatário não aparece para ninguém.
  //    Melhor o escritório inteiro ver um aviso velho do que o registro sumir.
  if (tabelaExiste('avisos') && tabelaExiste('avisos_destinos')) {
    const info = conn
      .prepare(
        `UPDATE avisos SET escopo = 'todos'
          WHERE escopo = 'setores'
            AND NOT EXISTS (SELECT 1 FROM avisos_destinos d WHERE d.aviso_id = avisos.id)`
      )
      .run();
    feito.avisosSemDestino = Number(info.changes || 0);
  }

  return feito;
}

/**
 * Apaga o conteúdo atual e repõe o do backup, tudo em uma transação: ou a
 * plataforma inteira volta ao retrato do backup, ou nada muda.
 */
function restaurar(dados, { usuario = null, restaurarArquivos: reporArquivos = true } = {}) {
  const conn = db.get();
  const tabelas = dados.tabelas || {};

  // Rede de proteção: o estado atual vai para data/backups antes de sumir.
  const copiaDeSeguranca = gravarNoDisco(
    gerar({ usuario, incluirArquivos: false }),
    'antes-de-restaurar'
  );

  const inseridos = {};
  const completado = { setoresDeUsuario: 0, parametros: [], avisosSemDestino: 0 };

  // As chaves estrangeiras ficam suspensas durante a troca (as tabelas são
  // repostas em ordem, mas o "apagar tudo" passa por estados inconsistentes).
  // PRAGMA não funciona dentro de transação, por isso vem antes.
  conn.pragma('foreign_keys = OFF');
  try {
    db.tx(() => {
      for (const nome of [...TABELAS].reverse()) {
        if (tabelaExiste(nome)) conn.prepare(`DELETE FROM ${nome}`).run();
      }

      for (const nome of TABELAS) {
        const brutas = Array.isArray(tabelas[nome]) ? tabelas[nome] : [];
        const linhas = ADAPTACOES[nome] ? brutas.map(ADAPTACOES[nome]) : brutas;
        inseridos[nome] = 0;
        if (!linhas.length || !tabelaExiste(nome)) continue;

        // Só as colunas que existem hoje: um backup mais antigo (ou mais novo
        // em colunas) continua entrando sem quebrar.
        const disponiveis = new Set(colunas(nome));
        const campos = Object.keys(linhas[0]).filter((c) => disponiveis.has(c));
        if (!campos.length) continue;

        const insercao = conn.prepare(
          `INSERT INTO ${nome} (${campos.join(', ')}) VALUES (${campos.map((c) => `@${c}`).join(', ')})`
        );
        for (const linha of linhas) {
          const valores = {};
          for (const campo of campos) {
            const valor = linha[campo];
            valores[campo] =
              valor === undefined || valor === null || typeof valor === 'number' || typeof valor === 'string'
                ? valor === undefined
                  ? null
                  : valor
                : JSON.stringify(valor);
          }
          insercao.run(valores);
          inseridos[nome] += 1;
        }
      }

      // O que o arquivo não tinha como trazer é recomposto aqui dentro, ainda
      // na mesma transação: ou a plataforma volta inteira, ou nada muda.
      Object.assign(completado, completarDepoisDeRestaurar(conn));

      // Numeração automática volta a seguir os dados repostos.
      if (tabelaExiste('sqlite_sequence')) {
        for (const nome of TABELAS) {
          if (!tabelaExiste(nome) || !colunas(nome).includes('id')) continue;
          const max = conn.prepare(`SELECT MAX(id) AS m FROM ${nome}`).get();
          if (max && max.m) {
            conn.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(max.m, nome);
          }
        }
      }
    });
  } finally {
    conn.pragma('foreign_keys = ON');
  }

  const violacoes = conn.prepare('PRAGMA foreign_key_check').all();
  // Os arquivos da tabela de preço voltam sempre; os anexos de processo,
  // só se não foi pedido para deixá-los de fora.
  const repostos = restaurarArquivos(dados.arquivos, { anexosDeProcesso: reporArquivos });

  return {
    inseridos,
    total: Object.values(inseridos).reduce((a, b) => a + b, 0),
    arquivosRepostos: repostos.anexos,
    tabelasPrecoRepostas: repostos.tabelasPreco,
    tabelasPrecoSemArquivo: tabelasDePrecoSemArquivo(),
    copiaDeSeguranca,
    completado,
    violacoes: violacoes.length,
  };
}

module.exports = {
  PASTA_TABELA_PRECO,
  tabelasDePrecoSemArquivo,
  FORMATO,
  VERSAO,
  TABELAS,
  TABELAS_DE_FORA,
  ADAPTACOES,
  ROTULOS,
  gerar,
  analisar,
  restaurar,
  completarDepoisDeRestaurar,
  nomeDoArquivo,
  gravarNoDisco,
};
