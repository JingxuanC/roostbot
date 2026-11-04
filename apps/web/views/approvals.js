// 「需要你」审批页（docs/build/m4-addendum.md §B/§C、docs/design/ui.md §4 深链 /w/<id>/needs）。
//
// 数据来自 GET /api/approvals；接口还没上线时 404/405/501 降级成「审批接口未就绪」，
// 不报红、不白屏、也不假装有审批。批准/拒绝走 POST /api/approvals/:id {decision}。
// 所有用户输入只进 textContent / 属性，不拼 innerHTML。

import { avatar, botAvatar, el } from '../lib/dom.js'
import { isAuthError, isMissingRoute } from '../lib/api-client.js'
import {
  approvalActions,
  approvalStatusLabel,
  approvalSummary,
  approvalTimeLabel,
  canDecide,
} from '../lib/approvals.js'
import * as ui from '../lib/ui.js'

const PAGE_TITLE = '需要你'

function listFrom(payload) {
  if (Array.isArray(payload)) return payload
  if (payload && Array.isArray(payload.approvals)) return payload.approvals
  return []
}

function isNotReady(error) {
  if (!error) return false
  if (isMissingRoute(error)) return true
  if (error.status === 405 || error.status === 501) return true
  // 内存 port 没有审批表时 API 返回 503 runtime.not_configured；这同样是「没就绪」。
  return error.status === 503 && error.code === 'runtime.not_configured'
}

function requesterName(bots, approval) {
  const explicit = typeof approval?.requesterName === 'string' ? approval.requesterName.trim() : ''
  if (explicit !== '') return explicit
  const id = typeof approval?.requester === 'string' ? approval.requester : ''
  const bot = (bots || []).find((item) => item.id === id)
  return bot && typeof bot.name === 'string' && bot.name.trim() !== '' ? bot.name : '一个 Bot'
}

function statusKind(status) {
  if (status === 'pending') return 'warn'
  if (status === 'approved') return 'ok'
  return ''
}

function notReadyView(ctx, root, error) {
  const header = ui.pageHeader(PAGE_TITLE, {
    subtitle: 'Bot 发起的请求要你确认；批准建群后，房间会出现在左侧。',
    actions: [ui.button('重试', { variant: 'ghost', onClick: () => void mountApprovalsPage(root, ctx) })],
  })
  const board = el('div', { class: 'page-card' })
  const state = ui.emptyState({
    title: '审批接口未就绪',
    body: '控制面还没有可用的 GET /api/approvals（或返回 405/501）。Bot 建群请求暂时不会出现在这里；界面不会假装有审批，也不会自动批准。接口上线后点「重试」即可。',
    action: ui.button('重试', {
      variant: 'primary',
      onClick: () => void mountApprovalsPage(root, ctx),
    }),
    secondary: ui.linkButton('Bot 列表', '#/bots', { variant: 'ghost' }),
  })
  const status = error && typeof error.status === 'number' ? error.status : 0
  const code = error && typeof error.code === 'string' ? error.code : ''
  state.append(
    el('p', {
      class: 'state-detail muted',
      text: `接口返回：${status > 0 ? `HTTP ${status}` : '没有可用响应'}${code === '' ? '' : ` · ${code}`}`,
    })
  )
  board.append(state)
  root.replaceChildren(el('div', { class: 'stack' }, [header, board]))
}

/**
 * @param {HTMLElement} root
 * @param {object} ctx {api, store, navigate, ensureWorkspaceId, loadBots, loadRooms, requirePair, hasToken}
 */
