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

Os comandos deste README são para o **Git Bash** (Windows) ou para qualquer terminal
Linux/macOS — a mesma sintaxe serve nos dois. No Windows, abra o **Git Bash** (menu Iniciar), não o
Prompt de Comando: é ele que traz o `openssl` usado pelos certificados e entende `cp`, `export` e
variáveis na frente do comando.

```bash
npm install          # instala dependências e copia o Chart.js para public/vendor
cp .env.example .env # configurações locais (edite depois, se precisar)
npm run doutor       # confere Node, OpenSSL, .env, banco e certificado
npm run seed         # carga inicial: setores, tipos, status, checklist modelo, usuários, parâmetros
npm start            # http://localhost:3000
```

Para subir também alguns processos de demonstração:

```bash
npm run seed:demo
```

Testes (regras de negócio, segurança, HTTPS, notificações e backup):

```bash
npm test
```

Zerar tudo (banco + uploads):

```bash
npm run reset && npm run seed
```

### Comandos do dia a dia

| O que fazer | Comando |
|---|---|
| Conferir o ambiente | `npm run doutor` |
| Subir a plataforma | `npm start` |
| Subir recarregando a cada alteração | `npm run dev` |
| Rodar com outra porta, só nesta vez | `PORT=8080 npm start` |
| Rodar em modo produção, só nesta vez | `NODE_ENV=production npm start` |
| Gerar autoridade + certificado TLS | `npm run certificado -- --nomes jsgriloprocessos` |
| Gerar chaves de Web Push | `npm run vapid` |
| Gerar um segredo de sessão | `openssl rand -hex 32` |

### Detalhes do Git Bash no Windows

Nada no projeto depende do terminal, mas quatro coisas mudam na hora de digitar:

- **Variável só para um comando** vai na frente, sem `set`:
  `NODE_ENV=production npm start` (no Prompt de Comando seria `set NODE_ENV=production && npm start`).
- **Copiar arquivo** é `cp`, não `copy`: `cp .env.example .env`.
- **Caminhos no `.env`**: prefira os relativos que já estão no exemplo (`./data/certificados/certificado.pem`).
  Se precisar de um caminho absoluto, não cole o que o `pwd` mostra (`/c/Users/...`) — o Node no Windows não
  entende esse formato. Use `pwd -W`, que devolve `C:/Users/...`.
- **`openssl` só existe no Git Bash.** Se `npm run certificado` reclamar que não encontrou o OpenSSL, você
  está no Prompt de Comando ou no PowerShell; abra o Git Bash e repita.

Se algum comando interativo travar sem mostrar nada (raro), rode com `winpty` na frente:
`winpty npm run certificado`.

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
| Planilhas | SheetJS (`xlsx`) | leitura do relatório de empresas do Domínio em .xlsx, .xls e .csv |

Não há etapa de compilação nem módulo nativo, e a aplicação não busca nada na internet para
funcionar. A única dependência que não vem do npm é a `xlsx` (SheetJS), instalada a partir do CDN
oficial do próprio projeto — é lá que saem as versões atuais, sem as vulnerabilidades da última
publicada no npm. Isso vale só no `npm install`; a aplicação em si continua offline.

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
  lib/
    seguranca.js         HTTPS obrigatório, cabeçalhos/CSP, freio de força bruta
    csrf.js              token por sessão em todo formulário
    eventos.js           canal SSE dos avisos em tempo real
    webpush.js           Web Push (VAPID + aes128gcm) com o crypto do Node
    registro.js          log de diagnóstico das notificações
    session-store.js     sessões no mesmo SQLite da aplicação
    compressao.js        gzip nas respostas de texto (o canal de avisos fica fora)
    estaticos.js         versão no endereço do CSS/JS: atualização chega sem limpar cache
    datas.js, pdf.js     utilidades de data e geração de PDF
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
    avisos.js            avisos em tempo real (quem recebe cada evento) e mural
    subtipos.js          subtipos de processo (detalhamento do tipo)
    push.js              inscrições de push por navegador/aparelho
    ordem-setores.js     ordem de atendimento dos setores por tipo de processo
    clientes.js          cadastro das empresas atendidas
    importacao-clientes.js  leitura do relatório de empresas do Domínio Sistemas
    backup.js            backup completo em JSON e restauração transacional
  routes/                camada HTTP
  views/                 telas EJS
  public/                CSS, JS (notificacoes.js), sw.js (Service Worker), Chart.js e fontes
