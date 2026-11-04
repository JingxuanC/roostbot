// 后台调度 tick（docs/design/scheduling.md §4）。控制面权威时钟：按固定间隔扫 schedule。
//
// 只在 ServerOptions.schedulerLoop === true 或 ROOST_SCHEDULER=1 时启动（见 server.ts）。
// 测试不要用真实定时器：直接调 store.tick({ now })。

import { TICK_ROUTINE_MS } from '../../../packages/scheduler/src/index.ts'
import { tick } from '../../../packages/store/src/schedules.ts'
import type { Store } from '../../../packages/store/src/types.ts'

export interface SchedulerLoopOptions {
  rawStore: Store
  /** 注入时钟；默认 Date.now。 */
  now?: () => number
  /** 扫描间隔；默认 §6 的 10 秒。 */
  intervalMs?: number
  /** tick 失败时的回调；默认写 console.error。 */
  onError?: (err: unknown) => void
}

/** 启动循环，返回 stop()；重复调用 stop 是幂等的。 */
export function startSchedulerLoop(options: SchedulerLoopOptions): () => void {
  const now = options.now ?? (() => Date.now())
  const intervalMs = options.intervalMs ?? TICK_ROUTINE_MS
  const onError =
    options.onError ??
    ((err: unknown) => {
      console.error('roost api: scheduler tick failed', err)
    })

  let stopped = false
  const run = (): void => {
    if (stopped) return
    try {
      tick(options.rawStore, { now: now() })
    } catch (err) {
      onError(err)
    }
  }

  const timer = setInterval(run, intervalMs)
  // 不因为后台循环拖住进程退出。
  timer.unref?.()

  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }
}
