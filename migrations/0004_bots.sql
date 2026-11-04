-- 0004_bots.sql — M4 Bot 域。
--
-- 事实源：docs/build/m4-contract.md §1、docs/design/bots.md §1。
-- 约定：
--   * name 在一个 workspace 内唯一（UNIQUE 约束就是并发创建时的名字锁；
--     store 在写之前还会先查一次，给调用方稳定的 BOT_NAME_TAKEN）。
--   * avatar / skills / tools_* / memory_scopes 都是 JSON 文本，读的时候容错解析。
--   * persona 的每次变化写 bot_versions（field='persona'），不改这一行历史。

CREATE TABLE bots (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  name               TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT '',
  persona            TEXT NOT NULL DEFAULT '',
  provider           TEXT NOT NULL DEFAULT 'deepseek-official',
  model              TEXT NOT NULL,
  avatar_json        TEXT,
  skills_json        TEXT NOT NULL DEFAULT '[]',
  tools_allow_json   TEXT NOT NULL DEFAULT '[]',
  tools_deny_json    TEXT NOT NULL DEFAULT '[]',
  approval           TEXT NOT NULL DEFAULT 'ask',
  memory_scopes_json TEXT NOT NULL DEFAULT '["team"]',
  status             TEXT NOT NULL DEFAULT 'active',
  created_by         TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE INDEX idx_bots_workspace ON bots(workspace_id, created_at);

CREATE TABLE bot_versions (
  id         TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL,
  field      TEXT NOT NULL,
  value      TEXT NOT NULL,
  actor      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_bot_versions_bot ON bot_versions(bot_id, created_at);