scripts/                 seed, reset, assets, certificado TLS, chaves VAPID, doutor
tests/                   regras de negócio, segurança, HTTPS, notificações e backup (node:test)
```

---

## Da planilha para a plataforma

| Aba | Onde vive |
|---|---|
| `TIPOS_PROCESSO` | tabela `tipos_processo` · **Administração → Tipos e setores** |
| `STATUS_PROCESSO` | tabela `status_processo` · aplicados automaticamente pelo motor de status |
| `SETORES` | tabela `setores` · **Administração → Tipos e setores** |
| `PROCESSOS` | tabela `processos` · **Abrir processo** (empresa escolhida no cadastro de clientes) e painel do processo |
| `CHECKLIST_MODELO` | tabela `checklist_modelo` · **Administração → Checklist modelo** (com filtros por texto, tipo, setor, obrigatoriedade e situação) |
| `CHECKLIST` | tabela `checklist` · gerada na abertura, respondida no painel do processo |
| `USUÁRIOS` | tabela `usuarios` · **Administração → Usuários** |
| `HISTÓRICO` | tabela `historico` · linha do tempo do processo e **Auditoria** |
| `PARAMETROS` | tabela `parametros` · **Administração → Parâmetros** |

Além das abas da planilha, a plataforma mantém as tabelas `clientes` (empresas atendidas),
`avisos`, `avisos_destinos` e `avisos_lidos` (avisos em tempo real e mural), `push_inscricoes`
(navegadores inscritos para receber notificação), `ordem_setores_tipo` (ordem de atendimento por
tipo), `documentos`, `notificacoes` (outbox de e-mail) e `sessoes`.

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

**Cliente vem do cadastro** — em **Abrir processo** os dados da empresa não são mais digitados:
escolhe-se o cliente numa lista alimentada pela aba **Clientes**, com busca por código, nome,
apelido, CNPJ ou município (tolerante a acento e a CNPJ com ou sem máscara; achando um único
resultado, ele já fica selecionado). O resumo da empresa aparece embaixo da lista, com link para a
ficha completa. Ao salvar, razão social, nome fantasia, CNPJ, inscrições, município/UF, responsável
legal, telefone e e-mail são **copiados do cadastro** para o processo — a cópia é proposital: o
processo guarda a foto da empresa no momento da abertura e continua legível mesmo que a ficha mude
depois. Trocar o cliente na tela de edição regrava esses campos e registra a troca no histórico.
Bancos criados antes dessa mudança ganham a coluna `cliente_id` na primeira abertura e os processos
antigos são ligados automaticamente pelo CNPJ; os que não casarem exibem um aviso na edição pedindo
para escolher a empresa. Um cliente com processos vinculados não pode ser excluído (use a situação
`Inativa`).

**Ordem de atendimento por tipo** — em **Administração → Checklist modelo**, ao escolher um tipo
de processo é possível definir quem responde primeiro (por exemplo, Departamento Pessoal antes do
Paralegal na Baixa de Empresa). A ordem é montada **arrastando** os setores da lista: segura,
move para a posição desejada e solta — a gravação é automática, sem botão e sem recarregar a
página (com o teclado, `Tab` até o setor e `↑`/`↓`; sem JavaScript, um botão “Salvar ordem”
aparece no lugar). Funciona com mouse, dedo e caneta, então também no celular. A ordem vale para o
agrupamento do checklist, para a etapa atual, para o status `Em Análise <setor>` e para o aviso de
vez do setor — e, por ser lida no momento do uso, também se aplica aos processos já em andamento.
Tipos sem ordem própria seguem a ordem geral da tabela `setores`; setores sem posição definida vão
para o fim.

**Checklist na ordem (`EXIGIR_ORDEM_SETORES`)** — com o parâmetro ligado (padrão), **um setor só
abre depois que o setor acima dele responder**: se o Fiscal vem antes do Paralegal, o Paralegal só
responde quando o Fiscal terminar. Na tela do processo o setor preso aparece esmaecido, marcado
como *aguardando &lt;setor&gt;*, sem o formulário de resposta e com a explicação de quem ele
espera; na fila e no início, o item traz a mesma marca. A recusa também é feita no servidor — não
adianta forjar o envio —, e vale para todo mundo, inclusive administradores.

Três coisas de propósito **não** seguram a fila, para que ela não emperre sem ninguém errar nada:
item **opcional** (ninguém é obrigado a respondê-lo), setor com a **aprovação desligada** em
Parâmetros (`EXIGIR_APROVACAO_JURIDICA = Não`, por exemplo) e setor **impedido** — um impedimento
já é uma resposta, e travar o escritório inteiro até resolvê-lo pararia o processo. Para voltar ao
atendimento livre, basta `EXIGIR_ORDEM_SETORES = Não` em **Administração → Parâmetros**.

> Parâmetros novos chegam sozinhos a bancos já em uso: na primeira abertura depois da atualização,
> o que falta é inserido na tela de Parâmetros — sem tocar em nenhum valor que o escritório já
> tenha ajustado.

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
(`ENVIAR_EMAIL_IMPEDIMENTO`) e publica um aviso em tempo real para todos os usuários.

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

## Clientes (empresas)

A aba **Clientes** lista as empresas atendidas pelo escritório. Todos os usuários consultam;
**somente administradores** cadastram, editam, removem e importam.

A ficha traz todos os campos do cadastro do Domínio Sistemas: código, apelido, nome, razão social,
nome fantasia, CNPJ/CPF/CEI/CAEPF, inscrições (estadual, municipal, Junta, Suframa, substituição
tributária), endereço completo, contato, natureza jurídica, CNAE, CAE, ramo de atividade, capital
social, responsável legal, contador, foro, duração do contrato, registro, situação e as datas de
inscrição, início de atividades e "cliente desde". A ficha também lista os **processos daquela
empresa** — os abertos pelo seletor de clientes e, por compatibilidade, os antigos que só guardavam
o CNPJ como texto.

O cadastro é a origem dos dados na abertura de processos: sem nenhuma empresa cadastrada, a tela
**Abrir processo** avisa e aponta para cá.

### Importar empresas no modelo Domínio Sistemas

O botão na tela de clientes aceita o relatório **Empresas · Dados cadastrais** exportado do Domínio
(`.xlsx`, `.xls` ou `.csv`). Esse relatório não vem em tabela: cada empresa ocupa um bloco de linhas
com pares `Rótulo: valor` em duas colunas, e o cabeçalho se repete a cada página — o leitor entende
esse formato, ignora os cabeçalhos e aproveita os 45 campos da ficha. Planilhas tabulares comuns
(uma linha de títulos, uma empresa por linha) também são aceitas, com os nomes de coluna
reconhecidos por sinônimos.

O fluxo tem duas etapas: ao enviar o arquivo **nada é gravado** — a tela mostra quantas empresas
foram lidas, quantas são novas, quantas já existem, o que foi descartado e uma amostra do que será
gravado. Só depois da confirmação a importação acontece.

- as empresas são identificadas pelo **código** do Domínio;
- empresas já cadastradas podem ser atualizadas ou mantidas como estão (opção na confirmação);
- as **observações internas** escritas na plataforma nunca são sobrescritas pela importação;
- datas viram formato ISO e o capital social também é guardado como número, para ordenar e somar;
- cada importação fica registrada na auditoria com o resultado.

## Subtipos de processo

O tipo diz **o que é** ("Alteração Contratual"); o subtipo diz **qual** — "Mudança de endereço",
"Entrada de sócio", "Alteração de capital".

- **Cadastro:** Administração → **Tipos e setores**, no cartão *Subtipos de processo*. Cada subtipo
  pertence a um tipo, e o nome é único **dentro do tipo**: dois tipos podem ter um subtipo com o
  mesmo nome, porque são coisas diferentes.
- **Na abertura:** o campo aparece assim que o tipo é escolhido e mostra só os subtipos daquele
  tipo. **Pode marcar mais de um** — uma alteração contratual costuma mudar endereço e capital na
  mesma ida ao cartório. Tipo sem subtipo cadastrado **esconde o campo**.
- **Depois de aberto:** os subtipos são editáveis na tela **Editar cadastro**, e o checklist
  acompanha (abaixo).
- **Opcional por decisão:** nenhum processo é obrigado a ter subtipo. Os processos abertos antes
  desta versão continuam válidos, sem nenhum.
- **Exclusão:** livre enquanto nenhum processo usa o subtipo. Depois disso a exclusão é **recusada**
  — apagar deixaria esses processos sem o detalhe que alguém registrou. O caminho é desmarcar
  **Ativo**: o subtipo some da abertura e continua legível em quem já o usa. Apagar o **tipo** leva
  os subtipos dele junto.

### Checklist por subtipo

Um item do **checklist modelo** pode valer para três alcances, do mais largo ao mais estreito:

| Tipo | Subtipo | Vale para |
|---|---|---|
| *Todos os processos* | — | todo processo aberto |
| um tipo | *Todo o tipo* | todo processo daquele tipo |
| um tipo | um subtipo | só os processos que marcaram **aquele** subtipo |

O checklist do processo é a **soma** dos três, montada na abertura.

#### Como o item repetido é reconhecido

Com dois subtipos marcados, é comum que os dois peçam a mesma coisa — "Emitir certidão negativa
federal" aparece tanto em *Entrada de sócio* quanto em *Alteração de capital*. Sem juntar, o item
nasceria duas vezes e alguém responderia o mesmo trabalho duas vezes.

A identidade do item é **setor + texto**, comparados assim:

- **sem acento, sem caixa, sem espaço sobrando e sem pontuação no fim** — "Emitir certidão
  negativa." e `emitir certidao negativa` são a mesma coisa escrita por duas pessoas;
- **o setor entra na chave de propósito.** A mesma frase em setores diferentes é tarefa de gente
  diferente: "Conferir documentação" no Fiscal e no Contábil são duas conferências, e as duas
  precisam acontecer. Só o texto não bastaria.

Quando o mesmo item chega por caminhos diferentes com exigências diferentes, **vence o mais
exigente**: se for obrigatório em algum deles, entra obrigatório. A posição é a da primeira
aparição, para o checklist não trocar de ordem conforme os subtipos escolhidos.

#### Ao trocar os subtipos de um processo já aberto

O checklist é recalculado e a tela diz exatamente o que mudou:

- **entra** o que passou a valer;
- **sai** o que deixou de valer — **desde que ninguém tenha mexido**;
- **fica** o item que já tem resposta, observação, impedimento ou conferência. Apagá-lo destruiria
  trabalho registrado, e quem respondeu não teria como saber que sumiu. A mensagem informa quantos
  foram mantidos por esse motivo.

Tudo vai para o histórico do processo: quais subtipos entraram e saíram, e quantos itens foram
adicionados, removidos e mantidos.

## Excluir um processo

Privativo do **administrador**, na tela do processo, em *Excluir este processo*.

> **Cancelar** e **excluir** são coisas diferentes. Cancelar encerra o processo e mantém tudo
> legível para todo mundo — é o que serve para trabalho que não vai adiante. Excluir apaga: somem o
> checklist, os anexos (inclusive os arquivos em disco), o histórico e os avisos daquele processo.
> Existe para o que não deveria ter sido aberto: engano de digitação, teste, duplicado.

Três travas, porque não tem volta:

1. **Perfil de administrador** — o bloco nem aparece para os demais, e a rota recusa quem tentar
   por fora.
2. **O número do processo digitado à mão** (`PR-2026-0007`), como a restauração de backup pede a
   palavra `RESTAURAR`. Clicar sem digitar não faz nada.
3. **Uma linha de auditoria que sobrevive** — ela é gravada *sem* processo vinculado, justamente
   para não sair na cascata: fica registrado quem apagou, quando, qual era o número, de que cliente,
   o motivo e quanto se perdeu junto (itens de checklist, anexos, registros de histórico e avisos).

## Avisos em tempo real

Todo movimento de processo publica um aviso que **aparece na hora**, sem recarregar a tela: um
cartão no canto inferior direito, no formato de uma notificação de desktop — título, texto, o
número do processo e um “×” para dispensar. Clicar no título abre o processo.

### Quais ações geram aviso

| Evento | Onde nasce | Quem recebe |
|---|---|---|
| Processo **aberto** | `POST /processos` | usuários dos setores no checklist + quem abriu + quem conduz |
| Item de checklist com **impedimento** | resposta do item | **todos os usuários** |
| Chegou a **vez do setor** | recálculo de status após uma resposta | usuários daquele setor |
| Processo **concluído** | botão Concluir | **todos os usuários** |
| Processo **cancelado** | ação de gestor | setores do processo |
| Processo **reaberto** | ação de gestor | setores do processo |
| **Prazo** vencido ou a vencer | varredura automática de prazos | setores do processo |

Conclusão e impedimento valem para o escritório inteiro — são os dois fatos que interessam a todo
mundo. Os demais vão só para quem participa daquele processo, para ninguém receber aviso de
trabalho que não é seu. O **Administrativo** também é avisado pelos setores auxiliares (Sócios,
Cliente, TI, Qualidade), que é ele quem responde.

### Três caminhos de entrega

A entrega é global por construção: o código vive em `src/public/js/notificacoes.js`, carregado no
rodapé de **toda** página autenticada, e no Service Worker — nada depende da tela aberta.

1. **Web Push + Service Worker** — chega com a plataforma **fechada**. Exige permissão do
   navegador e o par de chaves VAPID no servidor (veja abaixo).
2. **Service Worker acionado pela aba** — a aba recebe o aviso pelo canal SSE e pede ao Service
   Worker que mostre a notificação do sistema. É o caminho que funciona no **Android**, onde
   `new Notification()` dentro da página é proibido pelo navegador.
3. **Cartão dentro da página** — sempre acontece, com ou sem permissão concedida.

O canal em tempo real é **Server-Sent Events** (`GET /eventos`): mão única (servidor → tela), no
mesmo HTTPS da aplicação, reconectando sozinho. **Nenhum aviso se perde no caminho**: a tela guarda
o último aviso que viu e informa ao (re)conectar (`?desde=` e o cabeçalho `Last-Event-ID`); o
servidor repõe o que passou nesse intervalo — a troca de página, a rede que oscilou, o servidor que
reiniciou. O cartão reposto vem marcado como “enquanto você navegava”.

#### Uma conexão por navegador, não uma por aba

O canal é uma conexão HTTP que fica aberta. Em HTTP/1.1 o navegador só permite **seis conexões
simultâneas por endereço**, somando todas as abas — e uma conexão presa conta como ocupada.

Por isso as abas **elegem uma líder**: só ela abre `/eventos`; as outras recebem os avisos por
`BroadcastChannel`, que não passa pela rede. O posto é renovado a cada 2 s num registro compartilhado
(`localStorage`); se a aba líder é fechada, ela devolve o posto na hora, e se ela trava, outra assume
depois de 7 s. A notificação do **sistema** sai só pela líder, para não aparecer repetida; o cartão
dentro da página aparece em todas as abas, como antes.

Em navegador sem `BroadcastChannel`, cada aba abre a sua conexão — funciona igual, só não divide.
O servidor ainda assim limita a 4 canais por usuário e encerra o mais antigo ao passar disso.

### Som ao chegar o aviso

Junto com o cartão sai um **toque curto**, para quem está com a plataforma em outra aba perceber
sem estar olhando para a tela.

O som é **gerado no navegador** pela Web Audio API — duas notas com envelope curto. Não há arquivo
de áudio: um pedido de rede a menos, nada para baixar e nada para manter em cache.

| Situação | O que soa |
|---|---|
| Notificação do navegador **ativada** e a plataforma em segundo plano | o som do **próprio sistema operacional**, que acompanha a notificação — a plataforma não toca por cima, para não soar duas vezes |
| Notificação **não ativada** (ou negada) | o toque da plataforma |
| Som desligado no mural | nada — o cartão e o contador continuam normais |

**A regra do navegador, e o limite dela:** áudio só toca depois que a pessoa **clicou naquela
tela**. Não há como contornar, e nem se deve — é o que impede um site de gritar ao abrir. Duas
consequências práticas:

- O clique que abre uma tela acontece na tela **anterior**. Para o navegador, a tela nova é um
  documento novo, sem clique nenhum — ela começa muda até a pessoa clicar em algo ali.
- Por isso o caminho garantido para ouvir o alerta com a plataforma em segundo plano é **ativar as
  notificações do navegador**: aí quem toca é o sistema operacional, independente de clique.

Em **Avisos** há um interruptor (**"Tocar um som quando chegar aviso"**, ligado por padrão), um
botão **"Testar som"** e uma **linha de estado** que diz, na hora, se o navegador já liberou o áudio
daquela aba — verde para "Som liberado nesta aba", âmbar para "o navegador libera o som depois do
seu primeiro clique em cada tela". Sem essa linha o silêncio parecia defeito da plataforma. O botão
serve de atalho: o clique nele já é o gesto que libera o áudio, e ele diz se o navegador recusou em
vez de fingir que tocou. O ajuste vale por computador (fica no `localStorage`).

**Com várias abas, toca uma vez só.** Quem decide é a aba que segura a conexão: ela toca, e se o
áudio dela ainda não estiver liberado, pergunta quem consegue e **nomeia** a primeira que responder.
Nomear em vez de deixar cada aba tocar por conta é o que evita o coro: o navegador represa os
temporizadores das abas em segundo plano e solta todos no mesmo instante, de modo que qualquer
disputa por tempo terminaria com duas abas tocando juntas.

### Contador na aba do navegador

O cartão e o som resolvem o instante em que o aviso chega. Depois disso, quem foi trabalhar em
outra aba não tem como saber que ficou algo para ler — por isso o número de avisos não lidos
aparece no **rótulo da aba**, nos dois lugares que o navegador mostra:

| Onde | Como fica | Quando é o que se vê |
|---|---|---|
| **Título** | `(3) Processos · JS Grilo Processos` | com poucas abas abertas, o título aparece inteiro |
| **Ícone** | o número **no lugar** da sigla `JS` | com muitas abas o título some e sobra só o ícone |

O ícone é **desenhado no navegador** a cada mudança do número (canvas, 64 px para ficar nítido nas
telas de alta densidade) — não há arquivo de ícone por número. Havendo aviso, o número ocupa o
ícone inteiro no lugar da sigla: aos 16 pixels da aba não cabem os dois, e o que precisa ser lido é
o número. O corpo da fonte é escolhido medindo o texto, para `1` e `99+` ocuparem a mesma largura
útil. Acima de 99 vira `99+`, que é o que cabe. Sem avisos, a sigla volta.

O número é o mesmo do contador ao lado de **Avisos** no menu, e vem do mesmo funil: sobe quando
chega aviso, desce quando um é dispensado no "×" e volta ao ícone original quando tudo está lido.
Vale em **todas as abas abertas**, inclusive nas que não seguram a conexão — elas recebem o número
pelo canal entre abas. E a aba já nasce com o contador certo, a partir do que o servidor desenhou
no menu, sem esperar o canal conectar.

### Permissão do navegador

A permissão **nunca** é pedida no carregamento da página — isso faz o usuário negar por reflexo, e
navegador nenhum pergunta de novo depois. O fluxo é:

- **`default`** (nunca perguntada): depois do login aparece uma faixa discreta em qualquer tela —
  *“Ative as notificações”* — com os botões **Ativar notificações** e **Agora não**. A permissão só
  é solicitada a partir desse clique. “Agora não” silencia a faixa por 7 dias.
- **`granted`**: a faixa some e o navegador é inscrito no push (quando há VAPID configurado).
- **`denied`**: a faixa explica que as notificações estão bloqueadas e traz **o passo a passo do
  navegador em uso** (Chrome, Edge, Firefox, Opera, Safari, Chrome no Android e iOS têm textos
  próprios), com **Não mostrar de novo**. Mesmo bloqueado, o cartão dentro da plataforma e o mural
  continuam funcionando.

A escolha fica guardada no navegador (`localStorage`), então a faixa não volta a cada tela.

### Web Push (notificação com o navegador fechado)

Opcional e **desligado por padrão** — sem as chaves, a plataforma não conversa com nenhum serviço
externo. Para ligar:

```bash
npm run vapid     # gera o par de chaves e mostra as linhas do .env
```

```env
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:contato@seudominio.com.br
```

O conteúdo do aviso viaja **cifrado ponta a ponta** (aes128gcm, RFC 8291) com a chave que o próprio
navegador gerou: o serviço de push (Google/Mozilla/Apple) encaminha, mas não lê o aviso. A
assinatura VAPID (RFC 8292) e a criptografia são feitas com o `crypto` do próprio Node, em
`src/lib/webpush.js` — sem dependência nova. Inscrição que o navegador descartou (404/410) é
apagada sozinha.

Limites que valem conhecer:

- **iOS/iPadOS**: só entrega notificação web se a plataforma for adicionada à Tela de Início
  (PWA), a partir do iOS 16.4. A faixa de bloqueio já explica isso quando detecta iPhone/iPad.
- **HTTPS é obrigatório** para Service Worker e notificações (em `http://localhost` o navegador
  abre exceção, para desenvolvimento).
