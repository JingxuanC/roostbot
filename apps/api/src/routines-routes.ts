// 房间 routine 的 HTTP。
//
//   GET    /api/workspaces/:id/routines
//   POST   /api/workspaces/:id/routines
//   PATCH  /api/routines/:id
//   DELETE /api/routines/:id
//   POST   /api/routines/:id/run
//   GET    /api/routines/:id/runs
//   POST   /api/internal/routine-runs/:id/result

import type { IncomingMessage, ServerResponse } from 'node:http'

import { getWorkspaceRole } from '../../../packages/store/src/index.ts'
import {
  createRoutine,
  deleteRoutine,
  enqueueRoutineNow,
  finishRoutineRun,
  getRoutine,
  getRoutineRun,
  listRoutineRuns,
  listRoutines,
  updateRoutine,
} from '../../../packages/store/src/routines.ts'
import type { Routine, RoutineRun } from '../../../packages/store/src/routines.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { executeRoutineRun } from './routine-worker.ts'
import type { RoutineRunner } from './routine-worker.ts'
import type { StorePort } from './port.ts'
import { authenticate, isPlainObject, readJsonBody, sendError, sendJson } from './server.ts'
import { authorizeRuntimeHttp } from './runtime-auth.ts'

export interface RoutineRouteContext {
  store: StorePort
  now: () => number
  rawStore?: Store
  runtimeToken?: string
  routineRunner?: RoutineRunner
}

function requireStore(ctx: RoutineRouteContext, res: ServerResponse): Store | null {
  if (ctx.rawStore === undefined) {
    sendError(res, 503, 'runtime.not_configured', 'routines need the SQLite store')
    return null
  }
  return ctx.rawStore
}

function routineJson(routine: Routine): Record<string, unknown> {
  return {
    id: routine.id,
    workspaceId: routine.workspaceId,
    botId: routine.botId,
    name: routine.name,
    cron: routine.cron,
    timezone: routine.timezone,
    prompt: routine.prompt,
    roomId: routine.roomId,
    enabled: routine.enabled,
    nextRunAt: routine.nextRunAt,
    lastRunAt: routine.lastRunAt,
    createdAt: routine.createdAt,
    updatedAt: routine.updatedAt,
  }
}

function runJson(run: RoutineRun): Record<string, unknown> {
  return {
    id: run.id,
    routineId: run.routineId,
    scheduledFor: run.scheduledFor,
    status: run.status,
    resultText: run.resultText,
    messageSeq: run.messageSeq,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
  }
}

async function member(ctx: RoutineRouteContext, req: IncomingMessage, res: ServerResponse, workspaceId: string, manage: boolean): Promise<boolean> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message)
    return false
  }
  const store = ctx.rawStore
  if (store === undefined) {
    sendError(res, 503, 'runtime.not_configured', 'routines need the SQLite store')
    return false
  }
  const role = getWorkspaceRole(store, workspaceId, auth.session.accountId)
  if (role === null) {
    sendError(res, 403, 'forbidden', 'not a member of this workspace')
    return false
  }
  if (manage && role !== 'owner' && role !== 'admin') {
    sendError(res, 403, 'forbidden', 'owner or admin required')
    return false
  }
  return true
}

export async function handleListRoutines(ctx: RoutineRouteContext, req: IncomingMessage, res: ServerResponse, workspaceId: string): Promise<void> {
  if (!(await member(ctx, req, res, workspaceId, false))) return
  sendJson(res, 200, { routines: listRoutines(ctx.rawStore!, workspaceId).map(routineJson) })
}

