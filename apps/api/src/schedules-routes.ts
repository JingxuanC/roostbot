// 控制面调度 HTTP（docs/design/scheduling.md §2、§4–§10）。
//
// 本文件只导出 handler，由 server.ts 接线：
//
//   GET    /api/workspaces/:id/schedules   handleListSchedules      Bearer（任意成员）
//   POST   /api/workspaces/:id/schedules   handleCreateSchedule     Bearer（owner/admin）
//   PATCH  /api/schedules/:id              handlePatchSchedule      Bearer（owner/admin）
//   DELETE /api/schedules/:id              handleDeleteSchedule     Bearer（owner/admin）
//   POST   /api/schedules/:id/run          handleRunScheduleNow     Bearer（owner/admin）
//   GET    /api/runs                       handleListRuns           Bearer（任意成员）
//   POST   /api/runs/:id/stop              handleStopRun            Bearer（owner/admin）
//   POST   /api/internal/scheduler/tick    handleInternalSchedulerTick  runtime token
//
// schedule / activation / run 只在 SQLite 里；内存 port（无 rawStore）一律 503 runtime.not_configured。
// runtime token 语义与其他内部接口一致：无全局 token 且无 rawStore = 404；有 rawStore
// 时 workspace token 生效（但 tick 是全局操作，workspace token 一律 403）。

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  SCHEDULE_ERROR_CODES,
  SCHEDULE_OVERLAPS,
  StoreError,
  createSchedule,
  deleteSchedule,
  getRun,
  getSchedule,
  getWorkspaceRole,
  listRuns,
  listSchedules,
  manualActivation,
  stopRun,
  storeErrorTag,
  tick,
  updateSchedule,
} from '../../../packages/store/src/index.ts'
import type { RunStatus, Schedule, ScheduledRun, ScheduleOverlap } from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import type { SessionRecord, StorePort, WorkspaceRole } from './port.ts'
import { authenticate, isPlainObject, readJsonBody, sendError, sendJson } from './server.ts'
import { authorizeRuntimeHttp } from './runtime-auth.ts'

export interface ScheduleRouteContext {
  store: StorePort
  now: () => number
  rawStore?: Store
  runtimeToken?: string
}

type Ctx = ScheduleRouteContext

const MAX_ID_CHARS = 200
const RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'missed',
  'skipped',
]

// ---- 用户：schedule CRUD -----------------------------------------------------

export async function handleListSchedules(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  const store = requireStore(ctx, res)
  if (store === null) return
  if (workspaceRole(store, auth.accountId, workspaceId) === null) {
    return sendError(res, 403, 'forbidden', `account is not a member of workspace ${workspaceId}`)
  }
  sendJson(res, 200, { schedules: listSchedules(store, { workspaceId }).map(scheduleJson) })
}

export async function handleCreateSchedule(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  const store = requireStore(ctx, res)
  if (store === null) return
  if (!requireManager(store, auth.accountId, workspaceId, res)) return

  const body = await readObjectBody(req, res)
  if (body === null) return
  const botId = readId(body['botId'])
  if (botId === null) return sendError(res, 400, 'invalid_body', 'botId is required')
  const routineId = readId(body['routineId'])
  if (routineId === null) return sendError(res, 400, 'invalid_body', 'routineId is required')
  const cron = readId(body['cron'])
  if (cron === null) return sendError(res, 400, 'invalid_body', 'cron is required')
  const timezone = readId(body['timezone'])
  if (timezone === null) return sendError(res, 400, 'invalid_body', 'timezone is required')
  const enabled = readOptionalBool(body['enabled'])
  if (enabled === INVALID) return sendError(res, 400, 'invalid_body', 'enabled must be a boolean')
  const catchUpMs = readOptionalCount(body['catchUpMs'])
  if (catchUpMs === INVALID) return sendError(res, 400, 'invalid_body', 'catchUpMs must be an integer >= 0')
  const overlap = readOverlap(body['overlap'])
  if (overlap === INVALID) {
    return sendError(res, 400, 'invalid_body', `overlap must be one of ${SCHEDULE_OVERLAPS.join(', ')}`)
  }

  try {
    const schedule = createSchedule(store, {
      workspaceId,
      botId,
      routineId,
      cron,
      timezone,
      ...(enabled === null ? {} : { enabled }),
      ...(catchUpMs === null ? {} : { catchUpMs }),
      ...(overlap === null ? {} : { overlap }),
      at: ctx.now(),
    })
    sendJson(res, 201, { schedule: scheduleJson(schedule), nextRunAt: schedule.nextRunAt })
  } catch (err) {
    sendScheduleFailure(res, err)
  }
}

