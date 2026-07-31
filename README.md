# JS Grilo Contabilidade & Gestão — Plataforma de Processos Internos

Aplicação web para abertura e acompanhamento dos processos administrativos e societários
do escritório (constituição, baixa, alteração contratual, entrada/saída de sócio etc.),
com **checklist obrigatório por setor**, **notificações e prazos**, **histórico de auditoria**
e **dashboard gerencial**.

O modelo de dados é o da planilha `Processos.xlsx`: cada aba virou uma tabela do banco e um
ponto de configuração da plataforma.

---

## Requisitos

Apenas **Node.js 22.5 ou superior** (recomendado: Node 22 LTS ou Node 24) — nada além disso.

O banco usa o SQLite embutido no próprio Node (`node:sqlite`), então **não há módulo nativo para
compilar**: a instalação não pede Visual Studio, Xcode, Python nem node-gyp, e funciona igual em
Windows, macOS e Linux.

## Como rodar

```bash
npm install          # instala dependências e copia o Chart.js para public/vendor
npm run seed         # carga inicial: setores, tipos, status, checklist modelo, usuários, parâmetros
npm start            # http://localhost:3000
```

Para subir também alguns processos de demonstração:

```bash
npm run seed:demo
```

Testes das regras de negócio:

```bash
npm test
```

Zerar tudo (banco + uploads):

```bash
npm run reset && npm run seed
```

Configurações de ambiente ficam em `.env` (veja `.env.example`).

### Acesso

O login é feito pelo **ID de usuário** (não pelo e-mail). A carga inicial cria os 15 usuários da
aba `USUÁRIOS` com o ID derivado do nome e a senha definida em `SENHA_PADRAO`
(padrão `jsgrilo@2026`).

| Usuário | ID de login | Setor | Perfil |
|---|---|---|---|
| Jacqueline | `jacqueline` | Diretoria | Administrador |
| Gabriela | `gabriela` | Fiscal | Administrador |
| Jocileide | `jocileide` | Contábil | Administrador |
| Elidiane | `elidiane` | Administrativo | Administrador |
| Ana Paula, Cecilia, Geilza | `ana.paula`, `cecilia`, `geilza` | Fiscal | Usuário |
| Ana Lucia, Lalá, Samuel, Crislane | `ana.lucia`, `lala`, `samuel`, `crislane` | Departamento Pessoal | Usuário |
| Daiane, Nayara | `daiane`, `nayara` | Contábil | Usuário |
| Andreia | `andreia` | Financeiro | Usuário |
| Anna Clara | `anna.clara` | Administrativo | Usuário |

O ID é normalizado ao digitar: maiúsculas, acentos e espaços não impedem o acesso — "Ana Paula",
"ANA.PAULA" e `ana.paula` levam ao mesmo usuário. Quem já tem e-mail cadastrado também consegue
entrar digitando o e-mail, mas o identificador oficial é o ID.

O e-mail passou a ser **opcional** e serve apenas como dado de contato. Administradores definem o
ID em Administração → Usuários; deixando o campo vazio, o sistema deriva do nome
("Ana Paula" vira `ana.paula`).

> Troque as senhas no primeiro acesso (menu **Meu perfil**) ou pela tela **Administração → Usuários**.

## Stack

| Camada | Escolha | Motivo |
|---|---|---|
| Servidor | Node.js + Express | simples de hospedar, sem etapa de build |
| Banco | SQLite embutido no Node (`node:sqlite`) | relacional, arquivo único, backup trivial, **sem dependência nativa para compilar**; migrar para Postgres exige só trocar `src/db/driver.js` |
| Views | EJS renderizado no servidor | páginas rápidas, funcionam sem JavaScript |
| Gráficos | Chart.js servido localmente | sem CDN |
| PDF | PDFKit | checklist e relatório final gerados no servidor |
| Sessão/senha | express-session + bcryptjs | store de sessão em SQLite (`src/lib/session-store.js`) |

Não há dependência de CDN, serviço externo, etapa de compilação ou módulo nativo.

