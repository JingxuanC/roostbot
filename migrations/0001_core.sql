-- 0001_core.sql — core schema (events + workspace + auth).
--
-- 事实源：
--   docs/design/events.md     §3 事件信封
--   docs/design/workspace.md  §8 数据模型（workspaces / workspace_members）
--   docs/design/auth.md       §9 数据模型（accounts / devices / sessions / pairing_codes）
--
-- 约定：
--   * 所有 *_at / expires_at 都是 epoch 毫秒（与 JS Date.now() 对齐）；events.at 例外，见下。
--   * events.at 存 ISO-8601 字符串（信封要求「写入时刻」，按 seq 排序，不用时间戳排序）。
--   * events 只追加：本迁移之后的代码不得 UPDATE/DELETE 事件行，删除写 tombstone 事件
--     （events.md §2、§8）。seq 用 AUTOINCREMENT，保证永不复用。
--   * auth/workspace 表不加外键，与 auth.md §9、workspace.md §8 的 DDL 一致：控制面是权威，
--     卷里的这份是转发/投影，约束留给控制面。唯一的例外是 events.parent（时间线完整性）。
--
-- 不建 client_sessions：workspace.md §8 的 client_sessions 与 auth.md §9 的 sessions 是同一概念，
-- 这里以 auth.md 的 sessions 为准（见 packages/store/README.md「设计文档不一致」）。

CREATE TABLE events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT    NOT NULL UNIQUE,
  at           TEXT    NOT NULL,
  domain       TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  actor_json   TEXT,
  subject_json TEXT,
  audience     TEXT,
  parent       INTEGER REFERENCES events(seq),
  idem         TEXT    UNIQUE,
  trace_json   TEXT,
  payload_json TEXT    NOT NULL DEFAULT '{}',
  v            INTEGER NOT NULL DEFAULT 1 CHECK (v >= 1)
);

-- 读模型基本都按 seq 升序、按域/可见性切，故按 (过滤列, seq) 建索引。
CREATE INDEX idx_events_domain_seq   ON events(domain, seq);
CREATE INDEX idx_events_audience_seq ON events(audience, seq);
CREATE INDEX idx_events_kind_seq     ON events(kind, seq);
CREATE INDEX idx_events_parent       ON events(parent);

CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  home_mode   TEXT NOT NULL CHECK (home_mode IN ('cloud', 'local')),
  state       TEXT NOT NULL CHECK (state IN ('absent', 'stopped', 'starting', 'running', 'stopping', 'migrating')),
  volume_id   TEXT,
  profile_ver TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_workspaces_tenant ON workspaces(tenant_id, created_at);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  invited_by   TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT,                       -- Argon2id；OIDC-only 账号为空
  oidc_subject  TEXT,
  created_at    INTEGER NOT NULL,
  disabled_at   INTEGER
);

CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  label        TEXT,
  platform     TEXT CHECK (platform IN ('web', 'desktop', 'ios', 'android', 'cli')),
  last_seen_at INTEGER,
  revoked_at   INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_devices_account ON devices(account_id);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);

CREATE INDEX idx_sessions_device     ON sessions(device_id);
CREATE UNIQUE INDEX idx_sessions_token ON sessions(token_hash);

CREATE TABLE pairing_codes (
  code         TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  workspace_id TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

CREATE INDEX idx_pairing_codes_expires ON pairing_codes(expires_at);