export async function handlePatchSchedule(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  scheduleId: string,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  const store = requireStore(ctx, res)
  if (store === null) return
  const schedule = getSchedule(store, scheduleId)
  if (schedule === null) return sendError(res, 404, 'schedule.not_found', `unknown schedule ${scheduleId}`)
  if (!requireManager(store, auth.accountId, schedule.workspaceId, res)) return

  const body = await readObjectBody(req, res)
  if (body === null) return
  const cron = readOptionalId(body['cron'])
  if (cron === INVALID) return sendError(res, 400, 'invalid_body', 'cron must be a string')
  const timezone = readOptionalId(body['timezone'])
  if (timezone === INVALID) return sendError(res, 400, 'invalid_body', 'timezone must be a string')
  const enabled = readOptionalBool(body['enabled'])
  if (enabled === INVALID) return sendError(res, 400, 'invalid_body', 'enabled must be a boolean')
  const catchUpMs = readOptionalCount(body['catchUpMs'])
  if (catchUpMs === INVALID) return sendError(res, 400, 'invalid_body', 'catchUpMs must be an integer >= 0')
  const overlap = readOverlap(body['overlap'])
  if (overlap === INVALID) {
    return sendError(res, 400, 'invalid_body', `overlap must be one of ${SCHEDULE_OVERLAPS.join(', ')}`)
  }

  try {
    const updated = updateSchedule(store, {
      id: scheduleId,
      ...(cron === null ? {} : { cron }),
      ...(timezone === null ? {} : { timezone }),
      ...(enabled === null ? {} : { enabled }),
      ...(catchUpMs === null ? {} : { catchUpMs }),
      ...(overlap === null ? {} : { overlap }),
      at: ctx.now(),
    })
    sendJson(res, 200, { schedule: scheduleJson(updated) })
  } catch (err) {
    sendScheduleFailure(res, err)
  }
}

export async function handleDeleteSchedule(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  scheduleId: string,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  const store = requireStore(ctx, res)
  if (store === null) return
  const schedule = getSchedule(store, scheduleId)
  if (schedule === null) return sendError(res, 404, 'schedule.not_found', `unknown schedule ${scheduleId}`)
  if (!requireManager(store, auth.accountId, schedule.workspaceId, res)) return

  try {
    deleteSchedule(store, scheduleId)
    res.writeHead(204, { 'cache-control': 'no-store' })
    res.end()
  } catch (err) {
    sendScheduleFailure(res, err)
  }
}

// ---- 用户：立即触发 / run 查询 / 停止 ----------------------------------------

export async function handleRunScheduleNow(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  scheduleId: string,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  const store = requireStore(ctx, res)
  if (store === null) return
  const schedule = getSchedule(store, scheduleId)
  if (schedule === null) return sendError(res, 404, 'schedule.not_found', `unknown schedule ${scheduleId}`)
  if (!requireManager(store, auth.accountId, schedule.workspaceId, res)) return

  try {
    const result = manualActivation(store, {
      workspaceId: schedule.workspaceId,
      botId: schedule.botId,
      routineId: schedule.routineId,
      at: ctx.now(),
    })
    sendJson(res, 201, { run: runJson(result.run) })
  } catch (err) {
    sendScheduleFailure(res, err)
  }
}

export async function handleListRuns(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  const store = requireStore(ctx, res)
  if (store === null) return

  const workspaceId = readId(url.searchParams.get('workspaceId'))
  if (workspaceId === null) return sendError(res, 400, 'invalid_body', 'workspaceId is required')
  if (workspaceRole(store, auth.accountId, workspaceId) === null) {
    return sendError(res, 403, 'forbidden', `account is not a member of workspace ${workspaceId}`)
  }

  const status = readRunStatus(url.searchParams.get('status'))
  if (status === INVALID) {
    return sendError(res, 400, 'invalid_body', `status must be one of ${RUN_STATUSES.join(', ')}`)
  }
  const limit = readQueryCount(url.searchParams.get('limit'))
  if (limit === INVALID) return sendError(res, 400, 'invalid_body', 'limit must be an integer >= 1')

  try {
    const runs = listRuns(store, {
      workspaceId,
      ...(status === null ? {} : { status }),
      ...(limit === null ? {} : { limit }),
    })
    sendJson(res, 200, { runs: runs.map(runJson) })
  } catch (err) {
    sendScheduleFailure(res, err)
  }
}

export async function handleStopRun(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  const store = requireStore(ctx, res)
  if (store === null) return
  const run = getRun(store, runId)
  if (run === null) return sendError(res, 404, 'run.not_found', `unknown run ${runId}`)
  if (!requireManager(store, auth.accountId, run.workspaceId, res)) return

  try {
    const stopped = stopRun(store, { runId, by: auth.accountId, at: ctx.now() })
    sendJson(res, 200, { run: runJson(stopped) })
  } catch (err) {
    sendScheduleFailure(res, err)
  }
}

// ---- 内部：tick --------------------------------------------------------------

export async function handleInternalSchedulerTick(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = authorizeRuntimeHttp(ctx, req, res)
  if (auth === null) return
  const store = requireStore(ctx, res)
  if (store === null) return
  if (auth.workspaceId !== null) {
    // tick 没有 workspace 维度：一次调用会创建/推进所有 workspace 的到期 run。
    // workspace token 触发它就等于跨租户写入，所以只允许控制面全局 token。
    return sendError(res, 403, 'forbidden_workspace', 'scheduler tick is control-plane scoped')
  }
  try {
    const result = tick(store, { now: ctx.now() })
    sendJson(res, 200, result)
  } catch (err) {
    sendScheduleFailure(res, err)
  }
}

