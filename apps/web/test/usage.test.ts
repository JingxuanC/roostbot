import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_USAGE_RANGE,
  formatBytes,
  formatCost,
  formatMetricValue,
  formatTokens,
  isUsageEmpty,
  isUsageForbidden,
  isUsageNotReady,
  metricLabel,
  periodLabel,
  quotaLevel,
  quotaRatio,
  quotaRows,
  resetTimeLabel,
  usageRange,
  usageSummary,
} from '../lib/usage.js'

test('时间范围：默认近 7 天，今天按本地 0 点起止', () => {
  assert.equal(DEFAULT_USAGE_RANGE, 'last7')

  const now = new Date(2026, 2, 3, 14, 30, 15)
  const today = usageRange('today', now.getTime())
  assert.equal(today.value, 'today')
  assert.equal(today.label, '今天')
  assert.equal(today.from, new Date(2026, 2, 3, 0, 0, 0).getTime())
  assert.equal(today.to, new Date(2026, 2, 4, 0, 0, 0).getTime())
  assert.equal(new Date(today.from).getHours(), 0)
})

test('时间范围：近 7 天跨月、跨年都按本地自然日', () => {
  const week = usageRange('last7', new Date(2026, 2, 3, 9, 0, 0).getTime())
  assert.equal(week.from, new Date(2026, 1, 25, 0, 0, 0).getTime())
  assert.equal(week.to, new Date(2026, 2, 4, 0, 0, 0).getTime())
  assert.equal(week.label, '近 7 天')

  const year = usageRange('last7', new Date(2026, 0, 1, 23, 59, 59).getTime())
  assert.equal(year.from, new Date(2025, 11, 26, 0, 0, 0).getTime())
  assert.equal(year.to, new Date(2026, 0, 2, 0, 0, 0).getTime())
})

test('时间范围：近 30 天跨月、跨年；未知值退回默认', () => {
  const month = usageRange('last30', new Date(2026, 2, 3, 12, 0, 0).getTime())
  assert.equal(month.from, new Date(2026, 1, 2, 0, 0, 0).getTime())
  assert.equal(month.to, new Date(2026, 2, 4, 0, 0, 0).getTime())

  const crossYear = usageRange('last30', new Date(2026, 0, 2, 12, 0, 0).getTime())
  assert.equal(crossYear.from, new Date(2025, 11, 4, 0, 0, 0).getTime())

  const fallback = usageRange('nope', new Date(2026, 2, 3, 12, 0, 0).getTime())
  assert.equal(fallback.value, 'last7')
  assert.equal(fallback.from, new Date(2026, 1, 25, 0, 0, 0).getTime())
})

test('token 与成本格式化：0 显示 0，不出现 NaN', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1000), '1,000')
  assert.equal(formatTokens(1234567), '1,234,567')
  assert.equal(formatTokens(-5), '0')
  assert.equal(formatTokens('abc'), '0')
  assert.equal(formatTokens(undefined), '0')

  assert.equal(formatCost(0), '$0')
  assert.equal(formatCost(undefined), '$0')
  assert.equal(formatCost(0.0042), '$0.0042')
  assert.equal(formatCost(0.01), '$0.01')
  assert.equal(formatCost(12.5), '$12.50')
  assert.equal(formatCost(1234.5), '$1,234.50')
})

test('字节与 metric 值格式化', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1000), '1.00 KB')
  assert.equal(formatBytes(10_000_000_000), '10.0 GB')
  assert.equal(formatMetricValue('container_seconds', 90), '90 秒')
  assert.equal(formatMetricValue('tokens', 1234), '1,234')
  assert.equal(formatMetricValue('storage_bytes', 1000), '1.00 KB')
})

test('metric / period 中文名：未知值原样或中性文案', () => {
  assert.equal(metricLabel('tokens'), '模型 token')
  assert.equal(metricLabel('runs'), 'Run 数')
  assert.equal(metricLabel('container_seconds'), '容器秒')
  assert.equal(metricLabel('storage_bytes'), '存储')
  assert.equal(metricLabel('messages'), '消息数')
  assert.equal(metricLabel(''), '未知指标')
  assert.equal(metricLabel('custom'), 'custom')

  assert.equal(periodLabel('day'), '每日')
  assert.equal(periodLabel('month'), '每月')
  assert.equal(periodLabel(''), '未知周期')
  assert.equal(periodLabel('week'), 'week')
})

test('重置时间：本地格式，缺失/坏值不冒充当前时间', () => {
  assert.equal(resetTimeLabel(new Date(2026, 0, 5, 8, 5).getTime()), '2026-01-05 08:05')
  assert.equal(resetTimeLabel(undefined), '重置时间未知')
  assert.equal(resetTimeLabel(0), '重置时间未知')
  assert.equal(resetTimeLabel('not-a-date'), '重置时间未知')
})

