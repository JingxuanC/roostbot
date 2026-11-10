// 写进房间的 routine（docs/design/architecture-v2.md §8）。
//
// tick 只做三件事：落下一条隔离 run、往目标房间追加 routine.fired、推进 next_run_at。
// 它不读房间消息。谁来跑 prompt、要不要发言，由调用方的 runner 决定。

import { CronError, nextRunAt } from '../../scheduler/src/index.ts'
import { StoreError } from './errors.ts'
import { appendRoomSignal } from './room-log.ts'
import { newRoostId } from './ids.ts'
import { asInteger, asNonEmptyString, asRecord, assertOpen, errorMessage, toNumber } from './internal.ts'
import { sendMessage } from './rooms.ts'
import type { Store } from './types.ts'

export const ROUTINE_STATUSES = ['queued', 'posted', 'silent', 'failed'] as const
export type RoutineRunStatus = (typeof ROUTINE_STATUSES)[number]

export interface Routine {
  id: string
  workspaceId: string
  botId: string
  name: string
  cron: string
  timezone: string
  prompt: string
  roomId: string
  enabled: boolean
  nextRunAt: number
  lastRunAt: number | null
  createdAt: number
  updatedAt: number
}

export interface RoutineRun {
  id: string
  routineId: string
  scheduledFor: number
  status: RoutineRunStatus
  resultText: string | null
  messageSeq: number | null
  createdAt: number
  finishedAt: number | null
}

export interface CreateRoutineInput {
  workspaceId: string
  botId: string
  name: string
  cron: string
  prompt: string
  roomId: string
  timezone?: string
  enabled?: boolean
  at?: number
}

export interface UpdateRoutineInput {
  id: string
  name?: string
  cron?: string
  prompt?: string
  timezone?: string
  enabled?: boolean
  roomId?: string
  at?: number
}

const DEFAULT_TIMEZONE = 'Asia/Shanghai'

function invalid(message: string): never {
  throw new StoreError('INVALID_INPUT', message)
}

function text(value: unknown, label: string, max: number): string {
  const raw = asNonEmptyString(value, label, 'INVALID_INPUT').trim()
  if (raw.length > max) invalid(`${label} is too long`)
  return raw
}

function computeNext(cron: string, timezone: string, afterMs: number): number {
  try {
    return nextRunAt(cron, timezone, afterMs)
  } catch (error) {
    if (error instanceof CronError) invalid(error.message)
    throw error
  }
}

interface RoutineRow {
  id: string
  workspace_id: string
  bot_id: string
  name: string
  cron: string
  timezone: string
  prompt: string
  room_id: string
  enabled: number | bigint
  next_run_at: number | bigint
  last_run_at: number | bigint | null
  created_at: number | bigint
  updated_at: number | bigint
}

function rowToRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    botId: row.bot_id,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    prompt: row.prompt,
    roomId: row.room_id,
    enabled: toNumber(row.enabled) === 1,
    nextRunAt: toNumber(row.next_run_at),
    lastRunAt: row.last_run_at === null ? null : toNumber(row.last_run_at),
    createdAt: toNumber(row.created_at),
    updatedAt: toNumber(row.updated_at),
  }
}

interface RunRow {
  id: string
  routine_id: string
  scheduled_for: number | bigint
  status: string
  result_text: string | null
  message_seq: number | bigint | null
  created_at: number | bigint
  finished_at: number | bigint | null
}

function rowToRun(row: RunRow): RoutineRun {
  const status = ROUTINE_STATUSES.includes(row.status as RoutineRunStatus) ? (row.status as RoutineRunStatus) : 'failed'
  return {
    id: row.id,
    routineId: row.routine_id,
    scheduledFor: toNumber(row.scheduled_for),
    status,
    resultText: row.result_text,
    messageSeq: row.message_seq === null ? null : toNumber(row.message_seq),
    createdAt: toNumber(row.created_at),
    finishedAt: row.finished_at === null ? null : toNumber(row.finished_at),
  }
}