// ---- 序列化 -----------------------------------------------------------------

function scheduleJson(schedule: Schedule): Record<string, unknown> {
  return {
    id: schedule.id,
    workspaceId: schedule.workspaceId,
    routineId: schedule.routineId,
    botId: schedule.botId,
    cron: schedule.cron,
    timezone: schedule.timezone,
    enabled: schedule.enabled,
    catchUpMs: schedule.catchUpMs,
    overlap: schedule.overlap,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  }
}

function runJson(run: ScheduledRun): Record<string, unknown> {
  return {
    id: run.id,
    activationId: run.activationId,
    workspaceId: run.workspaceId,
    botId: run.botId,
    routineId: run.routineId,
    kind: run.kind,
    source: run.source,
    status: run.status,
    outcome: run.outcome ?? null,
    scheduledFor: run.scheduledFor,
    executions: run.executions,
    restarts: run.restarts,
    lastActivityAt: run.lastActivityAt,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    result: run.result ?? null,
    createdAt: run.createdAt,
  }
}

// ---- 鉴权 / 输入 / 错误 -----------------------------------------------------

function requireStore(ctx: Ctx, res: ServerResponse): Store | null {
  if (ctx.rawStore !== undefined) return ctx.rawStore
  sendError(res, 503, 'runtime.not_configured', 'schedules need the SQLite store')
  return null
}

async function requireAuth(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<SessionRecord | null> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
    return null
  }
  return auth.session
}

function workspaceRole(store: Store, accountId: string, workspaceId: string): WorkspaceRole | null {
  return getWorkspaceRole(store, workspaceId, accountId)
}

function requireManager(store: Store, accountId: string, workspaceId: string, res: ServerResponse): boolean {
  const role = workspaceRole(store, accountId, workspaceId)
  if (role === 'owner' || role === 'admin') return true
  sendError(res, 403, 'forbidden', `workspace ${workspaceId} requires owner/admin role`)
  return false
}

async function readObjectBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  const parsed = await readJsonBody(req)
  if (!parsed.ok) {
    sendError(res, parsed.status, parsed.code, parsed.message)
    return null
  }
  if (!isPlainObject(parsed.value)) {
    sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
    return null
  }
  return parsed.value
}

const INVALID = Symbol('invalid')
type Invalid = typeof INVALID

function readId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id === '' || id.length > MAX_ID_CHARS ? null : id
}

function readOptionalId(value: unknown): string | null | Invalid {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return INVALID
  return value.trim() === '' ? null : value.trim()
}

function readOptionalBool(value: unknown): boolean | null | Invalid {
  if (value === undefined || value === null) return null
  return typeof value === 'boolean' ? value : INVALID
}

function readOptionalCount(value: unknown): number | null | Invalid {
  if (value === undefined || value === null) return null
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : INVALID
}

function readOverlap(value: unknown): ScheduleOverlap | null | Invalid {
  if (value === undefined || value === null) return null
  return typeof value === 'string' && (SCHEDULE_OVERLAPS as readonly string[]).includes(value)
    ? (value as ScheduleOverlap)
    : INVALID
}

function readRunStatus(value: string | null): RunStatus | null | Invalid {
  if (value === null || value === '') return null
  return (RUN_STATUSES as readonly string[]).includes(value) ? (value as RunStatus) : INVALID
}

function readQueryCount(value: string | null): number | null | Invalid {
  if (value === null || value === '') return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : INVALID
}

function sendScheduleFailure(res: ServerResponse, err: unknown): void {
  const tag = storeErrorTag(err)
  if (tag === SCHEDULE_ERROR_CODES.notFound) {
    return sendError(res, 404, 'schedule.not_found', err instanceof Error ? err.message : 'schedule not found')
  }
  if (tag === SCHEDULE_ERROR_CODES.exists) {
    return sendError(res, 409, 'schedule.exists', err instanceof Error ? err.message : 'schedule exists')
  }
  if (tag === SCHEDULE_ERROR_CODES.invalid) {
    return sendError(res, 400, 'schedule.invalid', err instanceof Error ? err.message : 'invalid schedule')
  }
  if (tag === SCHEDULE_ERROR_CODES.runNotFound) {
    return sendError(res, 404, 'run.not_found', err instanceof Error ? err.message : 'run not found')
  }
  if (err instanceof StoreError) {
    if (err.code === 'INVALID_INPUT') {
      return sendError(res, 400, 'schedule.invalid', err.message)
    }
    if (err.code === 'FORBIDDEN') return sendError(res, 403, 'forbidden', err.message)
  }
  console.error('roost api: schedule store failure', err)
  sendError(res, 500, 'internal_error', 'schedule store failure')
}
