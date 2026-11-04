// 预算：配额、预留-结算与用量行（docs/design/budget.md §3–§6、§10）。
//
// 核心规则（§4）：
//   * 准入时 reserve：剩余 = limit - used - reserved，不足直接 QUOTA_EXHAUSTED，绝不静默降级；
//   * 结束时 settle：reserved -= amount，used += actual；actual 可以大于 amount（负差额也记账）；
//   * 周期按 UTC 推进（日=UTC 0 点，月=UTC 1 号 0 点）；工作区时区留后续（§12 待决 1）。
//
// 幂等（§6）：
//   * usage_rows.idem = `<turnId>:<source>`，重放返回已有行、不重复计费；
//   * settle 只在 settled_at IS NULL 时落定，重复调用原样返回；
//   * billing.cap 同一配额同一周期只写一次（事件 idem = quota + resets_at）。
//
// 行与事件同一 savepoint：事件写失败时回滚行，不留「看不见的扣账」。

import { StoreError } from './errors.ts'
import { appendEvent } from './events.ts'
import { newRoostId } from './ids.ts'
import { asInteger, asNonEmptyString, asRecord, assertOpen, errorMessage, toNumber } from './internal.ts'
import type { Store } from './types.ts'

export const QUOTA_SCOPES = ['tenant', 'workspace'] as const
export type QuotaScope = (typeof QUOTA_SCOPES)[number]

export const QUOTA_PERIODS = ['day', 'month'] as const
export type QuotaPeriod = (typeof QUOTA_PERIODS)[number]

export const QUOTA_METRICS = [
  'tokens',
  'runs',
  'container_seconds',
  'storage_bytes',
  'messages',
] as const
export type QuotaMetric = (typeof QUOTA_METRICS)[number]

/** 软限：used / limit >= 80% 发 warning（不阻断）。 */
export const SOFT_LIMIT_RATIO = 0.8

/** 预算域内部错误码（写在 StoreError.message 的 `CODE: ` 前缀里，API 用 storeErrorTag 取回）。 */
export const BUDGET_ERROR_CODES = {
  quotaNotFound: 'QUOTA_NOT_FOUND',
  quotaExhausted: 'QUOTA_EXHAUSTED',
  reservationNotFound: 'QUOTA_RESERVATION_NOT_FOUND',
  invalid: 'QUOTA_INVALID',
} as const

export interface Quota {
  id: string
  scope: QuotaScope
  scopeId: string
  period: QuotaPeriod
  metric: QuotaMetric
  limitValue: number
  usedValue: number
  reserved: number
  /** 本周期结束（下一次重置）的 epoch 毫秒；UTC 边界。 */
  resetsAt: number | null
}

export interface Reservation {
  id: string
  runId: string
  workspaceId: string
  quotaId: string
  metric: string
  amount: number
  createdAt: number
  settledAt: number | null
  actual: number | null
}

export interface UsageRow {
  id: string
  at: number
  workspaceId: string
  runId: string | null
  turnId: string | null
  botId: string | null
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  cachedTokens: number | null
  toolCalls: number | null
  costUsd: number | null
  source: string | null
  idem: string | null
}

export interface EnsureQuotaInput {
  scope: QuotaScope
  scopeId: string
  period: QuotaPeriod
  metric: QuotaMetric
  limitValue: number
  at?: number
}

export interface ReserveInput {
  /** 已知配额 id 时直接用它；否则用 scope/scopeId/period/metric 定位。 */
  quotaId?: string
  scope?: QuotaScope
  scopeId?: string
  period?: QuotaPeriod
  metric?: QuotaMetric
  runId: string
  workspaceId: string
  amount: number
  at?: number
}

export interface ReserveResult {
  reservation: Reservation
  quota: Quota
  /** 扣掉本次预留后的剩余量（limit - used - reserved）。 */
  remaining: number
}

export interface SettleInput {
  reservationId: string
  actual: number
  at?: number
}

