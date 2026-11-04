// 预算控制面：配额查看 / 限额调整 / 用量，以及 runtime 的预留-结算与用量上报。
// 设计源：docs/design/budget.md §4–§6、§10；事件见 docs/design/events.md §3。
//
// 本文件只导出 handler，由 server.ts 接线：
//
//   POST  /api/internal/budget/reserve  handleInternalBudgetReserve  runtime token
//   POST  /api/internal/budget/settle   handleInternalBudgetSettle   runtime token
//   POST  /api/internal/usage           handleInternalUsage          runtime token
//   GET   /api/quotas                   handleListQuotas             Bearer（成员只读）
//   PATCH /api/quotas/:id               handlePatchQuota             Bearer（仅 owner）
//   GET   /api/usage                    handleGetUsage               Bearer（owner/admin）
//
// 配额/预留/用量只在 SQLite 里；内存 port（无 rawStore）一律 503 runtime.not_configured。
// runtime token 语义与其他内部接口一致：未配置 404，错误 token 401。

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  QUOTA_METRICS,
  QUOTA_PERIODS,
  StoreError,
  getQuota,
  getWorkspaceRole,
  isSoftLimitReached,
  listQuotas,
  quotaRatio,
  recordUsage,
  reserve,
  setQuotaLimit,
  settle,
  storeErrorTag,
  sumUsage,
} from '../../../packages/store/src/index.ts'
import type {
  Quota,
  QuotaMetric,
  QuotaPeriod,
  Reservation,
  UsageRow,
} from '../../../packages/store/src/index.ts'
import { BUDGET_ERROR_CODES } from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import type { SessionRecord, StorePort, WorkspaceRole } from './port.ts'
import { authenticate, isPlainObject, readJsonBody, sendError, sendJson } from './server.ts'

export interface BudgetRouteContext {
  store: StorePort
  now: () => number
  rawStore?: Store
  runtimeToken?: string
}

type Ctx = BudgetRouteContext

const MAX_ID_CHARS = 200

// ---- 内部：预留 / 结算 / 用量 -------------------------------------------------

export async function handleInternalBudgetReserve(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const store = requireRuntimeStore(ctx, req, res)
  if (store === null) return
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const body = parsed.value

  const workspaceId = readId(body['workspaceId'])
  if (workspaceId === null) return sendError(res, 400, 'invalid_body', 'workspaceId is required')
  const runId = readId(body['runId'])
  if (runId === null) return sendError(res, 400, 'invalid_body', 'runId is required')
  const metric = readMetric(body['metric'])
  if (metric === null) {
    return sendError(res, 400, 'invalid_body', `metric must be one of ${QUOTA_METRICS.join(', ')}`)
  }
  const period = readPeriod(body['period'])
  if (period === 'invalid') {
    return sendError(res, 400, 'invalid_body', `period must be one of ${QUOTA_PERIODS.join(', ')}`)
  }
  const amount = readCount(body['amount'])
  if (amount === null) return sendError(res, 400, 'invalid_body', 'amount must be an integer >= 0')

  try {
    const result = reserve(store, {
      scope: 'workspace',
      scopeId: workspaceId,
      period,
      metric,
      runId,
      workspaceId,
      amount,
      at: ctx.now(),
    })
    sendJson(res, 201, { reservation: reservationJson(result.reservation), remaining: result.remaining })
  } catch (err) {
    sendBudgetFailure(res, err)
  }
}

export async function handleInternalBudgetSettle(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const store = requireRuntimeStore(ctx, req, res)
  if (store === null) return
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const body = parsed.value

  const reservationId = readId(body['reservationId'])
  if (reservationId === null) return sendError(res, 400, 'invalid_body', 'reservationId is required')
  const actual = readCount(body['actual'])
  if (actual === null) return sendError(res, 400, 'invalid_body', 'actual must be an integer >= 0')

  try {
    const result = settle(store, { reservationId, actual, at: ctx.now() })
    sendJson(res, 200, {
      reservation: reservationJson(result.reservation),
      remaining: result.remaining,
    })
  } catch (err) {
    sendBudgetFailure(res, err)
  }
}

