-- =====================================================================
-- JS Grilo Contabilidade & Gestão - Plataforma de Processos Internos
-- Esquema relacional espelhando as abas da planilha Processos.xlsx
-- =====================================================================

PRAGMA foreign_keys = ON;

-- --------------------------------------------------------------- SETORES
CREATE TABLE IF NOT EXISTS setores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nome       TEXT    NOT NULL UNIQUE,
  -- setores "auxiliares" (Sócios, Cliente, TI, Qualidade, Financeiro) aparecem
  -- no CHECKLIST_MODELO mas não são setores operacionais da aba SETORES.
  auxiliar   INTEGER NOT NULL DEFAULT 0 CHECK (auxiliar IN (0, 1)),
  ativo      INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),
  ordem      INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------------------------------- TIPOS_PROCESSO
CREATE TABLE IF NOT EXISTS tipos_processo (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  nome  TEXT    NOT NULL UNIQUE,
  ativo INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),
  ordem INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------------------------------ STATUS_PROCESSO
CREATE TABLE IF NOT EXISTS status_processo (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  nome   TEXT    NOT NULL UNIQUE,
  ordem  INTEGER NOT NULL DEFAULT 0,
  -- status "final" encerra o processo (Concluído / Cancelado)
  final  INTEGER NOT NULL DEFAULT 0 CHECK (final IN (0, 1)),
  -- status de espera podem ser definidos manualmente pelo responsável
  espera INTEGER NOT NULL DEFAULT 0 CHECK (espera IN (0, 1))
);

-- -------------------------------------------------------------- USUARIOS
-- O acesso é feito pelo ID de usuário (`login`), não pelo e-mail.
-- O e-mail permanece como dado de contato e é opcional.
CREATE TABLE IF NOT EXISTS usuarios (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nome       TEXT    NOT NULL,
  login      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  email      TEXT    UNIQUE COLLATE NOCASE,
  senha_hash TEXT    NOT NULL,
  setor_id   INTEGER NOT NULL REFERENCES setores (id),
  perfil     TEXT    NOT NULL DEFAULT 'Usuário' CHECK (perfil IN ('Administrador', 'Usuário')),
  status     TEXT    NOT NULL DEFAULT 'Ativo'   CHECK (status IN ('Ativo', 'Inativo')),
  criado_em  TEXT    NOT NULL DEFAULT (datetime('now')),
  ultimo_login TEXT
);

-- ------------------------------------------------------ CHECKLIST_MODELO
-- tipo_processo_id NULL == linha "Todos" da planilha (aplica-se a todo processo)
CREATE TABLE IF NOT EXISTS checklist_modelo (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo_processo_id INTEGER REFERENCES tipos_processo (id) ON DELETE CASCADE,
  setor_id         INTEGER NOT NULL REFERENCES setores (id),
  item             TEXT    NOT NULL,
  obrigatorio      INTEGER NOT NULL DEFAULT 1 CHECK (obrigatorio IN (0, 1)),
  ativo            INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),
  ordem            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_modelo_tipo ON checklist_modelo (tipo_processo_id);