export function createRoutine(store: Store, input: CreateRoutineInput): Routine {
  assertOpen(store)
  const req = asRecord(input, 'routine', 'INVALID_INPUT')
  const workspaceId = text(req.workspaceId, 'routine.workspaceId', 80)
  const botId = text(req.botId, 'routine.botId', 80)
  const name = text(req.name, 'routine.name', 80)
  const cron = text(req.cron, 'routine.cron', 80)
  const prompt = text(req.prompt, 'routine.prompt', 8000)
  const roomId = text(req.roomId, 'routine.roomId', 80)
  const timezone = req.timezone === undefined || req.timezone === null || req.timezone === ''
    ? DEFAULT_TIMEZONE
    : text(req.timezone, 'routine.timezone', 80)
  const enabled = req.enabled === undefined || req.enabled === null ? true : req.enabled === true
  const at = req.at === undefined || req.at === null ? Date.now() : asInteger(req.at, 'routine.at', 0, 'INVALID_INPUT')
  const room = store.db.prepare('SELECT workspace_id FROM rooms WHERE id = ?').get(roomId) as
    | { workspace_id: string }
    | undefined
  if (room === undefined || room.workspace_id !== workspaceId) invalid(`unknown room ${roomId}`)
  const bot = store.db.prepare('SELECT workspace_id FROM bots WHERE id = ?').get(botId) as
    | { workspace_id: string }
    | undefined
  if (bot === undefined || bot.workspace_id !== workspaceId) invalid(`unknown bot ${botId}`)
  const next = computeNext(cron, timezone, at)
  const id = newRoostId('rtn', at)
  store.db
    .prepare(
      `INSERT INTO routines (id, workspace_id, bot_id, name, cron, timezone, prompt, room_id, enabled, next_run_at, last_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(id, workspaceId, botId, name, cron, timezone, prompt, roomId, enabled ? 1 : 0, next, at, at)
  return getRoutine(store, id)!
}

export function getRoutine(store: Store, id: string): Routine | null {
  assertOpen(store)
  const row = store.db.prepare('SELECT * FROM routines WHERE id = ?').get(asNonEmptyString(id, 'routine.id', 'INVALID_INPUT')) as
    | RoutineRow
    | undefined
  return row === undefined ? null : rowToRoutine(row)
}

export function listRoutines(store: Store, workspaceId: string): Routine[] {
  assertOpen(store)
  const rows = store.db
    .prepare('SELECT * FROM routines WHERE workspace_id = ? ORDER BY created_at, id')
    .all(asNonEmptyString(workspaceId, 'routine.workspaceId', 'INVALID_INPUT')) as RoutineRow[]
  return rows.map(rowToRoutine)
}

export function updateRoutine(store: Store, input: UpdateRoutineInput): Routine {
  assertOpen(store)
  const current = getRoutine(store, input.id)
  if (current === null) throw new StoreError('INVALID_INPUT', `unknown routine ${input.id}`)
  const name = input.name === undefined ? current.name : text(input.name, 'routine.name', 80)
  const cron = input.cron === undefined ? current.cron : text(input.cron, 'routine.cron', 80)
  const prompt = input.prompt === undefined ? current.prompt : text(input.prompt, 'routine.prompt', 8000)
  const timezone = input.timezone === undefined ? current.timezone : text(input.timezone, 'routine.timezone', 80)
  const roomId = input.roomId === undefined ? current.roomId : text(input.roomId, 'routine.roomId', 80)
  const enabled = input.enabled === undefined ? current.enabled : input.enabled === true
  const at = input.at === undefined ? Date.now() : asInteger(input.at, 'routine.at', 0, 'INVALID_INPUT')
  if (roomId !== current.roomId) {
    const room = store.db.prepare('SELECT workspace_id FROM rooms WHERE id = ?').get(roomId) as
      | { workspace_id: string }
      | undefined
    if (room === undefined || room.workspace_id !== current.workspaceId) invalid(`unknown room ${roomId}`)
  }
  const next = cron !== current.cron || timezone !== current.timezone ? computeNext(cron, timezone, at) : current.nextRunAt
  store.db
    .prepare(
      `UPDATE routines SET name = ?, cron = ?, prompt = ?, timezone = ?, room_id = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
    )
    .run(name, cron, prompt, timezone, roomId, enabled ? 1 : 0, next, at, current.id)
  return getRoutine(store, current.id)!
}

export function deleteRoutine(store: Store, id: string): void {
  assertOpen(store)
  const routineId = asNonEmptyString(id, 'routine.id', 'INVALID_INPUT')
  const result = store.db.prepare('DELETE FROM routines WHERE id = ?').run(routineId)
  if (toNumber(result.changes) === 0) throw new StoreError('INVALID_INPUT', `unknown routine ${routineId}`)
}

export function listRoutineRuns(store: Store, routineId: string, limit = 20): RoutineRun[] {
  assertOpen(store)
  const rows = store.db
    .prepare('SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY scheduled_for DESC LIMIT ?')
    .all(asNonEmptyString(routineId, 'routine.id', 'INVALID_INPUT'), Math.max(1, Math.min(100, limit))) as RunRow[]
  return rows.map(rowToRun)
}

export function getRoutineRun(store: Store, id: string): RoutineRun | null {
  assertOpen(store)
  const row = store.db.prepare('SELECT * FROM routine_runs WHERE id = ?').get(asNonEmptyString(id, 'run.id', 'INVALID_INPUT')) as
    | RunRow
    | undefined
  return row === undefined ? null : rowToRun(row)
}

/**
 * 到点的 routine 各落一条 queued run，并追加 schedule.routine.fired。
 * 不读聊天记录。幂等键是 (routine, scheduledFor)。
 */
