// 定时任务页：列表、启停、删除、立即运行；运行历史在 schedules-runs.js。
//
// 数据来自：
//   GET    /api/workspaces/:id/schedules   → 任意成员可读
//   POST   /api/workspaces/:id/schedules   → owner/admin 新建
//   PATCH  /api/schedules/:id              → owner/admin 启停
//   DELETE /api/schedules/:id              → owner/admin 删除
//   POST   /api/schedules/:id/run          → owner/admin 立即运行
// 401 一律回配对页；403 提示仅 owner/admin；503/404 说明接口未就绪 + 重试。
// 所有用户可见文本只进 textContent / value，不拼 innerHTML。

import { isAuthError } from '../lib/api-client.js'
import { el } from '../lib/dom.js'
import {
  botNameMap,
  formatCatchUp,
  formatDateTime,
  isScheduleForbidden,
  isScheduleNotReady,
  nextRunRelative,
  overlapLabel,
  resolveBotName,
  scheduleErrorText,
} from '../lib/schedules.js'
import * as ui from '../lib/ui.js'
import { scheduleFormSection } from './schedules-form.js'
import { createRunsSection } from './schedules-runs.js'

const PAGE_TITLE = '定时任务'
const PAGE_SUBTITLE = '按 cron / daily / weekly / every 定时唤醒 Bot；同一工作区里 routineId 唯一。'
const SECTION_DESC = '列表对成员可读；新建、启停、删除与立即运行需要 owner/admin。'

