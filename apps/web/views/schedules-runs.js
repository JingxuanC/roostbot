// 定时任务页「运行历史」分区：最近 50 条 run，queued/running 可停止。
//
// 数据来自 GET /api/runs?workspaceId=&limit=50 → { runs: [...] }。
// 分区自己加载、自己降级：503/404 显示未就绪卡片，错误给重试；401 交给 requirePair。
// 所有用户可见文本只进 textContent。

import { isAuthError } from '../lib/api-client.js'
import { el } from '../lib/dom.js'
import {
  canStopRun,
  formatDateTime,
  isScheduleForbidden,
  isScheduleNotReady,
  runOutcomeLabel,
  runStatusKind,
  runStatusLabel,
  scheduleErrorText,
} from '../lib/schedules.js'
import * as ui from '../lib/ui.js'

const RUN_LIMIT = 50
const SECTION_TITLE = '运行历史'
const SECTION_DESC = '按当前工作区拉最近 50 条；排队中/运行中的 Run 可以人工停止。'

function runsPath(workspaceId) {
  const params = new URLSearchParams({ workspaceId, limit: String(RUN_LIMIT) })
  return `/api/runs?${params.toString()}`
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
}

/**
 * @param {object} ctx 页面上下文
 * @param {object} state 页面状态（会写入 state.runs 槽位）
 * @returns {{node: HTMLElement, reload: () => Promise<void>}}
 */
export function createRunsSection(ctx, state) {
  const host = el('div')
  const statusLine = ui.statusLine('')
  let seq = 0

  function sectionNode() {
    const slot = state.runs
    const description = SECTION_DESC

    if (slot.mode === 'loading') {
      return ui.section(SECTION_TITLE, [ui.loading('正在载入运行历史…')], { description })
    }
    if (slot.mode === 'forbidden') {
      return ui.section(
        SECTION_TITLE,
        [
          ui.emptyState({
            title: '没有权限查看运行历史',
            body: '当前账号不是这个工作区的成员。运行历史不会拿样例冒充。',
          }),
        ],
        { description }
      )
    }
    if (slot.mode === 'not-ready') {
      return ui.section(
        SECTION_TITLE,
        [
          ui.emptyState({
            title: '运行历史接口未就绪',
            body: '控制面还没有可用的 GET /api/runs（或返回 404/405/501/503）。界面不会显示假数据；接口上线后点「重试」即可。',
            action: ui.button('重试', { variant: 'primary', onClick: () => void reload() }),
          }),
        ],
        { description }
      )
    }
    if (slot.mode === 'error') {
      return ui.section(
        SECTION_TITLE,
        [
          ui.errorState({
            error: slot.error,
            message: `运行历史载入失败：${slot.error instanceof Error ? slot.error.message : String(slot.error)}`,
            onRetry: () => void reload(),
          }),
        ],
        { description }
      )
    }

    const rows = Array.isArray(slot.rows) ? slot.rows : []
    if (rows.length === 0) {
      return ui.section(
        SECTION_TITLE,
        [
          statusLine,
          ui.emptyState({
            title: '还没有运行记录',
            body: '定时任务还没触发过；点「立即运行」或等到下次运行后会出现在这里。',
          }),
        ],
        { description }
      )
    }

    const wrap = el('div', { class: 'usage-table-wrap' })
    const table = el('table', { class: 'usage-table schedule-runs-table' })
    const head = el('thead')
    const headRow = el('tr')
    for (const label of ['状态', 'Outcome', 'routineId', '开始', '结束', '执行次数', '操作']) {
      headRow.append(el('th', { text: label, class: label === '执行次数' ? 'num' : undefined }))
    }
    head.append(headRow)

    const body = el('tbody')
    for (const run of rows) body.append(runRow(run))
    table.append(head, body)
    wrap.append(table)

    return ui.section(SECTION_TITLE, [statusLine, wrap], { description })
  }

  function runRow(run) {
    const row = run && typeof run === 'object' ? run : {}
    const tr = el('tr', { title: typeof row.id === 'string' ? row.id : undefined })

    const statusCell = el('td')
    statusCell.append(ui.badge(runStatusLabel(row.status), runStatusKind(row.status)))
    tr.append(statusCell)

    const outcome = runOutcomeLabel(row.outcome)
    tr.append(el('td', { text: outcome === '' ? '—' : outcome }))
    tr.append(el('td', { text: typeof row.routineId === 'string' && row.routineId !== '' ? row.routineId : '—' }))
    tr.append(el('td', { text: row.startedAt ? formatDateTime(row.startedAt) : '—' }))
    tr.append(el('td', { text: row.finishedAt ? formatDateTime(row.finishedAt) : '—' }))
    tr.append(el('td', { class: 'num', text: String(count(row.executions)) }))

    const actionCell = el('td')
    if (canStopRun(row) && typeof row.id === 'string' && row.id !== '') {
      actionCell.append(
        ui.button('停止', {
          variant: 'ghost',
          size: 'sm',
          title: '人工停止是终态；watchdog 不会自动拉起',
          onClick: (event) => void stopRun(row, event.currentTarget),
        })
      )
    } else {
      actionCell.append(el('span', { class: 'muted', text: '—' }))
    }
    tr.append(actionCell)
    return tr
  }

  async function reload() {
    const token = ++seq
    state.runs = { mode: 'loading', rows: [], error: null }
    paint()
    let data
    try {
      data = await ctx.api.get(runsPath(state.workspaceId))
    } catch (error) {
      if (token !== seq) return
      if (isAuthError(error)) {
        ctx.requirePair()
        return
      }
      if (isScheduleForbidden(error)) state.runs = { mode: 'forbidden', rows: [], error }
      else if (isScheduleNotReady(error)) state.runs = { mode: 'not-ready', rows: [], error }
      else state.runs = { mode: 'error', rows: [], error }
      paint()
      return
    }
    if (token !== seq) return
    const list = Array.isArray(data?.runs) ? data.runs.filter((item) => item && typeof item === 'object') : []
    state.runs = { mode: 'ready', rows: list, error: null }
    paint()
  }

  async function stopRun(run, button) {
    ui.setStatus(statusLine, '')
    ui.setBusy(button, true, '停止中…')
    try {
      await ctx.api.post(`/api/runs/${encodeURIComponent(run.id)}/stop`)
    } catch (error) {
      if (isAuthError(error)) {
        ctx.requirePair()
        return
      }
      ui.setBusy(button, false)
      ui.setStatus(statusLine, scheduleErrorText(error), 'error')
      return
    }
    await reload()
    ui.setStatus(statusLine, `已停止 run ${run.id}。`)
  }

  function paint() {
    host.replaceChildren(sectionNode())
  }

  state.runs = { mode: 'loading', rows: [], error: null }
  paint()
  void reload()

  return { node: host, reload }
}
