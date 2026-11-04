// 控制面调度：schedule / activation / run / run_event（docs/design/scheduling.md §2、§5–§10）。
//
// 本模块只做「到点决定触发」与持久化，不做睡眠/唤醒握手，也不在容器里计时。
// 核心规则：
//   * tick 扫描 enabled 且 next_run_at <= now 的 schedule；next_run_at 必须持久化；
//   * scheduledFor 永远是原定时刻，不改成 now；now - scheduledFor > catch_up_ms 记 missed；
//   * 幂等键 clockIdem(routineId, scheduledFor) 唯一，重复 tick 不会建第二条 activation/run；
//   * 重叠策略 queue/skip：同一 schedule 已有 queued/running 的 run 时，skip 留 skipped(duplicate) 收据；
//   * 每次 tick 最多补 100 次，防时钟回拨/长时间离线刷屏；推进按原 scheduledFor 计算。
//
// 所有写入在同一个 savepoint 里：activation、run、run_event、schedule 推进同生共死。
// 域错误码用 `CODE: detail` 写在 StoreError.message 前缀里（与 members/budget 同法）。

import { CATCH_UP_MS, clockIdem, isMissed, nextRunAt } from '../../scheduler/src/index.ts'
import type { ActivationKind, Run, RunEvidence, RunOutcome, RunStatus } from '../../scheduler/src/index.ts'
import { StoreError } from './errors.ts'
import { newRoostId } from './ids.ts'
import {
  asInteger,
  asNonEmptyString,
  asRecord,
  assertOpen,
  errorMessage,
  toNumber,
} from './internal.ts'
import type { Store } from './types.ts'

export const SCHEDULE_OVERLAPS = ['queue', 'skip'] as const
export type ScheduleOverlap = (typeof SCHEDULE_OVERLAPS)[number]

/** 单次 tick 最多处理的触发次数（跨 schedule 计数）。 */
export const MAX_CATCH_UP_PER_TICK = 100

export const SCHEDULE_ERROR_CODES = {
  notFound: 'SCHEDULE_NOT_FOUND',
  exists: 'SCHEDULE_EXISTS',
  invalid: 'SCHEDULE_INVALID',
  runNotFound: 'RUN_NOT_FOUND',
} as const

export interface Schedule {
  id: string
  workspaceId: string
  routineId: string
  botId: string
  cron: string
  timezone: string
  enabled: boolean
  catchUpMs: number
  overlap: ScheduleOverlap
  nextRunAt: number
  lastRunAt: number | null
  createdAt: number
  updatedAt: number
}

export interface CreateScheduleInput {
  workspaceId: string
  routineId: string
  botId: string
  cron: string
  timezone: string
  enabled?: boolean
  catchUpMs?: number
  overlap?: ScheduleOverlap
  at?: number
}

export interface UpdateScheduleInput {
  id: string
  cron?: string
  timezone?: string
  enabled?: boolean
  catchUpMs?: number
  overlap?: ScheduleOverlap
  at?: number
}

export interface ListSchedulesQuery {
  workspaceId?: string
  enabled?: boolean
}

export interface TickInput {
  now?: number
}

export interface TickResult {
  created: number
  missed: number
  skipped: number
}

export interface ManualActivationInput {
  workspaceId: string
  botId: string
  routineId: string
  roomId?: string
  at?: number
  idem?: string
}

export interface ManualActivationResult {
  activationId: string
  run: ScheduledRun
}

export interface ListRunsQuery {
  workspaceId: string
  status?: RunStatus
  limit?: number
}

export interface StopRunInput {
  runId: string
  by: string
  at?: number
}

/** run + 它所属 activation 的展示字段（列表接口用）。 */
export interface ScheduledRun extends Run {
  workspaceId: string
  botId: string
  routineId: string
  kind: ActivationKind
  source: string
  scheduledFor: number | null
  createdAt: number
}

interface ScheduleRow {
  id: string
  workspace_id: string
  routine_id: string
  bot_id: string
  cron: string
  timezone: string
  enabled: number | bigint
  catch_up_ms: number | bigint
  overlap: string
  next_run_at: number | bigint
  last_run_at: number | bigint | null
  created_at: number | bigint
  updated_at: number | bigint
}

