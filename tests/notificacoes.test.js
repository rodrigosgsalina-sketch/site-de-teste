'use strict';

/**
 * Testes das notificações em tempo real:
 *  - quem recebe cada tipo de aviso (setores do processo × plataforma inteira);
 *  - entrega imediata pelo canal SSE, sem recarregar a tela;
 *  - contador de não lidos por usuário e dispensa individual.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgrilo-not-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'teste.db');

const db = require('../src/db');
const { carregarSeed, criarCliente, liberarAteOSetor } = require('./apoio');
const avisos = require('../src/domain/avisos');
const eventos = require('../src/lib/eventos');
const clientesDom = require('../src/domain/clientes');
const processosDom = require('../src/domain/processos');
const checklist = require('../src/domain/checklist');

const fsp = require('fs');
const caminhos = require('path');

const conn = carregarSeed(db);
const app = require('../src/app');
const servidor = app.listen(0);
const base = `http://127.0.0.1:${servidor.address().port}`;

function usuario(login) {
  return conn
    .prepare('SELECT u.*, s.nome AS setor FROM usuarios u JOIN setores s ON s.id = u.setor_id WHERE u.login = ?')
    .get(login);
}

const admin = usuario('jacqueline');       // Diretoria / Administrador
const fiscal = usuario('ana.paula');       // Fiscal
const contabil = usuario('daiane');        // Contábil
const financeiro = usuario('andreia');     // Financeiro
const pessoal = usuario('samuel');         // Departamento Pessoal
const tipoBaixa = conn.prepare("SELECT id FROM tipos_processo WHERE nome = 'Baixa de Empresa'").get();
const tipoCertidoes = conn.prepare("SELECT id FROM tipos_processo WHERE nome = 'Emissão de Certidões'").get();

const cliente = clientesDom.criar({ codigo: '10', nome: 'Empresa Aviso', razao_social: 'EMPRESA AVISO LTDA' }, admin);

function novoProcesso() {
  return processosDom.criar({ tipo_processo_id: tipoBaixa.id, cliente_id: cliente.id }, admin);
}

/* ------------------------------------------------------------ destinatários */

test('todo movimento de processo avisa o escritório inteiro', () => {
  // Emissão de Certidões passa pelo Fiscal e pelo Paralegal — não pelo DP.
  // Antes, quem era de fora do checklist não ficava sabendo de nada.
  const setoresNoChecklist = checklist.setoresDoProcesso(
    processosDom.criar({ tipo_processo_id: tipoCertidoes.id, cliente_id: cliente.id }, admin).id
  );
  assert.ok(setoresNoChecklist.includes('Fiscal'));
  assert.ok(!setoresNoChecklist.includes('Departamento Pessoal'));

  const antesFiscal = avisos.contarNaoLidos(fiscal.id);
  const antesPessoal = avisos.contarNaoLidos(pessoal.id);

  const processo = processosDom.criar({ tipo_processo_id: tipoCertidoes.id, cliente_id: cliente.id }, admin);
  avisos.processoAberto(processo, checklist.setoresDoProcesso(processo.id), admin);

  assert.strictEqual(avisos.contarNaoLidos(fiscal.id), antesFiscal + 1);
  assert.strictEqual(
    avisos.contarNaoLidos(pessoal.id),
    antesPessoal + 1,
    'quem não participa do checklist também precisa saber que o processo abriu'
  );
  assert.strictEqual(avisos.naoLidos(pessoal.id, 1)[0].escopo, 'todos');

  // O mesmo vale para o resto do ciclo de vida.
  const cenarios = [
    ['concluido', () => avisos.processoConcluido(processo, admin)],
    ['cancelado', () => avisos.processoCancelado(processo, 'desistência', admin)],
    ['reaberto', () => avisos.processoReaberto(processo, 'voltou atrás', admin)],
    ['prazo', () => avisos.prazoDoProcesso(processo, -2)],
  ];
  for (const [tipo, publicar] of cenarios) {
    const antes = avisos.contarNaoLidos(pessoal.id);
    publicar();
    assert.strictEqual(avisos.contarNaoLidos(pessoal.id), antes + 1, `${tipo} precisa chegar a todos`);
    assert.strictEqual(avisos.naoLidos(pessoal.id, 1)[0].tipo, tipo);
  }
});

