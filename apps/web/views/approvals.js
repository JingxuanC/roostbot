// 「需要你」审批页（docs/build/m4-addendum.md §B/§C、docs/design/ui.md §3.3 / §12 待决 3）。
//
// 数据来自 GET /api/approvals；接口还没上线时 404/405/501 降级成「审批接口未就绪」，
// 不报红、不白屏、也不假装有审批。批准/拒绝走 POST /api/approvals/:id {decision}。
// 卡片显示「谁 / 要做什么 / 作用对象 / 影响什么」；批准只对这一次生效，
// 长期授权只能去设置页显式开启（不在审批主按钮旁边）。
// 所有用户输入只进 textContent / 属性，不拼 innerHTML。

import { avatar, botAvatar, el } from '../lib/dom.js'
import { isAuthError, isMissingRoute } from '../lib/api-client.js'
import {
  approvalActions,
  approvalDecisionHistory,
  approvalFacts,
  approvalListModel,
  approvalRequester,
  approvalStatusLabel,
  approvalTimeLabel,
  canDecide,
} from '../lib/approvals.js'
import * as ui from '../lib/ui.js'

const PAGE_TITLE = '需要你'
const HISTORY_LIMIT = 20
const PAGE_SUBTITLE = 'Bot 或用户的请求要你确认；批准只对这一次生效，长期授权要去设置里显式开启。'

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

function statusKind(status) {
  if (status === 'pending') return 'warn'
  if (status === 'approved') return 'ok'
  return ''
}