---

## Estrutura

```
src/
  app.js                 Express, sessão, helpers de view, tratamento de erros
  server.js              inicialização + agendador de alertas de prazo
  config.js              variáveis de ambiente
  db/
    schema.sql           esquema relacional (uma tabela por aba da planilha)
    seed-data.js         conteúdo da planilha (fonte da carga inicial)
    driver.js            acesso ao SQLite embutido do Node (sem módulo nativo)
    index.js             conexão, migrações e transações
  domain/                regras de negócio (testáveis, sem Express)
    processos.js         criação, numeração, motor de status, conclusão, prazos
    checklist.js         clonagem do modelo, respostas, impedimentos, fila
    parametros.js        leitura tipada de PARAMETROS + numeração automática
    acesso.js            perfis, setores e visibilidade
    historico.js         auditoria automática
    notificacoes.js      e-mails (transporte simulado ou SMTP) + outbox
    integracoes.js       adaptadores: Google Chat/Drive + stubs previstos
    documentos.js        upload/registro de anexos
    dashboard.js         indicadores gerenciais
    usuarios.js          autenticação por ID de usuário e CRUD
    avisos.js            mural interno visível a todos os usuários
  routes/                camada HTTP
  views/                 telas EJS
  public/                CSS, JS, Chart.js e a logomarca (img/)
scripts/                 seed, reset, cópia de assets
tests/                   testes das regras de negócio (node:test)
```

---

## Da planilha para a plataforma

| Aba | Onde vive |
|---|---|
| `TIPOS_PROCESSO` | tabela `tipos_processo` · **Administração → Tipos e setores** |
| `STATUS_PROCESSO` | tabela `status_processo` · aplicados automaticamente pelo motor de status |
| `SETORES` | tabela `setores` · **Administração → Tipos e setores** |
| `PROCESSOS` | tabela `processos` · **Abrir processo** e painel do processo |
| `CHECKLIST_MODELO` | tabela `checklist_modelo` · **Administração → Checklist modelo** |
| `CHECKLIST` | tabela `checklist` · gerada na abertura, respondida no painel do processo |
| `USUÁRIOS` | tabela `usuarios` · **Administração → Usuários** |
| `HISTÓRICO` | tabela `historico` · linha do tempo do processo e **Auditoria** |
| `PARAMETROS` | tabela `parametros` · **Administração → Parâmetros** |

Além das abas da planilha, a plataforma mantém as tabelas `avisos` e `avisos_lidos` (mural interno),
`documentos`, `notificacoes` (outbox de e-mail) e `sessoes`.

**Setores auxiliares.** O `CHECKLIST_MODELO` referencia cinco “setores” que não estão na aba
`SETORES`: Sócios, Financeiro, Cliente, TI e Qualidade. Eles foram criados como setores
marcados como *auxiliares*: aparecem no checklist normalmente, e quem responde por eles é o
**Administrativo** (além de administradores e Diretoria) — exceto Financeiro, que tem equipe
própria na aba de usuários. A classificação é editável em Administração → Tipos e setores.

---

## Regras de negócio implementadas

**Numeração automática** — `PREFIXO_PROCESSO` + ano + sequencial com `DIGITOS_PROCESSO` dígitos
(`PR-2026-0001`), incrementando `PROXIMO_PROCESSO` dentro da mesma transação da criação. A
sequência reinicia sozinha quando o ano vira.

**Abertura do processo** — status inicial `Aberto`; `DATA_PREVISAO` = abertura +
`PRAZO_PADRAO_PROCESSO_DIAS`; o checklist é clonado do modelo (itens do tipo escolhido **+**
os itens da linha “Todos”), cada item recebendo o prazo do seu setor
(`PRAZO_FISCAL_HORAS`, `PRAZO_DP_HORAS`, `PRAZO_CONTABIL_HORAS`, `PRAZO_JURIDICO_HORAS`).

**Motor de status** — recalculado a cada resposta do checklist:

1. algum item impedido → `Impedido`;
2. todos os obrigatórios bloqueantes concluídos → `Liberado`;
3. status de espera definido manualmente é preservado enquanto houver pendências;
4. caso contrário, `Em Análise <setor>` do primeiro setor com item pendente (Fiscal, DP,
   Contábil, Jurídico) — ou `Aberto`.

Os status de espera (`Aguardando Cliente`, `Aguardando Assinaturas`, `Aguardando Junta
Comercial`, `Aguardando Receita Federal`, `Aguardando Prefeitura`) são definidos na tela do
processo. Alterar manualmente para um status de análise exige `PERMITIR_PULAR_ETAPAS`.

**Impedimento** — marcar impedimento exige descrição (`EXIGIR_OBSERVACAO_IMPEDIMENTO`), muda o
item para `Impedido`, joga o processo para `Impedido`, notifica Diretoria e Administrativo
(`ENVIAR_EMAIL_IMPEDIMENTO`) e publica um aviso interno para todos os usuários.

**Bloqueio de conclusão** — com `BLOQUEAR_CONCLUSAO_COM_PENDENCIA` ligado, o botão “Concluir
processo” fica desabilitado e a tela lista exatamente o que falta:

- itens obrigatórios pendentes (de setores com aprovação obrigatória);
- qualquer item impedido;
- todos os itens, inclusive opcionais, se `EXIGIR_CHECKLIST_100` estiver ligado;
- revisão final do setor Qualidade (`EXIGIR_REVISAO_FINAL`);
- ao menos um documento anexado (`EXIGIR_UPLOAD_DOCUMENTOS`);
- conclusão por gestor (`EXIGIR_APROVACAO_GESTOR`).

Itens com `OBRIGATORIO = Não` aparecem marcados como **opcional** e não bloqueiam.
`EXIGIR_APROVACAO_JURIDICA = Não` faz os itens do Jurídico não bloquearem a conclusão —
mesma lógica vale para Fiscal, DP e Contábil.

**Dupla conferência** — com `EXIGIR_DUPLA_CONFERENCIA` ligado, a resposta fica pendente até
que **outro** colaborador confirme o item.

**Auditoria** — criação, alteração de cadastro, resposta de item, impedimento, mudança de
status, conclusão, cancelamento, reabertura, upload/remoção de documento, geração de PDF e
alteração de parâmetros geram linha em `HISTORICO` automaticamente, com usuário e data/hora.

**Controle de acesso** — perfil `Administrador` e setor `Diretoria` veem tudo. Perfil `Usuário`
vê os processos em que o seu setor tem itens (mais os que abriu ou conduz) e só responde os
itens do próprio setor. O dashboard gerencial é restrito a gestores; a área de Administração,
a administradores.

---

## Avisos internos (mural para todos os usuários)

Quando um processo é **concluído com sucesso** ou fica **impedido**, a plataforma publica um aviso
que aparece para **todos os usuários**, independentemente de setor ou perfil — em faixa no topo de
qualquer tela e no mural em **Avisos**, com contador de não lidos no menu.

- o aviso de conclusão informa o processo, o cliente e quem concluiu;
- o aviso de impedimento traz o setor e o motivo registrado;
- cada pessoa dispensa o seu aviso no “×”; isso não afeta o que os outros veem;
- o mural guarda o histórico, marcando o que já foi lido.

É diferente das notificações por e-mail, que são dirigidas ao setor responsável.

## Notificações, prazos e integrações

O envio de e-mail passa por um transporte configurável (`MAIL_TRANSPORT`). No padrão `mock`
nada sai para a internet, mas **toda notificação é registrada** na tabela `notificacoes` e
pode ser auditada em **Administração → Notificações** — inclusive as suprimidas por parâmetro.
Para ativar envio real, implemente o transporte `smtp` em `src/domain/notificacoes.js`; o
restante da aplicação não muda.

Eventos cobertos: abertura de processo (avisa cada setor envolvido), vez do setor, impedimento,
conclusão e alertas de prazo. Os alertas usam `ALERTAR_PROCESSO_ATRASADO` e
`DIAS_ALERTA_ATRASO`, rodam em segundo plano a cada `ALERT_INTERVAL_MINUTES` e podem ser
disparados manualmente na tela de Notificações (útil para agendar por cron externo).

