-- 0016_connectors.sql — 连接器控制面：连接 / 按 Bot 授权 / 调用审计。
--
-- 事实源：docs/design/connectors.md §8（数据模型）、§3（授权三层）、§7（失败语义）、§9（接口）。
--
-- 本批（M6-6.1）只做控制面框架，不接真实 OAuth 网关：
--   * connections 记录 workspace 连了哪些服务；token 永远不在本地，只有展示用 account_label。
--   * connector_grants 是「哪个 Bot 能用哪些连接器的哪些动作」；空 actions = 该 access 下全部。
--   * connector_calls 是调用审计（含被拒原因），不含结果正文，避免把第三方数据落盘。
--
-- 幂等实现说明：connector_calls 用 SQLite partial unique index 表达
--   UNIQUE (workspace_id, bot_id, idem) WHERE idem IS NOT NULL
-- 即 idem 为空时允许任意多条，非空时同一 (workspace, bot) 只能有一条；
-- 重放时 store.recordCall 先读后写，冲突时返回已有行（duplicate=true），不再写第二条事件。

CREATE TABLE connections (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  slug          TEXT NOT NULL,          -- gmail | github | feishu …
  backend       TEXT NOT NULL,          -- openconnector | composio | native-mcp
  status        TEXT NOT NULL,          -- connected | expired | revoked
  account_label TEXT,                   -- 展示用（如邮箱），不含 token
  connected_by  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (workspace_id, slug)
);

CREATE INDEX idx_connections_workspace ON connections(workspace_id, created_at);

CREATE TABLE connector_grants (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  bot_id        TEXT NOT NULL,
  slug          TEXT NOT NULL,
  access        TEXT NOT NULL,          -- read | write
  actions       TEXT,                   -- JSON 数组；空=该 access 的全部
  granted_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (workspace_id, bot_id, slug)
);

CREATE INDEX idx_connector_grants_workspace ON connector_grants(workspace_id, slug);

CREATE TABLE connector_calls (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  bot_id        TEXT NOT NULL,
  slug          TEXT NOT NULL,
  action        TEXT NOT NULL,
  ok            INTEGER NOT NULL,
  denied_reason TEXT,
  result_bytes  INTEGER,
  idem          TEXT,
  at            INTEGER NOT NULL
);

-- idem 非空时唯一（partial index）；为空时保留每次调用的审计行。
CREATE UNIQUE INDEX idx_connector_calls_idem
  ON connector_calls(workspace_id, bot_id, idem)
  WHERE idem IS NOT NULL;

CREATE INDEX idx_connector_calls_workspace_at ON connector_calls(workspace_id, at);