test('配额使用率与警示阈值：80% 警示，100% 耗尽', () => {
  assert.equal(quotaRatio({ limitValue: 100, usedValue: 80 }), 0.8)
  assert.equal(quotaRatio({ limitValue: 100, usedValue: 150 }), 1.5)
  assert.equal(quotaRatio({ limitValue: 0, usedValue: 10, ratio: 0.5 }), 0.5)
  assert.equal(quotaRatio({ limitValue: 0, usedValue: 10 }), 0)

  assert.deepEqual(quotaLevel(0.79), { kind: '', label: '' })
  assert.deepEqual(quotaLevel(0.8), { kind: 'warn', label: '接近上限' })
  assert.deepEqual(quotaLevel(0.99), { kind: 'warn', label: '接近上限' })
  assert.deepEqual(quotaLevel(1), { kind: 'danger', label: '已耗尽' })
  assert.deepEqual(quotaLevel(1.2), { kind: 'danger', label: '已耗尽' })
  assert.deepEqual(quotaLevel(0), { kind: '', label: '' })
})

test('配额行：已用/上限、预留、重置时间与进度条裁剪', () => {
  const rows = quotaRows([
    {
      id: 'q1',
      metric: 'tokens',
      period: 'day',
      limitValue: 1000,
      usedValue: 800,
      reserved: 50,
      resetsAt: new Date(2026, 0, 5, 8, 5).getTime(),
    },
    {
      id: 'q2',
      metric: 'runs',
      period: 'month',
      limitValue: 10,
      usedValue: 15,
      reserved: 0,
      resetsAt: null,
    },
    null,
  ])

  assert.equal(rows.length, 2)
  const first = rows[0]
  assert.equal(first.metricLabel, '模型 token')
  assert.equal(first.periodLabel, '每日')
  assert.equal(first.usedLabel, '800')
  assert.equal(first.limitLabel, '1,000')
  assert.equal(first.reservedLabel, '50')
  assert.equal(first.percentLabel, '80%')
  assert.equal(first.barPercent, 80)
  assert.equal(first.levelKind, 'warn')
  assert.equal(first.levelLabel, '接近上限')
  assert.equal(first.resetLabel, '2026-01-05 08:05')

  const second = rows[1]
  assert.equal(second.metricLabel, 'Run 数')
  assert.equal(second.periodLabel, '每月')
  assert.equal(second.percentLabel, '150%')
  assert.equal(second.barPercent, 100)
  assert.equal(second.levelKind, 'danger')
  assert.equal(second.levelLabel, '已耗尽')
  assert.equal(second.resetLabel, '重置时间未知')
})

test('用量汇总：兼容 botId/model 与 store 的 key 形状', () => {
  const summary = usageSummary({
    totals: {
      inputTokens: '10',
      outputTokens: 5,
      cachedTokens: 5,
      toolCalls: '2',
      costUsd: '0.5',
    },
    byBot: [
      { botId: 'bot_1', inputTokens: 10, outputTokens: 5, cachedTokens: 5, costUsd: 1 },
      { key: 'bot_2', inputTokens: 1, outputTokens: 2, cachedTokens: 0, costUsd: 0 },
    ],
    byModel: [{ model: 'gpt-x', tokens: 20, costUsd: 1 }],
  })

  assert.equal(summary.totals.tokens, 20)
  assert.equal(summary.totals.toolCalls, 2)
  assert.equal(summary.totals.costUsd, 0.5)
  assert.deepEqual(
    summary.byBot.map((row) => row.key),
    ['bot_1', 'bot_2']
  )
  assert.equal(summary.byBot[0].tokens, 20)
  assert.equal(summary.byBot[1].tokens, 3)
  assert.equal(summary.byModel[0].key, 'gpt-x')
  assert.equal(summary.byModel[0].tokens, 20)
})

test('用量汇总：坏数据按 0，空响应不抛异常', () => {
  const summary = usageSummary({ totals: null, byBot: [null, 'oops', {}], byModel: null })
  assert.equal(summary.totals.tokens, 0)
  assert.equal(summary.totals.costUsd, 0)
  assert.equal(summary.byBot.length, 1)
  assert.equal(summary.byBot[0].key, '')
  assert.equal(summary.byBot[0].tokens, 0)
  assert.deepEqual(usageSummary(undefined).byModel, [])
})

test('空状态判断：token / 工具调用 / 成本全为 0 才算没有用量', () => {
  assert.equal(isUsageEmpty({ totals: { tokens: 0, toolCalls: 0, costUsd: 0 } }), true)
  assert.equal(isUsageEmpty({ totals: { tokens: 1, toolCalls: 0, costUsd: 0 } }), false)
  assert.equal(isUsageEmpty({ totals: { tokens: 0, toolCalls: 1, costUsd: 0 } }), false)
  assert.equal(isUsageEmpty({ totals: { tokens: 0, toolCalls: 0, costUsd: 0.01 } }), false)
  assert.equal(isUsageEmpty(null), true)
})

test('降级判定：403 与未就绪只认确定的状态码', () => {
  assert.equal(isUsageForbidden({ status: 403 }), true)
  assert.equal(isUsageForbidden({ code: 'forbidden' }), true)
  assert.equal(isUsageForbidden({ status: 401 }), false)
  assert.equal(isUsageForbidden(null), false)

  assert.equal(isUsageNotReady({ status: 404 }), true)
  assert.equal(isUsageNotReady({ status: 405 }), true)
  assert.equal(isUsageNotReady({ status: 501 }), true)
  assert.equal(isUsageNotReady({ status: 503, code: 'runtime.not_configured' }), true)
  assert.equal(isUsageNotReady({ status: 500 }), false)
  assert.equal(isUsageNotReady({ status: 403 }), false)
  assert.equal(isUsageNotReady(null), false)
})
