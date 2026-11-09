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
import {
  notificationPermission,
  notificationUiState,
  permissionDeniedText,
  readNotificationPref,
  requestNotificationPermission,
  supportsNotifications,
  writeNotificationPref,
} from '../lib/notifications.js'
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

/**
 * 通知开关（ui.md §3.6，TODO 5.5.6）：只在 change 事件里请求权限（用户手势）。
 * 权限被拒绝时如实说明，不把开关留在「开」。
 */
/** 只读的本地 Computer 列表；绑定动作在 CLI 里完成（workdir 只存在本机）。 */
function computersSection(ctx, workspaceId) {
  const box = el('div', { class: 'stack' })
  const status = ui.statusLine('')
  const section = ui.section('已连接的电脑', [status, box], {
    description: '在本地运行 `roost setup` 后，这台电脑会出现在这里；绑定 Bot 用 `roost bind`。',
  })
  void load()
  return section

  async function load() {
    box.replaceChildren(ui.loading('正在载入电脑…'))
    ui.setStatus(status, '')
    try {
      const [computersData, bindingsData] = await Promise.all([
        ctx.api.get('/api/computers'),
        ctx.api.get(`/api/workspaces/${encodeURIComponent(workspaceId)}/computer-bindings`),
      ])
      const computers = Array.isArray(computersData?.computers) ? computersData.computers : []
      const bindings = Array.isArray(bindingsData?.bindings) ? bindingsData.bindings : []
      box.replaceChildren()
      if (computers.length === 0) {
        box.append(ui.emptyState({
          title: '还没有电脑',
          body: '在终端运行：roost login --token <CLI 令牌>，然后 roost setup。',
        }))
        return
      }
      for (const computer of computers) {
        const row = el('div', { class: 'computer-row' })
        const title = el('div', { class: 'computer-row-main' })
        title.append(el('strong', { text: computer.name || computer.id }))
        title.append(el('span', { class: 'computer-kind', text: computer.status || 'unknown' }))
        row.append(title)
        row.append(el('span', { class: 'computer-meta muted', text: `${computer.os || ''} ${computer.arch || ''}`.trim() }))
        const own = bindings.filter((binding) => binding.computerId === computer.id)
        if (own.length > 0) {
          const list = el('div', { class: 'computer-bindings' })
          for (const binding of own) {
            list.append(el('span', { class: 'computer-binding', text: `${binding.agentKind || 'agent'} · ${binding.workdirLabel || 'project'}` }))
          }
          row.append(list)
        }
        box.append(row)
      }
      if (bindings.length === 0) box.append(el('p', { class: 'muted', text: '还没有 Bot 绑定到本机；运行 `roost bind`。' }))
    } catch (error) {
      if (isAuthError(error)) { ctx.requirePair(); return }
      box.replaceChildren(ui.errorState({
        error,
        message: `电脑列表载入失败：${error instanceof Error ? error.message : String(error)}`,
        onRetry: () => void load(),
      }))
    }
  }
}

