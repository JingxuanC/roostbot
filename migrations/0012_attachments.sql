-- 0012_attachments.sql — 附件 / 产物 / 消息引用。
--
-- 事实源：
--   docs/design/storage.md   §5 元数据与引用
--   docs/design/artifacts.md §8 数据模型
--
-- 本仓库适配（设计文档写的是 message_id，这里消息身份是 events.seq）：
--   message_attachments.message_seq 引用 events.seq，而不是引入新的 mid。
--
-- 索引：
--   * 按 workspace 列附件；
--   * GC 扫 ref_count = 0 且 created_at 超期的对象；
--   * messageJson 按 message_seq 批量取附件。

CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,              -- 内容寻址：sha256 前 32 hex
  workspace_id TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  size         INTEGER NOT NULL,
  mime         TEXT NOT NULL,
  owner        TEXT NOT NULL,                 -- account id / bot id
  audience     TEXT NOT NULL DEFAULT 'team',
  ref_count    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_attachments_workspace ON attachments(workspace_id, created_at);
CREATE INDEX idx_attachments_gc        ON attachments(ref_count, created_at);

CREATE TABLE attachment_refs (
  attachment_id TEXT NOT NULL,
  event_id      TEXT NOT NULL,                -- 引用了它的消息/事件（msg:<seq> 或事件 id）
  PRIMARY KEY (attachment_id, event_id)
);

CREATE INDEX idx_attachment_refs_event ON attachment_refs(event_id);

CREATE TABLE artifacts (
  id           TEXT PRIMARY KEY,              -- 内容寻址
  workspace_id TEXT NOT NULL,
  kind         TEXT NOT NULL,                 -- image|pdf|html|table|code|page
  mime         TEXT NOT NULL,
  name         TEXT NOT NULL,                 -- 展示名
  size         INTEGER NOT NULL,
  width        INTEGER,
  height       INTEGER,
  thumb_id     TEXT,
  produced_by  TEXT NOT NULL,
  run_id       TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_artifacts_workspace ON artifacts(workspace_id, created_at);

CREATE TABLE message_attachments (
  message_seq INTEGER NOT NULL,               -- = events.seq（chat.message）
  artifact_id TEXT NOT NULL,
  position    INTEGER NOT NULL,
  PRIMARY KEY (message_seq, artifact_id)
);

CREATE INDEX idx_message_attachments_message  ON message_attachments(message_seq, position);
CREATE INDEX idx_message_attachments_artifact ON message_attachments(artifact_id);
