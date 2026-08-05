#!/usr/bin/env node
'use strict';

/**
 * Certificados TLS da plataforma.
 *
 * Dois modos:
 *
 *   npm run certificado
 *       Cria uma AUTORIDADE CERTIFICADORA LOCAL (uma vez só) e emite o
 *       certificado do servidor assinado por ela. Instalando o certificado da
 *       autoridade nos aparelhos do escritório, o navegador para de mostrar
 *       "site não seguro" — é a solução para uso em rede interna, onde não há
 *       domínio público e o Let's Encrypt não pode emitir nada.
 *
 *   npm run certificado -- --autoassinado
 *       Certificado solto, sem autoridade. Serve para um teste rápido; o
 *       navegador sempre vai reclamar.
 *
 * Opções:
 *   --nomes jsgriloprocessos,servidor.local   nomes pelos quais o sistema é acessado
 *   --ips 192.168.0.10                        endereços IP que também respondem
 *   --validade 825                            dias de validade do certificado
 *   --forcar                                  refaz o certificado do servidor
 *   --nova-autoridade                         refaz também a autoridade (exige
 *                                             reinstalar em todos os aparelhos)
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/config');

const destino = path.join(config.dataDir, 'certificados');
const arquivos = {
  autoridade: path.join(destino, 'autoridade.pem'),
  autoridadeChave: path.join(destino, 'autoridade-chave.pem'),
  certificado: path.join(destino, 'certificado.pem'),
  chave: path.join(destino, 'chave.pem'),
  instrucoes: path.join(destino, 'COMO-INSTALAR.txt'),
};

/* ------------------------------------------------------------------ apoio */

function argumento(nome, padrao = null) {
  const indice = process.argv.indexOf(`--${nome}`);
  if (indice === -1) return padrao;
  const valor = process.argv[indice + 1];
  return valor && !valor.startsWith('--') ? valor : true;
}

function temFlag(nome) {
  return process.argv.includes(`--${nome}`);
}

function openssl(args, opcoes = {}) {
  return execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'], ...opcoes });
}

function exigirOpenssl() {
  try {
    openssl(['version']);
  } catch (_) {
    console.error(
      'O OpenSSL não foi encontrado.\n' +
        '  • Windows: ele vem junto com o Git for Windows — rode este comando no "Git Bash".\n' +
        '  • Linux/macOS: instale o pacote openssl.\n' +
        'Como alternativa, use o mkcert (https://github.com/FiloSottile/mkcert), que faz o mesmo trabalho.'
    );
    process.exit(1);
  }
}

/** Endereços IPv4 da máquina, fora o localhost. */
function ipsDaMaquina() {
  const encontrados = [];
  const interfaces = os.networkInterfaces();
  for (const nome of Object.keys(interfaces)) {
    for (const rede of interfaces[nome] || []) {
      if (rede.family === 'IPv4' && !rede.internal) encontrados.push(rede.address);
    }
  }
  return encontrados;
}

/** Nomes e IPs que o certificado precisa cobrir. */
function alternativos() {
  const nomes = new Set(['localhost']);
  const ips = new Set(['127.0.0.1']);

  const nomesPedidos = argumento('nomes');
  if (typeof nomesPedidos === 'string') nomesPedidos.split(',').forEach((n) => n.trim() && nomes.add(n.trim()));
  else {
    // Sem --nomes, cobre o apelido combinado com o escritório e o nome da máquina.
    nomes.add('jsgriloprocessos');
    if (os.hostname()) {
      nomes.add(os.hostname());
      nomes.add(`${os.hostname()}.local`);
    }
  }

  const ipsPedidos = argumento('ips');
  if (typeof ipsPedidos === 'string') ipsPedidos.split(',').forEach((i) => i.trim() && ips.add(i.trim()));
  else ipsDaMaquina().forEach((i) => ips.add(i));

  return { nomes: [...nomes], ips: [...ips] };
}

/* --------------------------------------------------------------- geração */