export async function mountApprovalsPage(root, ctx) {
  root.replaceChildren(ui.loading('正在载入待审批…'))

  // 不靠 ctx.hasToken() 判断：会话通常在 HttpOnly cookie 里（auth.md §7），
  // 前端看不到 token 不代表没配对。直接请求；401 时 requirePair() 会带回去配对页。
  let bots = []
  try {
    bots = await ctx.loadBots()
  } catch (error) {
    if (isAuthError(error)) {
      ctx.requirePair()
      return
    }
    // 名字解析失败不阻塞审批列表；卡片会显示「一个 Bot」。
    bots = []
  }

  let workspaceId = ''
  try {
    workspaceId = await ctx.ensureWorkspaceId()
  } catch (error) {
    if (isAuthError(error)) {
      ctx.requirePair()
      return
    }
    // 没有 workspaceId 也试一次（契约允许省略）；失败再走统一错误态。
  }

  let approvals = []
  try {
    const params = new URLSearchParams()
    if (workspaceId !== '') params.set('workspaceId', workspaceId)
    params.set('status', 'pending')
    const data = await ctx.api.get(`/api/approvals?${params.toString()}`)
    approvals = listFrom(data).filter(
      (item) => item !== null && typeof item === 'object' && !Array.isArray(item)
    )
  } catch (error) {
    if (isAuthError(error)) {
      ctx.requirePair()
      return
    }
    if (isNotReady(error)) {
      notReadyView(ctx, root, error)
      return
    }
    root.replaceChildren(
      ui.pageHeader(PAGE_TITLE, {
        actions: [ui.button('重试', { variant: 'ghost', onClick: () => void mountApprovalsPage(root, ctx) })],
      }),
      ui.errorState({
        error,
        message: `审批列表载入失败：${error instanceof Error ? error.message : String(error)}`,
        onRetry: () => void mountApprovalsPage(root, ctx),
        onPair: typeof ctx.hasToken === 'function' && ctx.hasToken() ? undefined : true,
      })
    )
    return
  }

  root.replaceChildren(approvalsView(ctx, root, bots, approvals))
  const main = root.closest('main')
  if (main) main.focus()
}

