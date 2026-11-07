-- 0024_agent_runtimes.sql — 控制面多 Agent Runtime（docs/design/agent-runtimes.md §10–§11）。
--
-- 只做加法：
--   * bots 增加 runtime 配置与能力缓存。已有行默认 dsh，旧读取路径不需要改。
--   * room_slots 记录房间里的参与者位置；Slot 不绑定 Runtime。
--   * agent_bindings 记录一个 Slot 与原生/Adapter 会话的绑定；同一 Slot 同时最多一个 active。
--   * agent_sessions 记录 Embedded 模式下由控制面启动的进程（workdir/pid/生命周期）。
--
-- 所有 JSON / 能力字段以 TEXT 存储；读写层负责序列化与校验。不存明文凭据，
-- credential_ref 只能是指向 secret provider 的引用（设计 §13）。

ALTER TABLE bots ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'dsh';
ALTER TABLE bots ADD COLUMN runtime_config TEXT;
ALTER TABLE bots ADD COLUMN credential_ref TEXT;
ALTER TABLE bots ADD COLUMN capabilities TEXT;

CREATE INDEX idx_bots_runtime_kind ON bots(runtime_kind);

-- 房间参与者位置。status 由 store 校验：open | bound | closed。
CREATE TABLE room_slots (
  id           TEXT PRIMARY KEY,
  room_id      TEXT NOT NULL,
  bot_id       TEXT,
  runtime_kind TEXT,
  status       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX idx_room_slots_room_status ON room_slots(room_id, status);
CREATE INDEX idx_room_slots_bot ON room_slots(bot_id);

-- Slot 与 Agent 会话的绑定。generation 用于区分同一 Slot 的多次绑定；
-- 同一 Slot 最多一个 active binding（部分唯一索引兜底并发）。
CREATE TABLE agent_bindings (
  id           TEXT PRIMARY KEY,
  slot_id      TEXT NOT NULL,
  room_id      TEXT NOT NULL,
  bot_id       TEXT,
  kind         TEXT NOT NULL,       -- native | embedded
  runtime_kind TEXT NOT NULL,
  external_id  TEXT,                -- 原生 session id / ACP session id
  state        TEXT NOT NULL,       -- active | closed | interrupted | failed
  generation   INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE INDEX idx_agent_bindings_slot_state ON agent_bindings(slot_id, state);
CREATE INDEX idx_agent_bindings_room_state ON agent_bindings(room_id, state);
CREATE INDEX idx_agent_bindings_bot ON agent_bindings(bot_id);
CREATE UNIQUE INDEX idx_agent_bindings_active_slot
  ON agent_bindings(slot_id) WHERE state = 'active';

-- Embedded 运行时会话。一个 binding 可以按代际产生多个 session（重启/恢复）。
CREATE TABLE agent_sessions (
  id         TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL,
  workdir    TEXT NOT NULL,
  pid        INTEGER,
  status     TEXT NOT NULL,         -- starting | running | exited | failed | closed
  started_at INTEGER,
  ended_at   INTEGER
);

CREATE INDEX idx_agent_sessions_binding_status ON agent_sessions(binding_id, status);
CREATE INDEX idx_agent_sessions_status ON agent_sessions(status);
