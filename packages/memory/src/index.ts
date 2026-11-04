// @roost/memory：记忆 claim 的纯规则层（docs/design/memory.md §3–§9；docs/build/wave2.md §A）。
//
// 这个包不碰 DB、不发事件、不调模型：只负责「一条 claim 合不合格」与「哪些该清」。
// 入库仍走 store.writeMemory（memory.md §14），复盘 routine 则消费 planCleanup 的结果。

export * from './claims.ts'
export * from './cleanup.ts'
