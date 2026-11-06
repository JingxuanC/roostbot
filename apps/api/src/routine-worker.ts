// 隔离的 routine worker（docs/design/architecture-v2.md §8）。
//
// runner 的入参只有 runId / routine / prompt / 目标房间。没有 messages。
// 返回空文本就静默，不往房间写气泡。

import { finishRoutineRun, getRoutine, getRoutineRun } from '../../../packages/store/src/routines.ts'
import type { RoutineRun } from '../../../packages/store/src/routines.ts'
import type { Store } from '../../../packages/store/src/types.ts'

export interface RoutineJob {
  runId: string
  routineId: string
  botId: string
  roomId: string
  prompt: string
  scheduledFor: number
}

export interface RoutineResult {
  text: string | null
  /** 房间里要看见的失败，不是静默。 */
  error?: boolean
  /** 还可以再试。次数由 executeRoutineRun 封顶。 */
  retry?: boolean
}

export const ROUTINE_MAX_ATTEMPTS = 3

export type RoutineRunner = (job: RoutineJob) => Promise<RoutineResult>

/** 没有模型时什么都不发。沙箱可以改走 POST /api/internal/routine-runs/:id/result。 */
export const silentRoutineRunner: RoutineRunner = async () => ({ text: null })

export async function executeRoutineRun(store: Store, run: RoutineRun, runner: RoutineRunner, now = Date.now()): Promise<RoutineRun> {
  if (run.status !== 'queued') return run
  const routine = getRoutine(store, run.routineId)
  if (routine === null) return finishRoutineRun(store, run.id, null, now)
  const job: RoutineJob = {
    runId: run.id,
    routineId: routine.id,
    botId: routine.botId,
    roomId: routine.roomId,
    prompt: routine.prompt,
    scheduledFor: run.scheduledFor,
  }
  let lastError = '模型没有返回'
  for (let attempt = 1; attempt <= ROUTINE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await runner(job)
      if (result?.retry === true && attempt < ROUTINE_MAX_ATTEMPTS) continue
      const text = result?.text ?? null
      return finishRoutineRun(store, run.id, text, now, { error: result?.error === true })
    } catch (error) {
      lastError = error instanceof Error && error.message !== '' ? error.message : '模型没有返回'
      if (attempt >= ROUTINE_MAX_ATTEMPTS) break
    }
  }
  return finishRoutineRun(store, run.id, `失败：${lastError}`, now, { error: true })
}

export function routineRunOrNull(store: Store, id: string): RoutineRun | null {
  return getRoutineRun(store, id)
}
