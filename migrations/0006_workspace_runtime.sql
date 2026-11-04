-- 0006_workspace_runtime.sql — 工作区沙箱状态（TODO 4.3.2）。
--
-- 事实源：docs/design/sandboxing.md §15。每个工作区一个用户沙箱，名字固定、stop/start 复用；
-- 控制面用这张表回答“它现在是什么状态”，room-agent 的启动不依赖它。

CREATE TABLE workspace_runtime (
  workspace_id  TEXT PRIMARY KEY,
  sandbox       TEXT NOT NULL,
  phase         TEXT NOT NULL CHECK (phase IN ('creating', 'ready', 'stopped', 'error', 'unknown')),
  started_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