function notReadyView(ctx, root, error) {
  const header = ui.pageHeader(PAGE_TITLE, {
    subtitle: PAGE_SUBTITLE,
    actions: [ui.button('重试', { variant: 'ghost', onClick: () => void mountApprovalsPage(root, ctx) })],
  })
  const board = el('div', { class: 'page-card' })
  const state = ui.emptyState({
    title: '审批接口未就绪',
    body: '控制面还没有可用的 GET /api/approvals（或返回 405/501）。Bot 建群等请求暂时不会出现在这里；界面不会假装有审批，也不会自动批准。接口上线后点「重试」即可。',
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
 * @param {object} ctx {api, store, navigate, ensureWorkspaceId, loadBots, loadRooms, requirePair, hasToken, refreshNeedsCount}
 */
export async function mountApprovalsPage(root, ctx) {
  root.replaceChildren(ui.loading('正在载入审批…'))

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
    // 不带 status：一次取回待处理 + 最近已决策，页面才能在没有 pending 时仍看见历史。
    const query = params.toString()
    const data = await ctx.api.get(`/api/approvals${query === '' ? '' : `?${query}`}`)
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
  if (typeof ctx.refreshNeedsCount === 'function') void ctx.refreshNeedsCount()
  const main = root.closest('main')
  if (main) main.focus()
}

function approvalsView(ctx, root, bots, approvals) {
  const model = approvalListModel(approvals, { limit: HISTORY_LIMIT })
  const refreshButton = ui.button('刷新', {
    variant: 'ghost',
    onClick: () => void mountApprovalsPage(root, ctx),
  })
  const header = ui.pageHeader(PAGE_TITLE, {
    subtitle: PAGE_SUBTITLE,
    actions: [ui.linkButton('设置', '#/settings', { variant: 'ghost' }), refreshButton],
  })

  const board = el('div', { class: 'page-card approvals-board' })
  const countLine = el('p', { class: 'section-desc approvals-count', role: 'status' })
  const pendingHeading = el('h2', { class: 'section-title approval-section-title', text: '待处理' })
  const pendingList = el('div', { class: 'needs-body approval-list' })
  const pendingEmpty = el('p', {
    class: 'section-desc approvals-count',
    text: '没有待批准的请求；下面是最近已决策的记录。',
  })
  const decidedHeading = el('h2', { class: 'section-title approval-section-title', text: '最近已决策' })
  const decidedList = el('div', { class: 'needs-body approval-list approval-history-list' })
  const empty = ui.emptyState({
    title: '没有待批准的请求',
    body: 'Bot 建群等需要人工确认的请求会出现在这里；已处理过的记录也会保留，不拿样例凑数。',
    action: ui.linkButton('Bot 列表', '#/bots', { variant: 'ghost' }),
    secondary: ui.linkButton('设置', '#/settings', { variant: 'ghost' }),
  })

  function syncCount() {
    const pendingCount = approvals.filter((approval) => approval.status === 'pending').length
    const historyCount = decidedList.childElementCount
    const total = approvals.length
    pendingHeading.textContent = `待处理（${pendingCount}）`
    decidedHeading.textContent = `最近已决策（${historyCount}）`
    countLine.textContent =
      total === 0
        ? ''
        : `${pendingCount} 条待批准 · ${historyCount} 条最近已决策（共 ${total} 条记录）。`
    pendingHeading.hidden = total === 0
    pendingList.hidden = pendingCount === 0
    pendingEmpty.hidden = !(total > 0 && pendingCount === 0)
    decidedHeading.hidden = historyCount === 0
    decidedList.hidden = historyCount === 0
    empty.hidden = total > 0
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

  async function decide(approval, action, refs) {
    if (!canDecide(approval)) return
    ui.setError(refs.error, '')
    ui.setStatus(refs.note, '')
    for (const button of refs.buttons) button.disabled = true
    try {
      const result = await ctx.api.post(`/api/approvals/${encodeURIComponent(approval.id)}`, {
        decision: action.decision,
      })
      const saved = result && result.approval && typeof result.approval === 'object' ? result.approval : null
      const nextStatus =
        saved && (saved.status === 'approved' || saved.status === 'rejected') ? saved.status : action.decision
      approval.status = nextStatus
      approval.decidedAt = (saved && saved.decidedAt) || Date.now()
      if (saved) {
        for (const key of ['decidedBy', 'action', 'target', 'consequence']) {
          if (saved[key] !== undefined) approval[key] = saved[key]
        }
      }
      refs.statusBadge = replaceStatusBadge(refs.statusBadge, nextStatus)
      refs.actionRow.remove()
      refs.card.classList.add('is-decided')
      const history = approvalDecisionHistory(approval)
      refs.impact.textContent = history ? history.text : '已处理（状态未知）'
      refs.impact.classList.add('approval-history')
      decidedList.prepend(refs.card)
      while (decidedList.childElementCount > HISTORY_LIMIT && decidedList.lastElementChild) {
        decidedList.lastElementChild.remove()
      }

      if (nextStatus === 'approved') {
        const room = result && result.room && typeof result.room === 'object' ? result.room : null
        const roomName = room && typeof room.name === 'string' && room.name.trim() !== '' ? room.name : ''
        ui.setStatus(
          refs.note,
          roomName === ''
            ? '已允许（一次）：控制面已按请求创建房间；左侧房间列表正在刷新。'
            : `已允许（一次）：已创建房间「${roomName}」，左侧列表正在刷新。`
        )
      } else {
        ui.setStatus(refs.note, '已拒绝（一次）：不会创建房间。')
      }
      syncCount()
      if (typeof ctx.refreshNeedsCount === 'function') void ctx.refreshNeedsCount()
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
      for (const button of refs.buttons) button.disabled = false
      if (isNotReady(cause)) {
        ui.setStatus(
          refs.note,
          `审批接口未就绪（HTTP ${cause.status ?? '?'}）：这次没有提交成功，也没有发生任何状态变化。`,
          'error'
        )
        return
      }
      if (cause && cause.status === 409) {
        ui.setStatus(refs.note, '这条审批已经被处理过了；刷新列表可以看到最新状态。', 'error')
        return
      }
      ui.setError(refs.error, `提交失败：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  function approvalCard(approval) {
    const facts = approvalFacts(approval)
    const requester = approvalRequester(approval, bots)
    const pending = canDecide(approval)
    const card = el('article', {
      class: `need-card approval-card${pending ? '' : ' is-decided'}`,
    })

    const head = el('p', { class: 'need-head' })
    head.append(
      el('span', {
        class: `need-icon ${pending ? 'is-warn' : 'is-done'}`,
        'aria-hidden': 'true',
        text: pending ? '⚠' : '✓',
      })
    )
    head.append(requester.bot ? botAvatar(requester.bot, 20) : avatar(requester.id || requester.name, 20))
    head.append(
      el('span', {
        class: 'need-who',
        text: requester.name,
        title:
          requester.id === ''
            ? ''
            : requester.kind === 'bot'
              ? `Bot：${requester.id}`
              : requester.kind === 'user'
                ? `用户：${requester.id}`
                : `请求方：${requester.id}`,
      })
    )
    head.append(ui.badge(facts.kindLabel, 'accent'))
    let statusBadge = ui.badge(approvalStatusLabel(approval.status), statusKind(approval.status))
    head.append(statusBadge)
    card.append(head)

    card.append(el('h2', { class: 'need-title', text: facts.title }))

    const dl = el('dl', { class: 'need-meta' })
    for (const field of facts.facts) {
      const value =
        field.label === '成员' && facts.memberIds.length > 0
          ? facts.memberIds.map(memberLabel).join('、')
          : field.value
      const row = el('div')
      row.append(el('dt', { text: field.label }), el('dd', { text: value }))
      dl.append(row)
    }
    card.append(dl)

    const createdAt = approval.createdAt ?? approval.created_at
    const history = approvalDecisionHistory(approval)
    const impact = el('p', {
      class: `need-impact${history ? ' approval-history' : ''}`,
      text:
        history !== null
          ? history.text
          : `请求时间：${approvalTimeLabel(createdAt)} · 批准只对这一次生效；长期授权请到「设置」里显式开启。`,
    })
    card.append(impact)

    const error = ui.inlineError()
    const note = ui.statusLine('')
    card.append(error)

    const refs = { buttons: [], statusBadge, error, note, actionRow: null, impact, card }
    if (pending) {
      const actionRow = el('div', { class: 'need-actions' })
      for (const action of approvalActions(approval)) {
        const button = ui.button(action.label, {
          variant: action.variant,
          size: 'sm',
          title:
            action.decision === 'approved'
              ? '只批准这一次；不会创建长期授权'
              : '拒绝这一次；不会创建房间',
        })
        button.addEventListener('click', () => void decide(approval, action, refs))
        refs.buttons.push(button)
        actionRow.append(button)
      }
      refs.actionRow = actionRow
      card.append(actionRow)
    }

    card.append(note)
    return card
  }

  for (const approval of model.pending) pendingList.append(approvalCard(approval))
  for (const approval of model.decided) decidedList.append(approvalCard(approval))
  board.append(countLine, pendingHeading, pendingEmpty, pendingList, decidedHeading, decidedList, empty)
  syncCount()

  return el('div', { class: 'stack' }, [header, board])
}
