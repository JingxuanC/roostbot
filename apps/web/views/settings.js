// 设置页：长期授权（docs/design/ui.md §3.3 / §12 待决 3）。
//
// 单次批准只对这一次生效；长期授权必须在这里显式创建，避免在审批卡上误点。
// 授权按 workspace + kind + action + target 精确匹配（不做通配）。
// 403 显示「仅 owner/admin 可管理」；404/405/501/503 降级为未就绪说明，不白屏。
// 所有用户输入只进 textContent / value / 属性，不拼 innerHTML。

import { el } from '../lib/dom.js'
import { isAuthError, isMissingRoute } from '../lib/api-client.js'
import { approvalGrantPayload, approvalGrantsView } from '../lib/approvals.js'
import * as ui from '../lib/ui.js'

const PAGE_TITLE = '设置'
const KIND_MAX = 80
const ACTION_MAX = 200
const TARGET_MAX = 500

function isNotReady(error) {
  if (!error) return false
  if (isMissingRoute(error)) return true
  if (error.status === 405 || error.status === 501) return true
  return error.status === 503 && error.code === 'runtime.not_configured'
}

function isPermissionError(error) {
  return Boolean(error && (error.status === 403 || error.code === 'forbidden'))
}

function grantsPath(workspaceId) {
  return `/api/approval-grants?workspaceId=${encodeURIComponent(workspaceId)}`
}

function notice(title, body, action) {
  return ui.emptyState({ title, body, action })
}

/**
 * @param {HTMLElement} root
 * @param {object} ctx {api, ensureWorkspaceId, requirePair, refreshNeedsCount}
 */
export async function mountSettingsPage(root, ctx) {
  root.replaceChildren(ui.loading('正在载入设置…'))

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
        message: `工作区载入失败：${error instanceof Error ? error.message : String(error)}`,
        onRetry: () => void mountSettingsPage(root, ctx),
        onPair: typeof ctx.hasToken === 'function' && ctx.hasToken() ? undefined : true,
      })
    )
    return
  }

  let grants = []
  let mode = 'ready'
  let loadError = null
  try {
    const data = await ctx.api.get(grantsPath(workspaceId))
    grants = Array.isArray(data?.grants) ? data.grants : []
  } catch (error) {
    if (isAuthError(error)) {
      ctx.requirePair()
      return
    }
    if (isPermissionError(error)) {
      mode = 'forbidden'
    } else if (isNotReady(error)) {
      mode = 'not-ready'
    } else {
      loadError = error
    }
  }

  if (loadError !== null) {
    root.replaceChildren(
      ui.pageHeader(PAGE_TITLE),
      ui.errorState({
        error: loadError,
        message: `长期授权载入失败：${loadError instanceof Error ? loadError.message : String(loadError)}`,
        onRetry: () => void mountSettingsPage(root, ctx),
      })
    )
    return
  }

  root.replaceChildren(settingsView(ctx, root, workspaceId, grants, mode))
  const main = root.closest('main')
  if (main) main.focus()
}

