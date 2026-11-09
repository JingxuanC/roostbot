-- 0026_computer_projects.sql — Web 创建的 binding 只带 projectId，
-- 真实本地路径仍只保存在 roostd 的 ~/.roost/config.json。
ALTER TABLE computer_bindings ADD COLUMN project_id TEXT;
CREATE INDEX idx_computer_bindings_project ON computer_bindings(project_id);
