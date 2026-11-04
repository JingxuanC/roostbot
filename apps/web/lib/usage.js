// 用量页的纯逻辑：时间范围、用量汇总归一化、格式化、配额进度与降级判定。
//
// 数据来自（docs/design/budget.md §8–§10、apps/api/src/budget-routes.ts）：
//   GET /api/usage?workspaceId=&from=&to=  → { totals, byBot, byModel }
//   GET /api/quotas?workspaceId=           → { quotas: [...] }
// 这里不发请求、不碰 DOM；视图只负责把模型渲染成 textContent。
//
// 时间范围按「本地时区自然日」计算：今天 = 本地 0 点到明天 0 点，
// 近 7/30 天 = 含今天在内的 7/30 个自然日。用 Date(y, m, d ± n) 而不是固定 86400000，
// 这样跨月、跨年、夏令时切换都由运行时按本地时区处理。

const RANGE_OPTIONS = [
  { value: 'today', label: '今天', days: 1 },
  { value: 'last7', label: '近 7 天', days: 7 },
  { value: 'last30', label: '近 30 天', days: 30 },
]

export const USAGE_RANGES = RANGE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))
export const DEFAULT_USAGE_RANGE = 'last7'

export const QUOTA_WARN_RATIO = 0.8
export const QUOTA_DANGER_RATIO = 1

const METRIC_LABELS = {
  tokens: '模型 token',
  runs: 'Run 数',
  container_seconds: '容器秒',
  storage_bytes: '存储',
  messages: '消息数',
}

