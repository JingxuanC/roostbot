import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CATCH_UP_DEFAULT_HOURS,
  botNameMap,
  browserTimeZone,
  canStopRun,
  expressionExamples,
  expressionForm,
  formatCatchUp,
  formatDateTime,
  isScheduleForbidden,
  isScheduleNotReady,
  nextRunRelative,
  overlapLabel,
  resolveBotName,
  runOutcomeLabel,
  runStatusKind,
  runStatusLabel,
  scheduleErrorText,
  validateScheduleForm,
} from '../lib/schedules.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = new Date(2026, 0, 1, 0, 0, 0).getTime()

test('表达式形态：cron / daily / weekly / every / 空 / 未知', () => {
  assert.equal(expressionForm('0 9 * * *'), 'cron')
  assert.equal(expressionForm('*/15 8-18 * * 1-5'), 'cron')
  assert.equal(expressionForm('daily 09:00'), 'daily')
  assert.equal(expressionForm('  DAILY 09:00  '), 'daily')
  assert.equal(expressionForm('weekly mon,wed 09:00'), 'weekly')
  assert.equal(expressionForm('every 3600'), 'every')
  assert.equal(expressionForm('every'), 'every')
  assert.equal(expressionForm(''), 'empty')
  assert.equal(expressionForm('   '), 'empty')
  assert.equal(expressionForm('daily'), 'unknown')
  assert.equal(expressionForm('not a cron'), 'unknown')
  assert.equal(expressionForm('0 9 * *'), 'unknown')
})

test('表达式示例覆盖四种形态', () => {
  const forms = expressionExamples().map((item) => expressionForm(item.value))
  assert.deepEqual(forms, ['cron', 'daily', 'weekly', 'every'])
  for (const item of expressionExamples()) {
    assert.equal(typeof item.label, 'string')
    assert.notEqual(item.label, '')
  }
})