test('usuário inativo não entra na conta dos avisos', () => {
  const antes = avisos.contarNaoLidos(pessoal.id);
  conn.prepare("UPDATE usuarios SET status = 'Inativo' WHERE id = ?").run(pessoal.id);
  try {
    const processo = novoProcesso();
    avisos.processoConcluido(processo, admin);
    // O aviso é de escopo 'todos', então continua legível para ele se voltar;
    // o que não pode é ele ser contado como público ativo do aviso.
    const leitura = avisos.leitores(avisos.naoLidos(fiscal.id, 1)[0].id);
    assert.ok(
      ![...leitura.viram, ...leitura.naoViram].some((p) => p.nome === pessoal.nome),
      'quem está inativo não é cobrado por não ter visto'
    );
  } finally {
    conn.prepare("UPDATE usuarios SET status = 'Ativo' WHERE id = ?").run(pessoal.id);
  }
  assert.ok(avisos.contarNaoLidos(pessoal.id) >= antes);
});

test('a vez do setor avisa apenas aquele setor', () => {
  const processo = novoProcesso();
  const antesContabil = avisos.contarNaoLidos(contabil.id);
  const antesFiscal = avisos.contarNaoLidos(fiscal.id);

  avisos.vezDoSetor(processo, 'Contábil');

  assert.strictEqual(avisos.contarNaoLidos(contabil.id), antesContabil + 1);
  assert.strictEqual(avisos.contarNaoLidos(fiscal.id), antesFiscal, 'o Fiscal não é chamado no lugar do Contábil');
  assert.strictEqual(avisos.naoLidos(contabil.id, 1)[0].tipo, 'vez_setor');
});

test('dispensar o aviso vale só para quem dispensou', () => {
  const processo = novoProcesso();
  avisos.processoConcluido(processo, admin);
  const aviso = avisos.naoLidos(fiscal.id, 1)[0];

  const antesContabil = avisos.contarNaoLidos(contabil.id);
  const restantes = avisos.marcarLido(aviso.id, fiscal.id);

  assert.strictEqual(typeof restantes, 'number');
  assert.ok(!avisos.naoLidos(fiscal.id, 20).some((a) => a.id === aviso.id));
  assert.strictEqual(avisos.contarNaoLidos(contabil.id), antesContabil, 'a tela do colega não muda');
});

/* --------------------------------------------------------------- tempo real */

/** Abre o canal SSE e devolve um leitor de eventos com espera. */
async function abrirCanal(cookie) {
  const controle = new AbortController();
  const resposta = await fetch(`${base}/eventos`, {
    headers: { cookie, accept: 'text/event-stream' },
    signal: controle.signal,
  });
  assert.strictEqual(resposta.status, 200);
  assert.match(resposta.headers.get('content-type'), /text\/event-stream/);

  const leitor = resposta.body.getReader();
  const decodificador = new TextDecoder();
  let acumulado = '';
  const recebidos = [];
  // A leitura pendente é guardada entre as esperas: se ela fosse recriada a
  // cada volta, o pedaço que chegasse depois de um tempo esgotado se perderia.
  let leituraPendente = null;

  async function proximo(nomeEvento, limiteMs = 4000) {
    const limite = Date.now() + limiteMs;
    for (;;) {
      const achado = recebidos.findIndex((e) => e.evento === nomeEvento);
      if (achado >= 0) return recebidos.splice(achado, 1)[0];
      if (Date.now() > limite) throw new Error(`tempo esgotado esperando "${nomeEvento}"`);

      if (!leituraPendente) leituraPendente = leitor.read();
      const pedaco = await Promise.race([
        leituraPendente,
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), Math.max(1, limite - Date.now()))),
      ]);
      if (pedaco.timeout) continue;
      leituraPendente = null;
      if (pedaco.done) throw new Error('canal encerrado pelo servidor');

      acumulado += decodificador.decode(pedaco.value, { stream: true });
      const blocos = acumulado.split('\n\n');
      acumulado = blocos.pop();
      for (const bloco of blocos) {
        const evento = (bloco.match(/^event: (.+)$/m) || [])[1];
        const dados = bloco
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('\n');
        if (evento) recebidos.push({ evento, dados: dados ? JSON.parse(dados) : null });
      }
    }
  }

  return { proximo, fechar: () => controle.abort() };
}

