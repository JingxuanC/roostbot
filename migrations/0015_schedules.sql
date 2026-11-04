-- 0015_schedules.sql — 控制面调度：schedule / activation / run / run_event。
--
-- 事实源：docs/design/scheduling.md §10（数据模型）、§2（Activation）、§5（Run 生命周期）、
--         §7（幂等）、§8（错过/追赶/停止）。
--
-- 本批只做控制面计时（tick 扫描 + 幂等落库），不做睡眠/唤醒握手与容器内执行。
-- 时间戳统一为 epoch 毫秒（与 JS Date.now() 对齐）；runs 没有 created_at，
-- 用 activation 的 created_at + last_activity 表达生命周期。
--
-- 幂等：activations.idem 唯一；clock 的键是 `<routineId>@<scheduledFor ISO>`，
-- 重试、容器重启、双计时器都撞同一个键，不会产生第二条 activation/run。

CREATE TABLE workspace_schedules (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  routine_id    TEXT NOT NULL,           -- Bot 侧的 routine 标识
  bot_id        TEXT NOT NULL,
  cron          TEXT NOT NULL,           -- 5 段 cron 或 daily/weekly/every
  timezone      TEXT NOT NULL,           -- IANA
  enabled       INTEGER NOT NULL DEFAULT 1,
  catch_up_ms   INTEGER NOT NULL DEFAULT 43200000,   -- 12 小时
  overlap       TEXT NOT NULL DEFAULT 'queue' CHECK (overlap IN ('queue', 'skip')),
  next_run_at   INTEGER NOT NULL,
  last_run_at   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (workspace_id, routine_id)
);

-- tick 的核心扫描：enabled = 1 AND next_run_at <= now。
CREATE INDEX idx_schedules_next_run ON workspace_schedules(next_run_at, enabled);

CREATE TABLE activations (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('clock', 'event', 'repair', 'manual')),
  source        TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  bot_id        TEXT NOT NULL,
  room_id       TEXT,
  idem          TEXT NOT NULL,
  scheduled_for INTEGER,
  payload       TEXT NOT NULL,
  budget        TEXT NOT NULL,
  done_when     TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE (idem)                          -- 幂等的唯一来源（§7）
);

CREATE INDEX idx_activations_workspace_created ON activations(workspace_id, created_at);

CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  activation_id TEXT NOT NULL REFERENCES activations(id),
  status        TEXT NOT NULL
                CHECK (status IN ('queued', 'running', 'waiting', 'completed', 'failed', 'missed', 'skipped')),
  outcome       TEXT,
  executions    INTEGER NOT NULL DEFAULT 0,
  restarts      INTEGER NOT NULL DEFAULT 0,
  last_activity INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  result        TEXT,
  evidence      TEXT
);

CREATE INDEX idx_runs_activation ON runs(activation_id);

CREATE TABLE run_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   TEXT NOT NULL,
  at       INTEGER NOT NULL,
  kind     TEXT NOT NULL,                -- enqueued|admitted|started|progress|parked|answered|settled|missed|cancelled
  detail   TEXT
);

CREATE INDEX idx_run_events_run_at ON run_events(run_id, at);