- Sem VAPID, tudo continua funcionando **com a plataforma aberta em alguma aba** — o que cobre o
  uso normal do escritório.

### Diagnóstico

Com `LOG_NOTIFICACOES` ligado (padrão fora de produção), servidor e tela registram cada etapa:

```
[avisos] 2026-08-05T16:44:11.580Z publicado · aviso=8 tipo=aberto escopo=setores destinatarios=8 processo=PR-2026-0012
[avisos] 2026-08-05T16:44:11.612Z entregue por SSE · aviso=8 canais=2 usuariosSemAbaAberta=6
[avisos] 2026-08-05T16:44:12.004Z push enviado · aviso=8 enviados=3 falhas=0 removidos=0
```

E no console do navegador: `iniciando` → `Service Worker registrado` → `permissão atual` →
`canal conectado` → `aviso recebido` → `cartão exibido na tela` / `notificação do sistema exibida`
(ou o motivo de não ter exibido). É por essas linhas que se descobre em qual etapa um aviso parou.

Isso é diferente das notificações por e-mail, que são dirigidas ao setor responsável e ficam
registradas na tabela `notificacoes`.

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

## Identidade visual e interface

**Tipografia.** Três famílias empacotadas no projeto (`src/public/fonts/`, ~160 KB, nenhuma
requisição a CDN):

