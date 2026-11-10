// 本地 Computer 的任务派发（P0）。
//
// 云端轮次已经由 round-orchestrator 生成 assignments；这里把「Bot 已绑定到
// 某台 Computer」的 assignment 物化成 computer_jobs，并负责 claim / result。
// Cloud room-agent 的 assignment 列表会排除这些 Bot，避免云端与本地重复执行。

import { activeRound } from '../../../packages/store/src/rounds.ts'
import { getRoom, listRooms } from '../../../packages/store/src/rooms.ts'
import { getBot } from '../../../packages/store/src/bots.ts'
import {
  claimComputerJob,
  createComputerJob,
  expireComputerJobs,
  finishComputerJob,
  getComputerJob,
  listComputerBindings,
  listQueuedComputerJobs,
  markComputerJobRunning,
} from '../../../packages/store/src/computers.ts'
import type { Computer, ComputerBinding, ComputerJob } from '../../../packages/store/src/computers.ts'
import type { SlotResult } from '../../../packages/contract/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { applyAdvance, assignmentsForRound } from './round-orchestrator.ts'

const JOB_IDEM_PREFIX = 'computer-job'

export function computerBoundBots(store: Store, workspaceId: string): Map<string, ComputerBinding> {
  const map = new Map<string, ComputerBinding>()
  for (const binding of listComputerBindings(store, { workspaceId, status: 'active' })) {
    if (!map.has(binding.botId)) map.set(binding.botId, binding)
  }
  return map
}

export function computerBoundBotIds(store: Store, workspaceId: string): Set<string> {
  return new Set(computerBoundBots(store, workspaceId).keys())
}

function payloadFor(
  store: Store,
  binding: ComputerBinding,
  assignment: { roundId: string; roomId: string; botId: string; sessionId?: string; prompt: string; index: number; total: number },
): Record<string, unknown> {
  const room = getRoom(store, assignment.roomId)
  const bot = getBot(store, assignment.botId)
  return {
    workspaceId: binding.workspaceId,
    roomId: assignment.roomId,
    roomName: room?.name ?? assignment.roomId,
    roundId: assignment.roundId,
    slotIndex: assignment.index,
    slotTotal: assignment.total,
    botId: assignment.botId,
    botName: bot?.name ?? assignment.botId,
    sessionId: assignment.sessionId ?? '',
    prompt: assignment.prompt,
    binding: {
      id: binding.id,
      agentKind: binding.agentKind,
      ...(binding.projectId === undefined ? {} : { projectId: binding.projectId }),
      ...(binding.workdirLabel === undefined ? {} : { workdirLabel: binding.workdirLabel }),
      permission: binding.permission,
    },
  }
}

/**
 * 为某台 computer 的 active bindings 补齐 job。
 * 幂等：同一 round + slot 只有一个 job。
 */
export function ensureComputerJobs(store: Store, computerId: string, now = Date.now()): ComputerJob[] {
  const bindings = listComputerBindings(store, { computerId, status: 'active' })
  const created: ComputerJob[] = []
  for (const binding of bindings) {
    for (const room of listRooms(store, { workspaceId: binding.workspaceId })) {
      const round = activeRound(store, room.id)
      if (round === null) continue
      let assignments: ReturnType<typeof assignmentsForRound> = []
      try { assignments = assignmentsForRound(store, room.id) } catch { continue }
      const assignment = assignments.find((item) => item.botId === binding.botId)
      if (assignment === undefined) continue
      const idem = `${JOB_IDEM_PREFIX}:${assignment.roundId}:${assignment.index}`
      const job = createComputerJob(store, {
        bindingId: binding.id,
        computerId,
        workspaceId: binding.workspaceId,
        roomId: assignment.roomId,
        roundId: assignment.roundId,
        slotIndex: assignment.index,
        botId: assignment.botId,
        idem,
        payload: payloadFor(store, binding, assignment),
        now,
      })
      if (job.state === 'queued') created.push(job)
    }
  }
  return created
}

/** 轮询：先补 job，再返回 queued job；没有就等到 waitMs 结束。 */
export async function waitForComputerJob(
  store: Store,
  computer: Computer,
  waitMs = 25_000,
  now: () => number = Date.now,
): Promise<ComputerJob | null> {
  expireComputerJobs(store, now())
  const deadline = now() + Math.max(0, Math.min(waitMs, 30_000))
  while (true) {
    ensureComputerJobs(store, computer.id, now())
    const queued = listQueuedComputerJobs(store, computer.id, 1)
    if (queued.length > 0) return queued[0]!
    if (now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

export function claimJobForComputer(
  store: Store,
  computer: Computer,
  jobId: string,
  now = Date.now(),
): ComputerJob | null {
  const job = getComputerJob(store, jobId)
  if (job === null || job.computerId !== computer.id) return null
  if (job.state === 'claimed' && (job.leaseUntil ?? 0) > now) return job
  return claimComputerJob(store, { jobId, computerId: computer.id, leaseMs: 60_000, now })
}

export interface ComputerJobResult {
  job: ComputerJob
  advanced?: { round: unknown; next: number | null }
}

export function completeComputerJob(
  store: Store,
  computer: Computer,
  jobId: string,
  result: SlotResult,
  now = Date.now(),
): ComputerJobResult {
  const job = getComputerJob(store, jobId)
  if (job === null || job.computerId !== computer.id) {
    throw new Error('job not found for this computer')
  }
  if (job.state === 'done') return { job }
  if (job.state !== 'claimed' && job.state !== 'running') {
    throw new Error(`job is ${job.state}, expected claimed/running`)
  }
  markComputerJobRunning(store, job.id, now)
  const advanced = applyAdvance({ store, roundId: job.roundId, slotIndex: job.slotIndex, result, now })
  const finished = finishComputerJob(store, { jobId: job.id, state: 'done', result, now })
  return { job: finished ?? job, advanced }
}

export function failComputerJob(
  store: Store,
  computer: Computer,
  jobId: string,
  error: string,
  now = Date.now(),
): ComputerJob | null {
  const job = getComputerJob(store, jobId)
  if (job === null || job.computerId !== computer.id) return null
  return finishComputerJob(store, { jobId, state: 'failed', result: { kind: 'error', error }, now })
}

export function cancelComputerJob(store: Store, jobId: string, now = Date.now()): ComputerJob | null {
  return finishComputerJob(store, { jobId, state: 'cancelled', now })
}
