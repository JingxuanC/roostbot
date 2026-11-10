-- 0025_computer_nodes.sql — 本地 Computer / roostd / 绑定 / 任务
--
-- 设计：docs/design/local-computer.md。
-- Computer 是执行节点，不是第二个 workspace home；绑定决定哪个 Bot 的哪个
-- 轮次可以在用户电脑上执行。

CREATE TABLE computers (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  os              TEXT NOT NULL,
  arch            TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  version         TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'connected',
  last_seen_at    INTEGER,
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER
);

CREATE INDEX idx_computers_account ON computers(account_id, created_at DESC);

CREATE TABLE computer_tokens (
  id              TEXT PRIMARY KEY,
  computer_id     TEXT NOT NULL,
  token_hash      TEXT NOT NULL UNIQUE,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  revoked_at      INTEGER
);

CREATE INDEX idx_computer_tokens_computer ON computer_tokens(computer_id);

CREATE TABLE computer_bindings (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  computer_id     TEXT NOT NULL,
  bot_id          TEXT NOT NULL,
  agent_kind      TEXT NOT NULL,
  workdir_label   TEXT,
  permission_json TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER
);

CREATE INDEX idx_computer_bindings_workspace ON computer_bindings(workspace_id, status);
CREATE INDEX idx_computer_bindings_computer ON computer_bindings(computer_id, status);
CREATE UNIQUE INDEX idx_computer_bindings_active_bot
  ON computer_bindings(workspace_id, bot_id) WHERE status = 'active';

CREATE TABLE computer_jobs (
  id              TEXT PRIMARY KEY,
  binding_id      TEXT NOT NULL,
  computer_id     TEXT NOT NULL,
  workspace_id    TEXT NOT NULL,
  room_id         TEXT NOT NULL,
  round_id        TEXT NOT NULL,
  slot_index      INTEGER NOT NULL,
  bot_id          TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'queued',
  lease_until     INTEGER,
  idem            TEXT NOT NULL UNIQUE,
  payload_json    TEXT NOT NULL,
  result_json     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_computer_jobs_poll
  ON computer_jobs(computer_id, state, created_at);
CREATE INDEX idx_computer_jobs_round
  ON computer_jobs(round_id, slot_index);
