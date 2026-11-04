// 回合超时与工作中宽限（4.2.16）：runtime 侧等 DSH 结果时的判定。
//
// 与 packages/rooms/src/round.ts 的 classifyGrace 同语义（那边是纯 TS，沙箱里的 room-agent
// 是 .mjs，不能直接 import TS，所以这里保留一份极小实现；两边都有测试锁住行为）。
//
//   elapsed < replyTimeoutMs        → continue（继续等）
//   到点且不在工作                   → timeout（按 missed 收尾）
//   到点仍在工作，且在宽限窗口内      → continue（再等它收尾）
//   宽限期用完仍在工作               → working（不阻塞轮次，结果按 late rounds 回群）

export const DEFAULT_REPLY_TIMEOUT_MS = 240_000
export const DEFAULT_WORK_GRACE_MS = 15_000

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegative(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** @returns {'continue'|'working'|'timeout'} */
export function graceVerdict(input = {}) {
  const replyTimeoutMs = positive(input.replyTimeoutMs, DEFAULT_REPLY_TIMEOUT_MS)
  const workGraceMs = nonNegative(input.workGraceMs, DEFAULT_WORK_GRACE_MS)
  const raw = typeof input.elapsedMs === 'number' && Number.isFinite(input.elapsedMs) ? input.elapsedMs : 0
  const elapsedMs = Math.max(0, raw)
  if (elapsedMs < replyTimeoutMs) return 'continue'
  if (input.working !== true) return 'timeout'
  return elapsedMs < replyTimeoutMs + workGraceMs ? 'continue' : 'working'
}

/** 从 env 读 limits（沙箱里由控制面注入；缺省与 contract 一致）。 */
export function graceLimitsFromEnv(env = process.env) {
  const timeout = Number.parseInt(String(env.ROOST_REPLY_TIMEOUT_MS ?? ''), 10)
  const grace = Number.parseInt(String(env.ROOST_WORK_GRACE_MS ?? ''), 10)
  return {
    ...(Number.isInteger(timeout) && timeout > 0 ? { replyTimeoutMs: timeout } : {}),
    ...(Number.isInteger(grace) && grace >= 0 ? { workGraceMs: grace } : {})
  }
}
