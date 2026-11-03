-- 房间与消息：房间是群体对话的单位；消息本体是 events 表里的 chat.message，不另存内容。
-- 设计见 docs/design/messaging.md（投递语义）与 docs/design/events.md（事实源）。

CREATE TABLE rooms (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name         TEXT NOT NULL,
  notice       TEXT,
  reply_mode   TEXT NOT NULL DEFAULT 'admin' CHECK (reply_mode IN ('admin', 'everyone', 'mentions')),
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_rooms_workspace ON rooms(workspace_id, created_at);

CREATE TABLE room_members (
  room_id    TEXT NOT NULL REFERENCES rooms(id),
  bot_id     TEXT,
  user_id    TEXT,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('host', 'admin', 'member')),
  created_at INTEGER NOT NULL,
  CHECK ((bot_id IS NULL) <> (user_id IS NULL)),
  PRIMARY KEY (room_id, bot_id, user_id)
);