As integrações ficam em `src/domain/integracoes.js`, cada uma com seu adaptador:

| Integração | Situação |
|---|---|
| Google Chat | implementada (webhook em `WEBHOOK_GOOGLE_CHAT`) |
| Google Drive | adaptador pronto, aguardando credenciais de serviço |
| WhatsApp, Onvio, Domínio Sistemas, e-CAC | previstas e desligadas, conforme a planilha |

---

## Documentos e relatórios

- Upload de anexos por processo, com registro de quem enviou e quando.
- **PDF do checklist** preenchido, agrupado por setor, com respostas, responsáveis, prazos e
  impedimentos (`GERAR_PDF_CHECKLIST`).
- **Relatório final** com cadastro, checklist, documentos e histórico completo
  (`GERAR_RELATORIO_FINAL`).

---

## Dashboard gerencial

Processos por status e por tipo (gráficos), impedidos com motivo, concluídos no período,
tempo médio de conclusão por tipo, produtividade por setor, ranking de colaboradores e meta
mensal (`META_PROCESSOS_MES`) versus realizado. Cada bloco respeita a preferência de exibição
correspondente em `PARAMETROS` (`EXIBIR_GRAFICOS`, `EXIBIR_TEMPO_MEDIO`, …).

---

## Identidade visual

A logomarca fica em `src/public/img/`:

| Arquivo | Onde aparece |
|---|---|
| `logo-jsgrilo.png` | topo da barra lateral, tela de login e cabeçalho dos PDFs |
| `marca-jsgrilo.png` | ícone da aba do navegador (favicon) |
| `logo-jsgrilo.webp` | original recebido, guardado como referência |

Para trocar a marca, basta substituir os arquivos mantendo os nomes — a plataforma lê as dimensões
do PNG na hora de montar o PDF, então logos com outra proporção continuam saindo corretas. Se
`logo-jsgrilo.png` for removido, os PDFs voltam a imprimir o nome do escritório em texto.

## Se algo der errado na instalação

**`npm error ... better-sqlite3 ... gyp ERR! find VS`** — versões anteriores deste projeto usavam o
`better-sqlite3`, um módulo nativo que precisa ser compilado em C++ quando não existe binário pronto
para a sua versão do Node. A partir desta versão o projeto usa o SQLite embutido no Node e o erro
não acontece mais. Se você veio de uma cópia antiga, apague a pasta `node_modules` e o arquivo
`package-lock.json` e rode `npm install` de novo.

**`node:sqlite não disponível` ou erro pedindo Node 22.5+** — rode `node -v`. Se a versão for
anterior à 22.5, instale o Node 22 LTS ou o Node 24 em <https://nodejs.org> e repita `npm install`.

**A porta 3000 já está em uso** — defina outra no arquivo `.env` (`PORT=3001`) ou na linha de
comando (`PORT=3001 npm start`).

**Quero recomeçar do zero** — `npm run reset && npm run seed` apaga o banco e os anexos e recarrega
o modelo da planilha.

## Backup

Todo o estado fica em `data/` (banco SQLite + uploads). Copiar essa pasta com a aplicação
parada é um backup completo. O parâmetro `BACKUP_AUTOMATICO` está previsto na tela de
parâmetros, mas a rotina agendada de cópia ainda não foi implementada — hoje o backup é
externo (cron copiando `data/`).

---

## O que ainda não está implementado

- Envio real de e-mail (transporte SMTP) — a estrutura está pronta, falta plugar o provedor.
- Upload efetivo para o Google Drive — depende das credenciais da conta de serviço.
- WhatsApp, Onvio, Domínio Sistemas e e-CAC — previstos e desligados, conforme combinado.
- Rotina agendada de backup automático.

---

Plataforma criada por **Rodrigo Grilo Salina** e **Gabriela Dionizio**.