async function cookieDe(login) {
  const navegador = criarCliente(base);
  await navegador.entrar(login, 'teste123');
  return { cookie: `jsgrilo.sid=${navegador.cookies.get('jsgrilo.sid')}`, navegador };
}

test('o canal SSE exige login', async () => {
  const resposta = await fetch(`${base}/eventos`, { redirect: 'manual' });
  assert.strictEqual(resposta.status, 302);
  assert.strictEqual(resposta.headers.get('location'), '/login');
});

test('o aviso chega na hora para quem está com a plataforma aberta', async () => {
  const sessaoFiscal = await cookieDe('ana.paula');
  const canal = await abrirCanal(sessaoFiscal.cookie);

  try {
    const conectado = await canal.proximo('conectado');
    assert.strictEqual(conectado.dados.usuario, 'Ana Paula');
    assert.strictEqual(typeof conectado.dados.naoLidos, 'number');

    const processo = novoProcesso();
    avisos.processoAberto(processo, checklist.setoresDoProcesso(processo.id), admin);

    const recebido = await canal.proximo('aviso');
    assert.strictEqual(recebido.dados.tipo, 'aberto');
    assert.strictEqual(recebido.dados.rotulo, 'Novo processo');
    assert.strictEqual(recebido.dados.cor, 'azul');
    assert.match(recebido.dados.titulo, new RegExp(`${processo.codigo} aberto`));
    assert.strictEqual(recebido.dados.url, `/processos/${processo.id}`);
    assert.ok(recebido.dados.naoLidos >= 1, 'o cartão já traz o novo total para o contador do menu');
  } finally {
    canal.fechar();
  }
});

test('cada canal só recebe o que é do seu usuário', async () => {
  const sessaoContabil = await cookieDe('daiane');
  const canal = await abrirCanal(sessaoContabil.cookie);

  try {
    await canal.proximo('conectado');

    // Aviso dirigido a outro setor não pode aparecer neste canal...
    const processo = novoProcesso();
    avisos.vezDoSetor(processo, 'Fiscal');
    await assert.rejects(() => canal.proximo('aviso', 700), /tempo esgotado/);

    // ...mas o que é do Contábil chega.
    avisos.vezDoSetor(processo, 'Contábil');
    const recebido = await canal.proximo('aviso');
    assert.strictEqual(recebido.dados.tipo, 'vez_setor');
    assert.match(recebido.dados.titulo, /Contábil/);
  } finally {
    canal.fechar();
  }
});

test('processo concluído chega a todos os canais abertos', async () => {
  const a = await cookieDe('andreia'); // Financeiro
  const b = await cookieDe('samuel'); // Departamento Pessoal
  const canalA = await abrirCanal(a.cookie);
  const canalB = await abrirCanal(b.cookie);

  try {
    await canalA.proximo('conectado');
    await canalB.proximo('conectado');

    const processo = novoProcesso();
    avisos.processoConcluido(processo, admin);

    const recebidoA = await canalA.proximo('aviso');
    const recebidoB = await canalB.proximo('aviso');
    assert.strictEqual(recebidoA.dados.tipo, 'concluido');
    assert.strictEqual(recebidoB.dados.id, recebidoA.dados.id);
  } finally {
    canalA.fechar();
    canalB.fechar();
  }
});

