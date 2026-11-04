-- 审批扩展与长期授权（M5-5.4；docs/design/ui.md §3.3、§12 待决 3）。
--
-- approvals 增三列描述「谁 / 要做什么 / 影响什么」：旧行保持 NULL，读取侧按 null 处理。
-- 长期授权单独一张表：v1 只做精确匹配（workspace + kind + action + target 全等），
-- 不做通配；撤销用 revoked_at 软删，保留审计。
-- 决策接口（POST /api/approvals/:id）只落单次审批，绝不隐式往这张表写入。

ALTER TABLE approvals ADD COLUMN action TEXT;
ALTER TABLE approvals ADD COLUMN target TEXT;
ALTER TABLE approvals ADD COLUMN consequence TEXT;

CREATE TABLE approval_grants (
  id          TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  action      TEXT,
  target      TEXT,
  granted_by  TEXT NOT NULL,
  granted_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

CREATE INDEX idx_approval_grants_match ON approval_grants(workspace_id, kind, action, target);
CREATE INDEX idx_approval_grants_workspace ON approval_grants(workspace_id, granted_at);
