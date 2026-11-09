// 连接器目录卡片：状态、账户标签、动作清单、连接/断开。
//
// POST   /api/connectors/:slug/connect      → 201 { url, state }
// DELETE /api/connectors/:slug?workspaceId= → 204
// 连接成功后用 window.open(url, '_blank', 'noopener') 打开授权页，并提示回来后刷新。
// 所有用户可见文本只进 textContent；授权地址只放行 http/https。

import { isAuthError } from '../lib/api-client.js'
import { el } from '../lib/dom.js'
import {
  actionsText,
  connectButtonLabel,
  connectorActions,
  connectorErrorText,
  connectorStatusKind,
  connectorStatusLabel,
  isConnectorConnected,
  isSafeAuthUrl,
} from '../lib/connectors.js'
import * as ui from '../lib/ui.js'

function connectPath(slug) {
  return `/api/connectors/${encodeURIComponent(slug)}/connect`
}

function connectorPath(slug, workspaceId) {
  return `/api/connectors/${encodeURIComponent(slug)}?workspaceId=${encodeURIComponent(workspaceId)}`
}

/**
 * @param {object} ctx {api, requirePair}
 * @param {object} page {workspaceId}
 * @param {object} connector 卡片（slug/title/backend/actions/connected/status/accountLabel）
 * @param {() => void} remount 重新拉整个页面
 * @param {boolean} manage 当前角色能否连接/断开
 */
export function connectorCard(ctx, page, connector, remount, manage) {
  const slug = typeof connector.slug === 'string' ? connector.slug : ''
  const title = typeof connector.title === 'string' && connector.title.trim() !== ''
    ? connector.title.trim()
    : slug
  const backend = typeof connector.backend === 'string' && connector.backend.trim() !== ''
    ? connector.backend.trim()
    : '未知后端'
  const account = typeof connector.accountLabel === 'string' ? connector.accountLabel.trim() : ''
  const actions = connectorActions(connector)
  const connected = isConnectorConnected(connector)
  const isMine = connector.isMine === true
  const connectionCount = Number.isInteger(connector.connectionCount) ? connector.connectionCount : 0

  const item = el('li', { class: 'connector-card-item' })
  const card = el('article', { class: 'connector-card' })
  const head = el('div', { class: 'connector-card-head' }, [
    el('h3', { class: 'connector-card-title', text: title }),
    ui.badge(connectorStatusLabel(connector.status), connectorStatusKind(connector.status)),
  ])
  card.append(head)

  const meta = [`slug ${slug || '（缺失）'}`, backend]
  if (account !== '') meta.push(`账户 ${account}`)
  if (connected && !isMine) meta.push('workspace 默认连接')
  if (connectionCount > 1) meta.push(`${connectionCount} 个连接`)
  card.append(el('p', { class: 'connector-card-meta muted', text: meta.join(' · ') }))
  card.append(el('p', { class: 'connector-card-actions', text: `动作：${actionsText(actions)}` }))

  const note = ui.statusLine('')
  const actionsHost = el('div', { class: 'connector-card-buttons' })
  card.append(note, actionsHost)
  item.append(card)

  if (!manage) {
    actionsHost.append(
      el('span', {
        class: 'field-hint',
        text: '当前账号只能查看连接状态。',
      })
    )
    return item
  }

  if (connected && isMine) {
    const disconnect = ui.button('断开', {
      variant: 'ghost',
      size: 'sm',
      title: '断开后 Bot 将不能再调用这个连接器',
    })
    disconnect.addEventListener('click', () => void disconnectConnector(disconnect, note))
    actionsHost.append(disconnect)
    return item
  }

  const connect = ui.button(connected ? '连接我的账号' : connectButtonLabel(connector.status), { variant: 'primary', size: 'sm' })
  const complete = ui.button('我已完成授权', { variant: 'ghost', size: 'sm' })
  complete.hidden = true
  complete.addEventListener('click', remount)
  connect.addEventListener('click', () => void startConnect(connect, complete, note))
  actionsHost.append(connect, complete)

  async function startConnect(button, completeButton, statusNode) {
    ui.setStatus(statusNode, '')
    ui.setBusy(button, true, '发起中…')
    try {
      const data = await ctx.api.post(connectPath(slug), { workspaceId: page.workspaceId })
      const url = data && typeof data.url === 'string' ? data.url : ''
      if (!isSafeAuthUrl(url)) {
        ui.setStatus(statusNode, '服务端返回的授权地址不合法，已阻止打开。', 'error')
        return
      }
      if (typeof window !== 'undefined' && typeof window.open === 'function') {
        window.open(url, '_blank', 'noopener')
      }
      completeButton.hidden = false
      ui.setStatus(
        statusNode,
        '已打开授权页：请在授权页完成后回到这里，点「我已完成授权」刷新列表。',
        'ok'
      )
    } catch (error) {
      if (isAuthError(error)) {
        ctx.requirePair()
        return
      }
      ui.setStatus(statusNode, connectorErrorText(error, 'connect'), 'error')
    } finally {
      ui.setBusy(button, false)
    }
  }

  async function disconnectConnector(button, statusNode) {
    const promptText = `断开「${title}」？断开后 Bot 将不能再调用这个连接器。`
    if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(promptText)) {
      return
    }
    ui.setStatus(statusNode, '')
    ui.setBusy(button, true, '断开中…')
    try {
      await ctx.api.del(connectorPath(slug, page.workspaceId))
      remount()
    } catch (error) {
      if (isAuthError(error)) {
        ctx.requirePair()
        return
      }
      ui.setBusy(button, false)
      ui.setStatus(statusNode, connectorErrorText(error, 'disconnect'), 'error')
    }
  }

  return item
}