export async function handleCreateRoutine(ctx: RoutineRouteContext, req: IncomingMessage, res: ServerResponse, workspaceId: string): Promise<void> {
  if (!(await member(ctx, req, res, workspaceId, true))) return
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  const body = parsed.value
  try {
    const routine = createRoutine(ctx.rawStore!, {
      workspaceId,
      botId: String(body.botId ?? ''),
      name: String(body.name ?? ''),
      cron: String(body.cron ?? ''),
      prompt: String(body.prompt ?? ''),
      roomId: String(body.roomId ?? ''),
      ...(typeof body.timezone === 'string' ? { timezone: body.timezone } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      at: ctx.now(),
    })
    sendJson(res, 201, { routine: routineJson(routine) })
  } catch (error) {
    sendError(res, 400, 'invalid_body', error instanceof Error ? error.message : 'invalid routine')
  }
}

export async function handlePatchRoutine(ctx: RoutineRouteContext, req: IncomingMessage, res: ServerResponse, routineId: string): Promise<void> {
  const store = requireStore(ctx, res)
  if (store === null) return
  const current = getRoutine(store, routineId)
  if (current === null) return sendError(res, 404, 'not_found', `unknown routine ${routineId}`)
  if (!(await member(ctx, req, res, current.workspaceId, true))) return
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  const body = parsed.value
  try {
    const routine = updateRoutine(store, {
      id: routineId,
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.cron === 'string' ? { cron: body.cron } : {}),
      ...(typeof body.prompt === 'string' ? { prompt: body.prompt } : {}),
      ...(typeof body.timezone === 'string' ? { timezone: body.timezone } : {}),
      ...(typeof body.roomId === 'string' ? { roomId: body.roomId } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      at: ctx.now(),
    })
    sendJson(res, 200, { routine: routineJson(routine) })
  } catch (error) {
    sendError(res, 400, 'invalid_body', error instanceof Error ? error.message : 'invalid routine')
  }
}

export async function handleDeleteRoutine(ctx: RoutineRouteContext, req: IncomingMessage, res: ServerResponse, routineId: string): Promise<void> {
  const store = requireStore(ctx, res)
  if (store === null) return
  const current = getRoutine(store, routineId)
  if (current === null) return sendError(res, 404, 'not_found', `unknown routine ${routineId}`)
  if (!(await member(ctx, req, res, current.workspaceId, true))) return
  deleteRoutine(store, routineId)
  sendJson(res, 200, { ok: true })
}

export async function handleRunRoutineNow(ctx: RoutineRouteContext, req: IncomingMessage, res: ServerResponse, routineId: string): Promise<void> {
  const store = requireStore(ctx, res)
  if (store === null) return
  const current = getRoutine(store, routineId)
  if (current === null) return sendError(res, 404, 'not_found', `unknown routine ${routineId}`)
  if (!(await member(ctx, req, res, current.workspaceId, true))) return
  const run = enqueueRoutineNow(store, routineId, ctx.now())
  const finished = await executeRoutineRun(store, run, ctx.routineRunner ?? (async () => ({ text: null })), ctx.now())
  sendJson(res, 202, { run: runJson(finished) })
}

export async function handleListRoutineRuns(ctx: RoutineRouteContext, req: IncomingMessage, res: ServerResponse, routineId: string): Promise<void> {
  const store = requireStore(ctx, res)
  if (store === null) return
  const current = getRoutine(store, routineId)
  if (current === null) return sendError(res, 404, 'not_found', `unknown routine ${routineId}`)
  if (!(await member(ctx, req, res, current.workspaceId, false))) return
  sendJson(res, 200, { runs: listRoutineRuns(store, routineId).map(runJson) })
}

export async function handleInternalRoutineResult(ctx: RoutineRouteContext, req: IncomingMessage, res: ServerResponse, runId: string): Promise<void> {
  const auth = authorizeRuntimeHttp(ctx, req, res)
  if (auth === null) return
  const store = requireStore(ctx, res)
  if (store === null) return
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  const text = isPlainObject(parsed.value) && typeof parsed.value.text === 'string' ? parsed.value.text : ''
  const error = isPlainObject(parsed.value) && parsed.value.error === true
  const existing = getRoutineRun(store, runId)
  if (existing === null) return sendError(res, 404, 'not_found', `unknown routine run ${runId}`)
  const routine = getRoutine(store, existing.routineId)
  if (routine !== null && auth.workspaceId !== null && auth.workspaceId !== routine.workspaceId) {
    return sendError(res, 403, 'forbidden', 'routine is in another workspace')
  }
  const run = finishRoutineRun(store, runId, text, ctx.now(), { error })
  sendJson(res, 200, { run: runJson(run) })
}