export function claimDueRoutines(store: Store, now = Date.now()): RoutineRun[] {
  assertOpen(store)
  const due = store.db
    .prepare('SELECT * FROM routines WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at, id LIMIT 50')
    .all(now) as RoutineRow[]
  const claimed: RoutineRun[] = []
  for (const row of due) {
    const routine = rowToRoutine(row)
    const scheduledFor = routine.nextRunAt
    const existing = store.db
      .prepare('SELECT * FROM routine_runs WHERE routine_id = ? AND scheduled_for = ?')
      .get(routine.id, scheduledFor) as RunRow | undefined
    let run: RoutineRun
    if (existing !== undefined) {
      run = rowToRun(existing)
    } else {
      const id = newRoostId('rrn', now)
      store.db
        .prepare(
          `INSERT INTO routine_runs (id, routine_id, scheduled_for, status, result_text, message_seq, created_at, finished_at)
           VALUES (?, ?, ?, 'queued', NULL, NULL, ?, NULL)`,
        )
        .run(id, routine.id, scheduledFor, now)
      appendRoomSignal(store, {
        roomId: routine.roomId,
        domain: 'schedule',
        kind: 'schedule.routine.fired',
        actor: { kind: 'bot', id: routine.botId },
        idem: `routine:${routine.id}@${scheduledFor}`,
        payload: {
          routineId: routine.id,
          runId: id,
          scheduledFor,
          prompt: routine.prompt,
        },
      })
      run = getRoutineRun(store, id)!
      claimed.push(run)
    }
    const following = computeNext(routine.cron, routine.timezone, scheduledFor)
    store.db
      .prepare('UPDATE routines SET next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ?')
      .run(following, scheduledFor, now, routine.id)
    if (existing !== undefined && run.status === 'queued') claimed.push(run)
  }
  return claimed
}

/** 立刻排一次（scheduledFor = now），给「立即运行」用。 */
export function enqueueRoutineNow(store: Store, routineId: string, now = Date.now()): RoutineRun {
  assertOpen(store)
  const routine = getRoutine(store, routineId)
  if (routine === null) throw new StoreError('INVALID_INPUT', `unknown routine ${routineId}`)
  const id = newRoostId('rrn', now)
  store.db
    .prepare(
      `INSERT INTO routine_runs (id, routine_id, scheduled_for, status, result_text, message_seq, created_at, finished_at)
       VALUES (?, ?, ?, 'queued', NULL, NULL, ?, NULL)`,
    )
    .run(id, routine.id, now, now)
  appendRoomSignal(store, {
    roomId: routine.roomId,
    domain: 'schedule',
    kind: 'schedule.routine.fired',
    actor: { kind: 'bot', id: routine.botId },
    idem: `routine:${routine.id}:manual:${id}`,
    payload: { routineId: routine.id, runId: id, scheduledFor: now, prompt: routine.prompt },
  })
  return getRoutineRun(store, id)!
}

/**
 * 隔离执行的收尾：只根据 runner 给出的文本决定发不发。
 * 空文本 = silent，房间里不出现新气泡。重复调用对终态幂等。
 */
export function finishRoutineRun(
  store: Store,
  runId: string,
  text: string | null,
  now = Date.now(),
  options: { error?: boolean } = {},
): RoutineRun {
  assertOpen(store)
  const run = getRoutineRun(store, runId)
  if (run === null) throw new StoreError('INVALID_INPUT', `unknown routine run ${runId}`)
  if (run.status !== 'queued') return run
  const routine = getRoutine(store, run.routineId)
  if (routine === null) invalid(`routine ${run.routineId} is gone`)
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed === '') {
    store.db
      .prepare(`UPDATE routine_runs SET status = 'silent', finished_at = ? WHERE id = ? AND status = 'queued'`)
      .run(now, run.id)
    return getRoutineRun(store, run.id)!
  }
  const failed = options.error === true
  try {
    const message = sendMessage(store, {
      roomId: routine.roomId,
      text: trimmed.slice(0, 8000),
      actor: { kind: 'bot', id: routine.botId },
      idem: `routine-run:${run.id}`,
      routine: {
        routineId: routine.id,
        runId: run.id,
        scheduledFor: new Date(run.scheduledFor).toISOString(),
        timezone: routine.timezone || 'Asia/Shanghai',
        ...(failed ? { error: true } : {}),
      },
    })
    store.db
      .prepare(
        `UPDATE routine_runs SET status = ?, result_text = ?, message_seq = ?, finished_at = ? WHERE id = ? AND status = 'queued'`,
      )
      .run(failed ? 'failed' : 'posted', trimmed.slice(0, 8000), message.seq, now, run.id)
  } catch (error) {
    store.db
      .prepare(`UPDATE routine_runs SET status = 'failed', result_text = ?, finished_at = ? WHERE id = ? AND status = 'queued'`)
      .run(errorMessage(error).slice(0, 500), now, run.id)
  }
  return getRoutineRun(store, run.id)!
}