| Fonte | Papel |
|---|---|
| Manrope (variável) | títulos, navegação, números e etiquetas |
| IBM Plex Sans (variável) | texto de interface, formulários e tabelas |
| IBM Plex Mono | dados de sistema: `PR-2026-0001`, `CHK-0007`, chaves de parâmetro |

As duas primeiras são fontes variáveis: um arquivo por família cobre todos os pesos, e as duas
principais são pré-carregadas para o texto não "piscar" na troca de fonte.

**Movimento.** As animações servem à leitura, não à decoração: a página se monta de cima para
baixo em cascata curta, os avisos entram deslizando, a barra de progresso preenche a partir do
zero, os indicadores contam até o valor quando entram na tela e o cabeçalho ganha sombra ao rolar.
Botões, linhas de tabela e itens de menu respondem ao ponteiro.

Tudo isso é desligado automaticamente para quem ativa **"reduzir movimento"** no sistema
operacional — nesse caso a interface aparece pronta, sem transições.

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

## Desempenho

Depois de algumas telas, a plataforma travava. A causa era uma só, e mensurável.

### O que estava acontecendo

**Cada aba segurava uma conexão aberta em `/eventos`** (o canal de avisos). Em HTTP/1.1 o navegador
permite **seis conexões simultâneas por endereço**, contando todas as abas juntas. Na sexta aba, as
seis vagas estavam ocupadas por canais de aviso e **nenhuma requisição nova conseguia começar**: a
tela seguinte ficava esperando uma vaga que não vinha.

