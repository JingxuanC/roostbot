// 告警规则与冷却去重（M6-6.8）。
//
// 输入是某一时刻的指标/健康快照，输出本次真正该发的告警。规则是纯判断函数，
// 冷却状态单独存放（默认进程内 Map，测试可注入），这样同一份快照重复求值
// 不会刷屏，而规则本身仍然可测、可替换。
//
// 默认规则对应 docs/design/observability.md §6 与 slo.md §3 的四类异常：
// sandbox 错误、预算超限、投递失败、健康降级。

import type { HealthStatus } from './health.ts'

export type AlertSeverity = 'info' | 'warning' | 'critical'

export interface Alert {
  /** 规则 id，例如 sandbox_error。 */
  rule: string
  severity: AlertSeverity
  detail: string
  /** 触发时刻（ISO date-time）。 */
  at: string
}

/** 指标/健康快照。字段可按 rule 需要扩展；嵌套 counters/gauges/metrics 也支持。 */
export interface AlertSnapshot {
  [key: string]: unknown
}

export interface AlertRule {
  id: string
  severity: AlertSeverity
  /** 返回 true 表示该规则命中。抛错视为不命中，避免一条坏规则阻断其余告警。 */
  match: (snapshot: AlertSnapshot) => boolean
  /** 命中时的说明；缺省用规则 id。 */
  detail?: (snapshot: AlertSnapshot) => string
}

export interface AlertEvaluationOptions {
  snapshot: AlertSnapshot
  rules?: readonly AlertRule[]
  /** 当前时刻：epoch 毫秒、Date 或返回毫秒的函数。 */
  now?: number | Date | (() => number)
  /** 冷却窗口；默认 5 分钟。 */
  cooldownMs?: number
  /** 注入冷却状态：rule id → 上次触发时刻（毫秒）。 */
  state?: Map<string, number>
}

export const DEFAULT_ALERT_COOLDOWN_MS = 5 * 60_000

const NESTED_CONTAINERS = ['counters', 'gauges', 'metrics', 'values'] as const

function nowMs(now: number | Date | (() => number) | undefined): number {
  if (typeof now === 'function') {
    const value = now()
    return Number.isFinite(value) ? value : Date.now()
  }
  if (now instanceof Date) {
    const value = now.getTime()
    return Number.isFinite(value) ? value : Date.now()
  }
  if (typeof now === 'number' && Number.isFinite(now)) return now
  return Date.now()
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/** 先查顶层键，再查 counters/gauges/metrics/values；点号键支持一层嵌套。 */
function pick(snapshot: AlertSnapshot, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
      const value = snapshot[key]
      if (value !== undefined) return value
    }
    const dot = key.indexOf('.')
    if (dot > 0) {
      const head = snapshot[key.slice(0, dot)]
      if (typeof head === 'object' && head !== null) {
        const value = (head as Record<string, unknown>)[key.slice(dot + 1)]
        if (value !== undefined) return value
      }
    }
  }
  for (const container of NESTED_CONTAINERS) {
    const box = snapshot[container]
    if (typeof box !== 'object' || box === null) continue
    const record = box as Record<string, unknown>
    for (const key of keys) {
      if (record[key] !== undefined) return record[key]
    }
  }
  return undefined
}

function countOf(snapshot: AlertSnapshot, keys: readonly string[]): number {
  return numeric(pick(snapshot, keys)) ?? 0
}

function isTruthy(snapshot: AlertSnapshot, keys: readonly string[]): boolean {
  const value = pick(snapshot, keys)
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value !== '' && value !== '0' && value !== 'false'
  const number = numeric(value)
  return number !== null && number > 0
}

const SANDBOX_KEYS = [
  'sandbox_error',
  'sandboxError',
  'sandboxErrors',
  'sandbox_errors',
  'sandbox_errors_total',
  'roost_sandbox_errors_total',
  'sandbox.error'
] as const

const BUDGET_KEYS = [
  'budget_exceeded',
  'budgetExceeded',
  'budget_exceeded_total',
  'roost_budget_exceeded_total',
  'budget.exceeded',
  'budget.cap'
] as const

const DELIVERY_KEYS = [
  'delivery_failed',
  'deliveryFailed',
  'delivery_failures',
  'delivery_failures_total',
  'roost_delivery_failures_total',
  'delivery.failed'
] as const