interface RunRow {
  id: string
  activation_id: string
  status: string
  outcome: string | null
  executions: number | bigint
  restarts: number | bigint
  last_activity: number | bigint
  started_at: number | bigint | null
  finished_at: number | bigint | null
  result: string | null
  evidence: string | null
  workspace_id: string
  bot_id: string
  kind: string
  source: string
  scheduled_for: number | bigint | null
  created_at: number | bigint
}

const SCHEDULE_COLUMNS =
  'id, workspace_id, routine_id, bot_id, cron, timezone, enabled, catch_up_ms, overlap, next_run_at, last_run_at, created_at, updated_at'
const RUN_SELECT = `SELECT r.id, r.activation_id, r.status, r.outcome, r.executions, r.restarts,
       r.last_activity, r.started_at, r.finished_at, r.result, r.evidence,
       a.workspace_id, a.bot_id, a.kind, a.source, a.scheduled_for, a.created_at
  FROM runs r JOIN activations a ON a.id = r.activation_id`
const RUN_SEARCH = `${RUN_SELECT}
  WHERE r.id = ?`

// ---- schedule 增删改查 --------------------------------------------------------

export function createSchedule(store: Store, input: CreateScheduleInput): Schedule {
  assertOpen(store)
  const req = asRecord(input, 'schedule')
  const workspaceId = asNonEmptyString(req.workspaceId, 'schedule.workspaceId')
  const routineId = asNonEmptyString(req.routineId, 'schedule.routineId')
  const botId = asNonEmptyString(req.botId, 'schedule.botId')
  const cron = asNonEmptyString(req.cron, 'schedule.cron')
  const timezone = asNonEmptyString(req.timezone, 'schedule.timezone')
  const enabled = readBool(req.enabled, 'schedule.enabled', true)
  const catchUpMs = readOptionalInteger(req.catchUpMs, 'schedule.catchUpMs', 0) ?? CATCH_UP_MS
  const overlap = readOverlap(req.overlap)
  const at = readAt(req.at)
  const next = computeNextRunAt(cron, timezone, at)

  return withSavepoint(store, 'roost_create_schedule', () => {
    const id = newRoostId('sch', at)
    try {
      store.db
        .prepare(
          `INSERT INTO workspace_schedules (${SCHEDULE_COLUMNS})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(id, workspaceId, routineId, botId, cron, timezone, enabled ? 1 : 0, catchUpMs, overlap, next, at, at)
    } catch (err) {
      if (errorMessage(err).includes('workspace_schedules')) {
        throw scheduleError(
          SCHEDULE_ERROR_CODES.exists,
          `routine ${routineId} already has a schedule in ${workspaceId}`,
        )
      }
      throw err instanceof StoreError
        ? err
        : new StoreError('INVALID_INPUT', `failed to create schedule: ${errorMessage(err)}`, { cause: err })
    }
    return getSchedule(store, id)!
  })
}

export function getSchedule(store: Store, id: string): Schedule | null {
  assertOpen(store)
  const scheduleId = asNonEmptyString(id, 'schedule.id')
  const row = store.db.prepare(`SELECT ${SCHEDULE_COLUMNS} FROM workspace_schedules WHERE id = ?`).get(scheduleId)
  return row === undefined || row === null ? null : rowToSchedule(row)
}

export function listSchedules(store: Store, query: ListSchedulesQuery = {}): Schedule[] {
  assertOpen(store)
  const req = asRecord(query, 'schedule.query')
  const clauses: string[] = []
  const params: unknown[] = []
  if (req.workspaceId !== undefined && req.workspaceId !== null) {
    clauses.push('workspace_id = ?')
    params.push(asNonEmptyString(req.workspaceId, 'schedule.query.workspaceId'))
  }
  if (req.enabled !== undefined && req.enabled !== null) {
    clauses.push('enabled = ?')
    params.push(readBool(req.enabled, 'schedule.query.enabled', true) ? 1 : 0)
  }
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
  const rows = store.db
    .prepare(`SELECT ${SCHEDULE_COLUMNS} FROM workspace_schedules${where} ORDER BY next_run_at ASC, id ASC`)
    .all(...params)
  return rows.map(rowToSchedule)
}

/** 只改给出的字段；cron/timezone 变化时按 at 重算 next_run_at。 */
export function updateSchedule(store: Store, input: UpdateScheduleInput): Schedule {
  assertOpen(store)
  const req = asRecord(input, 'schedule.update')
  const id = asNonEmptyString(req.id, 'schedule.id')
  const at = readAt(req.at)

  return withSavepoint(store, 'roost_update_schedule', () => {
    const current = getSchedule(store, id)
    if (current === null) throw scheduleError(SCHEDULE_ERROR_CODES.notFound, `unknown schedule ${id}`)

    const cron = optionalString(req.cron, 'schedule.cron') ?? current.cron
    const timezone = optionalString(req.timezone, 'schedule.timezone') ?? current.timezone
    const enabled = readBool(req.enabled, 'schedule.enabled', current.enabled)
    const catchUpMs = readOptionalInteger(req.catchUpMs, 'schedule.catchUpMs', 0) ?? current.catchUpMs
    const overlap = req.overlap === undefined || req.overlap === null ? current.overlap : readOverlap(req.overlap)
    const next =
      cron === current.cron && timezone === current.timezone
        ? current.nextRunAt
        : computeNextRunAt(cron, timezone, at)

    store.db
      .prepare(
        `UPDATE workspace_schedules
            SET cron = ?, timezone = ?, enabled = ?, catch_up_ms = ?, overlap = ?, next_run_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(cron, timezone, enabled ? 1 : 0, catchUpMs, overlap, next, at, id)
    return getSchedule(store, id)!
  })
}

export function deleteSchedule(store: Store, id: string): void {
  assertOpen(store)
  const scheduleId = asNonEmptyString(id, 'schedule.id')
  withSavepoint(store, 'roost_delete_schedule', () => {
    const current = getSchedule(store, scheduleId)
    if (current === null) throw scheduleError(SCHEDULE_ERROR_CODES.notFound, `unknown schedule ${scheduleId}`)
    store.db.prepare('DELETE FROM workspace_schedules WHERE id = ?').run(scheduleId)
  })
}

// ---- tick：到点 → activation + run ------------------------------------------

/**
 * 扫描到期的 schedule 并生产 activation/run。
 * 每次最多处理 100 次触发；推进 next_run_at 时按原 scheduledFor 计算，不按 now。
 */
export function tick(store: Store, input: TickInput = {}): TickResult {
  assertOpen(store)
  const req = asRecord(input, 'tick')
  const now = readAt(req.now)
  const result: TickResult = { created: 0, missed: 0, skipped: 0 }
  let processed = 0

  const rows = store.db
    .prepare(
      `SELECT ${SCHEDULE_COLUMNS} FROM workspace_schedules
        WHERE enabled = 1 AND next_run_at <= ?
        ORDER BY next_run_at ASC, id ASC`,
    )
    .all(now)

  for (const row of rows) {
    if (processed >= MAX_CATCH_UP_PER_TICK) break
    const schedule = rowToSchedule(row)
    withSavepoint(store, 'roost_tick_schedule', () => {
      let scheduledFor = schedule.nextRunAt
      while (scheduledFor <= now && processed < MAX_CATCH_UP_PER_TICK) {
        const next = computeNextRunAt(schedule.cron, schedule.timezone, scheduledFor)
        const idem = clockIdem(schedule.routineId, new Date(scheduledFor))
        const existing = activationByIdem(store, idem)
        // 并发 tick 撞 UNIQUE(idem) 时视作别人已经建好，跳过本次生产。
        let activationId: string | null = null
        if (existing === null) {
          try {
            activationId = insertActivation(store, {
              kind: 'clock',
              source: `routine:${schedule.routineId}`,
              workspaceId: schedule.workspaceId,
              botId: schedule.botId,
              idem,
              scheduledFor,
              at: now,
              brief: `运行 routine ${schedule.routineId}`,
            })
          } catch (err) {
            if (!errorMessage(err).includes('activations')) throw err
          }
        }
        if (activationId !== null) {
          if (isMissed(scheduledFor, now, schedule.catchUpMs)) {
            const runId = insertRun(store, activationId, 'missed', 'missed', now)
            insertRunEvent(store, runId, now, 'missed', `late by ${now - scheduledFor}ms`)
            result.missed += 1
          } else if (
            schedule.overlap === 'skip' &&
            hasOpenRun(store, schedule.workspaceId, schedule.routineId)
          ) {
            const runId = insertRun(store, activationId, 'skipped', 'duplicate', now)
            insertRunEvent(store, runId, now, 'cancelled', 'overlap:skip')
            result.skipped += 1
          } else {
            const runId = insertRun(store, activationId, 'queued', null, now)
            insertRunEvent(store, runId, now, 'enqueued', `scheduledFor=${new Date(scheduledFor).toISOString()}`)
            result.created += 1
          }
        }

        store.db
          .prepare(
            'UPDATE workspace_schedules SET next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ?',
          )
          .run(next, scheduledFor, now, schedule.id)
        processed += 1
        scheduledFor = next
      }
    })
  }

  return result
}

// ---- 人工触发 / run 查询 / 停止 ----------------------------------------------

/** 人工触发：用 idem 去重；不给 idem 时每次都是一次新的触发。 */
export function manualActivation(store: Store, input: ManualActivationInput): ManualActivationResult {
  assertOpen(store)
  const req = asRecord(input, 'manual')
  const workspaceId = asNonEmptyString(req.workspaceId, 'manual.workspaceId')
  const botId = asNonEmptyString(req.botId, 'manual.botId')
  const routineId = asNonEmptyString(req.routineId, 'manual.routineId')
  const roomId = optionalString(req.roomId, 'manual.roomId')
  const at = readAt(req.at)

  return withSavepoint(store, 'roost_manual_activation', () => {
    const id = newRoostId('act', at)
    const idem =
      optionalString(req.idem, 'manual.idem') ??
      `manual:${routineId}@${new Date(at).toISOString()}:${id}`
    const existing = activationByIdem(store, idem)
    if (existing !== null) {
      const run = getRunByActivation(store, existing.id)
      if (run !== null) return { activationId: existing.id, run }
    }

    let activationId: string
    try {
      activationId = insertActivation(store, {
        kind: 'manual',
        source: `manual:${routineId}`,
        workspaceId,
        botId,
        roomId,
        idem,
        scheduledFor: at,
        at,
        brief: `人工触发 routine ${routineId}`,
      })
    } catch (err) {
      // 并发同 idem：唯一约束兜底，回头读已有 activation/run。
      if (!errorMessage(err).includes('activations')) throw err
      const again = activationByIdem(store, idem)
      const run = again === null ? null : getRunByActivation(store, again.id)
      if (again !== null && run !== null) return { activationId: again.id, run }
      throw err
    }
    const runId = insertRun(store, activationId, 'queued', null, at)
    insertRunEvent(store, runId, at, 'enqueued', `manual@${new Date(at).toISOString()}`)
    const run = getRunByActivation(store, activationId)
    if (run === null) throw scheduleError(SCHEDULE_ERROR_CODES.runNotFound, `run for ${activationId} vanished`)
    return { activationId, run }
  })
}

export function listRuns(store: Store, query: ListRunsQuery): ScheduledRun[] {
  assertOpen(store)
  const req = asRecord(query, 'runs.query')
  const workspaceId = asNonEmptyString(req.workspaceId, 'runs.workspaceId')
  const clauses = ['a.workspace_id = ?']
  const params: unknown[] = [workspaceId]
  if (req.status !== undefined && req.status !== null) {
    clauses.push('r.status = ?')
    params.push(readRunStatus(req.status))
  }
  const limit = readOptionalInteger(req.limit, 'runs.limit', 1) ?? 50
  params.push(Math.min(limit, 200))
  const rows = store.db
    .prepare(
      `${RUN_SELECT} WHERE ${clauses.join(' AND ')}
        ORDER BY r.last_activity DESC, r.id DESC LIMIT ?`,
    )
    .all(...params)
  return rows.map(rowToRun)
}

export function getRun(store: Store, runId: string): ScheduledRun | null {
  assertOpen(store)
  const id = asNonEmptyString(runId, 'run.id')
  const row = store.db.prepare(RUN_SEARCH).get(id)
  return row === undefined || row === null ? null : rowToRun(row)
}

/** 人工停止：非终态 → completed/stopped + settled 事件；已是终态则原样返回（幂等）。 */
export function stopRun(store: Store, input: StopRunInput): ScheduledRun {
  assertOpen(store)
  const req = asRecord(input, 'run.stop')
  const runId = asNonEmptyString(req.runId, 'run.id')
  const by = asNonEmptyString(req.by, 'run.by')
  const at = readAt(req.at)

  return withSavepoint(store, 'roost_stop_run', () => {
    const current = getRun(store, runId)
    if (current === null) throw scheduleError(SCHEDULE_ERROR_CODES.runNotFound, `unknown run ${runId}`)
    if (isTerminalStatus(current.status)) return current

    store.db
      .prepare(
        `UPDATE runs SET status = 'completed', outcome = 'stopped', finished_at = ?, last_activity = ?
          WHERE id = ?`,
      )
      .run(at, at, runId)
    insertRunEvent(store, runId, at, 'settled', `stopped by ${by}`)
    return getRun(store, runId)!
  })
}

// ---- 内部 --------------------------------------------------------------------

interface ActivationRef {
  id: string
  scheduledFor: number | null
}

function activationByIdem(store: Store, idem: string): ActivationRef | null {
  const row = store.db
    .prepare('SELECT id, scheduled_for FROM activations WHERE idem = ?')
    .get(idem) as { id: string; scheduled_for: number | bigint | null } | undefined
  if (row === undefined || row === null) return null
  return {
    id: row.id,
    scheduledFor: row.scheduled_for === null ? null : toNumber(row.scheduled_for),
  }
}

function insertActivation(
  store: Store,
  input: {
    kind: ActivationKind
    source: string
    workspaceId: string
    botId: string
    roomId?: string
    idem: string
    scheduledFor: number
    at: number
    brief: string
  },
): string {
  const id = newRoostId('act', input.at)
  store.db
    .prepare(
      `INSERT INTO activations
         (id, kind, source, workspace_id, bot_id, room_id, idem, scheduled_for, payload, budget, done_when, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', NULL, ?)`,
    )
    .run(
      id,
      input.kind,
      input.source,
      input.workspaceId,
      input.botId,
      input.roomId ?? null,
      input.idem,
      input.scheduledFor,
      JSON.stringify({ brief: input.brief, inputs: [] }),
      input.at,
    )
  return id
}

function insertRun(
  store: Store,
  activationId: string,
  status: RunStatus,
  outcome: RunOutcome | null,
  at: number,
): string {
  const id = newRoostId('run', at)
  const terminal = isTerminalStatus(status)
  store.db
    .prepare(
      `INSERT INTO runs
         (id, activation_id, status, outcome, executions, restarts, last_activity, started_at, finished_at, result, evidence)
       VALUES (?, ?, ?, ?, 0, 0, ?, NULL, ?, NULL, NULL)`,
    )
    .run(id, activationId, status, outcome, at, terminal ? at : null)
  return id
}

function insertRunEvent(store: Store, runId: string, at: number, kind: string, detail: string | null): void {
  store.db
    .prepare('INSERT INTO run_events (run_id, at, kind, detail) VALUES (?, ?, ?, ?)')
    .run(runId, at, kind, detail)
}

/** 同一 schedule 是否已有 queued/running 的 clock run（manual run 不参与重叠判断）。 */
function hasOpenRun(store: Store, workspaceId: string, routineId: string): boolean {
  const row = store.db
    .prepare(
      `SELECT 1 AS ok FROM runs r JOIN activations a ON a.id = r.activation_id
        WHERE a.workspace_id = ? AND a.source = ? AND r.status IN ('queued', 'running')
        LIMIT 1`,
    )
    .get(workspaceId, `routine:${routineId}`)
  return row !== undefined && row !== null
}

function getRunByActivation(store: Store, activationId: string): ScheduledRun | null {
  const row = store.db.prepare(`${RUN_SELECT} WHERE r.activation_id = ? ORDER BY r.rowid ASC LIMIT 1`).get(activationId)
  return row === undefined || row === null ? null : rowToRun(row)
}

function computeNextRunAt(cron: string, timezone: string, afterMs: number): number {
  try {
    return nextRunAt(cron, timezone, afterMs)
  } catch (err) {
    throw scheduleError(
      SCHEDULE_ERROR_CODES.invalid,
      err instanceof Error ? err.message : String(err),
    )
  }
}

function scheduleError(code: string, detail: string): StoreError {
  return new StoreError('INVALID_INPUT', `${code}: ${detail}`)
}

const RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'missed',
  'skipped',
]

function isTerminalStatus(status: RunStatus | string): boolean {
  return status === 'completed' || status === 'failed' || status === 'missed' || status === 'skipped'
}

function readRunStatus(value: unknown): RunStatus {
  if (typeof value !== 'string' || !RUN_STATUSES.includes(value as RunStatus)) {
    throw new StoreError('INVALID_INPUT', `runs.status must be one of ${RUN_STATUSES.join(', ')}`)
  }
  return value as RunStatus
}

function readOverlap(value: unknown): ScheduleOverlap {
  if (value === undefined || value === null) return 'queue'
  if (typeof value !== 'string' || !(SCHEDULE_OVERLAPS as readonly string[]).includes(value)) {
    throw new StoreError('INVALID_INPUT', `schedule.overlap must be one of ${SCHEDULE_OVERLAPS.join(', ')}`)
  }
  return value as ScheduleOverlap
}

function readBool(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new StoreError('INVALID_INPUT', `${label} must be a boolean`)
  return value
}

function readOptionalInteger(value: unknown, label: string, min: number): number | null {
  if (value === undefined || value === null) return null
  return asInteger(value, label, min)
}

function readAt(value: unknown): number {
  return value === undefined || value === null ? Date.now() : asInteger(value, 'at', 0)
}

function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  return asNonEmptyString(value, label)
}

