-- 0027_connector_accounts.sql — 连接器身份从 workspace 级改为 account 级。
--
-- 旧模型：一个 workspace 的一个服务只能有一条连接（谁先连谁的账号就是全 workspace 的账号）。
-- 新模型：每个账号可以连自己的账号；workspace 可有多条连接，用 alias 区分，
-- 其中一条可标记为 workspace 默认（Bot 未指定 connection_id 时使用）。
--
-- 选择一次性重建 connections 表，避免 SQLite 不能直接删除 UNIQUE 约束的问题。
-- 旧行保留：account_id = connected_by，alias = legacy_<id>，并标记为默认。

CREATE TABLE connections_new (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  slug          TEXT NOT NULL,
  backend       TEXT NOT NULL,
  status        TEXT NOT NULL,
  account_label TEXT,
  account_id    TEXT NOT NULL,
  alias         TEXT NOT NULL,
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  UNIQUE (workspace_id, slug, account_id),
  UNIQUE (workspace_id, alias)
);

INSERT INTO connections_new
  (id, workspace_id, slug, backend, status, account_label, account_id, alias, is_default, created_at)
SELECT id, workspace_id, slug, backend, status, account_label, connected_by, 'legacy_' || id, 1, created_at
FROM connections;

DROP TABLE connections;
ALTER TABLE connections_new RENAME TO connections;

CREATE INDEX idx_connections_workspace ON connections(workspace_id, created_at);
CREATE UNIQUE INDEX idx_connections_workspace_default
  ON connections(workspace_id, slug)
  WHERE is_default = 1;

ALTER TABLE connector_grants ADD COLUMN connection_id TEXT;
CREATE INDEX idx_connector_grants_connection ON connector_grants(connection_id);