const HEALTH_KEYS = [
  'health',
  'healthStatus',
  'health_status',
  'health_degraded',
  'healthDegraded',
  'status'
] as const

/** 从快照里读健康状态；字符串、{status} 或 health_degraded 计数都接受。 */
export function healthStatusFromSnapshot(snapshot: AlertSnapshot): HealthStatus | null {
  const raw = pick(snapshot, HEALTH_KEYS)
  const direct = typeof raw === 'string' ? raw.trim().toLowerCase() : null
  if (direct !== null && direct !== '') {
    if (direct === 'ok' || direct === 'up' || direct === 'healthy') return 'ok'
    if (direct === 'down' || direct === 'failed' || direct === 'error') return 'down'
    return 'degraded'
  }
  if (typeof raw === 'object' && raw !== null) {
    const nested = (raw as Record<string, unknown>)['status']
    if (typeof nested === 'string') {
      const status = nested.trim().toLowerCase()
      if (status === 'ok' || status === 'up' || status === 'healthy') return 'ok'
      if (status === 'down' || status === 'failed' || status === 'error') return 'down'
      return 'degraded'
    }
  }
  if (isTruthy(snapshot, ['health_degraded', 'healthDegraded'])) return 'degraded'
  return null
}

/**
 * 默认规则。severity 取舍：
 * - sandbox_error / health_degraded 会直接影响执行与可用性 → critical；
 * - budget_exceeded / delivery_failed 先降级但服务还在 → warning。
 */
export const DEFAULT_ALERT_RULES: readonly AlertRule[] = [
  {
    id: 'sandbox_error',
    severity: 'critical',
    match: (snapshot) => countOf(snapshot, SANDBOX_KEYS) > 0,
    detail: (snapshot) => `sandbox 错误计数 ${countOf(snapshot, SANDBOX_KEYS)}（阈值 > 0）`
  },
  {
    id: 'budget_exceeded',
    severity: 'warning',
    match: (snapshot) => countOf(snapshot, BUDGET_KEYS) > 0 || isTruthy(snapshot, ['budget.exceeded', 'budget.cap']),
    detail: (snapshot) => `预算超限计数 ${countOf(snapshot, BUDGET_KEYS)}（阈值 > 0）`
  },
  {
    id: 'delivery_failed',
    severity: 'warning',
    match: (snapshot) => countOf(snapshot, DELIVERY_KEYS) > 0,
    detail: (snapshot) => `投递失败计数 ${countOf(snapshot, DELIVERY_KEYS)}（阈值 > 0）`
  },
  {
    id: 'health_degraded',
    severity: 'critical',
    match: (snapshot) => {
      const status = healthStatusFromSnapshot(snapshot)
      return status !== null && status !== 'ok'
    },
    detail: (snapshot) => {
      const status = healthStatusFromSnapshot(snapshot)
      return `健康状态 ${status ?? 'unknown'}（期望 ok）`
    }
  }
]

/** 测试/多实例场景用的独立冷却状态。 */
export function createAlertState(): Map<string, number> {
  return new Map<string, number>()
}

// 默认状态属于进程：同一个 server 里重复求值才会真正去重。
const defaultState = createAlertState()

/**
 * 求值。按 rules 顺序返回本次应发的告警；冷却窗口内的重复触发被丢弃。
 * 命中才写 state，因此被冷却压住的触发不会延长冷却。
 */
export function evaluateAlerts(options: AlertEvaluationOptions): Alert[] {
  const {
    snapshot,
    rules = DEFAULT_ALERT_RULES,
    now,
    cooldownMs = DEFAULT_ALERT_COOLDOWN_MS,
    state = defaultState
  } = options
  const at = nowMs(now)
  const windowMs = Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : 0
  const alerts: Alert[] = []

  for (const rule of rules) {
    let fired = false
    try {
      fired = rule.match(snapshot) === true
    } catch {
      fired = false
    }
    if (!fired) continue

    const last = state.get(rule.id)
    if (last !== undefined && at - last < windowMs) continue
    state.set(rule.id, at)

    let detail = rule.id
    if (rule.detail !== undefined) {
      try {
        detail = rule.detail(snapshot)
      } catch {
        detail = rule.id
      }
    }
    alerts.push({ rule: rule.id, severity: rule.severity, detail, at: new Date(at).toISOString() })
  }

  return alerts
}
