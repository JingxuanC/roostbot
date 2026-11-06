-- 0023_routines.sql — 写进房间的定时任务（docs/design/architecture-v2.md §8）。
--
-- 和 workspace_schedules 分开：那张表只产生 activation/run，不把结果写回房间。
-- 这里的一次触发只带 prompt，不带房间历史；结果是目标房间里的一条 bot 消息，
-- 或者什么都不发（silent）。

CREATE TABLE routines (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  bot_id       TEXT NOT NULL,
  name         TEXT NOT NULL,
  cron         TEXT NOT NULL,
  timezone     TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  prompt       TEXT NOT NULL,
  room_id      TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  next_run_at  INTEGER NOT NULL,
  last_run_at  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX idx_routines_due ON routines(enabled, next_run_at);

CREATE TABLE routine_runs (
  id             TEXT PRIMARY KEY,
  routine_id     TEXT NOT NULL,
  scheduled_for  INTEGER NOT NULL,
  status         TEXT NOT NULL,
  result_text    TEXT,
  message_seq    INTEGER,
  created_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  UNIQUE (routine_id, scheduled_for)
);

CREATE INDEX idx_routine_runs_status ON routine_runs(status, created_at);
