// 用量页的展示片段：汇总卡片、按 Bot/模型明细、配额卡片与未就绪提示。
// 只建 DOM；数据来自 views/usage.js 拉取并用 lib/usage.js 归一化后的模型。

import { el } from '../lib/dom.js'
import * as ui from '../lib/ui.js'
import {
  formatCost,
  formatTokens,
  isUsageEmpty,
} from '../lib/usage.js'

export function summaryCards(totals) {
  const grid = el('div', { class: 'usage-cards' })
  grid.append(
    summaryCard(
      '总 token',
      formatTokens(totals.tokens),
      `输入 ${formatTokens(totals.inputTokens)} · 输出 ${formatTokens(totals.outputTokens)} · 缓存 ${formatTokens(totals.cachedTokens)}`
    )
  )
  grid.append(summaryCard('工具调用', formatTokens(totals.toolCalls), 'runtime 上报的 tool.call 次数'))
  grid.append(
    summaryCard(
      '成本',
      formatCost(totals.costUsd),
      totals.costUsd > 0 ? 'provider 上报或估算的美元成本' : '这个区间没有成本记录'
    )
  )
  return grid
}

function summaryCard(label, value, detail) {
  const card = el('div', { class: 'usage-card' })
  card.append(el('p', { class: 'usage-card-label muted', text: label }))
  card.append(el('p', { class: 'usage-card-value', text: value }))
  card.append(el('p', { class: 'usage-card-detail muted', text: detail }))
  return card
}

export function detailsSections(data) {
  if (isUsageEmpty(data)) {
    return [
      ui.section(
        '明细',
        [
          ui.emptyState({
            title: '这个区间没有用量',
            body: '选定范围内没有 token、工具调用或成本记录。换个时间范围看看，或确认 runtime 已上报 usage。',
          }),
        ],
        { description: '按 Bot / 按模型拆分。' }
      ),
    ]
  }
  return [
    detailSection('按 Bot', data.byBot, 'Bot', '未知 Bot'),
    detailSection('按模型', data.byModel, '模型', '未知模型'),
  ]
}

function detailSection(title, rows, keyLabel, fallbackKey) {
  const table = el('table', { class: 'usage-table' })
  table.append(el('caption', { class: 'sr-only', text: `${title}：按${keyLabel}拆分 token 与成本` }))
  const head = el('thead')
  const headRow = el('tr')
  headRow.append(
    el('th', { scope: 'col', text: keyLabel }),
    el('th', { scope: 'col', class: 'num', text: 'token' }),
    el('th', { scope: 'col', class: 'num', text: '成本' })
  )
  head.append(headRow)

  const body = el('tbody')
  for (const row of rows) {
    const tr = el('tr')
    tr.append(
      el('td', { text: row.key === '' ? fallbackKey : row.key }),
      el('td', { class: 'num', text: formatTokens(row.tokens) }),
      el('td', { class: 'num', text: formatCost(row.costUsd) })
    )
    body.append(tr)
  }
  table.append(head, body)
  return ui.section(title, [el('div', { class: 'usage-table-wrap' }, [table])])
}

export function quotaCard(row) {
  const card = el('div', { class: `quota-card${row.levelKind === '' ? '' : ` is-${row.levelKind}`}` })
  const top = el('div', { class: 'quota-top' })
  top.append(el('strong', { class: 'quota-metric', text: row.metricLabel }))
  top.append(ui.badge(row.periodLabel))
  if (row.levelLabel !== '') top.append(ui.badge(row.levelLabel, row.levelKind))
  card.append(top)

  card.append(el('p', { class: 'quota-used', text: `已用 ${row.usedLabel} / 上限 ${row.limitLabel}` }))

  const bar = el('div', {
    class: `usage-bar${row.levelKind === '' ? '' : ` is-${row.levelKind}`}`,
    role: 'progressbar',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': String(Math.min(100, row.percent)),
    'aria-label': `${row.metricLabel} ${row.periodLabel}配额`,
  })
  const fill = el('span', { class: 'usage-bar-fill' })
  fill.style.width = `${row.barPercent}%`
  bar.append(fill)
  card.append(bar)

  card.append(el('p', { class: 'quota-meta muted', text: `${row.percentLabel} · 预留 ${row.reservedLabel}` }))
  card.append(el('p', { class: 'quota-meta muted', text: `重置：${row.resetLabel}` }))
  return card
}

export function notReadyState(options) {
  const state = ui.emptyState({
    title: options.title,
    body: options.body,
    action: ui.button('重试', { variant: 'primary', onClick: options.onRetry }),
  })
  state.append(el('p', { class: 'state-detail muted', text: errorDetail(options.error) }))
  return state
}

function errorDetail(error) {
  const status = error && typeof error.status === 'number' ? error.status : 0
  const code = error && typeof error.code === 'string' ? error.code : ''
  return `接口返回：${status > 0 ? `HTTP ${status}` : '没有可用响应'}${code === '' ? '' : ` · ${code}`}`
}