test('表单校验：合法输入归一化成后端 payload', () => {
  const result = validateScheduleForm({
    botId: 'bot_1',
    routineId: '  daily-premarket  ',
    expression: ' daily 09:00 ',
    timezone: ' Asia/Shanghai ',
    catchUpHours: '12',
    overlap: 'queue',
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.payload, {
    botId: 'bot_1',
    routineId: 'daily-premarket',
    cron: 'daily 09:00',
    timezone: 'Asia/Shanghai',
    catchUpMs: 12 * HOUR,
    overlap: 'queue',
  })
})

test('表单校验：catchUp 留空取默认 12 小时，0 合法，小数可换算', () => {
  const base = {
    botId: 'bot_1',
    routineId: 'r1',
    expression: '0 9 * * *',
    timezone: 'UTC',
    overlap: 'skip',
  }
  assert.equal(validateScheduleForm(base).payload.catchUpMs, CATCH_UP_DEFAULT_HOURS * HOUR)
  assert.equal(validateScheduleForm({ ...base, catchUpHours: '' }).payload.catchUpMs, 12 * HOUR)
  assert.equal(validateScheduleForm({ ...base, catchUpHours: '0' }).payload.catchUpMs, 0)
  assert.equal(validateScheduleForm({ ...base, catchUpHours: '0.5' }).payload.catchUpMs, HOUR / 2)
  assert.equal(validateScheduleForm({ ...base, overlap: '' }).payload.overlap, 'queue')
})

test('表单校验：必填项与形态错误各有明确字段', () => {
  const valid = {
    botId: 'bot_1',
    routineId: 'r1',
    expression: 'daily 09:00',
    timezone: 'UTC',
    catchUpHours: '12',
    overlap: 'queue',
  }

  assert.deepEqual(
    { field: validateScheduleForm({ ...valid, botId: '' }).field },
    { field: 'botId' }
  )
  assert.equal(validateScheduleForm({ ...valid, routineId: '   ' }).field, 'routineId')
  assert.equal(validateScheduleForm({ ...valid, expression: '' }).field, 'expression')
  assert.equal(validateScheduleForm({ ...valid, expression: 'not a cron' }).field, 'expression')
  assert.equal(validateScheduleForm({ ...valid, expression: 'every 0' }).field, 'expression')
  assert.equal(validateScheduleForm({ ...valid, expression: 'every x' }).field, 'expression')
  assert.equal(validateScheduleForm({ ...valid, expression: 'daily 25:00' }).field, 'expression')
  assert.equal(validateScheduleForm({ ...valid, expression: 'weekly nope 09:00' }).field, 'expression')
  assert.equal(validateScheduleForm({ ...valid, timezone: '' }).field, 'timezone')
  assert.equal(validateScheduleForm({ ...valid, catchUpHours: '-1' }).field, 'catchUpHours')
  assert.equal(validateScheduleForm({ ...valid, catchUpHours: 'abc' }).field, 'catchUpHours')
  assert.equal(validateScheduleForm({ ...valid, overlap: 'later' }).field, 'overlap')
})

test('表单校验：weekly 与 every 的合法形态通过', () => {
  const base = {
    botId: 'bot_1',
    routineId: 'r1',
    timezone: 'UTC',
    catchUpHours: '12',
    overlap: 'queue',
  }
  assert.equal(validateScheduleForm({ ...base, expression: 'weekly mon,wed 09:00' }).ok, true)
  assert.equal(validateScheduleForm({ ...base, expression: 'weekly 0,7 23:59' }).ok, true)
  assert.equal(validateScheduleForm({ ...base, expression: 'every 1' }).ok, true)
})

test('浏览器时区：总能给出非空默认值', () => {
  const zone = browserTimeZone()
  assert.equal(typeof zone, 'string')
  assert.notEqual(zone, '')
})

test('时间格式化：本地 yyyy-mm-dd HH:mm，坏值不冒充当前时间', () => {
  assert.equal(formatDateTime(new Date(2026, 0, 5, 8, 5).getTime()), '2026-01-05 08:05')
  assert.equal(formatDateTime(new Date(2026, 11, 31, 23, 59).getTime()), '2026-12-31 23:59')
  assert.equal(formatDateTime(undefined), '时间未知')
  assert.equal(formatDateTime(0), '时间未知')
  assert.equal(formatDateTime('not-a-date'), '时间未知')
})

test('nextRun 相对时间：分钟 / 小时 / 天 / 已过期', () => {
  assert.equal(nextRunRelative(NOW + 5 * MINUTE, NOW), '还有 5 分钟')
  assert.equal(nextRunRelative(NOW + 2 * HOUR, NOW), '还有 2 小时')
  assert.equal(nextRunRelative(NOW + 3 * DAY, NOW), '还有 3 天')
  assert.equal(nextRunRelative(NOW + 30_000, NOW), '不到 1 分钟')
  assert.equal(nextRunRelative(NOW - 1, NOW), '已过期')
  assert.equal(nextRunRelative(undefined, NOW), '时间未知')
  assert.equal(nextRunRelative('not-a-date', NOW), '时间未知')
})

test('追赶窗口文案：天 / 小时 / 分钟 / 不追赶', () => {
  assert.equal(formatCatchUp(0), '不追赶')
  assert.equal(formatCatchUp(12 * HOUR), '12 小时')
  assert.equal(formatCatchUp(DAY), '1 天')
  assert.equal(formatCatchUp(90 * MINUTE), '90 分钟')
  assert.equal(formatCatchUp(-1), '未知')
  assert.equal(formatCatchUp(undefined), '未知')
})

test('重叠策略文案：已知值中文，未知值原样', () => {
  assert.equal(overlapLabel('queue'), '排队')
  assert.equal(overlapLabel('skip'), '跳过')
  assert.equal(overlapLabel(''), '未知策略')
  assert.equal(overlapLabel('later'), 'later')
})

test('运行状态文案与徽章色调', () => {
  assert.equal(runStatusLabel('queued'), '排队中')
  assert.equal(runStatusLabel('running'), '运行中')
  assert.equal(runStatusLabel('waiting'), '等待中')
  assert.equal(runStatusLabel('completed'), '已完成')
  assert.equal(runStatusLabel('failed'), '失败')
  assert.equal(runStatusLabel('missed'), '已错过')
  assert.equal(runStatusLabel('skipped'), '已跳过')
  assert.equal(runStatusLabel(''), '未知状态')
  assert.equal(runStatusLabel('paused'), 'paused')

  assert.equal(runStatusKind('running'), 'accent')
  assert.equal(runStatusKind('completed'), 'ok')
  assert.equal(runStatusKind('failed'), 'danger')
  assert.equal(runStatusKind('missed'), 'warn')
  assert.equal(runStatusKind('skipped'), '')
  assert.equal(runStatusKind('paused'), '')
})

test('outcome 文案：空值表示还没结束，未知值原样', () => {
  assert.equal(runOutcomeLabel('done'), '完成')
  assert.equal(runOutcomeLabel('needs_input'), '等待输入')
  assert.equal(runOutcomeLabel('budget'), '预算耗尽')
  assert.equal(runOutcomeLabel('stopped'), '已停止')
  assert.equal(runOutcomeLabel('duplicate'), '重复跳过')
  assert.equal(runOutcomeLabel(null), '')
  assert.equal(runOutcomeLabel(''), '')
  assert.equal(runOutcomeLabel('other'), 'other')
})

test('只有 queued / running 可停止', () => {
  assert.equal(canStopRun({ status: 'queued' }), true)
  assert.equal(canStopRun({ status: 'running' }), true)
  assert.equal(canStopRun({ status: 'waiting' }), false)
  assert.equal(canStopRun({ status: 'completed' }), false)
  assert.equal(canStopRun(null), false)
})

test('Bot 名解析：找不到时退回 botId，不伪造名字', () => {
  const map = botNameMap([
    { id: 'bot_1', name: '数据官' },
    { id: 'bot_2', name: '  ' },
    { id: '', name: '坏数据' },
    null,
  ])
  assert.equal(resolveBotName(map, 'bot_1'), '数据官')
  assert.equal(resolveBotName(map, 'bot_2'), 'bot_2')
  assert.equal(resolveBotName(map, 'bot_missing'), 'bot_missing')
  assert.equal(resolveBotName(map, ''), '未知 Bot')
  assert.equal(botNameMap(undefined).size, 0)
})

test('降级判定：403 与未就绪只认确定的状态码', () => {
  assert.equal(isScheduleForbidden({ status: 403 }), true)
  assert.equal(isScheduleForbidden({ code: 'forbidden' }), true)
  assert.equal(isScheduleForbidden({ status: 401 }), false)
  assert.equal(isScheduleForbidden(null), false)

  assert.equal(isScheduleNotReady({ status: 503, code: 'runtime.not_configured' }), true)
  assert.equal(isScheduleNotReady({ status: 404, code: 'not_found' }), true)
  assert.equal(isScheduleNotReady({ status: 405 }), true)
  assert.equal(isScheduleNotReady({ status: 501 }), true)
  assert.equal(isScheduleNotReady({ status: 404, code: 'schedule.not_found' }), false)
  assert.equal(isScheduleNotReady({ status: 404, code: 'run.not_found' }), false)
  assert.equal(isScheduleNotReady({ status: 500 }), false)
  assert.equal(isScheduleNotReady(null), false)
})

test('错误文案：invalid / exists / forbidden / not_found / 未就绪', () => {
  assert.equal(
    scheduleErrorText({ status: 400, code: 'schedule.invalid', message: 'unknown time zone "X"' }),
    'unknown time zone "X"'
  )
  assert.equal(
    scheduleErrorText({ status: 400, code: 'schedule.invalid', message: 'SCHEDULE_INVALID: time out of range: "25:00"' }),
    'time out of range: "25:00"'
  )
  assert.equal(scheduleErrorText({ status: 400, code: 'schedule.invalid' }), '表达式或时区不合法')
  assert.match(scheduleErrorText({ status: 409, code: 'schedule.exists' }), /routineId 唯一/)
  assert.equal(
    scheduleErrorText({ status: 403, code: 'forbidden' }),
    '仅 owner/admin 可修改定时任务。'
  )
  assert.equal(
    scheduleErrorText({ status: 404, code: 'schedule.not_found' }),
    '这个定时任务已不存在，请刷新后重试。'
  )
  assert.equal(
    scheduleErrorText({ status: 404, code: 'run.not_found' }),
    '这次运行已不存在，请刷新后重试。'
  )
  assert.match(
    scheduleErrorText({ status: 503, code: 'runtime.not_configured' }),
    /调度接口未就绪/
  )
  assert.equal(scheduleErrorText({ status: 400, message: 'botId is required' }), '请求不合法：botId is required')
  assert.equal(scheduleErrorText({ status: 500, message: 'boom' }), '操作失败：boom')
  assert.equal(scheduleErrorText({ status: 401 }), '会话已失效，请重新配对。')
  assert.equal(scheduleErrorText(null), '操作失败，请重试。')
})