function rowToSchedule(row: unknown): Schedule {
  const r = row as ScheduleRow
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    routineId: r.routine_id,
    botId: r.bot_id,
    cron: r.cron,
    timezone: r.timezone,
    enabled: toNumber(r.enabled) === 1,
    catchUpMs: toNumber(r.catch_up_ms),
    overlap: r.overlap === 'skip' ? 'skip' : 'queue',
    nextRunAt: toNumber(r.next_run_at),
    lastRunAt: r.last_run_at === null ? null : toNumber(r.last_run_at),
    createdAt: toNumber(r.created_at),
    updatedAt: toNumber(r.updated_at),
  }
}

function rowToRun(row: unknown): ScheduledRun {
  const r = row as RunRow
  const source = r.source
  const routineId = source.startsWith('routine:')
    ? source.slice('routine:'.length)
    : source.startsWith('manual:')
      ? source.slice('manual:'.length)
      : source
  return {
    id: r.id,
    activationId: r.activation_id,
    status: r.status as RunStatus,
    ...(r.outcome === null ? {} : { outcome: r.outcome as RunOutcome }),
    executions: toNumber(r.executions),
    restarts: toNumber(r.restarts),
    lastActivityAt: toNumber(r.last_activity),
    ...(r.started_at === null ? {} : { startedAt: toNumber(r.started_at) }),
    ...(r.finished_at === null ? {} : { finishedAt: toNumber(r.finished_at) }),
    ...(r.result === null ? {} : { result: r.result }),
    ...(parseEvidence(r.evidence) === null ? {} : { evidence: parseEvidence(r.evidence)! }),
    workspaceId: r.workspace_id,
    botId: r.bot_id,
    routineId,
    kind: r.kind as ActivationKind,
    source,
    scheduledFor: r.scheduled_for === null ? null : toNumber(r.scheduled_for),
    createdAt: toNumber(r.created_at),
  }
}

function parseEvidence(text: string | null): RunEvidence | null {
  if (text === null) return null
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as RunEvidence) : null
  } catch {
    return null
  }
}

/** 行与事件同一 savepoint：任何一步失败都回滚 activation/run/schedule 推进。 */
function withSavepoint<T>(store: Store, name: string, fn: () => T): T {
  store.db.exec(`SAVEPOINT ${name}`)
  try {
    const result = fn()
    store.db.exec(`RELEASE ${name}`)
    return result
  } catch (err) {
    try {
      store.db.exec(`ROLLBACK TO ${name}`)
      store.db.exec(`RELEASE ${name}`)
    } catch {
      // savepoint 可能已随外层事务回滚；保留原始错误。
    }
    throw err
  }
}