-- -------------------------------------------------------------- PROCESSOS
CREATE TABLE IF NOT EXISTS processos (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo                 TEXT    NOT NULL UNIQUE,          -- ID_PROCESSO (PR-2026-0001)
  data_abertura          TEXT    NOT NULL,                 -- ISO date
  tipo_processo_id       INTEGER NOT NULL REFERENCES tipos_processo (id),
  status_id              INTEGER NOT NULL REFERENCES status_processo (id),
  status_manual          INTEGER NOT NULL DEFAULT 0 CHECK (status_manual IN (0, 1)),
  etapa_atual            TEXT,
  razao_social           TEXT    NOT NULL,
  nome_fantasia          TEXT,
  cnpj                   TEXT,
  inscricao_estadual     TEXT,
  inscricao_municipal    TEXT,
  municipio              TEXT,
  uf                     TEXT,
  cliente_responsavel    TEXT,
  telefone               TEXT,
  email                  TEXT,
  responsavel_interno_id INTEGER REFERENCES usuarios (id),
  data_previsao          TEXT,
  data_conclusao         TEXT,
  observacoes            TEXT,
  criado_por_id          INTEGER REFERENCES usuarios (id),
  criado_em              TEXT    NOT NULL DEFAULT (datetime('now')),
  atualizado_em          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_processos_status ON processos (status_id);
CREATE INDEX IF NOT EXISTS idx_processos_tipo   ON processos (tipo_processo_id);

-- -------------------------------------------------------------- CHECKLIST
CREATE TABLE IF NOT EXISTS checklist (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo                 TEXT    NOT NULL UNIQUE,          -- CHK-0001
  processo_id            INTEGER NOT NULL REFERENCES processos (id) ON DELETE CASCADE,
  setor_id               INTEGER NOT NULL REFERENCES setores (id),
  item                   TEXT    NOT NULL,
  obrigatorio            INTEGER NOT NULL DEFAULT 1 CHECK (obrigatorio IN (0, 1)),
  resposta               TEXT    CHECK (resposta IN ('Sim', 'Não', 'N/A')),
  possui_impedimento     INTEGER NOT NULL DEFAULT 0 CHECK (possui_impedimento IN (0, 1)),
  descricao_impedimento  TEXT,
  responsavel_id         INTEGER REFERENCES usuarios (id),
  data_resposta          TEXT,
  status_item            TEXT    NOT NULL DEFAULT 'Pendente'
                                 CHECK (status_item IN ('Pendente', 'Concluído', 'Impedido')),
  -- dupla conferência (parâmetro EXIGIR_DUPLA_CONFERENCIA)
  conferido_por_id       INTEGER REFERENCES usuarios (id),
  data_conferencia       TEXT,
  prazo                  TEXT,                             -- deadline calculado (PRAZO_*_HORAS)
  data_criacao           TEXT    NOT NULL DEFAULT (datetime('now')),
  data_atualizacao       TEXT,
  observacao             TEXT,
  ordem                  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_checklist_processo ON checklist (processo_id);
CREATE INDEX IF NOT EXISTS idx_checklist_setor    ON checklist (setor_id, status_item);

-- -------------------------------------------------------------- HISTORICO
CREATE TABLE IF NOT EXISTS historico (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  processo_id INTEGER REFERENCES processos (id) ON DELETE CASCADE,
  acao        TEXT    NOT NULL,
  usuario_id  INTEGER REFERENCES usuarios (id),
  usuario_nome TEXT,                                       -- snapshot (auditoria)
  data_hora   TEXT    NOT NULL DEFAULT (datetime('now')),
  observacao  TEXT
);
CREATE INDEX IF NOT EXISTS idx_historico_processo ON historico (processo_id, id);

-- ------------------------------------------------------------- PARAMETROS
CREATE TABLE IF NOT EXISTS parametros (
  chave     TEXT PRIMARY KEY,
  valor     TEXT,
  tipo      TEXT NOT NULL DEFAULT 'texto' CHECK (tipo IN ('texto', 'numero', 'booleano', 'email')),
  categoria TEXT NOT NULL DEFAULT 'Geral',
  descricao TEXT,
  editavel  INTEGER NOT NULL DEFAULT 1 CHECK (editavel IN (0, 1))
);

-- ------------------------------------------------------------- DOCUMENTOS
CREATE TABLE IF NOT EXISTS documentos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  processo_id   INTEGER NOT NULL REFERENCES processos (id) ON DELETE CASCADE,
  nome_original TEXT    NOT NULL,
  nome_arquivo  TEXT    NOT NULL,
  mime          TEXT,
  tamanho       INTEGER,
  descricao     TEXT,
  usuario_id    INTEGER REFERENCES usuarios (id),
  drive_file_id TEXT,                                      -- integração futura Google Drive
  criado_em     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documentos_processo ON documentos (processo_id);

-- ----------------------------------------------------------- NOTIFICACOES
-- "outbox": toda notificação gerada fica registrada, mesmo quando o
-- transporte é simulado (mock). Permite auditoria e reenvio.
CREATE TABLE IF NOT EXISTS notificacoes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  canal        TEXT    NOT NULL DEFAULT 'email',
  destinatario TEXT    NOT NULL,
  setor        TEXT,
  assunto      TEXT    NOT NULL,
  corpo        TEXT    NOT NULL,
  processo_id  INTEGER REFERENCES processos (id) ON DELETE CASCADE,
  evento       TEXT,
  status       TEXT    NOT NULL DEFAULT 'Enviada' CHECK (status IN ('Enviada', 'Falha', 'Suprimida')),
  erro         TEXT,
  criado_em    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notificacoes_processo ON notificacoes (processo_id);

-- ----------------------------------------------------------------- AVISOS
-- Comunicados exibidos dentro da plataforma para TODOS os usuários —
-- hoje: processo concluído e processo impedido. Diferente de `notificacoes`,
-- que é o outbox de e-mail dirigido a um destinatário específico.
CREATE TABLE IF NOT EXISTS avisos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo        TEXT    NOT NULL CHECK (tipo IN ('concluido', 'impedido')),
  titulo      TEXT    NOT NULL,
  mensagem    TEXT    NOT NULL,
  processo_id INTEGER REFERENCES processos (id) ON DELETE CASCADE,
  usuario_id  INTEGER REFERENCES usuarios (id),
  usuario_nome TEXT,
  criado_em   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_avisos_criado ON avisos (id DESC);

-- Marcação de leitura por usuário: o aviso vale para todos, mas cada um
-- dispensa o seu.
CREATE TABLE IF NOT EXISTS avisos_lidos (
  aviso_id   INTEGER NOT NULL REFERENCES avisos (id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
  lido_em    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (aviso_id, usuario_id)
);

-- Sessões do express-session ficam na tabela `sessoes` (src/lib/session-store.js).