Medido antes da correção, abrindo uma aba de cada vez e cronometrando a tela seguinte:

| Abas abertas | Carregar `/processos` |
|---|---|
| 1 a 5 | 48–67 ms |
| **6 em diante** | **não carrega** (12 s sem resposta) |

Junto disso havia peso desnecessário: a tela **Abrir processo** trazia as 945 empresas do cadastro
dentro do HTML, com nove atributos cada — **676 KB por carregamento**, em toda abertura e em todo
erro de validação. E nada trafegava comprimido.

### O que foi feito

| Mudança | Efeito |
|---|---|
| **Uma conexão para todas as abas** — as abas elegem uma líder por `BroadcastChannel` (veja "Avisos em tempo real") | de 6 vagas ocupadas para 1, com qualquer número de abas |
| **Seletor de cliente por busca** — `/clientes/buscar` devolve até 20 empresas do que foi digitado, em vez de mandar o cadastro inteiro | `/processos/novo`: 676 KB → 12,5 KB de HTML |
| **Compressão gzip** (`src/lib/compressao.js`, com o zlib do próprio Node) | HTML, CSS, JS e JSON encolhem 70–90% |
| **Endereço versionado nos estáticos** (`app.css?v=6a91e6c7`) | um ano de cache, `immutable`, e a atualização chega na hora — endereço novo é arquivo novo |
| **Consulta de avisos só em quem desenha tela** | chamadas de JSON e o canal de eventos pararam de pagar duas consultas ao banco à toa |
| **Estado inicial do canal por conexão** | conectar uma aba não repõe avisos nas outras |

