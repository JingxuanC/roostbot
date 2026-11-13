// 预算控制面：配额查看 / 限额调整 / 用量，以及 runtime 的预留-结算与用量上报。
// 设计源：docs/design/budget.md §4–§6、§10；事件见 docs/design/events.md §3。
//
// 本文件只导出 handler，由 server.ts 接线：
//
//   POST  /api/internal/budget/reserve  handleInternalBudgetReserve  runtime token
//   POST  /api/internal/budget/settle   handleInternalBudgetSettle   runtime token
//   POST  /api/internal/usage           handleInternalUsage          runtime token
//   POST  /api/internal/meter           handleInternalMeter          runtime token（容器秒/存储采样）
//   GET   /api/quotas                   handleListQuotas             Bearer（成员只读）
//   PATCH /api/quotas/:id               handlePatchQuota             Bearer（仅 owner）
//   GET   /api/usage                    handleGetUsage               Bearer（owner/admin）
//
// 配额/预留/用量只在 SQLite 里；内存 port（无 rawStore）一律 503 runtime.not_configured。
// runtime token 语义与其他内部接口一致：无全局 token 且无 rawStore = 404；有 rawStore
// 时 workspace token 生效（跨 workspace = 403），错误 token = 401。

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  QUOTA_METRICS,
  QUOTA_PERIODS,
  QUOTA_SCOPES,
  StoreError,
  getQuota,
  getReservation,
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
  QuotaScope,
  Reservation,
  UsageRow,
} from '../../../packages/store/src/index.ts'
import { BUDGET_ERROR_CODES } from '../../../packages/store/src/index.ts'
import { USAGE_DAILY_MAX_DAYS, usageDaily } from '../../../packages/store/src/budget.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import type { SessionRecord, StorePort, WorkspaceRole } from './port.ts'
import { authenticate, isPlainObject, readJsonBody, sendError, sendJson } from './server.ts'
import { reserveRoostCredits, RoostBudgetDenied, settleRoostCredits } from './roost-budget-billing.ts'
import { authorizeRuntimeHttp, ensureRuntimeWorkspace } from './runtime-auth.ts'
import type { RuntimeRequestAuth } from './runtime-auth.ts'

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
  const runtime = requireRuntimeStore(ctx, req, res)
  if (runtime === null) return
  const { store, auth } = runtime
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const body = parsed.value

  const workspaceId = readId(body['workspaceId'])
  if (workspaceId === null) return sendError(res, 400, 'invalid_body', 'workspaceId is required')
  if (!ensureRuntimeWorkspace(auth, workspaceId, res)) return
  const runId = readId(body['runId'])
  if (runId === null) return sendError(res, 400, 'invalid_body', 'runId is required')
  const turnId = readOptionalId(body['turnId'])
  if (turnId === INVALID) return sendError(res, 400, 'invalid_body', 'turnId must be a string')
  const scope = readScope(body['scope'])
  if (scope === 'invalid') {
    return sendError(res, 400, 'invalid_body', `scope must be one of ${QUOTA_SCOPES.join(', ')}`)
  }
  const scopeId = readOptionalId(body['scopeId'])
  if (scopeId === INVALID) return sendError(res, 400, 'invalid_body', 'scopeId must be a string')
  if (scope === 'turn' && turnId === null && scopeId === null) {
    return sendError(res, 400, 'invalid_body', 'turnId or scopeId is required for turn scope')
  }
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
      ...(scope === null ? {} : { scope }),
      ...(scopeId === null ? {} : { scopeId }),
      period,
      metric,
      runId,
      workspaceId,
      ...(turnId === null ? {} : { turnId }),
      amount,
      at: ctx.now(),
    })
    try {
      await reserveRoostCredits(store, workspaceId, {
        id: result.reservation.id,
        metric: result.reservation.metric,
      }, amount)
    } catch (err) {
      // Undo the local hold; if Roost denied, the product must not spend.
      settle(store, { reservationId: result.reservation.id, actual: 0, at: ctx.now() })
      if (err instanceof RoostBudgetDenied) {
        sendError(res, 402, 'insufficient_credits', err.message)
        return
      }
      throw err
    }
    sendJson(res, 201, {
      reservation: reservationJson(result.reservation),
      remaining: result.remaining,
      reservations: result.reservations.map(reservationJson),
      layers: result.layers.map((layer) => ({
        scope: layer.scope,
        quotaId: layer.quota.id,
        reservationId: layer.reservation.id,
        amount: layer.reservation.amount,
        remaining: layer.remaining,
      })),
    })
  } catch (err) {
    sendBudgetFailure(res, err)
  }
}

