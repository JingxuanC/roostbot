-- 0014_budget.sql — 预算配额、预留与用量行（docs/design/budget.md §10）。
--
-- 事实源：docs/design/budget.md §10（数据模型）、§4（预留-结算）、§6（谁在哪里扣账）。
-- 本批只做控制面记账：配额、预留-结算、用量行与 billing.* 事件；
-- 不做模型代理（token 由调用方上报）与容器秒采集（runtime 心跳留后续）。
--
-- 实现补充（budget.md §11 实现状态）：
--   * usage_rows.idem：幂等键 `<turnId>:<source>`，重放不重复计费（§6「幂等」）。
--   * reservations.quota_id：§10 原表没有指向配额的外键，结算时无法定位预留属于哪条配额。
--     这里补一列（实现细节，不改变预留字段语义）。
--
-- 周期按 UTC 推进（日=UTC 0 点，月=UTC 1 号 0 点）；工作区时区留后续（budget.md §12 待决 1）。

CREATE TABLE quotas (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('tenant', 'workspace')),
  scope_id    TEXT NOT NULL,
  period      TEXT NOT NULL CHECK (period IN ('day', 'month')),
  metric      TEXT NOT NULL
              CHECK (metric IN ('tokens', 'runs', 'container_seconds', 'storage_bytes', 'messages')),
  limit_value INTEGER NOT NULL,
  used_value  INTEGER NOT NULL DEFAULT 0,
  reserved    INTEGER NOT NULL DEFAULT 0,
  resets_at   INTEGER,
  UNIQUE (scope, scope_id, period, metric)
);

CREATE INDEX idx_quotas_scope ON quotas(scope, scope_id);

CREATE TABLE reservations (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  quota_id     TEXT NOT NULL,             -- 实现补充：结算时定位所属配额
  metric       TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  settled_at   INTEGER,
  actual       INTEGER
);

CREATE INDEX idx_reservations_run ON reservations(run_id);

CREATE TABLE usage_rows (
  id            TEXT PRIMARY KEY,
  at            INTEGER NOT NULL,
  workspace_id  TEXT NOT NULL,
  run_id        TEXT,
  turn_id       TEXT,
  bot_id        TEXT,
  model         TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  tool_calls    INTEGER,
  cost_usd      REAL,
  source        TEXT,                     -- provider_report | estimated
  idem          TEXT UNIQUE               -- 实现补充：`<turnId>:<source>`，重放不重复计费
);

CREATE INDEX idx_usage_rows_workspace_at ON usage_rows(workspace_id, at);
