-- 0020_marketplace_jobs.sql — 插件安装流水线：作业表 + 工具来源列。
--
-- 事实源：docs/build/wave1.md §B（5.1.3 / 5.1.7 / 5.1.9 / 5.1.10）、
--         docs/design/plugin-marketplace.md §4（安装流程）/ §8（快照回滚）。
--
-- 0013 的 plugin_installs.state 只有 installing|installed|failed|disabling：
-- 够表达「锁写了、沙箱还没生效」，但表达不了「等审批 / 回滚中 / 已回滚」。
-- 这里不改那四态（安装行继续只描述「装没装成」），把审批态与回滚态放进作业表：
--   * 一次安装/升级/卸载请求 = 一条 job；安装行可以有多条 job（先装、再升级、再卸载）。
--   * job 也是「这次要应用的锁」的载体（lock_json），以及「回到哪」的快照（snapshot_json）。
--   * 工具来源（哪个插件给了哪些工具）写在 plugin_installs.tools_json（5.1.7）。
--
-- state 取值（代码里的状态机是唯一事实源，packages/plugins/src/install.ts）：
--   preflight | awaiting-approval | installing | installed | failed
--   | rolling-back | rolled-back | disabled

ALTER TABLE plugin_installs ADD COLUMN tools_json TEXT;      -- 5.1.7 工具来源：[{name, source}]

CREATE TABLE plugin_install_jobs (
  id               TEXT PRIMARY KEY,
  install_id       TEXT NOT NULL,          -- plugin_installs.id（新装时是预分配 id）
  workspace_id     TEXT NOT NULL,
  slug             TEXT NOT NULL,
  version          TEXT NOT NULL,          -- 这次要应用到的版本
  state            TEXT NOT NULL,
  lock_json        TEXT,                   -- 这次要应用的 profile 锁文档（JSON）
  snapshot_json    TEXT,                   -- 安装前快照：旧锁 + 旧安装行（JSON）
  permissions_json TEXT,                   -- 权限披露 / 预检结果（JSON）
  error            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX idx_plugin_install_jobs_install   ON plugin_install_jobs(install_id, created_at);
CREATE INDEX idx_plugin_install_jobs_workspace ON plugin_install_jobs(workspace_id, slug, created_at);