### Resultado medido

Mesmas telas, mesmos dados, agora com gzip:

| Tela | Antes | Agora | |
|---|---|---|---|
| Minha fila | 25,9 KB | 3,3 KB | −87% |
| Processos | 13,2 KB | 3,1 KB | −77% |
| Clientes | 64,0 KB | 7,9 KB | −88% |
| Avisos | 10,3 KB | 2,5 KB | −75% |
| **Abrir processo** | **675,9 KB** | **3,3 KB** | **−100%** |
| Dashboard | 9,9 KB | 2,9 KB | −71% |
| **as seis juntas** | **799 KB** | **23 KB** | **−97%** |

E com nove abas abertas ao mesmo tempo, `/processos` carrega em 54–74 ms — antes, a partir da sexta,
não carregava.

O backup completo (1,3 MB de JSON) viaja em 159 KB. Duas coisas ficam **fora** da compressão de
propósito: o canal `text/event-stream`, porque comprimir um fluxo aberto significaria segurar os
avisos num buffer, e o que já nasce comprimido (fontes woff2, PDF, imagens).

Os testes em `tests/desempenho.test.js` guardam cada um desses pontos.

## Segurança e publicação na internet

A plataforma foi preparada para ficar exposta na internet. O que já vem ligado:

| Defesa | Como funciona |
|---|---|
| **HTTPS obrigatório** | Com `FORCE_HTTPS` (padrão em produção), toda requisição em HTTP puro é redirecionada com 308 para `https://` — e um POST em HTTP é recusado, nunca redirecionado, para a senha não ser reenviada às cegas depois de já ter viajado em claro. Vale tanto no middleware quanto na porta de redirecionamento (`HTTP_REDIRECT_PORT`). |
| **HSTS** | `Strict-Transport-Security` de 180 dias, enviado só nas respostas que já vieram por HTTPS. |
| **Cookie de sessão** | `HttpOnly` (o JavaScript da página não lê), `SameSite=Lax` e `Secure` sempre que houver HTTPS. Nome próprio (`jsgrilo.sid`), sem revelar a tecnologia. |
| **CSRF** | Todo formulário carrega um token ligado à sessão; sem ele — ou com o token de outra sessão — a escrita é recusada com 403. Vale inclusive para o envio de arquivos e para a restauração de backup. |
| **Content-Security-Policy** | `default-src 'self'` com **nonce por requisição** nos scripts: nada de script inline injetado, nada carregado de outro domínio, nada de `<iframe>` embutindo a plataforma. |
| **Sessão renovada no login** | O identificador de sessão muda no instante em que a senha confere (evita fixação de sessão); sair destrói a sessão no servidor. |
| **Freio de força bruta** | 8 tentativas por IP + usuário a cada 15 minutos (`LOGIN_TENTATIVAS`, `LOGIN_JANELA_MINUTOS`); estourado o limite, responde 429 com `Retry-After` e insistir só renova a espera. |
| **Mensagem única no login** | "ID de usuário ou senha inválidos" tanto para usuário inexistente quanto para senha errada — e o tempo de resposta é o mesmo nos dois casos, para não entregar quais IDs existem. |
| **Senhas** | bcrypt com custo 12 (`BCRYPT_ROUNDS`), mínimo de 8 caracteres, recusando as senhas óbvias das listas de ataque. |
| **Anexos** | Extensões em lista fechada (nada de `.html`, `.svg` ou executável), nome de arquivo higienizado, gravação com nome gerado pelo servidor, download sempre como anexo e com `nosniff`. |
| **Sem redirecionador aberto** | Os campos de "retorno" só aceitam caminhos internos: `//site-falso` e `https://…` viram `/`. |
| **Injeção** | Todo acesso ao banco usa *prepared statements*; o EJS escapa a saída por padrão e os dados embutidos em `<script>` passam por um serializador que neutraliza `</script>`. |
| **Saída para a internet** | Parâmetros de webhook (`WEBHOOK_*`) só aceitam `https://`. |
| **Outros cabeçalhos** | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Origin-Agent-Cluster`, e o `X-Powered-By` desligado. |

Em `NODE_ENV=production` a aplicação **se recusa a subir** com `SESSION_SECRET` fraco — o valor
que vem no `.env.example`, um placeholder conhecido ou qualquer segredo com menos de 24
caracteres — ou sem HTTPS declarado (nem certificado próprio, nem proxy). É proposital: essas duas
falhas não dão erro visível, só deixam a porta aberta. O `npm run doutor` avisa antes disso, ainda
em desenvolvimento.

### HTTPS: tirando o aviso de "site não seguro"

O aviso do navegador não é sobre a criptografia — ela já funciona com qualquer
certificado. O aviso diz que **ninguém conhecido assinou** aquele certificado. Quem assina é uma
autoridade certificadora, e há dois tipos: as **públicas** (Let's Encrypt e afins), em que todo
navegador já confia, e as **privadas**, em que só confia quem as instalar. A escolha entre elas
depende de uma única pergunta: *existe um domínio público apontando para o servidor?*

| Situação | Solução | Aviso do navegador |
|---|---|---|
| Rede interna, sem domínio (`jsgriloprocessos` no arquivo hosts) | **autoridade local do escritório** (abaixo) | some nos aparelhos onde a autoridade for instalada |
| Domínio público real, portas 80/443 abertas | **Let's Encrypt** via Caddy (ou certbot) | some em qualquer aparelho, sem instalar nada |

> **Let's Encrypt não emite certificado para rede local.** Para assinar, ele precisa provar que
> você controla um **domínio público** — e não existe dono comprovável de `jsgriloprocessos` nem
> de `192.168.0.10`. Nenhuma autoridade pública emite certificado para nome inventado ou IP
> privado; é regra do setor, não limitação da plataforma.

---

#### Cenário 1 — rede interna do escritório (autoridade local)

É o caso de hoje: a plataforma é acessada por um nome amigável configurado no arquivo `hosts`,
sem domínio registrado. A saída é o escritório ter **a própria autoridade certificadora**: um
arquivo que você instala uma vez em cada aparelho e que passa a valer como "assinatura conhecida"
naqueles aparelhos.

**1. Gere a autoridade e o certificado** (na máquina que roda a plataforma):

```bash
npm run certificado -- --nomes jsgriloprocessos --ips 192.168.0.10
```

Troque o IP pelo endereço da máquina na rede. O comando cria, em `data/certificados/`:

| Arquivo | Para que serve |
|---|---|
| `autoridade.pem` | **instalar nos aparelhos** — é o que remove o aviso |
| `autoridade-chave.pem` | **segredo do servidor.** Quem tiver essa chave forja certificado de qualquer site nos aparelhos onde a autoridade estiver instalada |
| `certificado.pem` / `chave.pem` | o que a plataforma serve |
| `COMO-INSTALAR.txt` | o passo a passo por sistema, gerado com os nomes que você escolheu |

**2. Aponte o `.env`:**

```env
NODE_ENV=production
SESSION_SECRET=<gere com: openssl rand -hex 32>
TLS_CERT=./data/certificados/certificado.pem
TLS_KEY=./data/certificados/chave.pem
PORT=443
HTTP_REDIRECT_PORT=80
```

No Linux, portas abaixo de 1024 exigem privilégio: rode como serviço (systemd) ou libere o Node
com `sudo setcap 'cap_net_bind_service=+ep' $(which node)`. No Windows, basta rodar como
administrador. Se preferir não mexer nisso, use `PORT=8443` e `HTTP_REDIRECT_PORT=8080` e acesse
`https://jsgriloprocessos:8443`.