export interface SettleResult {
  reservation: Reservation
  quota: Quota | null
  remaining: number | null
}

export interface RecordUsageInput {
  workspaceId: string
  runId?: string | null
  turnId: string
  botId?: string | null
  model?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  cachedTokens?: number | null
  toolCalls?: number | null
  costUsd?: number | null
  source: string
  at?: number
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  /** input + output + cached（记账口径；cached 是否子集由 provider 决定）。 */
  tokens: number
  toolCalls: number
  costUsd: number
  rows: number
}

export interface UsageGroup {
  key: string | null
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  tokens: number
  toolCalls: number
  costUsd: number
  rows: number
}

export interface UsageSummary {
  totals: UsageTotals
  byBot: UsageGroup[]
  byModel: UsageGroup[]
}

interface QuotaRow {
  id: string
  scope: string
  scope_id: string
  period: string
  metric: string
  limit_value: number | bigint
  used_value: number | bigint
  reserved: number | bigint
  resets_at: number | bigint | null
}

interface ReservationRow {
  id: string
  run_id: string
  workspace_id: string
  quota_id: string
  metric: string
  amount: number | bigint
  created_at: number | bigint
  settled_at: number | bigint | null
  actual: number | bigint | null
}

interface UsageRowRow {
  id: string
  at: number | bigint
  workspace_id: string
  run_id: string | null
  turn_id: string | null
  bot_id: string | null
  model: string | null
  input_tokens: number | bigint | null
  output_tokens: number | bigint | null
  cached_tokens: number | bigint | null
  tool_calls: number | bigint | null
  cost_usd: number | null
  source: string | null
  idem: string | null
}

const QUOTA_COLUMNS = 'id, scope, scope_id, period, metric, limit_value, used_value, reserved, resets_at'
const RESERVATION_COLUMNS =
  'id, run_id, workspace_id, quota_id, metric, amount, created_at, settled_at, actual'
const USAGE_COLUMNS =
  'id, at, workspace_id, run_id, turn_id, bot_id, model, input_tokens, output_tokens, cached_tokens, tool_calls, cost_usd, source, idem'

// ---- 配额 -------------------------------------------------------------------

