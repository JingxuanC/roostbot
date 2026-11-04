// 用量页：时间范围、汇总、配额与按 Bot/模型明细。
//
// 数据来自：
//   GET /api/usage?workspaceId=&from=&to=  → 汇总 + byBot + byModel（owner/admin）
//   GET /api/quotas?workspaceId=           → 配额（任意成员）
// 两个接口独立降级：用量 403 是整页提示（仅 owner/admin），配额 403 只降级配额区。
// 401 一律回配对页；404/405/501/503 说明接口未就绪 + 重试；不拿缓存或样例冒充数据。
// 所有用户可见文本只进 textContent / value，不拼 innerHTML。

import { el } from '../lib/dom.js'
import { isAuthError } from '../lib/api-client.js'
import * as ui from '../lib/ui.js'
import {
  DEFAULT_USAGE_RANGE,
  USAGE_RANGES,
  isUsageForbidden,
  isUsageNotReady,
  quotaRows,
  usageRange,
  usageSummary,
} from '../lib/usage.js'
import { detailsSections, notReadyState, quotaCard, summaryCards } from './usage-parts.js'

const PAGE_TITLE = '用量'
const PAGE_SUBTITLE = '按时间范围查看工作区的 token、工具调用与成本；配额按周期自动重置。'
const QUOTA_DESC = '只读；reserved 是进行中的预留，实际可用可能低于「上限 − 已用」。'

function usagePath(workspaceId, range) {
  const selected = usageRange(range)
  const params = new URLSearchParams({
    workspaceId,
    from: String(selected.from),
    to: String(selected.to),
  })
  return `/api/usage?${params.toString()}`
}