function criarAutoridade() {
  if (fs.existsSync(arquivos.autoridade) && !temFlag('nova-autoridade')) {
    console.log('• Autoridade local já existe — reaproveitando (os aparelhos já instalados continuam valendo).');
    return false;
  }

  openssl([
    'req', '-x509', '-newkey', 'rsa:4096', '-sha256', '-nodes',
    '-days', '3650',
    '-keyout', arquivos.autoridadeChave,
    '-out', arquivos.autoridade,
    '-subj', '/C=BR/O=JS Grilo Contabilidade e Gestao/CN=JS Grilo - Autoridade Local',
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  protegerChave(arquivos.autoridadeChave);
  console.log('• Autoridade local criada (validade de 10 anos).');
  return true;
}

function protegerChave(caminho) {
  try {
    fs.chmodSync(caminho, 0o600);
  } catch (_) {
    /* sistemas de arquivo sem permissões POSIX (Windows) */
  }
}

function emitirCertificado({ nomes, ips, dias }) {
  const csr = path.join(destino, 'pedido.csr');
  const extensoes = path.join(destino, 'extensoes.cnf');
  const somenteServidor = path.join(destino, 'servidor.pem');

  const san = [...nomes.map((n) => `DNS:${n}`), ...ips.map((i) => `IP:${i}`)].join(',');
  fs.writeFileSync(
    extensoes,
    [
      'basicConstraints=CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=${san}`,
      '',
    ].join('\n')
  );

  openssl([
    'req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', arquivos.chave,
    '-out', csr,
    '-subj', `/C=BR/O=JS Grilo Contabilidade e Gestao/CN=${nomes[0] === 'localhost' ? nomes[1] || 'localhost' : nomes[0]}`,
  ]);

  openssl([
    'x509', '-req', '-sha256',
    '-in', csr,
    '-CA', arquivos.autoridade,
    '-CAkey', arquivos.autoridadeChave,
    '-CAcreateserial',
    '-days', String(dias),
    '-extfile', extensoes,
    '-out', somenteServidor,
  ]);

  // O arquivo servido é a cadeia completa: certificado do servidor + autoridade.
  fs.writeFileSync(
    arquivos.certificado,
    fs.readFileSync(somenteServidor, 'utf8') + fs.readFileSync(arquivos.autoridade, 'utf8')
  );
  protegerChave(arquivos.chave);
  fs.unlinkSync(csr);
  fs.unlinkSync(extensoes);
  fs.unlinkSync(somenteServidor);
}

function emitirAutoassinado({ nomes, ips, dias }) {
  const san = [...nomes.map((n) => `DNS:${n}`), ...ips.map((i) => `IP:${i}`)].join(',');
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
    '-days', String(dias),
    '-keyout', arquivos.chave,
    '-out', arquivos.certificado,
    '-subj', `/C=BR/O=JS Grilo Contabilidade e Gestao/CN=${nomes[1] || nomes[0]}`,
    '-addext', `subjectAltName=${san}`,
  ]);
  protegerChave(arquivos.chave);
}

/* ---------------------------------------------------------- instruções */

