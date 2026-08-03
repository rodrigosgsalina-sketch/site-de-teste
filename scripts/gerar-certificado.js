#!/usr/bin/env node
'use strict';

/**
 * Gera um certificado TLS autoassinado para testar a plataforma em HTTPS na
 * própria máquina (https://localhost:3000).
 *
 *   npm run certificado
 *
 * O navegador vai avisar que o certificado não tem uma autoridade conhecida —
 * é esperado num certificado de teste. Para a internet, use um certificado real
 * (Let's Encrypt / certbot) ou deixe o HTTPS a cargo de um proxy como o Caddy.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const config = require('../src/config');

const destino = path.join(config.dataDir, 'certificados');
const arquivoChave = path.join(destino, 'chave.pem');
const arquivoCert = path.join(destino, 'certificado.pem');

function temOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function main() {
  if (!temOpenssl()) {
    console.error(
      'O OpenSSL não foi encontrado.\n' +
        '  • Windows: ele vem junto com o Git for Windows — rode este comando no "Git Bash".\n' +
        '  • Linux/macOS: instale o pacote openssl.\n' +
        'Como alternativa, coloque um certificado que você já tenha em TLS_CERT/TLS_KEY.'
    );
    process.exit(1);
  }

  fs.mkdirSync(destino, { recursive: true });

  if (fs.existsSync(arquivoCert) && !process.argv.includes('--forcar')) {
    console.log(`Já existe um certificado em ${destino}. Use --forcar para gerar outro.`);
  } else {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '365', '-nodes',
        '-keyout', arquivoChave,
        '-out', arquivoCert,
        '-subj', '/C=BR/ST=Piaui/L=Teresina/O=JS Grilo Contabilidade e Gestao/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'inherit' }
    );
    // A chave privada não é de leitura pública.
    try {
      fs.chmodSync(arquivoChave, 0o600);
    } catch (_) {
      /* sistemas de arquivo sem permissões POSIX (Windows) */
    }
    console.log(`\nCertificado de teste criado em ${destino}`);
  }

  console.log('\nColoque estas duas linhas no seu arquivo .env e reinicie a plataforma:\n');
  console.log(`TLS_CERT=${arquivoCert}`);
  console.log(`TLS_KEY=${arquivoChave}`);
  console.log('\nDepois acesse https://localhost:' + config.port);
}

main();
