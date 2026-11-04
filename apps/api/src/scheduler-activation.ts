// 调度激活：在 store.tick 的 clock 路径之外补 event / repair 两条（6.5.2）。
//
// tick 本身只处理 clock（到点 + missed + overlap），这里：
//   - repairPass：发现"上次 run 没有终态"的 routine，用稳定的 repair idem 重新触发一次；
//   - activateFromEvent：外部信号（webhook/routine 事件）按 event idem 触发一次，重复信号幂等。
//
// 判定全部委托 packages/scheduler 的 decideActivation（纯函数，已有边界测试）。

import { decideActivation } from '../../../packages/scheduler/src/index.ts'
import { listRuns, listSchedules, manualActivation } from '../../../packages/store/src/schedules.ts'
import type { Store } from '../../../packages/store/src/types.ts'

const OPEN_RUN = new Set(['queued', 'running', 'waiting'])
const FINISHED = new Set(['done', 'failed', 'cancelled', 'missed', 'skipped', 'stopped'])

export interface RepairPassResult {
  repaired: Array<{ routineId: string; runId: string }>
}

/** 扫所有 schedule，把"中断且未补"的 run 重新激活一次。 */
export function repairPass(store: Store, now: number): RepairPassResult {
  const repaired: RepairPassResult['repaired'] = []
  for (const schedule of listSchedules(store, {})) {
    if (!schedule.enabled) continue
    const runs = listRuns(store, { workspaceId: schedule.workspaceId, limit: 50 })
      .filter((run) => run.routineId === schedule.routineId)
      .sort((a, b) => b.createdAt - a.createdAt)
    const open = runs.find((run) => OPEN_RUN.has(run.status))
    const lastFinished = runs.find((run) => FINISHED.has(run.status))
    const decision = decideActivation({
      routine: {
        id: schedule.routineId,
        enabled: schedule.enabled,
        nextRunAt: schedule.nextRunAt,
        catchUpMs: schedule.catchUpMs
      },
      now,
      ...(open === undefined ? {} : { lastRunAt: open.startedAt }),
      ...(lastFinished === undefined
        ? {}
        : { lastRunStatus: lastFinished.status, lastRunFinishedAt: lastFinished.finishedAt ?? lastFinished.createdAt })
    })
    if (decision.action !== 'repair') continue
    try {
      const result = manualActivation(store, {
        workspaceId: schedule.workspaceId,
        botId: schedule.botId,
        routineId: schedule.routineId,
        idem: decision.idem,
        at: now
      })
      repaired.push({ routineId: schedule.routineId, runId: result.run.id })
    } catch {
      // 幂等键已存在（另一个 tick 补过）或写入失败：下一轮再试，不阻塞其它 schedule。
    }
  }
  return { repaired }
}

export interface EventActivationInput {
  workspaceId: string
  routineId: string
  signalId: string
  at: number
}

/** 外部信号触发一次 routine（event idem 去重）。 */
export function activateFromEvent(store: Store, input: EventActivationInput): { runId: string } | null {
  const schedule = listSchedules(store, {}).find(
    (candidate) => candidate.workspaceId === input.workspaceId && candidate.routineId === input.routineId
  )
  if (schedule === undefined) return null
  const idem = `event:${input.routineId}:${input.signalId}`
  const result = manualActivation(store, {
    workspaceId: schedule.workspaceId,
    botId: schedule.botId,
    routineId: schedule.routineId,
    idem,
    at: input.at
  })
  return { runId: result.run.id }
}