function schedulesPath(workspaceId) {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/schedules`
}

function schedulePath(id) {
  return `/api/schedules/${encodeURIComponent(id)}`
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

async function fetchSchedules(ctx, workspaceId) {
  try {
    const data = await ctx.api.get(schedulesPath(workspaceId))
    const rows = Array.isArray(data?.schedules)
      ? data.schedules.filter((item) => item && typeof item === 'object')
      : []
    return { auth: null, slot: { mode: 'ready', rows, error: null } }
  } catch (error) {
    if (isAuthError(error)) return { auth: error, slot: { mode: 'error', rows: [], error } }
    if (isScheduleForbidden(error)) return { auth: null, slot: { mode: 'forbidden', rows: [], error } }
    if (isScheduleNotReady(error)) return { auth: null, slot: { mode: 'not-ready', rows: [], error } }
    return { auth: null, slot: { mode: 'error', rows: [], error } }
  }
}

function canManage(role) {
  // 角色未知时先放出控件，让服务端的 403 给出权威结果。
  return role === '' || role === 'owner' || role === 'admin'
}

/**
 * @param {HTMLElement} root
 * @param {object} ctx {api, ensureWorkspaceId, requirePair, loadBots, hasToken}
 */
export async function mountSchedulesPage(root, ctx) {
  root.replaceChildren(ui.loading('正在载入定时任务…'))

  let workspaceId = ''
  try {
    workspaceId = await ctx.ensureWorkspaceId()
  } catch (error) {
    if (isAuthError(error)) {
      ctx.requirePair()
      return
    }
    root.replaceChildren(
      ui.pageHeader(PAGE_TITLE),
      ui.errorState({
        error,
        message: `工作区载入失败：${errorText(error)}`,
        onRetry: () => void mountSchedulesPage(root, ctx),
        onPair: typeof ctx.hasToken === 'function' && ctx.hasToken() ? undefined : true,
      })
    )
    return
  }

  const state = {
    workspaceId,
    role: '',
    bots: [],
    schedules: { mode: 'loading', rows: [], error: null },
    runs: { mode: 'loading', rows: [], error: null },
  }

  try {
    const data = await ctx.api.get('/api/workspaces')
    const list = Array.isArray(data?.workspaces) ? data.workspaces : []
    const current = list.find(
      (workspace) => workspace && typeof workspace === 'object' && workspace.id === workspaceId
    )
    if (current && typeof current.role === 'string') state.role = current.role
  } catch (error) {
    if (isAuthError(error)) {
      ctx.requirePair()
      return
    }
  }

  if (typeof ctx.loadBots === 'function') {
    try {
      const bots = await ctx.loadBots()
      state.bots = Array.isArray(bots) ? bots : []
    } catch (error) {
      if (isAuthError(error)) {
        ctx.requirePair()
        return
      }
    }
  }

  const result = await fetchSchedules(ctx, workspaceId)
  if (result.auth) {
    ctx.requirePair()
    return
  }
  state.schedules = result.slot

  const runs = createRunsSection(ctx, state)
  render(root, ctx, state, runs, true)
}

async function reloadSchedules(root, ctx, state, runs) {
  state.schedules = { mode: 'loading', rows: [], error: null }
  render(root, ctx, state, runs)
  const result = await fetchSchedules(ctx, state.workspaceId)
  if (result.auth) {
    ctx.requirePair()
    return
  }
  state.schedules = result.slot
  render(root, ctx, state, runs)
}

function render(root, ctx, state, runs, focus = false) {
  const header = ui.pageHeader(PAGE_TITLE, { subtitle: PAGE_SUBTITLE })

  if (state.schedules.mode === 'forbidden') {
    root.replaceChildren(
      el('div', { class: 'stack' }, [
        header,
        el('div', { class: 'page-card' }, [
          ui.emptyState({
            title: '没有权限查看定时任务',
            body: '当前账号不是这个工作区成员。定时任务不会拿样例数据冒充。',
          }),
        ]),
      ])
    )
    focusMain(root, focus)
    return
  }

  const parts = [header]
  for (const node of schedulesSections(ctx, state, { root, runs })) parts.push(node)
  if (runs) parts.push(runs.node)
  root.replaceChildren(el('div', { class: 'stack' }, parts))
  focusMain(root, focus)
}

function focusMain(root, focus) {
  if (!focus) return
  const main = root.closest('main')
  if (main) main.focus()
}

function schedulesSections(ctx, state, options) {
  const slot = state.schedules
  const remount = () => void reloadSchedules(options.root, ctx, state, options.runs)

  if (slot.mode === 'loading') {
    return [ui.section('定时任务', [ui.loading('正在载入定时任务…')], { description: SECTION_DESC })]
  }
  if (slot.mode === 'not-ready') {
    return [
      ui.section(
        '定时任务',
        [
          ui.emptyState({
            title: '调度接口未就绪',
            body: '控制面还没有可用的定时任务接口（或返回 404/405/501/503 runtime.not_configured）。界面不会显示假数据；接口上线后点「重试」即可。',
            action: ui.button('重试', { variant: 'primary', onClick: remount }),
          }),
        ],
        { description: SECTION_DESC }
      ),
    ]
  }
  if (slot.mode === 'error') {
    return [
      ui.section(
        '定时任务',
        [
          ui.errorState({
            error: slot.error,
            message: `定时任务载入失败：${errorText(slot.error)}`,
            onRetry: remount,
          }),
        ],
        { description: SECTION_DESC }
      ),
    ]
  }

  let rows = Array.isArray(slot.rows) ? slot.rows.slice() : []
  const botMap = botNameMap(state.bots)
  const manager = canManage(state.role)
  const sectionStatus = ui.statusLine('')
  const list = el('ul', { class: 'grant-list schedule-list' })
  const empty = ui.emptyState({
    title: '还没有定时任务',
    body: '在下面新建一条；到点后 Bot 会按 routineId 开始一个回合。',
  })

  function syncRows() {
    state.schedules.rows = rows
  }

  function renderRows() {
    list.replaceChildren()
    for (const schedule of rows) list.append(scheduleRow(schedule))
    empty.hidden = rows.length > 0
  }

  function replaceRow(id, patch) {
    const index = rows.findIndex((item) => item && item.id === id)
    if (index >= 0) rows[index] = { ...rows[index], ...patch }
    syncRows()
    renderRows()
  }

  function labelOf(schedule) {
    return typeof schedule.routineId === 'string' && schedule.routineId !== '' ? schedule.routineId : schedule.id
  }

  async function toggleSchedule(schedule, checkbox) {
    const next = !schedule.enabled
    ui.setStatus(sectionStatus, '')
    checkbox.disabled = true
    try {
      const data = await ctx.api.patch(schedulePath(schedule.id), { enabled: next })
      const updated =
        data && typeof data === 'object' && data.schedule && typeof data.schedule === 'object'
          ? data.schedule
          : { enabled: next }
      replaceRow(schedule.id, updated)
      ui.setStatus(sectionStatus, `${next ? '已启用' : '已停用'}「${labelOf(schedule)}」。`)
    } catch (error) {
      if (isAuthError(error)) {
        ctx.requirePair()
        return
      }
      checkbox.checked = schedule.enabled
      checkbox.disabled = false
      ui.setStatus(sectionStatus, scheduleErrorText(error), 'error')
    }
  }

  async function deleteSchedule(schedule, button) {
    const label = labelOf(schedule)
    const prompt = `删除定时任务「${label}」？删除后不会再触发；已经产生的运行记录会保留。`
    if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(prompt)) {
      return
    }
    ui.setStatus(sectionStatus, '')
    ui.setBusy(button, true, '删除中…')
    try {
      await ctx.api.del(schedulePath(schedule.id))
      rows = rows.filter((item) => !(item && item.id === schedule.id))
      syncRows()
      renderRows()
      ui.setStatus(sectionStatus, `已删除「${label}」。`)
    } catch (error) {
      if (isAuthError(error)) {
        ctx.requirePair()
        return
      }
      ui.setBusy(button, false)
      ui.setStatus(sectionStatus, scheduleErrorText(error), 'error')
    }
  }

  async function runNow(schedule, button) {
    const label = labelOf(schedule)
    ui.setStatus(sectionStatus, '')
    ui.setBusy(button, true, '触发中…')
    try {
      const data = await ctx.api.post(`${schedulePath(schedule.id)}/run`)
      const run = data && typeof data === 'object' && data.run && typeof data.run === 'object' ? data.run : null
      ui.setStatus(
        sectionStatus,
        `已触发「${label}」${run && typeof run.id === 'string' ? `，run ${run.id} 已排队` : ''}。`
      )
      if (options.runs && typeof options.runs.reload === 'function') await options.runs.reload()
    } catch (error) {
      if (isAuthError(error)) {
        ctx.requirePair()
        return
      }
      ui.setStatus(sectionStatus, scheduleErrorText(error), 'error')
    } finally {
      ui.setBusy(button, false)
    }
  }

  function scheduleRow(schedule) {
    const item = el('li', { class: `grant-row schedule-row${schedule.enabled ? '' : ' is-disabled'}` })
    const main = el('div', { class: 'grant-main' })
    const top = el('div', { class: 'grant-top' })
    top.append(ui.badge(schedule.enabled ? '启用' : '停用', schedule.enabled ? 'ok' : ''))
    top.append(el('span', { class: 'grant-key', text: labelOf(schedule) }))
    top.append(
      el('span', {
        class: 'muted schedule-bot',
        title: typeof schedule.botId === 'string' ? schedule.botId : undefined,
        text: `Bot · ${resolveBotName(botMap, schedule.botId)}`,
      })
    )
    main.append(top)

    const nextRun = schedule.enabled
      ? `${formatDateTime(schedule.nextRunAt)}（${nextRunRelative(schedule.nextRunAt)}）`
      : '已停用，不触发'

    const dl = el('dl', { class: 'need-meta grant-meta schedule-meta' })
    const fields = [
      ['表达式', typeof schedule.cron === 'string' && schedule.cron !== '' ? schedule.cron : '—'],
      ['时区', typeof schedule.timezone === 'string' && schedule.timezone !== '' ? schedule.timezone : '—'],
      ['下次运行', nextRun],
      ['上次运行', schedule.lastRunAt ? formatDateTime(schedule.lastRunAt) : '从未运行'],
      ['重叠策略', overlapLabel(schedule.overlap)],
      ['追赶窗口', formatCatchUp(schedule.catchUpMs)],
    ]
    for (const [label, value] of fields) {
      const line = el('div')
      line.append(el('dt', { text: label }), el('dd', { text: value }))
      dl.append(line)
    }
    main.append(dl)

    const actions = el('div', { class: 'grant-actions schedule-actions' })
    if (manager) {
      const toggle = el('label', { class: 'schedule-toggle' })
      const checkbox = el('input', {
        type: 'checkbox',
        checked: Boolean(schedule.enabled),
        'aria-label': `启用或停用 ${labelOf(schedule)}`,
      })
      checkbox.addEventListener('change', () => void toggleSchedule(schedule, checkbox))
      toggle.append(checkbox, el('span', { text: schedule.enabled ? '已启用' : '已停用' }))
      actions.append(
        toggle,
        ui.button('立即运行', {
          variant: 'ghost',
          size: 'sm',
          title: '立即触发一次，不改变下次运行时间',
          onClick: (event) => void runNow(schedule, event.currentTarget),
        }),
        ui.button('删除', {
          variant: 'ghost',
          size: 'sm',
          title: '删除后不再触发；运行历史保留',
          onClick: (event) => void deleteSchedule(schedule, event.currentTarget),
        })
      )
    } else {
      actions.append(el('span', { class: 'muted', text: '只读' }))
    }

    item.append(main, actions)
    return item
  }

  renderRows()

  const listChildren = [sectionStatus]
  if (!manager) {
    listChildren.push(el('p', { class: 'field-hint', text: '当前角色只读；新建、启停、删除与立即运行需要 owner/admin。' }))
  }
  listChildren.push(empty, list)

  const sections = [ui.section('定时任务', listChildren, { description: SECTION_DESC })]
  if (manager) {
    sections.push(
      scheduleFormSection(ctx, state, (created) => {
        rows = [...rows, created]
        syncRows()
        renderRows()
      })
    )
  } else {
    sections.push(
      ui.section('新建定时任务', [
        ui.emptyState({
          title: '仅 owner/admin 可修改',
          body: '当前角色可以查看列表与运行历史；新建、启停、删除需要 owner/admin。',
        }),
      ])
    )
  }
  return sections
}
