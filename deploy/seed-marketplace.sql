-- 0023_seed_marketplace.sql — 内置插件市场目录（首次部署不再是空列表）。
--
-- 这些是 Roost 自带/官方维护的示例目录，安装仍走 marketplace 的 install 记录流程；
-- 不是远程市场同步。INSERT OR IGNORE 保证重复迁移/已有同名插件不会被覆盖。

INSERT OR IGNORE INTO plugin_publishers (id, name, verified, registry, created_at) VALUES
  ('pub_roost', 'Roost Labs', 1, 'roost', 1793887000000),
  ('pub_quant', 'Roost Quant', 1, 'roost', 1793887000000);

INSERT OR IGNORE INTO plugin_market (slug, title, publisher_id, category, tier, summary, readme, latest, icon, screenshots, updated_at) VALUES
  ('dsh-market-center', '行情中心', 'pub_quant', '数据', 'B',
   'A 股行情、成交额与盘前异动数据面，供 Bot 查询和复盘。',
   '提供可审计的行情读取能力；不包含交易执行。', '1.0.0', NULL, NULL, 1793887000000),
  ('quant-report-engine', '量化报告引擎', 'pub_quant', '报告', 'B',
   '把行情与财务数据整理成可断网打开的研究报告。',
   '报告生成、数据复核与导出；依赖只读数据面。', '1.0.0', NULL, NULL, 1793887000000),
  ('quant-skills-langalpha', 'LangAlpha 技能包', 'pub_quant', '技能', 'A',
   '面向投研工作流的技能集合，包含筛选、复盘和风险检查。',
   '纯技能包，不申请网络或凭据。', '1.0.0', NULL, NULL, 1793887000000),
  ('dsh-market-watch', '盘前观察', 'pub_quant', '工具', 'B',
   '盘前成交额异常与关键价位观察，生成简短提醒。',
   '只读行情观察与提醒，不执行交易。', '1.0.0', NULL, NULL, 1793887000000),
  ('dsh-causal-memory', '因果记忆', 'pub_roost', '工具', 'A',
   '从房间事件中提炼可追溯的判断和复盘线索。',
   '团队记忆索引；不保存聊天全文到外部服务。', '1.0.0', NULL, NULL, 1793887000000);

INSERT OR IGNORE INTO plugin_versions (slug, version, integrity, engines, manifest, permissions, published_at) VALUES
  ('dsh-market-center', '1.0.0', 'sha512-roost-market-center', '^0.2.1',
   '{"engines":"^0.2.1","slots":[],"services":[],"panels":0,"routes":[],"data":[],"diskBytes":0}',
   '{"tools":3,"network":[],"credentials":[],"binaries":[],"data_mounts":[]}', 1793887000000),
  ('quant-report-engine', '1.0.0', 'sha512-roost-report-engine', '^0.2.1',
   '{"engines":"^0.2.1","slots":[],"services":[],"panels":0,"routes":[],"data":[],"diskBytes":0}',
   '{"tools":2,"network":[],"credentials":[],"binaries":[],"data_mounts":[]}', 1793887000000),
  ('quant-skills-langalpha', '1.0.0', 'sha512-roost-langalpha-skills', '^0.2.1',
   '{"engines":"^0.2.1","slots":[],"services":[],"panels":0,"routes":[],"data":[],"diskBytes":0}',
   '{"tools":0,"network":[],"credentials":[],"binaries":[],"data_mounts":[]}', 1793887000000),
  ('dsh-market-watch', '1.0.0', 'sha512-roost-market-watch', '^0.2.1',
   '{"engines":"^0.2.1","slots":[],"services":[],"panels":0,"routes":[],"data":[],"diskBytes":0}',
   '{"tools":2,"network":[],"credentials":[],"binaries":[],"data_mounts":[]}', 1793887000000),
  ('dsh-causal-memory', '1.0.0', 'sha512-roost-causal-memory', '^0.2.1',
   '{"engines":"^0.2.1","slots":[],"services":[],"panels":0,"routes":[],"data":[],"diskBytes":0}',
   '{"tools":1,"network":[],"credentials":[],"binaries":[],"data_mounts":[]}', 1793887000000);