const PERIOD_LABELS = {
  day: '每日',
  month: '每月',
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function asCount(value) {
  return Math.max(0, Math.trunc(asNumber(value)))
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string' && value.trim() !== '') {
    const asNumberValue = Number(value)
    if (Number.isFinite(asNumberValue)) return asNumberValue
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Number.NaN
}

// ---- 时间范围 --------------------------------------------------------------

/**
 * 时间范围 → {value, label, from, to}（epoch ms，本地自然日边界）。
 * 未知 value 退回默认的「近 7 天」；坏 now 退回当前时间。
 */
export function usageRange(value, now = Date.now()) {
  const requested = asText(value)
  const option =
    RANGE_OPTIONS.find((item) => item.value === requested) ||
    RANGE_OPTIONS.find((item) => item.value === DEFAULT_USAGE_RANGE)
  const ms = Number.isFinite(now) ? now : Date.now()
  const base = new Date(ms)
  const year = base.getFullYear()
  const month = base.getMonth()
  const day = base.getDate()
  const from = new Date(year, month, day - (option.days - 1))
  const to = new Date(year, month, day + 1)
  return { value: option.value, label: option.label, from: from.getTime(), to: to.getTime() }
}

// ---- 格式化 ----------------------------------------------------------------

function groupThousands(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** token / 次数：整数 + 千分位；坏值按 0。 */
export function formatTokens(value) {
  return groupThousands(asCount(value))
}

/** 成本：0 显示 $0；小于 1 美分保留 4 位，其余 2 位；整千分位。 */
export function formatCost(value) {
  const amount = asNumber(value)
  if (!(amount > 0)) return '$0'
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  const [whole, fraction] = amount.toFixed(2).split('.')
  return `$${groupThousands(whole)}.${fraction}`
}

/** 字节按 SI 单位（1000 进制）展示，避免配额里出现 10737418240 这种长数字。 */
export function formatBytes(value) {
  const bytes = asCount(value)
  if (bytes < 1000) return `${groupThousands(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let size = bytes
  let unit = -1
  while (size >= 1000 && unit < units.length - 1) {
    size /= 1000
    unit += 1
  }
  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2
  return `${size.toFixed(digits)} ${units[unit]}`
}

/** 配额值按 metric 补单位；token / Run / 消息直接用千分位。 */
export function formatMetricValue(metric, value) {
  const name = asText(metric)
  if (name === 'storage_bytes') return formatBytes(value)
  if (name === 'container_seconds') return `${formatTokens(value)} 秒`
  return formatTokens(value)
}

/** metric 中文名；未知 metric 原样显示，空值给中性文案。 */
export function metricLabel(metric) {
  const value = asText(metric)
  if (value === '') return '未知指标'
  return METRIC_LABELS[value] || value
}

/** period 中文名；未知周期原样显示。 */
export function periodLabel(period) {
  const value = asText(period)
  if (value === '') return '未知周期'
  return PERIOD_LABELS[value] || value
}

/** 重置时间：本地时区 yyyy-mm-dd hh:mm；缺失/坏值不拿当前时间冒充。 */
export function resetTimeLabel(value) {
  const ms = toMs(value)
  if (!Number.isFinite(ms) || ms <= 0) return '重置时间未知'
  const date = new Date(ms)
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// ---- 用量汇总 --------------------------------------------------------------

function totalsOf(row) {
  const value = plainObject(row) || {}
  const inputTokens = asCount(value.inputTokens)
  const outputTokens = asCount(value.outputTokens)
  const cachedTokens = asCount(value.cachedTokens)
  const reportedTokens = asCount(value.tokens)
  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    tokens: reportedTokens > 0 ? reportedTokens : inputTokens + outputTokens + cachedTokens,
    toolCalls: asCount(value.toolCalls),
    costUsd: Math.max(0, asNumber(value.costUsd)),
    rows: asCount(value.rows),
  }
}

function groupsOf(list, keyName) {
  return (Array.isArray(list) ? list : [])
    .filter(plainObject)
    .map((row) => {
      const totals = totalsOf(row)
      // 后端 store 的 UsageGroup 用 key；任务契约写的是 botId / model。两种都认。
      const key = asText(row[keyName]) || asText(row.key)
      return { key, ...totals }
    })
}

/** 把 GET /api/usage 的响应归一化成 {totals, byBot, byModel}，坏值按 0。 */
export function usageSummary(data) {
  const body = plainObject(data) || {}
  return {
    totals: totalsOf(body.totals),
    byBot: groupsOf(body.byBot, 'botId'),
    byModel: groupsOf(body.byModel, 'model'),
  }
}

/** 选定区间是否完全没有用量（token / 工具调用 / 成本都为 0）。 */
export function isUsageEmpty(summary) {
  const totals = plainObject(summary) ? plainObject(summary.totals) || {} : {}
  return (
    asCount(totals.tokens) === 0 &&
    asCount(totals.toolCalls) === 0 &&
    !(asNumber(totals.costUsd) > 0)
  )
}

// ---- 配额 ------------------------------------------------------------------

/** 使用率：优先由 used/limit 计算；limit 非正时退回服务端 ratio。 */
export function quotaRatio(quota) {
  const row = plainObject(quota) || {}
  const limit = asNumber(row.limitValue)
  if (limit > 0) return Math.max(0, asNumber(row.usedValue) / limit)
  return Math.max(0, asNumber(row.ratio))
}

/** 使用率分级：>=80% 警示，>=100% 危险；其余正常。 */
export function quotaLevel(ratio) {
  const value = asNumber(ratio)
  if (value >= QUOTA_DANGER_RATIO) return { kind: 'danger', label: '已耗尽' }
  if (value >= QUOTA_WARN_RATIO) return { kind: 'warn', label: '接近上限' }
  return { kind: '', label: '' }
}

/**
 * 配额卡片模型：中文 metric/period、已用/上限、reserved、重置时间、
 * 原始比例、展示百分比与进度条宽度（裁到 0–100）。
 */
export function quotaRows(quotas) {
  return (Array.isArray(quotas) ? quotas : []).filter(plainObject).map((quota) => {
    const metric = asText(quota.metric)
    const ratio = quotaRatio(quota)
    const level = quotaLevel(ratio)
    const percent = Math.round(ratio * 100)
    return {
      id: asText(quota.id),
      metric,
      metricLabel: metricLabel(metric),
      period: asText(quota.period),
      periodLabel: periodLabel(quota.period),
      usedValue: asCount(quota.usedValue),
      limitValue: asCount(quota.limitValue),
      usedLabel: formatMetricValue(metric, quota.usedValue),
      limitLabel: formatMetricValue(metric, quota.limitValue),
      reserved: asCount(quota.reserved),
      reservedLabel: formatMetricValue(metric, quota.reserved),
      ratio,
      percent,
      percentLabel: `${percent}%`,
      barPercent: Math.max(0, Math.min(100, percent)),
      levelKind: level.kind,
      levelLabel: level.label,
      resetsAt: quota.resetsAt,
      resetLabel: resetTimeLabel(quota.resetsAt),
    }
  })
}

// ---- 降级判定 --------------------------------------------------------------

/** 403 / forbidden：当前账号没有查看用量的角色。 */
export function isUsageForbidden(error) {
  const row = plainObject(error)
  if (!row) return false
  return row.status === 403 || asText(row.code) === 'forbidden'
}

/** 404 路由缺失 / 405 / 501 / 503：接口还没就绪，界面不假装有数据。 */
export function isUsageNotReady(error) {
  const row = plainObject(error)
  if (!row) return false
  return row.status === 404 || row.status === 405 || row.status === 501 || row.status === 503
}