function quotasPath(workspaceId) {
  return `/api/quotas?workspaceId=${encodeURIComponent(workspaceId)}`
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

async function fetchUsage(ctx, workspaceId, range) {
  try {
    const data = await ctx.api.get(usagePath(workspaceId, range))
    return { auth: null, slot: { mode: 'ready', data: usageSummary(data), error: null } }
  } catch (error) {
    if (isAuthError(error)) return { auth: error, slot: { mode: 'error', data: null, error } }
    if (isUsageForbidden(error)) return { auth: null, slot: { mode: 'forbidden', data: null, error } }
    if (isUsageNotReady(error)) return { auth: null, slot: { mode: 'not-ready', data: null, error } }
    return { auth: null, slot: { mode: 'error', data: null, error } }
  }
}

async function fetchQuotas(ctx, workspaceId) {
  try {
    const data = await ctx.api.get(quotasPath(workspaceId))
    const list = Array.isArray(data?.quotas) ? data.quotas : []
    return { auth: null, slot: { mode: 'ready', list, error: null } }
  } catch (error) {
    if (isAuthError(error)) return { auth: error, slot: { mode: 'error', list: [], error } }
    if (isUsageForbidden(error)) return { auth: null, slot: { mode: 'forbidden', list: [], error } }
    if (isUsageNotReady(error)) return { auth: null, slot: { mode: 'not-ready', list: [], error } }
    return { auth: null, slot: { mode: 'error', list: [], error } }
  }
}

/**
 * @param {HTMLElement} root
 * @param {object} ctx {api, ensureWorkspaceId, requirePair, hasToken}
 */
export async function mountUsagePage(root, ctx) {
  root.replaceChildren(ui.loading('正在载入用量…'))

  let workspaceId = ''
  try {
    workspaceId = await ctx.ensureWorkspaceId()
  } catch (error) {
    if (isAuthError(error)) {
      ctx.requirePair()
      return
    }
    root.replaceChildren(
      el('div', { class: 'stack' }, [
        ui.pageHeader(PAGE_TITLE),
        ui.errorState({
          error,
          message: `工作区载入失败：${errorText(error)}`,
          onRetry: () => void mountUsagePage(root, ctx),
          onPair: typeof ctx.hasToken === 'function' && ctx.hasToken() ? undefined : true,
        }),
      ])
    )
    return
  }

  const state = {
    workspaceId,
    range: DEFAULT_USAGE_RANGE,
    seq: 0,
    usage: { mode: 'loading', data: null, error: null },
    quotas: { mode: 'loading', list: [], error: null },
  }

  const usageResult = await fetchUsage(ctx, workspaceId, state.range)
  if (usageResult.auth) {
    ctx.requirePair()
    return
  }
  state.usage = usageResult.slot

  // 用量 403 是整页拒绝；其它情况仍尝试加载配额（配额接口对成员开放）。
  if (state.usage.mode !== 'forbidden') {
    const quotaResult = await fetchQuotas(ctx, workspaceId)
    if (quotaResult.auth) {
      ctx.requirePair()
      return
    }
    state.quotas = quotaResult.slot
  }

  render(root, ctx, state, true)
}

async function reloadUsage(root, ctx, state) {
  const seq = ++state.seq
  state.usage = { mode: 'loading', data: null, error: null }
  render(root, ctx, state)
  const result = await fetchUsage(ctx, state.workspaceId, state.range)
  if (seq !== state.seq) return
  if (result.auth) {
    ctx.requirePair()
    return
  }
  state.usage = result.slot
  render(root, ctx, state)
}

async function reloadQuotas(root, ctx, state) {
  state.quotas = { mode: 'loading', list: [], error: null }
  render(root, ctx, state)
  const result = await fetchQuotas(ctx, state.workspaceId)
  if (result.auth) {
    ctx.requirePair()
    return
  }
  state.quotas = result.slot
  render(root, ctx, state)
}

function selectRange(root, ctx, state, value) {
  if (value === state.range) return
  state.range = value
  void reloadUsage(root, ctx, state)
}

function render(root, ctx, state, focus = false) {
  const header = ui.pageHeader(PAGE_TITLE, { subtitle: PAGE_SUBTITLE })

  if (state.usage.mode === 'forbidden') {
    root.replaceChildren(
      el('div', { class: 'stack' }, [
        header,
        el('div', { class: 'page-card' }, [
          ui.emptyState({
            title: '仅 owner/admin 可查看用量',
            body: '当前会话在这个工作区不是 owner/admin，所以不能查看用量明细。页面不会拿配额或缓存冒充用量。',
          }),
        ]),
      ])
    )
    focusMain(root, focus)
    return
  }

  const parts = [header, rangeTabs(state, (value) => selectRange(root, ctx, state, value))]
  parts.push(usageSection(root, ctx, state))
  if (state.usage.mode === 'ready') {
    for (const node of detailsSections(state.usage.data)) parts.push(node)
  }
  parts.push(quotaSection(root, ctx, state))
  root.replaceChildren(el('div', { class: 'stack' }, parts))
  focusMain(root, focus)
}

function focusMain(root, focus) {
  if (!focus) return
  const main = root.closest('main')
  if (main) main.focus()
}

function rangeTabs(state, onSelect) {
  const wrap = el('div', { class: 'usage-range', role: 'group', 'aria-label': '时间范围' })
  for (const option of USAGE_RANGES) {
    const active = option.value === state.range
    const button = ui.button(option.label, {
      variant: active ? 'primary' : 'ghost',
      onClick: () => onSelect(option.value),
    })
    button.setAttribute('aria-pressed', String(active))
    wrap.append(button)
  }
  return wrap
}

function usageSection(root, ctx, state) {
  const slot = state.usage
  if (slot.mode === 'loading') return ui.loading('正在载入用量…')
  if (slot.mode === 'not-ready') {
    return el('div', { class: 'page-card' }, [
      notReadyState({
        title: '用量接口未就绪',
        body: '控制面还没有可用的 GET /api/usage（或返回 404/405/501/503）。界面不会显示假数据；接口上线后点「重试」即可。',
        error: slot.error,
        onRetry: () => void reloadUsage(root, ctx, state),
      }),
    ])
  }
  if (slot.mode === 'error') {
    return ui.errorState({
      error: slot.error,
      message: `用量载入失败：${errorText(slot.error)}`,
      onRetry: () => void reloadUsage(root, ctx, state),
    })
  }
  return ui.section('汇总', [summaryCards(slot.data.totals)], {
    description: 'token 按 input + output + cached 记账；成本来自 provider 上报或估算。',
  })
}

function quotaSection(root, ctx, state) {
  const slot = state.quotas
  if (slot.mode === 'loading') {
    return ui.section('配额', [ui.loading('正在载入配额…')], { description: QUOTA_DESC })
  }
  if (slot.mode === 'forbidden') {
    return ui.section(
      '配额',
      [
        ui.emptyState({
          title: '配额信息不可用',
          body: '当前会话在这个工作区没有查看配额的权限。用量数据仍按上方展示，不拿缓存冒充配额。',
        }),
      ],
      { description: QUOTA_DESC }
    )
  }
  if (slot.mode === 'not-ready') {
    return ui.section(
      '配额',
      [
        notReadyState({
          title: '配额接口未就绪',
          body: '控制面还没有可用的 GET /api/quotas（或返回 404/405/501/503）。界面不会显示假的进度条；接口上线后点「重试」即可。',
          error: slot.error,
          onRetry: () => void reloadQuotas(root, ctx, state),
        }),
      ],
      { description: QUOTA_DESC }
    )
  }
  if (slot.mode === 'error') {
    return ui.section(
      '配额',
      [
        ui.errorState({
          error: slot.error,
          message: `配额载入失败：${errorText(slot.error)}`,
          onRetry: () => void reloadQuotas(root, ctx, state),
        }),
      ],
      { description: QUOTA_DESC }
    )
  }

  const rows = quotaRows(slot.list)
  if (rows.length === 0) {
    return ui.section(
      '配额',
      [
        ui.emptyState({
          title: '这个工作区还没有配置配额',
          body: '没有配额记录时不会显示假的进度条。配额由控制面按周期维护。',
        }),
      ],
      { description: QUOTA_DESC }
    )
  }

  const list = el('div', { class: 'quota-list' })
  for (const row of rows) list.append(quotaCard(row))
  return ui.section('配额', [list], { description: QUOTA_DESC })
}