test('dispensar pelo cartão devolve o novo total em JSON', async () => {
  const sessao = await cookieDe('ana.paula');
  const processo = novoProcesso();
  avisos.processoConcluido(processo, admin);

  const aviso = avisos.naoLidos(fiscal.id, 1)[0];
  const antes = avisos.contarNaoLidos(fiscal.id);
  const token = await sessao.navegador.token('/');

  const resposta = await sessao.navegador.post(
    `/avisos/${aviso.id}/lido`,
    { _csrf: token },
    { headers: { accept: 'application/json' } }
  );

  assert.strictEqual(resposta.status, 200);
  const corpo = await resposta.json();
  assert.strictEqual(corpo.ok, true);
  assert.strictEqual(corpo.naoLidos, antes - 1);
});

test('o ciclo de vida do processo publica os avisos correspondentes', () => {
  const processo = novoProcesso();
  const tipos = () => avisos.listar(admin.id, 30).filter((a) => a.processo_id === processo.id).map((a) => a.tipo);

  processosDom.cancelar(processo.id, admin, 'Cliente desistiu.');
  assert.ok(tipos().includes('cancelado'));

  processosDom.reabrir(processo.id, admin, 'Cliente voltou atrás.');
  assert.ok(tipos().includes('reaberto'));

  liberarAteOSetor(processo.id, 'Fiscal', admin);
  const item = checklist.doProcesso(processo.id).find((i) => i.setor === 'Fiscal');
  checklist.responder(
    item.id,
    { resposta: 'Não', possui_impedimento: true, descricao_impedimento: 'Faltou documento.' },
    admin
  );
  assert.ok(tipos().includes('impedido'));
});

test('a faixa do topo mostra só o que muda o rumo do processo', () => {
  const processo = novoProcesso();
  avisos.processoAberto(processo, checklist.setoresDoProcesso(processo.id), admin);
  avisos.processoConcluido(processo, admin);

  const naFaixa = avisos.naoLidos(fiscal.id, 5, { faixa: true });
  assert.ok(naFaixa.every((a) => avisos.TIPOS_DA_FAIXA.includes(a.tipo)));
  assert.ok(naFaixa.some((a) => a.tipo === 'concluido'));
  assert.ok(!naFaixa.some((a) => a.tipo === 'aberto'), 'abertura não empilha faixa no topo');

  // Mas continua contando no menu e aparecendo no mural.
  assert.ok(avisos.naoLidos(fiscal.id, 20).some((a) => a.tipo === 'aberto'));
  assert.ok(avisos.listar(fiscal.id, 50).some((a) => a.tipo === 'aberto'));
});

/* --------------------------------------------------------- som do aviso */

test('o mural traz o interruptor e o teste do som', async () => {
  const cliente = criarCliente(base);
  await cliente.entrar('daiane', 'teste123');
  const html = await (await cliente.get('/avisos')).text();

  assert.match(html, /data-som-avisos/, 'o interruptor do som precisa estar na tela');
  assert.match(html, /data-testar-som/, 'sem o botão de teste não há como liberar o áudio nem conferir');
  assert.match(html, /Tocar um som quando chegar aviso/);
});

test('o som é gerado no navegador, sem arquivo de áudio para baixar', () => {
  const script = fsp.readFileSync(caminhos.join(__dirname, '..', 'src', 'public', 'js', 'notificacoes.js'), 'utf8');

  assert.match(script, /AudioContext/, 'o toque sai da Web Audio API');
  assert.match(script, /createOscillator/);
  assert.ok(
    !/\.(mp3|ogg|wav|m4a)\b/i.test(script),
    'nenhum arquivo de áudio: um pedido de rede a menos e nada para manter em cache'
  );

  // Quem segura a conexão decide sozinho quem toca — nunca cada aba por conta,
  // senão o navegador solta os temporizadores represados juntos e sai coro.
  assert.match(script, /quem-pode-tocar/);
  assert.match(script, /posso-tocar/);
  assert.match(script, /somPendente/);

  // Com a notificação do sistema à vista, o som é o do sistema operacional.
  assert.match(script, /if \(!mostrarNoSistema\(aviso\)\) anunciar\(aviso\);/);
});