export async function handleInternalBudgetSettle(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const runtime = requireRuntimeStore(ctx, req, res)
  if (runtime === null) return
  const { store, auth } = runtime
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const body = parsed.value

  const reservationId = readId(body['reservationId'])
  if (reservationId === null) return sendError(res, 400, 'invalid_body', 'reservationId is required')
  // 结算按 reservationId 定位；workspace token 只能结算自己 workspace 的预留。
  const reservation = getReservation(store, reservationId)
  if (reservation !== null && !ensureRuntimeWorkspace(auth, reservation.workspaceId, res)) return
  const actual = readCount(body['actual'])
  if (actual === null) return sendError(res, 400, 'invalid_body', 'actual must be an integer >= 0')

  try {
    const result = settle(store, { reservationId, actual, at: ctx.now() })
    if (reservation !== null) {
      try {
        await settleRoostCredits(store, reservation.workspaceId, {
          id: reservation.id,
          metric: reservation.metric,
        }, actual)
      } catch (err) {
        console.error('roost-budget settle failed', err)
      }
    }
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
  const runtime = requireRuntimeStore(ctx, req, res)
  if (runtime === null) return
  const { store, auth } = runtime
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const body = parsed.value

  const workspaceId = readId(body['workspaceId'])
  if (workspaceId === null) return sendError(res, 400, 'invalid_body', 'workspaceId is required')
  if (!ensureRuntimeWorkspace(auth, workspaceId, res)) return
  const turnId = readOptionalId(body['turnId'])
  if (turnId === INVALID) return sendError(res, 400, 'invalid_body', 'turnId must be a string')
  const idem = readOptionalId(body['idem'])
  if (idem === INVALID) return sendError(res, 400, 'invalid_body', 'idem must be a string')
  if (turnId === null && idem === null) {
    return sendError(res, 400, 'invalid_body', 'turnId is required (or idem when there is no turn)')
  }
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
  const containerSeconds = readOptionalNumber(body['containerSeconds'])
  if (containerSeconds === INVALID) {
    return sendError(res, 400, 'invalid_body', 'containerSeconds must be a number >= 0')
  }
  const storageBytes = readOptionalCount(body['storageBytes'])
  if (storageBytes === INVALID) {
    return sendError(res, 400, 'invalid_body', 'storageBytes must be an integer >= 0')
  }

  try {
    const result = recordUsage(store, {
      workspaceId,
      runId,
      turnId,
      idem,
      botId,
      model,
      inputTokens,
      outputTokens,
      cachedTokens,
      toolCalls,
      costUsd,
      containerSeconds,
      storageBytes,
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

const METER_KINDS = ['container_seconds', 'storage_bytes'] as const
type MeterKind = (typeof METER_KINDS)[number]

/**
 * 控制面采样：容器秒 / 存储字节（budget.md §2、§6「控制面采样」）。
 * 没有 turnId，用调用方给的 idem 幂等；没给 idem 时每次采样都是新行。
 */
export async function handleInternalMeter(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const runtime = requireRuntimeStore(ctx, req, res)
  if (runtime === null) return
  const { store, auth } = runtime
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const body = parsed.value

  const workspaceId = readId(body['workspaceId'])
  if (workspaceId === null) return sendError(res, 400, 'invalid_body', 'workspaceId is required')
  if (!ensureRuntimeWorkspace(auth, workspaceId, res)) return
  const kind = readMeterKind(body['kind'])
  if (kind === null) {
    return sendError(res, 400, 'invalid_body', `kind must be one of ${METER_KINDS.join(', ')}`)
  }
  const idem = readOptionalId(body['idem'])
  if (idem === INVALID) return sendError(res, 400, 'invalid_body', 'idem must be a string')
  const at = readOptionalEpoch(body['at'])
  if (at === INVALID) return sendError(res, 400, 'invalid_body', 'at must be epoch ms >= 0')

  const amount = readOptionalNumber(body['amount'])
  if (amount === INVALID || amount === null) {
    return sendError(res, 400, 'invalid_body', 'amount must be a number >= 0')
  }
  if (kind === 'storage_bytes' && !Number.isSafeInteger(amount)) {
    return sendError(res, 400, 'invalid_body', 'storage_bytes amount must be an integer >= 0')
  }

  try {
    const result = recordUsage(store, {
      workspaceId,
      source: kind,
      idem: idem ?? `${kind}:${ctx.now()}:${Math.random().toString(36).slice(2)}`,
      ...(kind === 'container_seconds' ? { containerSeconds: amount } : { storageBytes: amount }),
      at: at ?? ctx.now(),
    })
    // 202：采样已接收；重放同 idem 也返回 202 + deduped=true。
    sendJson(res, 202, { usage: usageJson(result.row), deduped: result.deduped })
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

  const workspaceId = quotaWorkspaceId(store, quota)
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
    const daily = usageDaily(store, {
      workspaceId,
      days: coveredUtcDays(from, to),
      at: to > 0 ? to - 1 : to,
    })
    sendJson(res, 200, { ...summary, daily })
  } catch (err) {
    sendBudgetFailure(res, err)
  }
}

/** [from, to) 覆盖了多少个 UTC 日；上限 USAGE_DAILY_MAX_DAYS。 */
function coveredUtcDays(from: number, to: number): number {
  const DAY = 86_400_000
  const first = Math.floor(from / DAY)
  const last = Math.floor((to > from ? to - 1 : from) / DAY)
  return Math.min(Math.max(last - first + 1, 1), USAGE_DAILY_MAX_DAYS)
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
    containerSeconds: row.containerSeconds,
    storageBytes: row.storageBytes,
    source: row.source,
  }
}

// ---- 鉴权 / 输入 / 错误 -----------------------------------------------------

interface RuntimeStore {
  store: Store
  auth: RuntimeRequestAuth
}

function requireRuntimeStore(ctx: Ctx, req: IncomingMessage, res: ServerResponse): RuntimeStore | null {
  const auth = authorizeRuntimeHttp(ctx, req, res)
  if (auth === null) return null
  const store = requireStore(ctx, res)
  if (store === null) return null
  return { store, auth }
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

/**
 * 配额属于哪个 workspace，用于 PATCH 的 owner 判定：
 *   * workspace：scope_id 就是 workspace id；
 *   * tenant：取该 tenant 下最早的 workspace；
 *   * run：runs → activations.workspace_id；
 *   * turn：没有独立表，从 usage_rows 反查（同一 turn 必属同一 workspace）。
 */
function quotaWorkspaceId(store: Store, quota: Quota): string | null {
  if (quota.scope === 'workspace') return quota.scopeId
  if (quota.scope === 'tenant') return tenantWorkspaceId(store, quota.scopeId)
  if (quota.scope === 'run') {
    const row = store.db
      .prepare(
        `SELECT a.workspace_id AS workspace_id
           FROM runs r JOIN activations a ON a.id = r.activation_id
          WHERE r.id = ?`,
      )
      .get(quota.scopeId) as { workspace_id: string } | undefined
    return row?.workspace_id ?? null
  }
  const row = store.db
    .prepare('SELECT workspace_id FROM usage_rows WHERE turn_id = ? ORDER BY at, id LIMIT 1')
    .get(quota.scopeId) as { workspace_id: string } | undefined
  return row?.workspace_id ?? null
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

/** 非负有限数（容器秒允许小数）。 */
function readOptionalNumber(value: unknown): number | null | Invalid {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return INVALID
  return value
}

function readOptionalEpoch(value: unknown): number | null | Invalid {
  if (value === undefined || value === null) return null
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : INVALID
}

function readMetric(value: unknown): QuotaMetric | null {
  return typeof value === 'string' && (QUOTA_METRICS as readonly string[]).includes(value)
    ? (value as QuotaMetric)
    : null
}

function readScope(value: unknown): QuotaScope | null | 'invalid' {
  if (value === undefined || value === null) return null
  return typeof value === 'string' && (QUOTA_SCOPES as readonly string[]).includes(value)
    ? (value as QuotaScope)
    : 'invalid'
}

function readMeterKind(value: unknown): MeterKind | null {
  return typeof value === 'string' && (METER_KINDS as readonly string[]).includes(value)
    ? (value as MeterKind)
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
    const message = err instanceof Error ? err.message : 'quota exhausted'
    // 多层预留失败时把命中的层放进 error.layer（message 里同时有 layer=<scope>）。
    const match = /layer=(tenant|workspace|run|turn)/.exec(message)
    if (match !== null) {
      return sendJson(res, 429, { ok: false, error: { code: 'quota_exhausted', message, layer: match[1] } })
    }
    return sendError(res, 429, 'quota_exhausted', message)
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