**3. Instale `autoridade.pem` em cada aparelho.** O passo a passo completo está em
`data/certificados/COMO-INSTALAR.txt`; em resumo:

- **Windows** — renomeie para `.crt`, clique duas vezes → Instalar Certificado → *Computador
  Local* → "Colocar todos os certificados no repositório a seguir" → **Autoridades de Certificação
  Raiz Confiáveis**. Vale para Chrome e Edge.
- **macOS** — arraste para o *Acesso às Chaves* → chaveira **Sistema** → duplo clique no
  certificado → Confiar → **Confiar sempre**.
- **Firefox** (qualquer sistema, ele tem lista própria) — Ajustes → Privacidade e Segurança →
  Certificados → Ver certificados → aba **Autoridades** → Importar → marcar "Confiar nesta CA
  para identificar sites".
- **Android** — Ajustes → Segurança → Criptografia e credenciais → Instalar um certificado →
  **Certificado CA**.
- **iPhone/iPad** — abra o arquivo → Ajustes → *Perfil Baixado* → Instalar; **e depois**
  Ajustes → Geral → Sobre → **Ajustes de Confiança em Certificados** → ative a chave. Sem esse
  segundo passo o iOS ignora a autoridade.

**Alternativa: mkcert.** O [mkcert](https://github.com/FiloSottile/mkcert) faz exatamente o mesmo
trabalho e instala a autoridade no aparelho onde roda, com um comando:

```bash
mkcert -install                                    # cria e instala a autoridade local
mkcert jsgriloprocessos localhost 192.168.0.10     # emite o certificado
```

Depois aponte `TLS_CERT`/`TLS_KEY` para os arquivos que ele gerar. Nos **outros** aparelhos ainda
é preciso instalar a autoridade do mkcert (`mkcert -CAROOT` mostra onde ela está) — o trabalho por
aparelho é o mesmo dos dois jeitos.

**Renovação.** A autoridade vale 10 anos; o certificado do servidor, 825 dias. Para reemitir só o
certificado (sem tocar em aparelho nenhum):

```bash
npm run certificado -- --forcar
```

---

#### Cenário 2 — domínio público, com proxy na frente (recomendado quando houver domínio)

É o caminho mais simples de manter: o **Caddy** obtém e renova o certificado do Let's Encrypt
sozinho, e a plataforma continua em HTTP no `localhost:3000`, sem nunca mexer em certificado.

Pré-requisitos: domínio registrado (ex.: `processos.jsgrilo.com.br`), **registro DNS apontando
para o IP público do servidor** e **portas 80 e 443 abertas** até a máquina.

`.env`:

```env
NODE_ENV=production
SESSION_SECRET=<openssl rand -hex 32>
TRUST_PROXY=1
PORT=3000
```

`Caddyfile` (o arquivo inteiro):

```
processos.jsgrilo.com.br {
    reverse_proxy localhost:3000
}
```

`sudo caddy run --config Caddyfile` — e pronto: certificado emitido, HTTP redirecionado para
HTTPS e renovação automática a cada 60 dias. `TRUST_PROXY=1` é o que faz a aplicação entender que
a origem era HTTPS (pelo `X-Forwarded-Proto`) e enxergar o IP real de quem acessa, o que importa
para o freio de força bruta no login.

#### Cenário 3 — domínio público, sem proxy

Se preferir que a própria plataforma sirva o TLS, gere o certificado com o certbot e aponte:

```bash
sudo certbot certonly --webroot -w ./data/acme -d processos.jsgrilo.com.br
```

```env
NODE_ENV=production
SESSION_SECRET=<openssl rand -hex 32>
TLS_CERT=/etc/letsencrypt/live/processos.jsgrilo.com.br/fullchain.pem
TLS_KEY=/etc/letsencrypt/live/processos.jsgrilo.com.br/privkey.pem
PORT=443
HTTP_REDIRECT_PORT=80
ACME_WEBROOT=./data/acme
```

A porta 80 continua servindo `/.well-known/acme-challenge/` a partir de `ACME_WEBROOT`, então
`certbot renew` funciona **sem parar a plataforma**. Só falta reiniciar o serviço depois da
renovação (`--deploy-hook "systemctl restart jsgrilo"`), porque o Node lê o certificado ao subir.

---

#### O que muda quando o HTTPS entra

Medido nesta plataforma, antes e depois:

| | `http://jsgriloprocessos` | `https://jsgriloprocessos` |
|---|---|---|
| Contexto seguro (`isSecureContext`) | `false` | `true` |
| Service Worker | **API indisponível** | registrado |
| `Notification.permission` | `denied` (o navegador nem pergunta) | pode ser concedida |
| Notificação do sistema / Web Push | impossível | funciona |
| Cartão de aviso dentro da página (SSE) | funciona | funciona |

Ou seja: **as notificações do sistema operacional só passam a existir depois do HTTPS.** Em HTTP,
fora de `localhost`, o navegador esconde a API inteira — os avisos ficam limitados ao cartão
dentro da página e ao mural.

Duas consequências práticas da migração:

- **O cookie de sessão passa a ser `Secure`.** Quem continuar acessando pelo endereço antigo
  (`http://…` ou `http://IP:3000`) não consegue mais entrar — o navegador descarta o cookie.
  Avise a equipe para usar só o endereço `https://`.
- **HSTS.** Depois da primeira visita em HTTPS, o navegador passa a exigir HTTPS naquele endereço
  por 180 dias (`HSTS_MAX_AGE`) e não aceita mais voltar para HTTP nem clicar em "prosseguir".
  É proteção real, mas dificulta voltar atrás: nas primeiras semanas, considere
  `HSTS_MAX_AGE=86400` (1 dia) e só depois volte ao padrão.
- **Web Push continua exigindo internet.** Com a rede interna isolada, o navegador não alcança o
  serviço de push do fornecedor: a inscrição falha em silêncio e a plataforma segue com o cartão
  na tela e a notificação do sistema disparada pela aba aberta.

### Antes de abrir para a internet

1. troque `SESSION_SECRET` (`openssl rand -hex 32`);
2. troque a senha de todos os usuários — a carga inicial usa a mesma `SENHA_PADRAO` para todos;
3. confira que a pasta `data/` **não** está publicada pelo servidor web (ela guarda o banco, os
   anexos e os backups);
4. baixe um backup pela tela de Parâmetros e guarde fora do servidor;
5. mantenha o Node atualizado (`npm audit` está limpo hoje: 0 vulnerabilidades).

---

## Backup e restauração

Em **Administração → Parâmetros** há o cartão **Backup da plataforma**, com os dois lados da
operação — e os dois são exclusivos do administrador.

**Salvar backup** baixa um único arquivo `.json` com *tudo* o que está na plataforma naquele
momento: processos, checklists, clientes, usuários, parâmetros, checklist modelo, ordem de
atendimento, histórico/auditoria, avisos e notificações. Uma caixa opcional inclui também os
documentos anexados aos processos, e aí o arquivo passa a bastar sozinho. O nome sai no formato
`backup-jsgrilo-2026-08-03-18-29.json`.

**Restaurar backup** recebe esse mesmo arquivo de volta, em duas etapas:

1. no envio, **nada é gravado** — a plataforma confere a assinatura de integridade do arquivo e
   mostra uma tabela comparando, linha a linha, quantos registros existem hoje e quantos vêm no
   backup;
2. a troca só acontece depois de digitar **RESTAURAR** e confirmar. Antes de apagar qualquer
   coisa, o estado atual é salvo sozinho em `data/backups/antes-de-restaurar-….json`.

A restauração é total (apaga e repõe), porque um backup vale como retrato de um momento —
mesclar dois momentos criaria um terceiro que nunca existiu. Ela roda dentro de uma transação:
ou a plataforma inteira volta ao retrato do arquivo, ou nada muda. Ao final, a numeração
automática (`PR-2026-0001`) continua de onde o backup parou.

Detalhes que valem saber:

- o arquivo traz um `checksum` — backup editado à mão, truncado ou de outra origem é recusado
  antes de tocar no banco;
- se o backup não tiver nenhum administrador ativo, a conferência avisa antes de você confirmar;
- as sessões abertas ficam de fora do backup (sessão é do navegador, não do acervo do escritório);
- o arquivo contém dados de clientes e as senhas (cifradas) dos usuários — **guarde-o como
  documento sigiloso**;
- a cópia bruta continua valendo: com a aplicação parada, copiar a pasta `data/` também é um
  backup completo.

O parâmetro `BACKUP_AUTOMATICO` segue previsto na tela de parâmetros; a rotina agendada
(gerar sozinho todo dia) ainda não foi implementada — hoje o backup é sob demanda, pelo botão.

---

## O que ainda não está implementado

- Envio real de e-mail (transporte SMTP) — a estrutura está pronta, falta plugar o provedor.
- Upload efetivo para o Google Drive — depende das credenciais da conta de serviço.
- WhatsApp, Onvio, Domínio Sistemas e e-CAC — previstos e desligados, conforme combinado.
- Rotina agendada de backup automático (o backup manual, pela tela de Parâmetros, está pronto).
- Segundo fator de autenticação e expiração periódica de senha.
- Envio de push a partir de vários processos Node ao mesmo tempo (hoje a plataforma roda em um
  processo só; `src/lib/eventos.js` é o ponto de extensão se um dia forem vários).

---

Plataforma criada por **Rodrigo Grilo Salina** e **Gabriela Dionizio**.
