-- 0007_dm_rooms.sql — 私聊房间标记（M4 4.1.6 / 4.2.14）。
--
-- 事实源：docs/build/m4-addendum.md §A、docs/design/bots.md §2。
-- 每个 (workspace, bot) 恰好一个 DM；DM 是普通 rooms 行 + dm=1，成员在 room_members
-- （只有那个 bot，role='host'）。0 表示群聊，默认值让 0003 之后建的房间不用回填。

ALTER TABLE rooms ADD COLUMN dm INTEGER NOT NULL DEFAULT 0;
