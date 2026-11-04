// 设置页：成员与角色、设备与吊销、长期授权。
//
// 数据来自：
//   GET    /api/workspaces/:id/members        → 成员分区（settings-members.js）
//   GET    /api/devices                       → 设备分区（settings-devices.js）
//   GET/POST/DELETE /api/approval-grants      → 长期授权（本文件）
// 三个分区各自加载、各自降级：一个接口 403/503 不拖垮其它分区。
// 401 一律回配对页；403 说明角色不足；503 runtime.not_configured 说接口未就绪。
// 所有用户可见文本只进 textContent / value，不拼 innerHTML。

import { el } from '../lib/dom.js'
import { isAuthError } from '../lib/api-client.js'
import { approvalGrantPayload, approvalGrantsView } from '../lib/approvals.js'
import { isSettingsForbidden, isSettingsNotReady } from '../lib/settings.js'
import * as ui from '../lib/ui.js'
import { membersSection } from './settings-members.js'
import { devicesSection } from './settings-devices.js'

const PAGE_TITLE = '设置'
const KIND_MAX = 80
const ACTION_MAX = 200
const TARGET_MAX = 500

function grantsPath(workspaceId) {
  return `/api/approval-grants?workspaceId=${encodeURIComponent(workspaceId)}`
}

function membersPath(workspaceId) {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/members`
}

function notice(title, body, action) {
  return ui.emptyState({ title, body, action })
}

function retryButton(root, ctx) {
  return ui.button('重试', { variant: 'primary', onClick: () => void mountSettingsPage(root, ctx) })
}

/**
 * 拉一个分区；返回 401 时交给调用方 requirePair，其余错误只写回槽位。
 * @returns {Promise<unknown|null>} 只返回鉴权错误
 */
async function loadSection(ctx, slot, path, key) {
  try {
    const data = await ctx.api.get(path)
    slot.rows = Array.isArray(data?.[key]) ? data[key] : []
    slot.mode = 'ready'
    slot.error = null
  } catch (error) {
    if (isAuthError(error)) return error
    slot.rows = []
    if (isSettingsForbidden(error)) slot.mode = 'forbidden'
    else if (isSettingsNotReady(error)) slot.mode = 'not-ready'
    else {
      slot.mode = 'error'
      slot.error = error
    }
  }
  return null
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

  const state = {
    workspaceId,
    // 当前账号在这个工作区的角色。拿不到时保持空：成员只读展示，不显示管理控件。
    role: '',
    members: { mode: 'ready', rows: [], error: null },
    devices: { mode: 'ready', rows: [], error: null },
    grants: { mode: 'ready', rows: [], error: null },
  }

  // 角色只用于「能不能显示管理控件」和「推断哪个成员是你」；失败不阻断页面。
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

  const authError =
    (await loadSection(ctx, state.members, membersPath(workspaceId), 'members')) ||
    (await loadSection(ctx, state.devices, '/api/devices', 'devices')) ||
    (await loadSection(ctx, state.grants, grantsPath(workspaceId), 'grants'))
  if (authError) {
    ctx.requirePair()
    return
  }

  root.replaceChildren(settingsView(ctx, root, state))
  const main = root.closest('main')
  if (main) main.focus()
}

function settingsView(ctx, root, state) {
  const header = ui.pageHeader(PAGE_TITLE, {
    subtitle: '成员、设备与长期授权都在这里管理；单次批准不会写入长期授权。',
    actions: [ui.linkButton('需要你', '#/approvals', { variant: 'ghost' })],
  })

  const remount = () => void mountSettingsPage(root, ctx)
  // 成员/设备分区需要 workspaceId 与当前角色；用页面上下文的副本传进去，不改原对象。
  const pageCtx = { ...ctx, workspaceId: state.workspaceId, role: state.role }

  const board = el('div', { class: 'page-card settings-board' })
  board.append(membersSection(pageCtx, state.members, remount))
  board.append(devicesSection(pageCtx, state.devices, remount))
  for (const node of grantsSections(ctx, root, state)) board.append(node)
  return el('div', { class: 'stack' }, [header, board])
}

// ---------------------------------------------------------------------------
// 长期授权（原有能力，保留）
// ---------------------------------------------------------------------------

function grantsSections(ctx, root, state) {
  const description =
    '精确匹配，不支持通配；只对完全相同的 workspace + kind + action + target 请求生效。' +
    'action/target 留空表示只匹配「请求里同样没填」的情况。'

  if (state.grants.mode === 'forbidden') {
    return [
      ui.section(
        '长期授权',
        [
          notice(
            '仅 owner/admin 可管理长期授权',
            '当前会话在这个工作区不是 owner/admin，所以不能查看或修改长期授权。审批页的单次批准仍然可用；需要长期授权时请让工作区 owner/admin 来这里添加。'
          ),
        ],
        { description }
      ),
    ]
  }

  if (state.grants.mode === 'not-ready') {
    return [
      ui.section(
        '长期授权',
        [
          notice(
            '长期授权接口未就绪',
            '控制面还没有可用的 GET/POST /api/approval-grants（或返回 404/405/501/503）。界面不会假装已保存；接口上线后点「重试」即可。',
            retryButton(root, ctx)
          ),
        ],
        { description }
      ),
    ]
  }

  if (state.grants.mode === 'error') {
    return [
      ui.section(
        '长期授权',
        [
          ui.errorState({
            error: state.grants.error,
            message: `长期授权载入失败：${
              state.grants.error instanceof Error ? state.grants.error.message : String(state.grants.error)
            }`,
            onRetry: () => void mountSettingsPage(root, ctx),
          }),
        ],
        { description }
      ),
    ]
  }

  let current = Array.isArray(state.grants.rows) ? state.grants.rows.slice() : []
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
    const data = await ctx.api.get(grantsPath(state.workspaceId))
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
      if (isSettingsForbidden(cause)) {
        ui.setStatus(note, '仅 owner/admin 可管理长期授权。', 'error')
        return
      }
      if (isSettingsNotReady(cause)) {
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
      workspaceId: state.workspaceId,
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
      if (isSettingsForbidden(cause)) {
        ui.setError(error, '仅 owner/admin 可管理长期授权。')
        return
      }
      if (isSettingsNotReady(cause)) {
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

  return [
    ui.section('长期授权', [form], { description }),
    ui.section('当前授权', [emptyGrants, list], {
      description: '按授权时间升序；撤销后立即失效。',
    }),
  ]
}
