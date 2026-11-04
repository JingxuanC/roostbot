// 定时任务页的纯逻辑：表达式形态、表单校验、时间与运行状态文案、错误降级判定。
//
// 数据契约（apps/api/src/schedules-routes.ts）：
//   GET    /api/workspaces/:id/schedules → { schedules: [...] }
//   POST   /api/workspaces/:id/schedules { botId, routineId, cron, timezone, catchUpMs?, overlap? }
//   PATCH  /api/schedules/:id            { cron?, timezone?, enabled?, catchUpMs?, overlap? }
//   DELETE /api/schedules/:id
//   POST   /api/schedules/:id/run         → { run }
//   GET    /api/runs?workspaceId=&limit=  → { runs: [...] }
//   POST   /api/runs/:id/stop             → { run }
// 这里不发请求、不碰 DOM；视图只负责把模型渲染成 textContent。

export const CATCH_UP_DEFAULT_HOURS = 12
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

export const OVERLAP_OPTIONS = [
  { value: 'queue', label: '排队', description: '上一轮没结束时等它结束，再跑这一次' },
  { value: 'skip', label: '跳过', description: '重叠时丢弃这一次，并留一条 skipped 记录' },
]

const EXPRESSION_EXAMPLES = [
  { value: '0 9 * * *', label: 'cron · 每天 9:00' },
  { value: 'daily 09:00', label: 'daily 09:00' },
  { value: 'weekly mon,wed 09:00', label: 'weekly mon,wed 09:00' },
  { value: 'every 3600', label: 'every 3600（秒）' },
]

const RUN_STATUS_LABELS = {
  queued: '排队中',
  running: '运行中',
  waiting: '等待中',
  completed: '已完成',
  failed: '失败',
  missed: '已错过',
  skipped: '已跳过',
}

const RUN_STATUS_KINDS = {
  queued: 'accent',
  running: 'accent',
  waiting: 'warn',
  completed: 'ok',
  failed: 'danger',
  missed: 'warn',
  skipped: '',
}

const RUN_OUTCOME_LABELS = {
  done: '完成',
  needs_input: '等待输入',
  budget: '预算耗尽',
  stalled: '停滞',
  interrupted: '中断',
  provider_error: '服务商错误',
  denied: '拒绝',
  expired: '过期',
  stopped: '已停止',
  missed: '错过',
  refused: '拒绝执行',
  duplicate: '重复跳过',
}

const OVERLAP_LABELS = { queue: '排队', skip: '跳过' }

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
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

// ---- 表达式 -----------------------------------------------------------------

/** 示例文案；视图用按钮把 value 填进表达式输入框。 */
export function expressionExamples() {
  return EXPRESSION_EXAMPLES.map((item) => ({ ...item }))
}

/**
 * 表达式形态：cron（5 段）/ daily / weekly / every / empty / unknown。
 * 只判断结构，具体字段合法性交给 validateScheduleForm 与服务端。
 */
export function expressionForm(expression) {
  const text = asText(expression).toLowerCase()
  if (text === '') return 'empty'
  if (/^every(\s|$)/.test(text)) return 'every'
  if (/^daily\s+\S+$/.test(text)) return 'daily'
  if (/^weekly\s+\S+\s+\S+$/.test(text)) return 'weekly'
  if (text.split(/\s+/).length === 5) return 'cron'
  return 'unknown'
}

function clockValid(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (match === null) return false
  return Number(match[1]) <= 23 && Number(match[2]) <= 59
}

function weekdayValid(text) {
  const lowered = text.toLowerCase()
  if (/^\d+$/.test(lowered)) {
    const value = Number(lowered)
    return value >= 0 && value <= 7
  }
  return WEEKDAYS.includes(lowered)
}

function expressionShapeError(form, expression) {
  const text = expression.toLowerCase()
  if (form === 'every') {
    const match = /^every\s+(\d+)$/.exec(text)
    if (match === null) return 'every 需要正整数秒数'
    if (Number(match[1]) < 1) return 'every 秒数必须 ≥ 1'
    return ''
  }
  if (form === 'daily') {
    const match = /^daily\s+(\S+)$/.exec(text)
    if (match === null || !clockValid(match[1])) return 'daily 时间需要 HH:MM'
    return ''
  }
  if (form === 'weekly') {
    const match = /^weekly\s+(\S+)\s+(\S+)$/.exec(text)
    if (match === null) return 'weekly 需要「星期 时间」'
    if (!match[1].split(',').every((day) => day !== '' && weekdayValid(day))) {
      return 'weekly 的星期需要 mon…sun 或 0–7'
    }
    if (!clockValid(match[2])) return 'weekly 时间需要 HH:MM'
    return ''
  }
  return ''
}

