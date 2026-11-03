// 设计文档 §6 的常量，一处定义，别处引用。
// 每个数字都标注了它从哪来，改之前先看那一节。

export const TICK_EFFECT_MS = 2_000            // superagent: passes 每 2s
export const TICK_ROUTINE_MS = 10_000           // OMB: routines.ts:945
export const CATCH_UP_MS = 12 * 60 * 60_000     // OMB: 12 小时
export const BOOT_QUIET_MS = 2 * 60_000         // OMB: 启动后 2 分钟
export const CHECK_RUNS_PER_DAY = 24            // OMB: 每 routine 每日 24 次 AI run
export const BACKOFF_FIRST_MS = 15 * 60_000     // OMB: 15 分钟起
export const BACKOFF_MAX_MS = 4 * 60 * 60_000   // OMB: 上限 4 小时
export const JITTER_MIN = 0.8                   // OMB: ±20%
export const JITTER_MAX = 1.2
export const LAUNCH_RETRY_FIRST_MS = 5_000      // superagent: 5s 起
export const LAUNCH_RETRY_MAX_MS = 300_000      // superagent: 翻倍到 300s
export const LAUNCH_RETRIES = 3
export const FAILED_TURN_CONTINUATION_MS = [15_000, 30_000, 60_000] as const
export const WAKE_LEAD_SUSPEND_MS = 60_000      // OMB: suspend 提前 1 分钟
export const WAKE_LEAD_STOPPED_MS = 3 * 60_000  // OMB: stopped 提前 3 分钟
export const NO_SLEEP_WINDOW_MS = 5 * 60_000    // OMB: 5 分钟内不许睡
export const IDLE_BEFORE_SLEEP_MS = 10 * 60_000 // OMB: 10 分钟无人使用
export const TURN_STALL_MS = 5 * 60_000         // OMB: 默认 5 分钟无进展
export const BUSY_WAIT_MAX_MS = 10 * 60_000     // 本地决策：比 OMB 的 30 分钟收紧

/** Backoff after n consecutive failures, with deterministic jitter on the run id. */
export function backoffMs(failed: number, seed: string): number {
  if (failed <= 0) return 0
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (failed - 1))
  return Math.round(base * jitter(seed))
}

/** 同一个 seed 永远得到同一个抖动，退避不会在 tick 之间自己变短。 */
export function jitter(seed: string): number {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return JITTER_MIN + (hash % 1000) / 2500
}
