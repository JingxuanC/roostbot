-- 0013_marketplace.sql — 插件市场目录与安装记录。
--
-- 事实源：docs/design/plugin-marketplace.md §5（市场数据模型）。
-- 本批只做「目录 + 预检 + 安装记录」，不执行沙箱 sync/重启/冒烟/回滚（批次边界见 §12）。
--
-- 设计文档里的四张表照抄；唯一增量是 plugin_installs.state：
--   installing | installed | failed | disabling
-- 第二批 sync/回滚需要它表达「锁已写、还没在沙箱里生效」等中间态。默认 installing
-- 是因为本批写入安装行时确实还没有执行 sync —— 不假装已经 installed。

CREATE TABLE plugin_publishers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  verified   INTEGER NOT NULL DEFAULT 0,
  registry   TEXT NOT NULL,               -- npm | roost
  created_at INTEGER NOT NULL
);

CREATE TABLE plugin_market (
  slug         TEXT PRIMARY KEY,          -- 例如 dsh-market-center
  title        TEXT NOT NULL,
  publisher_id TEXT NOT NULL,
  category     TEXT NOT NULL,             -- 数据 / 报告 / 交易 / 工具 / 技能
  tier         TEXT NOT NULL,             -- A|B|C|D（预检后写入）
  summary      TEXT NOT NULL,
  readme       TEXT,
  latest       TEXT NOT NULL,
  icon         TEXT,
  screenshots  TEXT,                      -- JSON 数组（截图 URL）
  updated_at   INTEGER NOT NULL
);

CREATE INDEX idx_plugin_market_category ON plugin_market(category);
CREATE INDEX idx_plugin_market_tier     ON plugin_market(tier);

CREATE TABLE plugin_versions (
  slug         TEXT NOT NULL,
  version      TEXT NOT NULL,
  integrity    TEXT NOT NULL,
  engines      TEXT,                      -- DSH peer 区间，例如 ^0.2.1-alpha.2
  manifest     TEXT NOT NULL,             -- 插件兼容声明 JSON（engines/slots/routes/data/diskBytes）
  permissions  TEXT NOT NULL,             -- 能力与资源声明 JSON（network/credentials/disk/binaries/data_mounts…）
  published_at INTEGER NOT NULL,
  PRIMARY KEY (slug, version)
);

CREATE INDEX idx_plugin_versions_slug ON plugin_versions(slug);

CREATE TABLE plugin_installs (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  slug         TEXT NOT NULL,
  version      TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  lock         TEXT NOT NULL,             -- profile-lock 摘要 JSON（package.json + lockfile + patch 的摘要）
  installed_by TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  preflight    TEXT,                      -- 预检结果 JSON（含 problems）
  state        TEXT NOT NULL DEFAULT 'installing'
               CHECK (state IN ('installing', 'installed', 'failed', 'disabling')),
  UNIQUE (workspace_id, slug)
);

CREATE INDEX idx_plugin_installs_workspace ON plugin_installs(workspace_id, installed_at);
