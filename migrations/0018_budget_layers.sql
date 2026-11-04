-- 0018_budget_layers.sql — 配额四层（tenant / workspace / run / turn）与容器秒、存储计量。
--
-- 事实源：docs/design/budget.md §3（分层与归属）、§4（预留-结算）、§10（数据模型）。
--
-- 1) quotas.scope 的 CHECK 从 tenant|workspace 扩到 tenant|workspace|run|turn。
--    SQLite 不能直接改 CHECK，只能重建表：新建 → 复制 → 删旧 → 改名。
--    复制时显式列名，保留旧数据；UNIQUE (scope, scope_id, period, metric) 写在新建表里，
--    idx_quotas_scope 在改名后重建（DROP TABLE 会一并删掉旧索引）。
-- 2) usage_rows 增两列（实现补充，见 budget.md §13）：
--    * container_seconds REAL：runtime 启停/心跳采到的容器秒，聚合按行求和；
--    * storage_bytes INTEGER：卷大小采样，是 gauge，聚合取窗口内最大值而不是求和。

CREATE TABLE quotas_new (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL CHECK (scope IN ('tenant', 'workspace', 'run', 'turn')),
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

INSERT INTO quotas_new (id, scope, scope_id, period, metric, limit_value, used_value, reserved, resets_at)
SELECT id, scope, scope_id, period, metric, limit_value, used_value, reserved, resets_at
FROM quotas;

DROP TABLE quotas;

ALTER TABLE quotas_new RENAME TO quotas;

CREATE INDEX idx_quotas_scope ON quotas(scope, scope_id);

ALTER TABLE usage_rows ADD COLUMN container_seconds REAL;
ALTER TABLE usage_rows ADD COLUMN storage_bytes INTEGER;
