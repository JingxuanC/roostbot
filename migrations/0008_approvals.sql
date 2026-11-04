-- 审批（docs/build/m4-addendum.md §B、docs/design/rooms.md §6）。
-- 只存「待人工确认的动作」：payload 是动作的参数，不在这里落业务实体本身。
-- status: pending → approved | rejected（单向；decideApproval 不翻案）。

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  requester TEXT NOT NULL,
  requester_kind TEXT NOT NULL DEFAULT 'bot',
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);

CREATE INDEX idx_approvals_workspace ON approvals(workspace_id, status, created_at);