export async function handleInternalUsage(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const store = requireRuntimeStore(ctx, req, res)
  if (store === null) return
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const body = parsed.value

  const workspaceId = readId(body['workspaceId'])
  if (workspaceId === null) return sendError(res, 400, 'invalid_body', 'workspaceId is required')
  const turnId = readId(body['turnId'])
  if (turnId === null) return sendError(res, 400, 'invalid_body', 'turnId is required')
  const source = readId(body['source'])
  if (source === null) return sendError(res, 400, 'invalid_body', 'source is required')

  const runId = readOptionalId(body['runId'])
  if (runId === INVALID) return sendError(res, 400, 'invalid_body', 'runId must be a string')
  const botId = readOptionalId(body['botId'])
  if (botId === INVALID) return sendError(res, 400, 'invalid_body', 'botId must be a string')
  const model = readOptionalId(body['model'])
  if (model === INVALID) return sendError(res, 400, 'invalid_body', 'model must be a string')

  const inputTokens = readOptionalCount(body['inputTokens'])
  if (inputTokens === INVALID) {
    return sendError(res, 400, 'invalid_body', 'inputTokens must be an integer >= 0')
  }
  const outputTokens = readOptionalCount(body['outputTokens'])
  if (outputTokens === INVALID) {
    return sendError(res, 400, 'invalid_body', 'outputTokens must be an integer >= 0')
  }
  const cachedTokens = readOptionalCount(body['cachedTokens'])
  if (cachedTokens === INVALID) {
    return sendError(res, 400, 'invalid_body', 'cachedTokens must be an integer >= 0')
  }
  const toolCalls = readOptionalCount(body['toolCalls'])
  if (toolCalls === INVALID) {
    return sendError(res, 400, 'invalid_body', 'toolCalls must be an integer >= 0')
  }
  const costUsd = readOptionalCost(body['costUsd'])
  if (costUsd === INVALID) return sendError(res, 400, 'invalid_body', 'costUsd must be a number >= 0')

  try {
    const result = recordUsage(store, {
      workspaceId,
      runId,
      turnId,
      botId,
      model,
      inputTokens,
      outputTokens,
      cachedTokens,
      toolCalls,
      costUsd,
      source,
      at: ctx.now(),
    })
    sendJson(res, result.deduped ? 200 : 201, {
      usage: usageJson(result.row),
      deduped: result.deduped,
    })
  } catch (err) {
    sendBudgetFailure(res, err)
  }
}

// ---- 用户：配额与用量 --------------------------------------------------------

export async function handleListQuotas(
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
  const role = workspaceRole(store, auth.accountId, workspaceId)
  if (role === null) {
    return sendError(res, 403, 'forbidden', `account is not a member of workspace ${workspaceId}`)
  }

  sendJson(res, 200, { quotas: listQuotas(store, { workspaceId }).map(quotaJson) })
}

export async function handlePatchQuota(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  const store = requireStore(ctx, res)
  if (store === null) return

  const quotaId = quotaIdFromPath(url.pathname)
  if (quotaId === null) return sendError(res, 404, 'not_found', 'malformed quota path')

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const limitValue = readCount(parsed.value['limitValue'])
  if (limitValue === null) return sendError(res, 400, 'invalid_body', 'limitValue must be an integer >= 0')

  const quota = getQuota(store, quotaId)
  if (quota === null) return sendError(res, 404, 'quota_not_found', `unknown quota ${quotaId}`)

  const workspaceId = quota.scope === 'workspace' ? quota.scopeId : tenantWorkspaceId(store, quota.scopeId)
  const role = workspaceId === null ? null : workspaceRole(store, auth.accountId, workspaceId)
  if (role !== 'owner') {
    return sendError(res, 403, 'forbidden', 'only the workspace owner can change quota limits')
  }

  try {
    const updated = setQuotaLimit(store, { id: quotaId, limitValue, by: auth.accountId, at: ctx.now() })
    sendJson(res, 200, { quota: quotaJson(updated) })
  } catch (err) {
    sendBudgetFailure(res, err)
  }
}

export async function handleGetUsage(
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
  const from = readEpoch(url.searchParams.get('from'))
  if (from === null) return sendError(res, 400, 'invalid_body', 'from is required (epoch ms)')
  const to = readEpoch(url.searchParams.get('to'))
  if (to === null) return sendError(res, 400, 'invalid_body', 'to is required (epoch ms)')

  const role = workspaceRole(store, auth.accountId, workspaceId)
  if (role !== 'owner' && role !== 'admin') {
    return sendError(res, 403, 'forbidden', `workspace ${workspaceId} requires owner/admin role`)
  }

  try {
    const summary = sumUsage(store, { workspaceId, from, to })
    sendJson(res, 200, summary)
  } catch (err) {
    sendBudgetFailure(res, err)
  }
}

// ---- 序列化 -----------------------------------------------------------------

function quotaJson(quota: Quota): Record<string, unknown> {
  return {
    id: quota.id,
    scope: quota.scope,
    scopeId: quota.scopeId,
    period: quota.period,
    metric: quota.metric,
    limitValue: quota.limitValue,
    usedValue: quota.usedValue,
    reserved: quota.reserved,
    resetsAt: quota.resetsAt,
    ratio: quotaRatio(quota),
    warning: isSoftLimitReached(quota),
  }
}