// ---- 表单 -------------------------------------------------------------------

function fail(field, message) {
  return { ok: false, field, message, errors: { [field]: message } }
}

/**
 * 校验并归一化新建表单。
 * @param {{botId?: unknown, routineId?: unknown, expression?: unknown, timezone?: unknown,
 *   catchUpHours?: unknown, overlap?: unknown}} input
 * @returns {{ok:true, payload: object} | {ok:false, field:string, message:string, errors:object}}
 */
export function validateScheduleForm(input = {}) {
  const row = plainObject(input) || {}
  const botId = asText(row.botId)
  if (botId === '') return fail('botId', '请选择 Bot')

  const routineId = asText(row.routineId)
  if (routineId === '') return fail('routineId', 'routineId 不能为空')
  if (routineId.length > 200) return fail('routineId', 'routineId 最长 200 个字符')

  const expression = asText(row.expression)
  if (expression === '') return fail('expression', '表达式不能为空')
  const form = expressionForm(expression)
  if (form === 'unknown') {
    return fail('expression', '表达式需要是 5 段 cron、daily HH:MM、weekly 星期 HH:MM 或 every 秒数')
  }
  const shapeError = expressionShapeError(form, expression)
  if (shapeError !== '') return fail('expression', shapeError)

  const timezone = asText(row.timezone)
  if (timezone === '') return fail('timezone', '时区不能为空')

  const rawHours = row.catchUpHours
  const hoursText = typeof rawHours === 'string' ? rawHours.trim() : rawHours
  const hours = hoursText === '' || hoursText === undefined || hoursText === null ? CATCH_UP_DEFAULT_HOURS : Number(hoursText)
  if (!Number.isFinite(hours) || hours < 0) {
    return fail('catchUpHours', '追赶窗口需要 ≥ 0 的小时数')
  }
  const catchUpMs = Math.round(hours * HOUR_MS)
  if (!Number.isSafeInteger(catchUpMs)) {
    return fail('catchUpHours', '追赶窗口太大')
  }

  const overlap = asText(row.overlap) || 'queue'
  if (overlap !== 'queue' && overlap !== 'skip') {
    return fail('overlap', '重叠策略只能是 queue 或 skip')
  }

  return {
    ok: true,
    payload: {
      botId,
      routineId,
      cron: asText(expression),
      timezone,
      catchUpMs,
      overlap,
    },
  }
}

/** 浏览器时区；拿不到时回 UTC，保证表单总有合法默认值。 */
export function browserTimeZone() {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone !== '' ? zone : 'UTC'
  } catch {
    return 'UTC'
  }
}

// ---- 时间与策略文案 ----------------------------------------------------------

