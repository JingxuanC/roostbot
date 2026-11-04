// 连接器页（docs/design/connectors.md §3/§4/§9）：目录卡片 + 按 Bot 授权。
//
// 数据来自：
//   GET    /api/connectors?workspaceId=        → { connectors, connections }（任意成员）
//   POST   /api/connectors/:slug/connect       → 201 { url, state }（owner/admin）
//   DELETE /api/connectors/:slug?workspaceId=  → 204（owner/admin）
// 授权分区在 connectors-grants.js。
// 空目录就是空态（默认 Stub 网关没有目录），不拿样例连接器凑数；
// 401 回配对页；403 说明角色不足；501 说明网关未配置；503 说明接口未就绪。
// 所有用户可见文本只进 textContent / value，不拼 innerHTML。

import { isAuthError } from '../lib/api-client.js'
import { el } from '../lib/dom.js'
import {
  canManageConnectors,
  connectorErrorText,
  isConnectorForbidden,
  isConnectorNotConfigured,
  isConnectorNotReady,
} from '../lib/connectors.js'
import * as ui from '../lib/ui.js'
import { connectorCard } from './connectors-card.js'
import { connectorGrantsSection } from './connectors-grants.js'

const PAGE_TITLE = '连接器'
const PAGE_SUBTITLE =
  '连接器凭据只存在网关；工作区连接决定「连了哪些服务」，按 Bot 授权决定「哪个 Bot 能用哪些动作」。'

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function connectorListPath(workspaceId) {
  return `/api/connectors?workspaceId=${encodeURIComponent(workspaceId)}`
}

async function fetchConnectors(ctx, workspaceId) {
  try {
    const data = await ctx.api.get(connectorListPath(workspaceId))
    const rows = Array.isArray(data?.connectors)
      ? data.connectors.filter((item) => item && typeof item === 'object')
      : []
    return { auth: null, slot: { mode: 'ready', rows, error: null } }
  } catch (error) {
    if (isAuthError(error)) return { auth: error, slot: { mode: 'error', rows: [], error } }
    if (isConnectorForbidden(error)) return { auth: null, slot: { mode: 'forbidden', rows: [], error } }
    if (isConnectorNotReady(error)) return { auth: null, slot: { mode: 'not-ready', rows: [], error } }
    return { auth: null, slot: { mode: 'error', rows: [], error } }
  }
}

/**
 * @param {HTMLElement} root
 * @param {object} ctx {api, ensureWorkspaceId, requirePair, loadBots, hasToken}
 */
export async function mountConnectorsPage(root, ctx) {
  root.replaceChildren(ui.loading('正在载入连接器…'))

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
        onRetry: () => void mountConnectorsPage(root, ctx),
        onPair: typeof ctx.hasToken === 'function' && ctx.hasToken() ? undefined : true,
      })
    )
    return
  }

  const state = {
    workspaceId,
    // 角色只用于「显示管理控件」；拿不到时先放出控件，由服务端 403 兜底。
    role: '',
    connectors: { mode: 'loading', rows: [], error: null },
    bots: [],
  }

  try {
    const data = await ctx.api.get('/api/workspaces')
    const workspaces = Array.isArray(data?.workspaces) ? data.workspaces : []
    const current = workspaces.find(
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

  const result = await fetchConnectors(ctx, workspaceId)
  if (result.auth) {
    ctx.requirePair()
    return
  }
  state.connectors = result.slot

  render(root, ctx, state)
}

function render(root, ctx, state) {
  const remount = () => void mountConnectorsPage(root, ctx)
  const header = ui.pageHeader(PAGE_TITLE, {
    subtitle: PAGE_SUBTITLE,
    actions: [ui.button('刷新', { variant: 'ghost', onClick: remount })],
  })
  const slot = state.connectors

  if (slot.mode === 'forbidden') {
    root.replaceChildren(
      el('div', { class: 'stack' }, [
        header,
        el('div', { class: 'page-card' }, [
          ui.emptyState({
            title: '没有权限查看连接器',
            body: '当前账号不是这个工作区的成员，所以看不到连接器目录与连接状态。这里不会拿样例连接器冒充。',
          }),
        ]),
      ])
    )
    return
  }

  if (slot.mode === 'not-ready') {
    const notConfigured = isConnectorNotConfigured(slot.error)
    root.replaceChildren(
      el('div', { class: 'stack' }, [
        header,
        el('div', { class: 'page-card' }, [
          ui.emptyState({
            title: notConfigured ? '连接器网关未配置' : '连接器接口未就绪',
            body: `${connectorErrorText(slot.error, 'view')}接口上线后点「刷新」即可。`,
            action: ui.button('刷新', { variant: 'primary', onClick: remount }),
          }),
        ]),
      ])
    )
    return
  }

  if (slot.mode === 'error') {
    root.replaceChildren(
      el('div', { class: 'stack' }, [
        header,
        ui.errorState({
          error: slot.error,
          message: `连接器载入失败：${errorText(slot.error)}`,
          onRetry: remount,
        }),
      ])
    )
    return
  }

  const connectors = Array.isArray(slot.rows) ? slot.rows : []
  if (connectors.length === 0) {
    root.replaceChildren(
      el('div', { class: 'stack' }, [
        header,
        el('div', { class: 'page-card' }, [
          ui.emptyState({
            title: '还没有可用的连接器（网关未配置）',
            body: '控制面返回的连接器目录是空的，通常是连接器网关还没有配置或没有同步任何连接器。这里不会显示样例连接器。',
            action: ui.button('刷新', { variant: 'ghost', onClick: remount }),
          }),
        ]),
      ])
    )
    return
  }

  const manage = canManageConnectors(state.role)
  const list = el('ul', { class: 'connector-grid' })
  for (const connector of connectors) {
    list.append(connectorCard(ctx, state, connector, remount, manage))
  }

  const parts = [
    header,
    ui.section('连接器目录', [list], {
      description: manage
        ? '连接与断开需要 owner/admin；授权在页面下方的「按 Bot 授权」里单独管理。'
        : '连接与断开需要 owner/admin；当前账号可以查看目录与连接状态。',
    }),
  ]
  parts.push(connectorGrantsSection(ctx, { ...state, connectors }))
  root.replaceChildren(el('div', { class: 'stack' }, parts))
}
