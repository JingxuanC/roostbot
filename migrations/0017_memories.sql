-- 0017_memories.sql — 记忆：判断 + 证据 + 可证伪条件（docs/design/memory.md §11）。
--
-- 事实源：docs/design/memory.md §3（一条记忆的字段）、§4（作用域）、§11（数据模型）。
--
-- 设计要点：
--   * 记忆是事件的投影，不是聊天副本：只存 subject/claim/falsifier 与证据引用，不存原文。
--   * scope 只能是 team / room:<id> / member:<id>；跨 workspace 不共享（§4 规则 3）。
--   * falsifier 必填：没有可证伪条件的结论不允许写入（§3）。
--   * status：active | superseded | retracted | expired；检索只看 active 且未过期。
--   * 证据与读取记录都指向 memories.id；记忆被取代/撤回时保留，供审计与复盘。

CREATE TABLE memories (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  scope        TEXT NOT NULL,             -- team | room:<id> | member:<id>
  subject      TEXT NOT NULL,
  claim        TEXT NOT NULL,
  kind         TEXT NOT NULL
               CHECK (kind IN ('conclusion', 'constraint', 'preference', 'fact')),
  confidence   REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  falsifier    TEXT NOT NULL CHECK (length(trim(falsifier)) > 0),
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'superseded', 'retracted', 'expired')),
  supersedes   TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  hits         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_memories_workspace ON memories(workspace_id, scope, status, created_at);

CREATE TABLE memory_evidence (
  memory_id TEXT NOT NULL REFERENCES memories(id),
  kind      TEXT NOT NULL CHECK (kind IN ('event', 'report', 'file')),
  ref       TEXT NOT NULL
);

CREATE INDEX idx_memory_evidence_memory ON memory_evidence(memory_id);

CREATE TABLE memory_reads (
  memory_id TEXT NOT NULL REFERENCES memories(id),
  at        INTEGER NOT NULL,
  turn_id   TEXT NOT NULL,
  used      INTEGER NOT NULL DEFAULT 0    -- 模型是否引用
);

CREATE INDEX idx_memory_reads_memory_at ON memory_reads(memory_id, at);