function escreverInstrucoes({ nomes, ips, dias }) {
  const texto = `COMO TIRAR O AVISO DE "SITE NÃO SEGURO"
=======================================

O arquivo "autoridade.pem" desta pasta é a autoridade certificadora do
escritório. Instale-o UMA VEZ em cada aparelho que acessa a plataforma. Depois
disso o navegador passa a mostrar o cadeado normalmente em:

${nomes.map((n) => `  https://${n}`).join('\n')}
${ips.map((i) => `  https://${i}`).join('\n')}

O arquivo "autoridade-chave.pem" é SEGREDO: quem tiver essa chave consegue
forjar certificados para qualquer site nos aparelhos onde a autoridade estiver
instalada. Guarde-o só no servidor, com acesso restrito. Não é preciso copiá-lo
para lugar nenhum — os aparelhos recebem apenas "autoridade.pem".

WINDOWS (Chrome, Edge, e o sistema todo)
  1. Copie "autoridade.pem" para o computador e renomeie para "autoridade.crt".
  2. Clique duas vezes no arquivo → "Instalar Certificado".
  3. Escolha "Computador Local" (pede senha de administrador) e avance.
  4. Marque "Colocar todos os certificados no repositório a seguir" →
     "Procurar" → "Autoridades de Certificação Raiz Confiáveis" → OK → Concluir.
  5. Feche e abra o navegador.

macOS (Safari e Chrome)
  1. Abra o app "Acesso às Chaves" (Keychain Access).
  2. Arraste "autoridade.pem" para a chaveira "Sistema".
  3. Dê duplo clique no certificado "JS Grilo - Autoridade Local" → seção
     "Confiar" → "Ao usar este certificado: Confiar sempre".
  4. Feche a janela (pede a senha do Mac) e reabra o navegador.

FIREFOX (em qualquer sistema — ele tem a própria lista)
  1. Ajustes → Privacidade e Segurança → Certificados → "Ver certificados".
  2. Aba "Autoridades" → "Importar" → escolha "autoridade.pem".
  3. Marque "Confiar nesta CA para identificar sites" → OK.

ANDROID
  1. Envie "autoridade.pem" para o aparelho (e-mail, pen drive, rede).
  2. Ajustes → Segurança → Criptografia e credenciais → "Instalar um
     certificado" → "Certificado CA" → escolha o arquivo → "Instalar assim mesmo".
  3. O Android avisa que a rede pode ser monitorada — é o aviso padrão de
     qualquer autoridade instalada manualmente.

iPHONE / iPAD
  1. Envie "autoridade.pem" para o aparelho e abra o arquivo.
  2. Ajustes → "Perfil Baixado" → Instalar (pede o código do aparelho).
  3. IMPORTANTE: Ajustes → Geral → Sobre → "Ajustes de Confiança em
     Certificados" → ative a chave ao lado de "JS Grilo - Autoridade Local".

VALIDADE
  Autoridade: 10 anos. Certificado do servidor: ${dias} dias.
  Para renovar só o certificado do servidor (sem mexer nos aparelhos):
      npm run certificado -- --forcar
  Reinicie a plataforma depois.
`;
  fs.writeFileSync(arquivos.instrucoes, texto);
}

/* ------------------------------------------------------------------ main */

function main() {
  if (temFlag('ajuda') || temFlag('help')) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
    return;
  }

  exigirOpenssl();
  fs.mkdirSync(destino, { recursive: true });

  const dias = Number(argumento('validade', 825)) || 825;
  const { nomes, ips } = alternativos();
  const autoassinado = temFlag('autoassinado');

  const jaExiste = fs.existsSync(arquivos.certificado);
  if (jaExiste && !temFlag('forcar') && !temFlag('nova-autoridade')) {
    console.log(`Já existe um certificado em ${destino}. Use --forcar para emitir outro.\n`);
  } else if (autoassinado) {
    emitirAutoassinado({ nomes, ips, dias });
    console.log('• Certificado autoassinado criado (o navegador vai avisar que não é confiável).');
  } else {
    criarAutoridade();
    emitirCertificado({ nomes, ips, dias });
    escreverInstrucoes({ nomes, ips, dias });
    console.log(`• Certificado do servidor emitido para: ${[...nomes, ...ips].join(', ')}`);
    console.log(`• Validade: ${dias} dias.`);
  }

  console.log('\nColoque estas linhas no seu arquivo .env e reinicie a plataforma:\n');
  console.log(`TLS_CERT=${arquivos.certificado}`);
  console.log(`TLS_KEY=${arquivos.chave}`);
  console.log('HTTP_REDIRECT_PORT=80        # a porta 80 passa a redirecionar para https');
  console.log('PORT=443                     # no Linux exige privilégio para portas abaixo de 1024');

  if (!autoassinado) {
    console.log(`\nInstale ${arquivos.autoridade} nos aparelhos do escritório.`);
    console.log(`Passo a passo por sistema: ${arquivos.instrucoes}`);
  }
  console.log(`\nDepois acesse: https://${nomes.find((n) => n !== 'localhost') || 'localhost'}`);
}

main();