test('o som espera a liberação do áudio antes de decidir que falhou', () => {
  const script = fsp.readFileSync(caminhos.join(__dirname, '..', 'src', 'public', 'js', 'notificacoes.js'), 'utf8');

  // `resume()` é assíncrono. A primeira versão conferia o estado na linha
  // seguinte — que ainda era "suspended" — e o botão "Testar som" nunca tocava.
  const corpo = script.slice(script.indexOf('function tocar('), script.indexOf('function anunciar('));
  assert.ok(
    !/resume\(\);[\s\S]{0,200}state === 'running'/.test(corpo),
    'conferir o estado logo depois de resume() volta a quebrar o primeiro clique'
  );
  assert.match(corpo, /resume\(\)/);
  assert.match(corpo, /\.then\(/, 'a nota só pode sair depois de a liberação terminar');
  assert.match(corpo, /return Promise\.resolve\(/, 'tocar() responde uma promessa');

  // E quem chama precisa tratar a promessa, não o valor.
  assert.match(script, /tocar\(\)\.then\(function \(tocou\)/);
  assert.match(script, /tocar\(true\)\.then\(function \(tocou\)/);
});

test('o contador de não lidos vai para o rótulo da aba', () => {
  const script = fsp.readFileSync(caminhos.join(__dirname, '..', 'src', 'public', 'js', 'notificacoes.js'), 'utf8');

  // Título e ícone: cada um cobre uma situação. Com poucas abas o título
  // aparece inteiro; com muitas sobra só o ícone.
  assert.match(script, /document\.title = total > 0/);
  assert.match(script, /link\[rel~="icon"\]/);
  assert.match(script, /toDataURL\('image\/png'\)/, 'o ícone é desenhado a cada número, não é arquivo');
  assert.match(script, /'99\+'/, 'acima de 99 o número não cabe no ícone');

  // Havendo aviso, o número toma o lugar da sigla — não fica por cima dela.
  assert.match(
    script,
    /total > 0 \? \(total > 99 \? '99\+' : String\(total\)\) : 'JS'/,
    'com aviso o ícone mostra só o número; sem aviso, só a sigla'
  );
  assert.match(script, /measureText/, 'o corpo da fonte é medido para "1" e "99+" ocuparem a mesma largura');

  // Os dois saem do mesmo funil que já alimenta o contador do menu.
  const funil = script.slice(script.indexOf('function atualizarContador('), script.indexOf('function iniciais('));
  assert.match(funil, /atualizarTitulo\(total\)/);
  assert.match(funil, /atualizarFavicon\(total\)/);
  assert.match(funil, /total === contadorNaAba/, 'redesenhar o ícone com o mesmo número é trabalho à toa');

  // O rótulo de partida é guardado antes de qualquer coisa mexer nele, senão
  // o "(3)" gruda no título e vai se acumulando.
  assert.ok(
    script.indexOf('lembrarRotuloDaAba();') < script.indexOf('conectar();\n    ligarControlesDeSom'),
    'o título original precisa ser lembrado antes de o canal conectar'
  );
});

test('a aba nasce com o número que o servidor já desenhou no menu', () => {
  const script = fsp.readFileSync(caminhos.join(__dirname, '..', 'src', 'public', 'js', 'notificacoes.js'), 'utf8');
  assert.match(
    script,
    /badge && !badge\.hidden \? Number\(badge\.textContent\) \|\| 0 : 0/,
    'sem isso a aba só ganha o contador quando chegar o próximo aviso'
  );
});

test('o mural mostra se o navegador já liberou o áudio', async () => {
  const cliente = criarCliente(base);
  await cliente.entrar('daiane', 'teste123');
  const html = await (await cliente.get('/avisos')).text();

  assert.match(html, /data-som-estado/, 'silêncio sem explicação é o que faz parecer defeito');
  // A caixa vem marcada já no HTML: o som é ligado por padrão, e a tela precisa
  // dizer a verdade mesmo antes de o JavaScript rodar.
  assert.match(html, /data-som-avisos checked/);
});

test.after(() => {
  eventos.encerrarTodas();
  servidor.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
