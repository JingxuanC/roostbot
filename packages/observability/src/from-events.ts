// 事件 → 指标：把事件日志投影成 Prometheus 可用的点（M6-6.6）。
//
// 事件是事实源，指标只是投影（docs/design/events.md §7）。这里保持纯函数：
// 不读 DB、不看时钟、不做聚合，只把一条事件翻译成 0..N 个指标点，
// 由调用方交给 metrics registry。
//
// 覆盖 run.* / assignment.* / sandbox.* / budget.* / message.* / delivery.*；
// 同时接受事件信封里的新 kind（schedule.run.*、billing.*、chat.message）。
// 未知 kind 返回 []，绝不抛错 —— 指标管道不能因为一条脏事件停摆。
//
// 标签基数：只允许 kind（族）/status（状态）/workspace 三个键。
// kind/status 是有限集合；workspace 是用户可控 id，做长度截断，避免打爆标签。

export type MetricKind = 'counter' | 'gauge' | 'histogram'

export interface MetricPoint {
  name: string
  kind: MetricKind
  value: number
  /** 只包含低基数键：kind / status / workspace。 */
  labels: Record<string, string>
}

/** 兼容事件信封与旧扁平日志；unknown 字段原样忽略。 */
export interface MetricEvent {
  kind?: string
  domain?: string
  payload?: Record<string, unknown> | null
  [key: string]: unknown
}

type EventFamily = 'run' | 'assignment' | 'sandbox' | 'budget' | 'message' | 'delivery'

interface FamilyMatch {
  family: EventFamily
  /** kind 的后缀，或事件自带的 outcome/status。 */
  status: string
}

const FAMILY_BASE: Record<EventFamily, string> = {
  run: 'roost_runs',
  assignment: 'roost_assignments',
  sandbox: 'roost_sandbox_events',
  budget: 'roost_budget_events',
  message: 'roost_messages',
  delivery: 'roost_deliveries'
}

/** 事件的秒级耗时直方图；没有合适语义的族不产出。 */
const DURATION_METRIC: Partial<Record<EventFamily, string>> = {
  run: 'roost_run_duration_seconds',
  assignment: 'roost_assignment_duration_seconds',
  delivery: 'roost_delivery_duration_seconds'
}

const FAILED_STATUSES = new Set(['failed', 'failure', 'error', 'timeout', 'timedout', 'denied', 'undelivered'])
const BUDGET_EXCEEDED_STATUSES = new Set(['exceeded', 'cap', 'blocked', 'over', 'hard_limit'])
const DELIVERY_FAILED_STATUSES = new Set(['failed', 'failure', 'error', 'undelivered', 'timeout', 'dropped'])
const SANDBOX_ERROR_STATUSES = new Set(['denied', 'failed', 'failure', 'error', 'timeout'])

const MAX_LABEL_CHARS = 200

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function payloadOf(event: MetricEvent): Record<string, unknown> {
  const payload = event.payload
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload : {}
}

/** `schedule.run.started` / `run.started` 都归到 run 族。 */
function matchFamily(kind: string): FamilyMatch | null {
  if (kind === 'chat.message') return { family: 'message', status: 'message' }

  const scheduleRun = /^schedule\.run\.([a-z0-9_]+)$/.exec(kind)
  if (scheduleRun !== null) return { family: 'run', status: scheduleRun[1]! }

  const run = /^run\.([a-z0-9_]+)$/.exec(kind)
  if (run !== null) return { family: 'run', status: run[1]! }

  for (const family of ['assignment', 'sandbox', 'budget', 'message', 'delivery'] as const) {
    const match = new RegExp(`^${family}\\.([a-z0-9_]+)$`).exec(kind)
    if (match !== null) return { family, status: match[1]! }
  }

  // 事件信封的 billing 域就是预算域的权威写入方。
  const billing = /^billing\.([a-z0-9_]+)$/.exec(kind)
  if (billing !== null) return { family: 'budget', status: billing[1]! }

  return null
}

function normalizeStatus(raw: string): string {
  const status = raw.trim().toLowerCase()
  switch (status) {
    case 'completed':
    case 'complete':
    case 'succeeded':
    case 'success':
    case 'done':
      return 'done'
    case 'failure':
    case 'error':
    case 'timedout':
    case 'timeout':
      return 'failed'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    default:
      return status === '' ? 'unknown' : status
  }
}

