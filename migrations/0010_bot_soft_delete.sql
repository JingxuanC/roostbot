-- 0010_bot_soft_delete.sql — Bot 软删（docs/design/bots.md §5「软删 7 天」）。
--
-- deleted_at INTEGER NULL：NULL = 未删除；写入删除时刻（epoch 毫秒）即软删。
-- 语义：
--   * 软删后行还在，(workspace_id, name) 唯一约束仍占住名字——恢复窗口内名字不可复用，
--     恢复后身份（含名字、人设版本历史）完整还原；
--   * store 层 deleteBot 同时把 Bot 退出所有房间（room_members），恢复不自动回房间；
--   * 7 天恢复窗口由 store 层 BOT_SOFT_DELETE_WINDOW_MS 判定，这里只提供落库字段；
--   * 超过窗口的物理回收（GC）不在本迁移范围，按 workspace.md 的保留策略另行处理。

ALTER TABLE bots ADD COLUMN deleted_at INTEGER;

-- listBots 的默认形态是「workspace 内未删除」，给这个过滤建索引。
CREATE INDEX idx_bots_workspace_deleted ON bots(workspace_id, deleted_at);