function approvalsView(ctx, root, bots, approvals) {
  const refreshButton = ui.button('刷新', {
    variant: 'ghost',
    onClick: () => void mountApprovalsPage(root, ctx),
  })
  const header = ui.pageHeader(PAGE_TITLE, {
    subtitle: 'Bot 发起的请求要你确认；批准建群后，房间会出现在左侧。',
    actions: [refreshButton],
  })

  const board = el('div', { class: 'page-card approvals-board' })
  const countLine = el('p', { class: 'section-desc approvals-count', role: 'status' })
  const list = el('div', { class: 'needs-body approval-list' })
  const empty = ui.emptyState({
    title: '没有待批准的请求',
    body: 'Bot 建群等需要人工确认的请求会出现在这里；没有就什么都不显示，不拿样例凑数。',
    action: ui.linkButton('Bot 列表', '#/bots', { variant: 'ghost' }),
  })
  empty.hidden = approvals.length > 0

  function syncCount() {
    const pending = approvals.filter((approval) => approval.status === 'pending').length
    if (approvals.length === 0) {
      countLine.textContent = ''
      return
    }
    countLine.textContent =
      pending === 0
        ? `没有待批准的请求（共 ${approvals.length} 条记录）。`
        : `${pending} 条待批准（共 ${approvals.length} 条记录）。`
  }

  function memberLabel(botId) {
    const bot = bots.find((item) => item.id === botId)
    return bot && typeof bot.name === 'string' && bot.name.trim() !== '' ? bot.name : botId
  }

  function replaceStatusBadge(current, status) {
    const next = ui.badge(approvalStatusLabel(status), statusKind(status))
    current.replaceWith(next)
    return next
  }

  async function decide(approval, action, buttons, statusBadge, errorNode, noteNode, actionRow) {
    if (!canDecide(approval)) return
    ui.setError(errorNode, '')
    ui.setStatus(noteNode, '')
    for (const button of buttons) button.disabled = true
    try {
      const result = await ctx.api.post(`/api/approvals/${encodeURIComponent(approval.id)}`, {
        decision: action.decision,
      })
      const saved = result && result.approval && typeof result.approval === 'object' ? result.approval : null
      const nextStatus =
        saved && (saved.status === 'approved' || saved.status === 'rejected') ? saved.status : action.decision
      approval.status = nextStatus
      approval.decidedAt = (saved && saved.decidedAt) || Date.now()
      replaceStatusBadge(statusBadge, nextStatus)
      actionRow.remove()
      if (nextStatus === 'approved') {
        const room = result && result.room && typeof result.room === 'object' ? result.room : null
        const roomName = room && typeof room.name === 'string' && room.name.trim() !== '' ? room.name : ''
        ui.setStatus(
          noteNode,
          roomName === ''
            ? '已批准：控制面已按请求创建房间；左侧房间列表正在刷新。'
            : `已批准：已创建房间「${roomName}」，左侧列表正在刷新。`
        )
      } else {
        ui.setStatus(noteNode, '已拒绝：不会创建房间。')
      }
      syncCount()
      // 批准会建房：刷新侧栏/房间列表，失败也不影响这条审批已经提交。
      if (typeof ctx.loadRooms === 'function') {
        try {
          await ctx.loadRooms({ force: true })
        } catch {
          // 忽略：审批已经成功，房间列表稍后自己会刷。
        }
      }
      if (typeof ctx.refreshSidebar === 'function') ctx.refreshSidebar()
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      for (const button of buttons) button.disabled = false
      if (isNotReady(cause)) {
        ui.setStatus(
          noteNode,
          `审批接口未就绪（HTTP ${cause.status ?? '?'}）：这次没有提交成功，也没有发生任何状态变化。`,
          'error'
        )
        return
      }
      if (cause && cause.status === 409) {
        ui.setStatus(noteNode, '这条审批已经被处理过了；刷新列表可以看到最新状态。', 'error')
        return
      }
      ui.setError(errorNode, `提交失败：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  function approvalCard(approval) {
    const summary = approvalSummary(approval)
    const card = el('article', { class: 'need-card approval-card' })
    const requester = typeof approval.requester === 'string' ? approval.requester : ''
    const bot = bots.find((item) => item.id === requester)

    const head = el('p', { class: 'need-head' })
    head.append(el('span', { class: 'need-icon is-warn', 'aria-hidden': 'true', text: '⚠' }))
    head.append(bot ? botAvatar(bot, 20) : avatar(requester, 20))
    head.append(
      el('span', {
        class: 'need-who',
        text: requesterName(bots, approval),
        title: requester === '' ? '' : `Bot：${requester}`,
      })
    )
    head.append(ui.badge(summary.kindLabel, 'accent'))
    let statusBadge = ui.badge(approvalStatusLabel(approval.status), statusKind(approval.status))
    head.append(statusBadge)
    card.append(head)

    card.append(el('h2', { class: 'need-title', text: summary.title }))

    const dl = el('dl', { class: 'need-meta' })
    for (const field of summary.fields) {
      const value =
        field.label === '成员' && summary.memberIds.length > 0
          ? summary.memberIds.map(memberLabel).join('、')
          : field.value
      const row = el('div')
      row.append(el('dt', { text: field.label }), el('dd', { text: value }))
      dl.append(row)
    }
    card.append(dl)

    const createdAt = approval.createdAt ?? approval.created_at
    card.append(
      el('p', {
        class: 'need-impact',
        text: `请求时间：${approvalTimeLabel(createdAt)} · 批准后由控制面按请求创建房间`,
      })
    )

    const error = ui.inlineError()
    const note = ui.statusLine('')
    card.append(error)

    if (canDecide(approval)) {
      const actionRow = el('div', { class: 'need-actions' })
      const buttons = []
      for (const action of approvalActions(approval)) {
        const button = ui.button(action.label, {
          variant: action.variant,
          size: 'sm',
          title: action.decision === 'approved' ? '批准后按请求创建房间' : '拒绝后不会创建房间',
        })
        button.addEventListener('click', () => {
          void decide(approval, action, buttons, statusBadge, error, note, actionRow)
        })
        buttons.push(button)
        actionRow.append(button)
      }
      card.append(actionRow)
    }

    card.append(note)
    return card
  }

  for (const approval of approvals) list.append(approvalCard(approval))
  board.append(countLine, list, empty)
  syncCount()

  return el('div', { class: 'stack' }, [header, board])
}