/** 同 (scope, scope_id, period, metric) 已存在时原样返回，不覆盖 limit。 */
export function ensureQuota(store: Store, input: EnsureQuotaInput): Quota {
  assertOpen(store)
  const req = asRecord(input, 'quota', 'INVALID_INPUT')
  const scope = readScope(req.scope)
  const scopeId = asNonEmptyString(req.scopeId, 'quota.scopeId')
  const period = readPeriod(req.period)
  const metric = readMetric(req.metric)
  const limitValue = asInteger(req.limitValue, 'quota.limitValue', 0)
  const at = readAt(req.at)

  const existing = findQuotaTuple(store, scope, scopeId, period, metric)
  if (existing !== null) {
    if (existing.resetsAt === null) {
      store.db.prepare('UPDATE quotas SET resets_at = ? WHERE id = ?').run(periodEnd(period, at), existing.id)
      return getQuota(store, existing.id)!
    }
    return existing
  }

  const id = newRoostId('qta', at)
  try {
    store.db
      .prepare(
        `INSERT INTO quotas (${QUOTA_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      )
      .run(id, scope, scopeId, period, metric, limitValue, periodEnd(period, at))
  } catch (err) {
    throw new StoreError('INVALID_INPUT', `failed to create quota: ${errorMessage(err)}`, { cause: err })
  }
  return getQuota(store, id)!
}

export function getQuota(store: Store, id: string): Quota | null {
  assertOpen(store)
  const quotaId = asNonEmptyString(id, 'quota.id')
  const row = store.db.prepare(`SELECT ${QUOTA_COLUMNS} FROM quotas WHERE id = ?`).get(quotaId)
  return row === undefined || row === null ? null : rowToQuota(row)
}

export interface ListQuotasQuery {
  /** 给了 workspaceId：返回该 workspace 的配额 + 其 tenant 的配额。 */
  workspaceId?: string
  scope?: QuotaScope
  scopeId?: string
}

export function listQuotas(store: Store, query: ListQuotasQuery = {}): Quota[] {
  assertOpen(store)
  const req = asRecord(query, 'quota.query')

  if (req.scope !== undefined && req.scope !== null) {
    const scope = readScope(req.scope)
    const scopeId = asNonEmptyString(req.scopeId, 'quota.scopeId')
    return store.db
      .prepare(`SELECT ${QUOTA_COLUMNS} FROM quotas WHERE scope = ? AND scope_id = ? ORDER BY period, metric, id`)
      .all(scope, scopeId)
      .map(rowToQuota)
  }

  if (req.workspaceId === undefined || req.workspaceId === null) return []
  const workspaceId = asNonEmptyString(req.workspaceId, 'quota.workspaceId')
  const tenantRow = store.db.prepare('SELECT tenant_id FROM workspaces WHERE id = ?').get(workspaceId) as
    | { tenant_id: string }
    | undefined
  const rows = store.db
    .prepare(
      `SELECT ${QUOTA_COLUMNS} FROM quotas
        WHERE (scope = 'workspace' AND scope_id = ?)
           OR (scope = 'tenant' AND scope_id = ?)
        ORDER BY scope, period, metric, id`,
    )
    .all(workspaceId, tenantRow?.tenant_id ?? '')
  return rows.map(rowToQuota)
}

/** 只改 limit_value；写 billing.quota.changed（实现补充，见 budget.md §11）。 */
export function setQuotaLimit(
  store: Store,
  input: { id: string; limitValue: number; by?: string; at?: number },
): Quota {
  assertOpen(store)
  const req = asRecord(input, 'quota.limit', 'INVALID_INPUT')
  const id = asNonEmptyString(req.id, 'quota.id')
  const limitValue = asInteger(req.limitValue, 'quota.limitValue', 0)
  const by = typeof req.by === 'string' && req.by.trim() !== '' ? req.by : 'system'
  const at = readAt(req.at)

  return withSavepoint(store, 'roost_set_quota_limit', () => {
    const current = getQuota(store, id)
    if (current === null) throw budgetError(BUDGET_ERROR_CODES.quotaNotFound, `unknown quota ${id}`)
    store.db.prepare('UPDATE quotas SET limit_value = ? WHERE id = ?').run(limitValue, id)
    appendEvent(store, {
      at: new Date(at).toISOString(),
      domain: 'billing',
      kind: 'billing.quota.changed',
      actor: { kind: 'user', id: by },
      subject: { kind: 'quota', id },
      audience: 'team',
      idem: `billing.quota.changed:${id}:${at}:${limitValue}`,
      payload: {
        quotaId: id,
        scope: current.scope,
        scopeId: current.scopeId,
        period: current.period,
        metric: current.metric,
        from: current.limitValue,
        to: limitValue,
      },
    })
    return getQuota(store, id)!
  })
}

// ---- 预留 / 结算 -------------------------------------------------------------

export function reserve(store: Store, input: ReserveInput): ReserveResult {
  assertOpen(store)
  const req = asRecord(input, 'reserve', 'INVALID_INPUT')
  const runId = asNonEmptyString(req.runId, 'reserve.runId')
  const workspaceId = asNonEmptyString(req.workspaceId, 'reserve.workspaceId')
  const amount = asInteger(req.amount, 'reserve.amount', 0)
  const at = readAt(req.at)

  return withSavepoint(store, 'roost_budget_reserve', () => {
    const found = resolveQuota(store, req)
    if (found === null) throw budgetError(BUDGET_ERROR_CODES.quotaNotFound, 'quota not configured')
    const quota = refreshPeriod(store, found, at)

    const remaining = quota.limitValue - quota.usedValue - quota.reserved
    if (amount > remaining) {
      throw budgetError(
        BUDGET_ERROR_CODES.quotaExhausted,
        `quota ${quota.id} (${quota.metric}/${quota.period}) has ${remaining} left, requested ${amount}`,
        'FORBIDDEN',
      )
    }

    const updated = store.db
      .prepare(
        'UPDATE quotas SET reserved = reserved + ? WHERE id = ? AND used_value = ? AND reserved = ?',
      )
      .run(amount, quota.id, quota.usedValue, quota.reserved)
    if (toNumber(updated.changes) !== 1) {
      throw budgetError(BUDGET_ERROR_CODES.invalid, `quota ${quota.id} changed during reservation`)
    }

    const id = newRoostId('rsv', at)
    store.db
      .prepare(`INSERT INTO reservations (${RESERVATION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
      .run(id, runId, workspaceId, quota.id, quota.metric, amount, at)

    const next = getQuota(store, quota.id)!
    appendEvent(store, {
      at: new Date(at).toISOString(),
      domain: 'billing',
      kind: 'billing.reserve',
      actor: { kind: 'control-plane', id: 'budget' },
      subject: { kind: 'reservation', id },
      audience: 'team',
      idem: `billing.reserve:${id}`,
      trace: { run: runId, workspace: workspaceId },
      payload: {
        reservationId: id,
        quotaId: quota.id,
        runId,
        workspaceId,
        scope: next.scope,
        scopeId: next.scopeId,
        metric: next.metric,
        period: next.period,
        amount,
        limitValue: next.limitValue,
        usedValue: next.usedValue,
        reserved: next.reserved,
        remaining: next.limitValue - next.usedValue - next.reserved,
        resetsAt: next.resetsAt,
      },
    })
    maybeWriteCap(store, next, at)

    return {
      reservation: getReservation(store, id)!,
      quota: next,
      remaining: next.limitValue - next.usedValue - next.reserved,
    }
  })
}

export function getReservation(store: Store, id: string): Reservation | null {
  assertOpen(store)
  const reservationId = asNonEmptyString(id, 'reservation.id')
  const row = store.db
    .prepare(`SELECT ${RESERVATION_COLUMNS} FROM reservations WHERE id = ?`)
    .get(reservationId)
  return row === undefined || row === null ? null : rowToReservation(row)
}

/** 幂等：已结算直接原样返回，不再改 used / 不再写事件。 */
export function settle(store: Store, input: SettleInput): SettleResult {
  assertOpen(store)
  const req = asRecord(input, 'settle', 'INVALID_INPUT')
  const reservationId = asNonEmptyString(req.reservationId, 'settle.reservationId')
  const actual = asInteger(req.actual, 'settle.actual', 0)
  const at = readAt(req.at)

  return withSavepoint(store, 'roost_budget_settle', () => {
    const current = getReservation(store, reservationId)
    if (current === null) {
      throw budgetError(BUDGET_ERROR_CODES.reservationNotFound, `unknown reservation ${reservationId}`)
    }
    if (current.settledAt !== null) {
      const quota = getQuota(store, current.quotaId)
      return { reservation: current, quota, remaining: remainingOf(quota) }
    }

    const quotaBefore = getQuota(store, current.quotaId)
    if (quotaBefore !== null) refreshPeriod(store, quotaBefore, at)

    const updated = store.db
      .prepare('UPDATE reservations SET settled_at = ?, actual = ? WHERE id = ? AND settled_at IS NULL')
      .run(at, actual, reservationId)
    if (toNumber(updated.changes) === 1) {
      if (quotaBefore !== null) {
        // 周期已经翻页时 reserved 已被清 0，MAX 防止减成负数。
        store.db
          .prepare(
            'UPDATE quotas SET reserved = MAX(reserved - ?, 0), used_value = used_value + ? WHERE id = ?',
          )
          .run(current.amount, actual, current.quotaId)
      }
      appendEvent(store, {
        at: new Date(at).toISOString(),
        domain: 'billing',
        kind: 'billing.settle',
        actor: { kind: 'control-plane', id: 'budget' },
        subject: { kind: 'reservation', id: reservationId },
        audience: 'team',
        idem: `billing.settle:${reservationId}`,
        trace: { run: current.runId, workspace: current.workspaceId },
        payload: {
          reservationId,
          quotaId: current.quotaId,
          runId: current.runId,
          workspaceId: current.workspaceId,
          amount: current.amount,
          actual,
          // 正数 = 实际超出预留；负数 = 退回池子。
          delta: actual - current.amount,
        },
      })
    }

    const reservation = getReservation(store, reservationId)!
    const quota = getQuota(store, current.quotaId)
    if (quota !== null) maybeWriteCap(store, quota, at)
    return { reservation, quota, remaining: remainingOf(quota) }
  })
}

// ---- 用量 -------------------------------------------------------------------

/** 按 idem (`<turnId>:<source>`) 幂等；重放返回已有行且 deduped=true，不写第二条事件。 */
export function recordUsage(
  store: Store,
  input: RecordUsageInput,
): { row: UsageRow; deduped: boolean } {
  assertOpen(store)
  const req = asRecord(input, 'usage', 'INVALID_INPUT')
  const workspaceId = asNonEmptyString(req.workspaceId, 'usage.workspaceId')
  const turnId = asNonEmptyString(req.turnId, 'usage.turnId')
  const source = asNonEmptyString(req.source, 'usage.source')
  const idem = `${turnId}:${source}`
  const at = readAt(req.at)

  const existing = usageByIdem(store, idem)
  if (existing !== null) return { row: existing, deduped: true }

  const id = newRoostId('usg', at)
  const row: UsageRow = {
    id,
    at,
    workspaceId,
    runId: optionalString(req.runId, 'usage.runId'),
    turnId,
    botId: optionalString(req.botId, 'usage.botId'),
    model: optionalString(req.model, 'usage.model'),
    inputTokens: optionalCount(req.inputTokens, 'usage.inputTokens'),
    outputTokens: optionalCount(req.outputTokens, 'usage.outputTokens'),
    cachedTokens: optionalCount(req.cachedTokens, 'usage.cachedTokens'),
    toolCalls: optionalCount(req.toolCalls, 'usage.toolCalls'),
    costUsd: optionalCost(req.costUsd),
    source,
    idem,
  }

  try {
    store.db.exec('SAVEPOINT roost_record_usage')
    try {
      store.db
        .prepare(`INSERT INTO usage_rows (${USAGE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          row.id,
          row.at,
          row.workspaceId,
          row.runId,
          row.turnId,
          row.botId,
          row.model,
          row.inputTokens,
          row.outputTokens,
          row.cachedTokens,
          row.toolCalls,
          row.costUsd,
          row.source,
          row.idem,
        )
      appendEvent(store, {
        at: new Date(at).toISOString(),
        domain: 'billing',
        kind: 'billing.usage',
        actor: { kind: 'control-plane', id: 'billing' },
        subject: { kind: 'usage', id },
        audience: 'team',
        idem: `billing.usage:${idem}`,
        trace: traceFor(row),
        payload: {
          usageId: id,
          workspaceId,
          runId: row.runId,
          turnId,
          botId: row.botId,
          model: row.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cachedTokens: row.cachedTokens,
          toolCalls: row.toolCalls,
          costUsd: row.costUsd,
          source,
        },
      })
      store.db.exec('RELEASE roost_record_usage')
    } catch (err) {
      rollback(store, 'roost_record_usage')
      throw err
    }
  } catch (err) {
    // 并发同 idem：唯一约束兜底，回头读已有行按幂等返回。
    const again = usageByIdem(store, idem)
    if (again !== null) return { row: again, deduped: true }
    throw err instanceof StoreError
      ? err
      : new StoreError('INVALID_INPUT', `failed to record usage: ${errorMessage(err)}`, { cause: err })
  }

  return { row, deduped: false }
}

/** 聚合 [from, to) 的用量；tokens = input + output + cached。 */
export function sumUsage(
  store: Store,
  query: { workspaceId: string; from: number; to: number },
): UsageSummary {
  assertOpen(store)
  const req = asRecord(query, 'usage.query', 'INVALID_INPUT')
  const workspaceId = asNonEmptyString(req.workspaceId, 'usage.workspaceId')
  const from = asInteger(req.from, 'usage.from', 0)
  const to = asInteger(req.to, 'usage.to', 0)
  if (to < from) throw budgetError(BUDGET_ERROR_CODES.invalid, 'usage.to must be >= usage.from')

  const rows = store.db
    .prepare(`SELECT ${USAGE_COLUMNS} FROM usage_rows WHERE workspace_id = ? AND at >= ? AND at < ? ORDER BY at, id`)
    .all(workspaceId, from, to)
    .map(rowToUsage)

  const totals = emptyTotals()
  const bots = new Map<string, UsageGroup>()
  const models = new Map<string, UsageGroup>()
  for (const row of rows) {
    addToTotals(totals, row)
    addToGroup(bots, row.botId, row)
    addToGroup(models, row.model, row)
  }

  return { totals, byBot: sortGroups(bots), byModel: sortGroups(models) }
}

// ---- 软限 / 准入 ------------------------------------------------------------

/** used / limit；limit 为 0 时返回 0（无额度不等于已满，由 admissions 单独判定）。 */
export function quotaRatio(quota: Quota): number {
  if (quota.limitValue <= 0) return 0
  return quota.usedValue / quota.limitValue
}

export function isSoftLimitReached(quota: Quota): boolean {
  return quota.limitValue > 0 && quota.usedValue / quota.limitValue >= SOFT_LIMIT_RATIO
}

/**
 * 准入检查（budget.md §5）：该 workspace 的日 runs / tokens 配额是否已耗尽。
 * 只读，不推进周期；返回命中的配额，没有则 null。
 */
export function findExhaustedWorkspaceQuota(
  store: Store,
  workspaceId: string,
  at: number,
): Quota | null {
  assertOpen(store)
  const id = asNonEmptyString(workspaceId, 'workspaceId')
  const now = asInteger(at, 'at', 0)
  const rows = store.db
    .prepare(
      `SELECT ${QUOTA_COLUMNS} FROM quotas
        WHERE scope = 'workspace' AND scope_id = ? AND period = 'day'
          AND metric IN ('runs', 'tokens')
        ORDER BY metric, id`,
    )
    .all(id)
    .map(rowToQuota)
  for (const quota of rows) {
    // 已过重置点：本周期视作 0，不算耗尽（真正重置发生在下一次 reserve）。
    const rolled = quota.resetsAt !== null && now >= quota.resetsAt
    const used = rolled ? 0 : quota.usedValue
    const reserved = rolled ? 0 : quota.reserved
    if (used + reserved >= quota.limitValue) return quota
  }
  return null
}

/** 下一次 UTC 周期边界：日=次日 0 点，月=下月 1 号 0 点。 */
export function periodEnd(period: QuotaPeriod, at: number): number {
  if (period === 'day') return Math.floor(at / 86_400_000) * 86_400_000 + 86_400_000
  const date = new Date(at)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
}

// ---- 内部 --------------------------------------------------------------------

function resolveQuota(store: Store, req: Record<string, unknown>): Quota | null {
  if (req.quotaId !== undefined && req.quotaId !== null) {
    return getQuota(store, asNonEmptyString(req.quotaId, 'reserve.quotaId'))
  }
  const scope = readScope(req.scope ?? 'workspace')
  const scopeId = asNonEmptyString(req.scopeId, 'reserve.scopeId')
  const period = readPeriod(req.period ?? 'day')
  const metric = readMetric(req.metric)
  return findQuotaTuple(store, scope, scopeId, period, metric)
}

function findQuotaTuple(
  store: Store,
  scope: QuotaScope,
  scopeId: string,
  period: QuotaPeriod,
  metric: QuotaMetric,
): Quota | null {
  const row = store.db
    .prepare(
      `SELECT ${QUOTA_COLUMNS} FROM quotas WHERE scope = ? AND scope_id = ? AND period = ? AND metric = ?`,
    )
    .get(scope, scopeId, period, metric)
  return row === undefined || row === null ? null : rowToQuota(row)
}

/** now >= resets_at 时清零并推进周期；返回最新配额。 */
function refreshPeriod(store: Store, quota: Quota, at: number): Quota {
  if (quota.resetsAt === null) {
    store.db.prepare('UPDATE quotas SET resets_at = ? WHERE id = ?').run(periodEnd(quota.period, at), quota.id)
    return getQuota(store, quota.id)!
  }
  if (at < quota.resetsAt) return quota
  store.db
    .prepare('UPDATE quotas SET used_value = 0, reserved = 0, resets_at = ? WHERE id = ?')
    .run(periodEnd(quota.period, at), quota.id)
  return getQuota(store, quota.id)!
}

/** 80% 每周期只提醒一次；idem 用 resets_at 区分周期。 */
function maybeWriteCap(store: Store, quota: Quota, at: number): void {
  if (!isSoftLimitReached(quota)) return
  appendEvent(store, {
    at: new Date(at).toISOString(),
    domain: 'billing',
    kind: 'billing.cap',
    actor: { kind: 'control-plane', id: 'budget' },
    subject: { kind: 'quota', id: quota.id },
    audience: 'team',
    idem: `billing.cap:${quota.id}:${quota.resetsAt ?? 'none'}`,
    payload: {
      quotaId: quota.id,
      scope: quota.scope,
      scopeId: quota.scopeId,
      period: quota.period,
      metric: quota.metric,
      limitValue: quota.limitValue,
      usedValue: quota.usedValue,
      ratio: quotaRatio(quota),
      threshold: SOFT_LIMIT_RATIO,
      resetsAt: quota.resetsAt,
    },
  })
}

function remainingOf(quota: Quota | null): number | null {
  return quota === null ? null : quota.limitValue - quota.usedValue - quota.reserved
}

function usageByIdem(store: Store, idem: string): UsageRow | null {
  const row = store.db.prepare(`SELECT ${USAGE_COLUMNS} FROM usage_rows WHERE idem = ?`).get(idem)
  return row === undefined || row === null ? null : rowToUsage(row)
}

function traceFor(row: UsageRow): Record<string, unknown> {
  return {
    ...(row.runId === null ? {} : { run: row.runId }),
    ...(row.turnId === null ? {} : { turn: row.turnId }),
  }
}

function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, tokens: 0, toolCalls: 0, costUsd: 0, rows: 0 }
}

function addToTotals(totals: UsageTotals, row: UsageRow): void {
  totals.inputTokens += row.inputTokens ?? 0
  totals.outputTokens += row.outputTokens ?? 0
  totals.cachedTokens += row.cachedTokens ?? 0
  totals.tokens += (row.inputTokens ?? 0) + (row.outputTokens ?? 0) + (row.cachedTokens ?? 0)
  totals.toolCalls += row.toolCalls ?? 0
  totals.costUsd += row.costUsd ?? 0
  totals.rows += 1
}

function addToGroup(groups: Map<string, UsageGroup>, key: string | null, row: UsageRow): void {
  const mapKey = key ?? '__null__'
  let group = groups.get(mapKey)
  if (group === undefined) {
    group = { key, ...emptyTotals() }
    groups.set(mapKey, group)
  }
  addToTotals(group, row)
}

function sortGroups(groups: Map<string, UsageGroup>): UsageGroup[] {
  return [...groups.values()].sort((a, b) => b.tokens - a.tokens || String(a.key).localeCompare(String(b.key)))
}

function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new StoreError('INVALID_INPUT', `${label} must be a string when present`)
  const text = value.trim()
  return text === '' ? null : text
}

function optionalCount(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null
  return asInteger(value, label, 0)
}

function optionalCost(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new StoreError('INVALID_INPUT', 'usage.costUsd must be a non-negative number when present')
  }
  return value
}

function readAt(value: unknown): number {
  return value === undefined || value === null ? Date.now() : asInteger(value, 'at', 0)
}

function readScope(value: unknown): QuotaScope {
  if (typeof value === 'string' && (QUOTA_SCOPES as readonly string[]).includes(value)) {
    return value as QuotaScope
  }
  throw new StoreError('INVALID_INPUT', `quota.scope must be one of ${QUOTA_SCOPES.join(', ')}`)
}

function readPeriod(value: unknown): QuotaPeriod {
  if (typeof value === 'string' && (QUOTA_PERIODS as readonly string[]).includes(value)) {
    return value as QuotaPeriod
  }
  throw new StoreError('INVALID_INPUT', `quota.period must be one of ${QUOTA_PERIODS.join(', ')}`)
}

function readMetric(value: unknown): QuotaMetric {
  if (typeof value === 'string' && (QUOTA_METRICS as readonly string[]).includes(value)) {
    return value as QuotaMetric
  }
  throw new StoreError('INVALID_INPUT', `quota.metric must be one of ${QUOTA_METRICS.join(', ')}`)
}

function budgetError(code: string, detail: string, kind: 'INVALID_INPUT' | 'FORBIDDEN' = 'INVALID_INPUT'): StoreError {
  return new StoreError(kind, `${code}: ${detail}`)
}

function rowToQuota(row: unknown): Quota {
  const r = row as QuotaRow
  return {
    id: r.id,
    scope: r.scope as QuotaScope,
    scopeId: r.scope_id,
    period: r.period as QuotaPeriod,
    metric: r.metric as QuotaMetric,
    limitValue: toNumber(r.limit_value),
    usedValue: toNumber(r.used_value),
    reserved: toNumber(r.reserved),
    resetsAt: r.resets_at === null ? null : toNumber(r.resets_at),
  }
}

function rowToReservation(row: unknown): Reservation {
  const r = row as ReservationRow
  return {
    id: r.id,
    runId: r.run_id,
    workspaceId: r.workspace_id,
    quotaId: r.quota_id,
    metric: r.metric,
    amount: toNumber(r.amount),
    createdAt: toNumber(r.created_at),
    settledAt: r.settled_at === null ? null : toNumber(r.settled_at),
    actual: r.actual === null ? null : toNumber(r.actual),
  }
}

function rowToUsage(row: unknown): UsageRow {
  const r = row as UsageRowRow
  return {
    id: r.id,
    at: toNumber(r.at),
    workspaceId: r.workspace_id,
    runId: r.run_id,
    turnId: r.turn_id,
    botId: r.bot_id,
    model: r.model,
    inputTokens: r.input_tokens === null ? null : toNumber(r.input_tokens),
    outputTokens: r.output_tokens === null ? null : toNumber(r.output_tokens),
    cachedTokens: r.cached_tokens === null ? null : toNumber(r.cached_tokens),
    toolCalls: r.tool_calls === null ? null : toNumber(r.tool_calls),
    costUsd: r.cost_usd,
    source: r.source,
    idem: r.idem,
  }
}

function rollback(store: Store, savepoint: string): void {
  try {
    store.db.exec(`ROLLBACK TO ${savepoint}`)
    store.db.exec(`RELEASE ${savepoint}`)
  } catch {
    // 外层事务可能已经把 savepoint 一起回滚；保留原始错误。
  }
}

function withSavepoint<T>(store: Store, name: string, fn: () => T): T {
  store.db.exec(`SAVEPOINT ${name}`)
  try {
    const result = fn()
    store.db.exec(`RELEASE ${name}`)
    return result
  } catch (err) {
    rollback(store, name)
    throw err
  }
}
