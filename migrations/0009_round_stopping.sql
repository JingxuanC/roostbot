-- 0009_round_stopping.sql — 轮内停止请求（M4 4.2.16）。
--
-- 事实源：docs/design/rooms.md §10（只停当前成员，轮次继续）。
-- stopping 存“用户已请求停止、尚未被 runtime 消费”的 slot 下标（0-based）；
-- advance 该 slot 或轮次结束时清空。不改 slots_json（那是轮次状态本身）。

ALTER TABLE room_rounds ADD COLUMN stopping INTEGER;