/** epoch ms / Date / ISO → 本地 yyyy-mm-dd HH:mm；缺失或坏值不拿当前时间冒充。 */
export function formatDateTime(value) {
  const ms = toMs(value)
  if (!Number.isFinite(ms) || ms <= 0) return '时间未知'
  const date = new Date(ms)
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 下次运行相对时间：还有 X / 不到 1 分钟 / 已过期 / 时间未知。 */
export function nextRunRelative(value, now = Date.now()) {
  const ms = toMs(value)
  if (!Number.isFinite(ms) || ms <= 0) return '时间未知'
  const base = Number.isFinite(now) ? now : Date.now()
  const diff = ms - base
  if (diff <= 0) return '已过期'
  if (diff < MINUTE_MS) return '不到 1 分钟'
  if (diff < HOUR_MS) return `还有 ${Math.floor(diff / MINUTE_MS)} 分钟`
  if (diff < DAY_MS) return `还有 ${Math.floor(diff / HOUR_MS)} 小时`
  return `还有 ${Math.floor(diff / DAY_MS)} 天`
}

/** 追赶窗口：按整天/整小时展示，其余按分钟。 */
export function formatCatchUp(value) {
  const ms = toMs(value)
  if (!Number.isFinite(ms) || ms < 0) return '未知'
  if (ms === 0) return '不追赶'
  if (ms % DAY_MS === 0) return `${ms / DAY_MS} 天`
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS} 小时`
  return `${Math.round(ms / MINUTE_MS)} 分钟`
}

/** 重叠策略中文名；未知值原样显示。 */
export function overlapLabel(overlap) {
  const value = asText(overlap)
  if (value === '') return '未知策略'
  return OVERLAP_LABELS[value] || value
}

// ---- 运行状态 ---------------------------------------------------------------

/** 运行状态中文名；未知值原样显示，空值给中性文案。 */
export function runStatusLabel(status) {
  const value = asText(status)
  if (value === '') return '未知状态'
  return RUN_STATUS_LABELS[value] || value
}

/** 状态徽章色调：running/queued 强调、failed 危险、waiting/missed 警示。 */
export function runStatusKind(status) {
  return RUN_STATUS_KINDS[asText(status)] || ''
}

/** outcome 中文名；null / 空串表示还没结束，返回空串。 */
export function runOutcomeLabel(outcome) {
  const value = asText(outcome)
  if (value === '') return ''
  return RUN_OUTCOME_LABELS[value] || value
}

/** 只有 queued / running 的 run 可以停止。 */
export function canStopRun(run) {
  const row = plainObject(run)
  if (!row) return false
  return row.status === 'queued' || row.status === 'running'
}

// ---- Bot 名解析 -------------------------------------------------------------

/** botId → 显示名；坏数据跳过。 */
export function botNameMap(bots) {
  const map = new Map()
  for (const bot of Array.isArray(bots) ? bots : []) {
    const row = plainObject(bot)
    if (!row) continue
    const id = asText(row.id)
    if (id === '') continue
    const name = asText(row.name)
    map.set(id, name === '' ? id : name)
  }
  return map
}

/** 列表里的 Bot 名；找不到时退回 botId，不显示「未知 Bot」冒充。 */
export function resolveBotName(map, botId) {
  const id = asText(botId)
  if (id === '') return '未知 Bot'
  if (map && typeof map.get === 'function') {
    const name = map.get(id)
    if (typeof name === 'string' && name !== '') return name
  }
  return id
}

// ---- 降级判定与错误文案 ------------------------------------------------------

/** 403：当前账号没有管理/查看权限。 */
export function isScheduleForbidden(error) {
  const row = plainObject(error)
  if (!row) return false
  return row.status === 403 || asText(row.code) === 'forbidden'
}

/** 404 路由缺失 / 405 / 501 / 503：调度接口未就绪；schedule.not_found 不算。 */
export function isScheduleNotReady(error) {
  const row = plainObject(error)
  if (!row) return false
  const status = row.status
  const code = asText(row.code)
  if (status === 405 || status === 501 || status === 503) return true
  return status === 404 && code !== 'schedule.not_found' && code !== 'run.not_found'
}

/** 去掉 store 写在 message 前缀里的域错误码：`SCHEDULE_INVALID: ...` → `...`。 */
function withoutCodePrefix(message) {
  return message.replace(/^[A-Z][A-Z0-9_]*:\s*/, '')
}

/**
 * 操作失败文案。400 schedule.invalid 优先显示服务端原因；
 * 409 / 403 / 404 / 503 给稳定的中文说明，不把失败说成成功。
 */
export function scheduleErrorText(error) {
  const row = plainObject(error)
  if (!row) return '操作失败，请重试。'
  const code = asText(row.code)
  const message = asText(row.message)
  if (
    row.status === 401 ||
    code === 'unauthenticated' ||
    code === 'session_expired' ||
    code === 'session_revoked'
  ) {
    return '会话已失效，请重新配对。'
  }

  if (code === 'schedule.invalid') return withoutCodePrefix(message) || '表达式或时区不合法'
  if (code === 'schedule.exists' || row.status === 409) {
    return '这个 routine 已经有定时任务了；同一工作区里 routineId 唯一。'
  }
  if (code === 'forbidden' || row.status === 403) return '仅 owner/admin 可修改定时任务。'
  if (code === 'schedule.not_found') return '这个定时任务已不存在，请刷新后重试。'
  if (code === 'run.not_found') return '这次运行已不存在，请刷新后重试。'
  if (isScheduleNotReady(row)) {
    return `调度接口未就绪（HTTP ${row.status ?? '?'}）：控制面还没有接上 SQLite store。`
  }
  if (row.status === 400) return message === '' ? '请求不合法' : `请求不合法：${message}`
  return message === '' ? '操作失败，请重试。' : `操作失败：${message}`
}