function settingsView(ctx, root, workspaceId, initialGrants, mode) {
  const header = ui.pageHeader(PAGE_TITLE, {
    subtitle: '单次批准不会写入长期授权；只有这里显式添加的授权才会自动放行。',
    actions: [ui.linkButton('需要你', '#/approvals', { variant: 'ghost' })],
  })

  const board = el('div', { class: 'page-card settings-board' })
  const description =
    '精确匹配，不支持通配；只对完全相同的 workspace + kind + action + target 请求生效。' +
    'action/target 留空表示只匹配「请求里同样没填」的情况。'

  if (mode === 'forbidden') {
    board.append(
      ui.section(
        '长期授权',
        [
          notice(
            '仅 owner/admin 可管理长期授权',
            '当前会话在这个工作区不是 owner/admin，所以不能查看或修改长期授权。审批页的单次批准仍然可用；需要长期授权时请让工作区 owner/admin 来这里添加。'
          ),
        ],
        { description }
      )
    )
    return el('div', { class: 'stack' }, [header, board])
  }

  if (mode === 'not-ready') {
    board.append(
      ui.section(
        '长期授权',
        [
          notice(
            '长期授权接口未就绪',
            '控制面还没有可用的 GET/POST /api/approval-grants（或返回 404/405/501/503）。界面不会假装已保存；接口上线后点「重试」即可。',
            ui.button('重试', { variant: 'primary', onClick: () => void mountSettingsPage(root, ctx) })
          ),
        ],
        { description }
      )
    )
    return el('div', { class: 'stack' }, [header, board])
  }

  let current = Array.isArray(initialGrants) ? initialGrants.slice() : []
  const statusLine = ui.statusLine('')
  const list = el('ul', { class: 'grant-list' })
  const emptyGrants = ui.emptyState({
    title: '还没有长期授权',
    body: '单次批准不会自动变成长期授权。确实需要「以后同类请求都放行」时，才在上面的表单里显式添加。',
  })

  function grantRow(grant) {
    const item = el('li', { class: 'grant-row' })
    const main = el('div', { class: 'grant-main' })
    const top = el('div', { class: 'grant-top' })
    top.append(ui.badge(grant.kindLabel, 'accent'))
    top.append(
      el('span', {
        class: 'grant-key',
        text: `${grant.actionLabel} · ${grant.targetLabel}`,
      })
    )
    main.append(top)

    const dl = el('dl', { class: 'need-meta grant-meta' })
    const fields = [
      ['kind', grant.kind],
      ['action', grant.actionLabel],
      ['target', grant.targetLabel],
      ['授权人', grant.grantedBy],
      ['时间', grant.grantedAtLabel],
    ]
    for (const [label, value] of fields) {
      const row = el('div')
      row.append(el('dt', { text: label }), el('dd', { text: value }))
      dl.append(row)
    }
    main.append(dl)
    const note = ui.statusLine('')
    main.append(note)

    const revoke = ui.button('撤销', {
      variant: 'ghost',
      size: 'sm',
      title: '撤销后这个长期授权立即失效；已发生的单次审批不受影响',
    })
    revoke.addEventListener('click', () => void revokeGrant(grant, revoke, note))
    item.append(main, el('div', { class: 'grant-actions' }, [revoke]))
    return item
  }

  function renderRows() {
    const view = approvalGrantsView(current)
    list.replaceChildren()
    for (const grant of view.rows) list.append(grantRow(grant))
    emptyGrants.hidden = view.rows.length > 0
  }

  async function reloadGrants() {
    const data = await ctx.api.get(grantsPath(workspaceId))
    current = Array.isArray(data?.grants) ? data.grants : []
    renderRows()
  }

  async function revokeGrant(grant, button, note) {
    const promptText = `撤销「${grant.kindLabel} · ${grant.actionLabel} · ${grant.targetLabel}」？撤销后这个长期授权立即失效。`
    if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(promptText)) {
      return
    }
    ui.setStatus(note, '')
    ui.setBusy(button, true, '撤销中…')
    try {
      await ctx.api.del(`/api/approval-grants/${encodeURIComponent(grant.id)}`)
      try {
        await reloadGrants()
      } catch {
        // DELETE 已成功；列表刷新失败时先本地移除，下一次进入页面会重新拉。
        current = current.filter((item) => item.id !== grant.id)
        renderRows()
      }
      ui.setStatus(statusLine, '已撤销这条长期授权。')
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      ui.setBusy(button, false)
      if (isPermissionError(cause)) {
        ui.setStatus(note, '仅 owner/admin 可管理长期授权。', 'error')
        return
      }
      if (isNotReady(cause)) {
        ui.setStatus(
          note,
          `长期授权接口未就绪（HTTP ${cause.status ?? '?'}）：这次没有撤销成功。`,
          'error'
        )
        return
      }
      ui.setStatus(note, `撤销失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error')
    }
  }

  const kind = ui.input({
    id: 'grant-kind',
    value: 'create_room',
    placeholder: '例如 create_room',
    maxlength: KIND_MAX,
    required: true,
  })
  const action = ui.input({
    id: 'grant-action',
    placeholder: '留空只匹配没填 action 的请求',
    maxlength: ACTION_MAX,
  })
  const target = ui.input({
    id: 'grant-target',
    placeholder: '留空只匹配没填 target 的请求',
    maxlength: TARGET_MAX,
  })
  const error = ui.inlineError()
  const submit = ui.button('添加长期授权', { variant: 'primary', type: 'submit' })
  const form = el('form', { class: 'form grant-form', novalidate: true })

  form.append(
    ui.field('kind', kind, {
      id: 'grant-kind',
      required: true,
      hint: `默认 create_room；也可以手填其它 kind（≤${KIND_MAX} 字）`,
    }),
    ui.field('action（可空）', action, {
      id: 'grant-action',
      hint: `精确匹配；≤${ACTION_MAX} 字。留空表示只匹配请求里同样没填 action 的情况。`,
    }),
    ui.field('target（可空）', target, {
      id: 'grant-target',
      hint: `精确匹配；≤${TARGET_MAX} 字。不支持通配，只对完全相同的请求生效。`,
    }),
    error,
    statusLine,
    el('div', { class: 'form-foot' }, [submit])
  )

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    ui.setError(error, '')
    ui.setStatus(statusLine, '')
    const payload = approvalGrantPayload({
      workspaceId,
      kind: kind.value,
      action: action.value,
      target: target.value,
    })
    if (payload === null) {
      ui.setError(error, 'kind 不能为空')
      kind.focus()
      return
    }
    ui.setBusy(submit, true, '添加中…')
    try {
      const created = await ctx.api.post('/api/approval-grants', payload)
      const grant = created && created.grant && typeof created.grant === 'object' ? created.grant : null
      try {
        await reloadGrants()
      } catch {
        // POST 已成功；刷新失败时把返回的授权补进列表（同 key 幂等，按 id 去重）。
        if (grant && typeof grant.id === 'string' && !current.some((item) => item.id === grant.id)) {
          current = [...current, grant]
          renderRows()
        }
      }
      action.value = ''
      target.value = ''
      ui.setStatus(statusLine, '已添加。只对完全相同的请求生效；不会影响已经发生的单次审批。')
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      if (isPermissionError(cause)) {
        ui.setError(error, '仅 owner/admin 可管理长期授权。')
        return
      }
      if (isNotReady(cause)) {
        ui.setError(
          error,
          `长期授权接口未就绪（HTTP ${cause.status ?? '?'}）：这次没有保存，也没有发生任何状态变化。`
        )
        return
      }
      ui.setError(error, `添加失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      ui.setBusy(submit, false)
    }
  })

  renderRows()
  board.append(
    ui.section('长期授权', [form], { description }),
    ui.section('当前授权', [emptyGrants, list], {
      description: '按授权时间升序；撤销后立即失效。',
    })
  )

  return el('div', { class: 'stack' }, [header, board])
}