/** payload 的 outcome/status 是业务状态，优先于 kind 后缀。 */
function resolveStatus(fallback: string, payload: Record<string, unknown>, family: EventFamily): string {
  if (family === 'message') {
    const role = readString(payload.role)
    if (role !== null) return normalizeStatus(role)
  }
  const outcome = readString(payload.outcome)
  if (outcome !== null) return normalizeStatus(outcome)
  const status = readString(payload.status)
  if (status !== null) return normalizeStatus(status)
  if (payload.ok === false) return 'failed'
  return normalizeStatus(fallback)
}

function labelsFor(event: MetricEvent, family: EventFamily, status: string): Record<string, string> {
  const labels: Record<string, string> = { kind: family, status: status.slice(0, MAX_LABEL_CHARS) }
  const payload = payloadOf(event)
  const workspace = readString(payload['workspaceId']) ?? readString(event['workspaceId'])
  if (workspace !== null) labels.workspace = workspace.slice(0, MAX_LABEL_CHARS)
  return labels
}

function durationSeconds(payload: Record<string, unknown>): number | null {
  const ms = readNumber(payload['durationMs']) ?? readNumber(payload['duration_ms'])
  if (ms === null || ms < 0) return null
  return ms / 1000
}

/** 预算用量事件里的数量字段；没有就退化成 1 次事件。 */
function budgetUnits(payload: Record<string, unknown>): number | null {
  for (const key of ['amount', 'units', 'cost', 'tokens', 'value']) {
    const value = readNumber(payload[key])
    if (value !== null && value >= 0) return value
  }
  return null
}

/**
 * 一条事件 → 指标点。纯函数；未知/非法事件返回 []。
 *
 * 每个已知事件至少产出一个 `<族>_total` counter；耗时、沙箱错误、预算超限、
 * 投递失败再额外产出专用指标，便于告警规则直接按名字取数。
 */
export function metricsFromEvent(event: MetricEvent | null | undefined): MetricPoint[] {
  if (typeof event !== 'object' || event === null) return []
  const kind = readString(event.kind)
  if (kind === null) return []
  const match = matchFamily(kind.toLowerCase())
  if (match === null) return []

  const payload = payloadOf(event)
  const status = resolveStatus(match.status, payload, match.family)
  const labels = labelsFor(event, match.family, status)
  const points: MetricPoint[] = [
    {
      name: `${FAMILY_BASE[match.family]}_total`,
      kind: 'counter',
      value: 1,
      labels: { ...labels }
    }
  ]

  const durationMetric = DURATION_METRIC[match.family]
  if (durationMetric !== undefined) {
    const seconds = durationSeconds(payload)
    if (seconds !== null) {
      points.push({ name: durationMetric, kind: 'histogram', value: seconds, labels: { ...labels } })
    }
  }

  if (match.family === 'sandbox' && (SANDBOX_ERROR_STATUSES.has(status) || payload['ok'] === false)) {
    points.push({ name: 'roost_sandbox_errors_total', kind: 'counter', value: 1, labels: { ...labels } })
  }

  if (match.family === 'budget') {
    if (BUDGET_EXCEEDED_STATUSES.has(status) || payload['exceeded'] === true) {
      points.push({ name: 'roost_budget_exceeded_total', kind: 'counter', value: 1, labels: { ...labels } })
    }
    const units = budgetUnits(payload)
    if (units !== null) {
      const metric = readString(payload['metric']) ?? readString(payload['unit']) ?? 'units'
      points.push({
        name: 'roost_budget_units_total',
        kind: 'counter',
        value: units,
        labels: { ...labels, status: metric.slice(0, MAX_LABEL_CHARS) }
      })
    }
  }

  if (match.family === 'delivery' && DELIVERY_FAILED_STATUSES.has(status)) {
    points.push({ name: 'roost_delivery_failures_total', kind: 'counter', value: 1, labels: { ...labels } })
  }

  if (match.family === 'run' && FAILED_STATUSES.has(status)) {
    points.push({ name: 'roost_run_failures_total', kind: 'counter', value: 1, labels: { ...labels } })
  }

  return points
}
