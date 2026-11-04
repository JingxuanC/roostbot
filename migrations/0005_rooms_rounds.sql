-- 0005_rooms_rounds.sql — 房间扩展列与 M4 轮次/已读/会话表。
--
-- 事实源：docs/build/m4-contract.md §1、docs/design/rooms.md §7。
--
-- 注意：room_members 的 role 列在 0003 已存在（host|admin|member），这里不再 ALTER。
-- rooms.reply_mode 保持 0003 的 CHECK（admin|everyone|mentions）；M4 的 responder
-- 单独存 responder_json，kind=auto 时 reply_mode 落 'mentions'（v2 才真正启用 auto）。

ALTER TABLE rooms ADD COLUMN host_bot_id TEXT;
ALTER TABLE rooms ADD COLUMN responder_json TEXT;
ALTER TABLE rooms ADD COLUMN bulletin TEXT;
ALTER TABLE rooms ADD COLUMN purpose TEXT;
ALTER TABLE rooms ADD COLUMN created_by_kind TEXT;
ALTER TABLE rooms ADD COLUMN created_by TEXT;

CREATE TABLE room_rounds (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL,
  start_seq  INTEGER NOT NULL,
  state      TEXT NOT NULL,
  slots_json TEXT NOT NULL,
  turns      INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);

CREATE INDEX idx_room_rounds_room ON room_rounds(room_id, started_at);

CREATE TABLE room_seen (
  room_id TEXT NOT NULL,
  bot_id  TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  PRIMARY KEY (room_id, bot_id)
);

CREATE TABLE bot_sessions (
  room_id    TEXT NOT NULL,
  bot_id     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  updated_at INTEGER,
  PRIMARY KEY (room_id, bot_id)
);

-- 0003 的 room_members 主键是 (room_id, bot_id, user_id)，而 bot 成员的 user_id 为 NULL；
-- SQLite 里 NULL 互不相等，所以这个主键挡不住同一个 Bot 被加进同一个房间两次。
-- 用部分唯一索引补齐；host 同时也只能有一个。
CREATE UNIQUE INDEX idx_room_members_bot ON room_members(room_id, bot_id) WHERE bot_id IS NOT NULL;
CREATE UNIQUE INDEX idx_room_members_host ON room_members(room_id) WHERE role = 'host' AND bot_id IS NOT NULL;
CREATE INDEX idx_room_members_room ON room_members(room_id);