function reservationJson(reservation: Reservation): Record<string, unknown> {
  return {
    id: reservation.id,
    runId: reservation.runId,
    workspaceId: reservation.workspaceId,
    metric: reservation.metric,
    amount: reservation.amount,
    createdAt: reservation.createdAt,
    settledAt: reservation.settledAt,
    actual: reservation.actual,
  }
}

function usageJson(row: UsageRow): Record<string, unknown> {
  return {
    id: row.id,
    at: row.at,
    workspaceId: row.workspaceId,
    runId: row.runId,
    turnId: row.turnId,
    botId: row.botId,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedTokens: row.cachedTokens,
    toolCalls: row.toolCalls,
    costUsd: row.costUsd,
    source: row.source,
  }
}

// ---- 鉴权 / 输入 / 错误 -----------------------------------------------------

function runtimeTokenFrom(req: IncomingMessage): string | null {
  const header = (req.headers['x-runtime-token'] ?? '').toString()
  if (header !== '') return header
  const auth = (req.headers.authorization ?? '').trim()
  const match = /^Runtime[ ]+(\S+)$/.exec(auth)
  return match === null ? null : match[1]!
}

function authorizeRuntime(ctx: Ctx, req: IncomingMessage, res: ServerResponse): boolean {
  if (ctx.runtimeToken === undefined || ctx.runtimeToken === '') {
    sendError(res, 404, 'not_found', 'internal api is disabled')
    return false
  }
  const token = runtimeTokenFrom(req)
  if (token === null || token !== ctx.runtimeToken) {
    sendError(res, 401, 'unauthenticated', 'runtime token required')
    return false
  }
  return true
}

function requireRuntimeStore(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Store | null {
  if (!authorizeRuntime(ctx, req, res)) return null
  return requireStore(ctx, res)
}

function requireStore(ctx: Ctx, res: ServerResponse): Store | null {
  if (ctx.rawStore !== undefined) return ctx.rawStore
  sendError(res, 503, 'runtime.not_configured', 'budget needs the SQLite store')
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

/** tenant 配额的 owner 判断落到该 tenant 下的任一 workspace（取最早一个）。 */
function tenantWorkspaceId(store: Store, tenantId: string): string | null {
  const row = store.db
    .prepare('SELECT id FROM workspaces WHERE tenant_id = ? ORDER BY created_at, id LIMIT 1')
    .get(tenantId) as { id: string } | undefined
  return row?.id ?? null
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

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function readOptionalCount(value: unknown): number | null | Invalid {
  if (value === undefined || value === null) return null
  return readCount(value) ?? INVALID
}

function readOptionalCost(value: unknown): number | null | Invalid {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return INVALID
  return value
}

function readMetric(value: unknown): QuotaMetric | null {
  return typeof value === 'string' && (QUOTA_METRICS as readonly string[]).includes(value)
    ? (value as QuotaMetric)
    : null
}

function readPeriod(value: unknown): QuotaPeriod | 'invalid' {
  if (value === undefined || value === null) return 'day'
  return typeof value === 'string' && (QUOTA_PERIODS as readonly string[]).includes(value)
    ? (value as QuotaPeriod)
    : 'invalid'
}

function readEpoch(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function quotaIdFromPath(pathname: string): string | null {
  const match = /^\/api\/quotas\/([^/]+)$/.exec(pathname.replace(/\/+$/, ''))
  if (match === null) return null
  try {
    return readId(decodeURIComponent(match[1]!))
  } catch {
    return null
  }
}

function sendBudgetFailure(res: ServerResponse, err: unknown): void {
  const tag = storeErrorTag(err)
  if (tag === BUDGET_ERROR_CODES.quotaExhausted) {
    return sendError(res, 429, 'quota_exhausted', err instanceof Error ? err.message : 'quota exhausted')
  }
  if (tag === BUDGET_ERROR_CODES.quotaNotFound) {
    return sendError(res, 404, 'quota_not_found', err instanceof Error ? err.message : 'quota not found')
  }
  if (tag === BUDGET_ERROR_CODES.reservationNotFound) {
    return sendError(res, 404, 'reservation_not_found', err instanceof Error ? err.message : 'reservation not found')
  }
  if (err instanceof StoreError) {
    if (err.code === 'WORKSPACE_NOT_FOUND') return sendError(res, 404, 'workspace_not_found', err.message)
    if (err.code === 'INVALID_INPUT') return sendError(res, 400, 'budget.invalid', err.message)
    if (err.code === 'FORBIDDEN') return sendError(res, 403, 'forbidden', err.message)
  }
  console.error('roost api: budget store failure', err)
  sendError(res, 500, 'internal_error', 'budget store failure')
}