/** CLI token：让本地电脑通过 `roost login` 接入，不需要从浏览器手抄 cookie。 */
function cliSection(ctx) {
  const status = ui.statusLine('')
  const output = el('pre', { class: 'cli-token-output', hidden: true })
  const button = ui.button('生成 CLI 令牌', {
    variant: 'primary',
    onClick: async () => {
      ui.setBusy(button, true, '生成中…')
      ui.setStatus(status, '')
      try {
        const data = await ctx.api.post('/api/cli/tokens', { label: 'roost CLI' })
        const token = data && typeof data.token === 'string' ? data.token : ''
        if (token === '') throw new Error('服务端没有返回 token')
        const origin = (() => {
          try { return location.origin } catch { return 'https://roostbots.com' }
        })()
        output.textContent = `roost login --token ${token} --server ${origin}\nroost setup`
        output.hidden = false
        ui.setStatus(status, '令牌只显示一次。复制后运行上面的命令。')
        try { await navigator.clipboard?.writeText(output.textContent) } catch {}
      } catch (error) {
        if (isAuthError(error)) { ctx.requirePair(); return }
        ui.setStatus(status, `生成失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      } finally {
        ui.setBusy(button, false)
      }
    },
  })
  return ui.section('本地电脑', [button, status, output], {
    description: '安装 roost CLI 后，把本机作为执行节点接入 workspace。令牌只显示一次，可随时在设备列表吊销。',
  })
}

function notificationSection() {
  const supported = supportsNotifications()
  const permission = notificationPermission()
  const state = notificationUiState({
    supported,
    permission,
    enabled: supported && readNotificationPref(),
  })

  const checkbox = el('input', {
    type: 'checkbox',
    id: 'notify-needs',
    checked: state.checked,
    disabled: state.disabled,
  })
  const text = el('span', { class: 'notify-text' })
  text.append(el('span', { class: 'notify-label', text: '仅「需要你」时提醒' }))
  text.append(
    el('span', {
      class: 'notify-desc muted',
      text: '页面隐藏且出现新的待审批时弹系统通知；页面可见时只用应用内角标。',
    })
  )
  const row = el('label', { class: 'notify-row', for: 'notify-needs' }, [checkbox, text])
  const status = ui.statusLine(state.status)
  ui.setStatus(status, state.status, state.kind === 'error' ? 'error' : 'ok')

  checkbox.addEventListener('change', async () => {
    if (!checkbox.checked) {
      writeNotificationPref(false)
      ui.setStatus(status, '已关闭：只保留应用内角标。')
      return
    }
    checkbox.disabled = true
    try {
      const result = await requestNotificationPermission()
      if (result !== 'granted') {
        checkbox.checked = false
        writeNotificationPref(false)
        ui.setStatus(status, permissionDeniedText(result), 'error')
        return
      }
      writeNotificationPref(true)
      ui.setStatus(status, '已开启：页面隐藏且出现新的待审批时提醒；点通知会打开「需要你」。')
    } finally {
      checkbox.disabled = false
    }
  })

  return ui.section('通知', [row, status], {
    description: '安静优先：只有新的审批会提醒，Bot 的主动消息不会弹通知。',
  })
}

function settingsHub() {
  const links = [
    ['#/bots', 'Bot 与身份', '运行时、模型与工具权限'],
    ['#/plugins', '插件与面板', '扩展能力与面板'],
    ['#/usage', '用量与预算', 'Token 与成本'],
    ['#/schedules', '定时任务', '定时运行'],
    ['#/routines', '房间定时', '房间内的定时回合'],
    ['#/connectors', '连接器', '外部数据与工具'],
    ['#/approvals', '审批', '需要你决定的动作'],
  ]
  const nav = el('nav', { class: 'settings-hub', 'aria-label': '管理' })
  for (const [href, title, description] of links) {
    const link = el('a', { class: 'settings-hub-link', href })
    link.append(el('span', { class: 'settings-hub-title', text: title }))
    link.append(el('span', { class: 'settings-hub-desc', text: description }))
    link.append(el('span', { class: 'settings-hub-arrow', 'aria-hidden': 'true', text: '→' }))
    nav.append(link)
  }
  return nav
}

function settingsView(ctx, root, state) {
  const header = ui.pageHeader(PAGE_TITLE, {
    subtitle: '工作区、模型、成员与所有管理入口。',
    actions: [ui.linkButton('需要你', '#/approvals', { variant: 'ghost' })],
  })

  const remount = () => void mountSettingsPage(root, ctx)
  // 成员/设备分区需要 workspaceId 与当前角色；用页面上下文的副本传进去，不改原对象。
  const pageCtx = { ...ctx, workspaceId: state.workspaceId, role: state.role }

  const board = el('div', { class: 'page-card settings-board' })
  board.append(membersSection(pageCtx, state.members, remount))
  board.append(devicesSection(pageCtx, state.devices, remount))
  for (const node of grantsSections(ctx, root, state)) board.append(node)
  return el('div', { class: 'stack' }, [header, settingsHub(), cliSection(ctx), computersSection(ctx, state.workspaceId), notificationSection(), modelSection(ctx, state.workspaceId, state.role), board])
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
    ui.clearFieldInvalid(error)
    ui.setStatus(statusLine, '')
    const payload = approvalGrantPayload({
      workspaceId: state.workspaceId,
      kind: kind.value,
      action: action.value,
      target: target.value,
    })
    if (payload === null) {
      ui.setError(error, 'kind 不能为空')
      ui.setFieldInvalid(kind, true, error)
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

// ---------------------------------------------------------------------------
// 模型服务：BYO Key / 平台免费额度（2026-11-05）
// ---------------------------------------------------------------------------

const MODEL_PATH = (workspaceId) => `/api/workspaces/${encodeURIComponent(workspaceId)}/model`

function fmtTokens(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return String(value ?? '—')
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`
  return String(n)
}

function modelSection(ctx, workspaceId, role) {
  const box = el('div', { class: 'stack' })
  const section = ui.section('模型服务', [box], {
    description: '用自己的 DeepSeek / OpenAI-compatible Key；不填则使用平台免费额度。Key 只保存密文，页面只显示后 4 位。',
  })

  if (role !== 'owner' && role !== 'admin') {
    box.append(notice('仅 owner/admin 可管理模型 Key', '成员可以使用平台免费额度；自带 Key 需要 workspace owner/admin 设置。'))
    return section
  }
  void load()

  async function load() {
    box.replaceChildren(ui.loading('正在载入模型设置…'))
    let data
    try {
      data = await ctx.api.get(MODEL_PATH(workspaceId))
    } catch (error) {
      if (isAuthError(error)) {
        ctx.requirePair()
        return
      }
      box.replaceChildren(
        ui.errorState({
          error,
          message: `模型设置载入失败：${error instanceof Error ? error.message : String(error)}`,
          onRetry: () => void load(),
        })
      )
      return
    }
    render(data)
  }

  function render(data) {
    box.replaceChildren()
    const free = data?.free
    if (free) {
      const expires =
        typeof free.expiresAt === 'number' && free.expiresAt > 0
          ? ` · ${new Date(free.expiresAt).toLocaleDateString('zh-CN')} 过期`
          : ''
      box.append(
        el('p', {
          class: 'field-hint',
          text: `平台免费额度：${fmtTokens(free.balance)} tokens${expires} · 免费模型 ${free.model}`,
        })
      )
    }

    if (data?.byo) {
      const byo = data.byo
      box.append(
        el('div', { class: 'page-card model-current' }, [
          el('p', { class: 'field-label', text: '当前使用：自带 Key' }),
          el('p', { class: 'field-hint', text: `${byo.provider} · ${byo.model} · ${byo.baseUrl} · 密钥 ${byo.keyHint}` })
        ])
      )
      const actions = el('div', { class: 'section-actions' })
      actions.append(ui.button('测试连接', { variant: 'outline', onClick: () => void testSaved() }))
      actions.append(ui.button('更换 Key', { variant: 'primary', onClick: () => renderForm(byo) }))
      actions.append(ui.button('删除 Key', { variant: 'ghost', onClick: () => void remove() }))
      box.append(actions)
      return
    }
    renderForm(null)
  }

  function renderForm(current) {
    box.querySelectorAll('.model-form').forEach((node) => node.remove())
    const provider = ui.select({
      id: 'model-provider',
      options: [
        { value: 'deepseek', label: 'DeepSeek' },
        { value: 'openai-compatible', label: 'OpenAI-compatible' }
      ],
      value: current?.provider || 'deepseek'
    })
    const baseUrl = ui.input({
      id: 'model-base-url',
      value: current?.baseUrl || 'https://api.deepseek.com',
      placeholder: 'https://api.deepseek.com',
      required: true
    })
    const model = ui.input({
      id: 'model-name',
      value: current?.model || 'deepseek-flash',
      placeholder: 'deepseek-flash',
      required: true
    })
    const apiKey = ui.input({
      id: 'model-api-key',
      type: 'password',
      placeholder: current ? `留空则保留当前密钥（${current.keyHint}）` : 'sk-...',
      autocomplete: 'off',
      required: !current
    })
    const status = ui.statusLine('')
    status.hidden = true
    const saveButton = ui.button('保存并测试', {
      variant: 'primary',
      onClick: () => void save({ provider, baseUrl, model, apiKey, status, button: saveButton })
    })
    const form = el('div', { class: 'stack model-form' }, [
      ui.field('Provider', provider, { id: 'model-provider' }),
      ui.field('Base URL', baseUrl, { id: 'model-base-url', hint: '只接受 https；本地开发允许 http://localhost。末尾 /v1 会自动去掉。' }),
      ui.field('模型', model, { id: 'model-name', hint: '免费额度只允许平台免费模型；BYO 可填自己的模型名。' }),
      ui.field('API Key', apiKey, { id: 'model-api-key', hint: '只保存密文，服务端不会回显；留空表示只更新上面三项。' }),
      status,
      el('div', { class: 'section-actions' }, [
        saveButton,
        ui.button('取消', { variant: 'ghost', onClick: () => load() })
      ])
    ])
    box.append(form)
  }

  async function save({ provider, baseUrl, model, apiKey, status, button }) {
    ui.setBusy(button, true, '保存中…')
    status.hidden = true
    try {
      await ctx.api.request('PUT', MODEL_PATH(workspaceId), {
        provider: provider.value.trim(),
        baseUrl: baseUrl.value.trim(),
        model: model.value.trim(),
        ...(apiKey.value.trim() === '' ? {} : { apiKey: apiKey.value.trim() })
      })
      ui.setStatus(status, '已保存，正在测试连接…')
      status.hidden = false
      await test({
        provider: provider.value.trim(),
        baseUrl: baseUrl.value.trim(),
        model: model.value.trim(),
        apiKey: apiKey.value.trim(),
        status
      })
      await load()
    } catch (error) {
      if (isAuthError(error)) return ctx.requirePair()
      ui.setStatus(status, error instanceof Error ? error.message : String(error), 'error')
      status.hidden = false
    } finally {
      ui.setBusy(button, false)
    }
  }

  async function testSaved() {
    await test({ status: null })
  }

  async function test({ provider, baseUrl, model, apiKey, status }) {
    if (status) {
      status.hidden = false
      ui.setStatus(status, '正在测试连接…')
    }
    try {
      const result = await ctx.api.post(`${MODEL_PATH(workspaceId)}/test`, {
        ...(provider ? { provider } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(model ? { model } : {}),
        ...(apiKey ? { apiKey } : {})
      })
      if (status) {
        if (result?.ok) ui.setStatus(status, `连接正常（${result.latencyMs ?? 0}ms）`)
        else ui.setStatus(status, `连接失败${result?.status ? `：HTTP ${result.status}` : result?.error ? `：${result.error}` : ''}`, 'error')
      }
    } catch (error) {
      if (status) ui.setStatus(status, error instanceof Error ? error.message : String(error), 'error')
      if (isAuthError(error)) ctx.requirePair()
    }
  }

  async function remove() {
    try {
      await ctx.api.del(MODEL_PATH(workspaceId))
      await load()
    } catch (error) {
      if (isAuthError(error)) return ctx.requirePair()
      box.prepend(el('p', { class: 'field-hint', text: `删除失败：${error instanceof Error ? error.message : String(error)}` }))
    }
  }

  return section
}
