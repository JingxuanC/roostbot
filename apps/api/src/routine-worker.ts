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

export type RoutineRunner = (job: RoutineJob) => Promise<{ text: string | null }>

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
  let text: string | null = null
  try {
    const result = await runner(job)
    text = result?.text ?? null
  } catch (error) {
    return finishRoutineRun(store, run.id, error instanceof Error ? `失败：${error.message}` : '失败', now)
  }
  return finishRoutineRun(store, run.id, text, now)
}

export function routineRunOrNull(store: Store, id: string): RoutineRun | null {
  return getRoutineRun(store, id)
}
