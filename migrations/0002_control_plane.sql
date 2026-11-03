-- 0002_control_plane.sql — 控制面其余核心表。
--
-- 事实源：
--   docs/design/workspace.md §8（runtimes / capability_grants）
--   docs/design/auth.md      §9（invites）
--
-- 这些表由控制面写；卷内这份是转发/只读投影（events.md §6）。放在第二个迁移里，
-- 一是让迁移按文件名顺序执行可被真实测试覆盖，二是给后续控制面表一个明确的追加位置。

CREATE TABLE runtimes (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('home', 'local-node')),
  container_id TEXT,
  base_url     TEXT,                       -- 控制面内部地址，不对外
  token_hash   TEXT NOT NULL,
  started_at   INTEGER,
  last_seen_at INTEGER
);

CREATE INDEX idx_runtimes_workspace ON runtimes(workspace_id, kind);

CREATE TABLE capability_grants (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  node_id      TEXT NOT NULL,
  cap          TEXT NOT NULL,              -- fs | mcp:<name> | model:<name>
  scope        TEXT NOT NULL,              -- 允许的路径前缀/命令白名单，JSON
  granted_by   TEXT NOT NULL,
  expires_at   INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_grants_workspace_node ON capability_grants(workspace_id, node_id);

CREATE TABLE invites (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  token_hash   TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  accepted_at  INTEGER
);

CREATE INDEX idx_invites_workspace ON invites(workspace_id, email);
