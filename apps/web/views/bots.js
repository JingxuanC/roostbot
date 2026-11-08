// Bot 列表与设置页（docs/design/bots.md §4、docs/design/ui.md §3.7）。
// 页面只做展示与表单；请求都经 ctx.api，错误显示在原地。

import { botAvatar, el } from '../lib/dom.js'
import { button, field } from '../lib/components.js'
import { isAuthError } from '../lib/api-client.js'
import { AVATAR_ACCEPT, avatarLabel, isAvatarDataUrl, readAvatarFile } from '../lib/avatar.js'
import { memberNameConflict } from '../lib/mentions.js'
import { installsListPath, toolSourceRows } from '../lib/installs.js'
import * as ui from '../lib/ui.js'

const NAME_MAX = 40
const ROLE_MAX = 24
const PERSONA_MAX = 20_000

export const APPROVAL_LABELS = {
  ask: '每次询问',
  edits: '只有编辑免问',
  auto: '自动执行',
  full: '完全放开',
}

const APPROVAL_OPTIONS = [
  { value: 'ask', label: '每次询问' },
  { value: 'edits', label: '只有编辑免问' },
  { value: 'auto', label: '自动执行' },
  { value: 'full', label: '完全放开（默认）' },
]

const MEMORY_OPTIONS = [
  { value: 'team', label: '团队', description: '所有房间都能读到' },
  { value: 'room', label: '房间', description: '只在这个房间生效' },
  { value: 'member', label: '个人', description: '只跟这个 Bot 有关' },
]

// ---- 运行时（docs/design/agent-runtimes.md §5/§6/§10）----------------------
// 字段形状以后端并行实现为准：Bot/Create/Update 增加 runtimeKind（默认 dsh）、
// 可选 runtimeConfig / credentialRef / capabilities。这里只做展示与选择，
// 能力缺失时显示「未探测」，绝不把缺失当成「支持」。
export const DEFAULT_RUNTIME = 'dsh'
export const RUNTIME_OPTIONS = [
  { value: 'dsh', label: 'DSH', short: 'DSH' },
  { value: 'grok-build', label: 'Grok Build', short: 'Grok Build' },
  { value: 'claude-code', label: 'Claude Code', short: 'Claude' },
  { value: 'codex', label: 'Codex', short: 'Codex' },
  { value: 'hermes', label: 'Hermes', short: 'Hermes' },
]
const RUNTIME_BY_VALUE = new Map(RUNTIME_OPTIONS.map((option) => [option.value, option]))

const CAPABILITY_FIELDS = [
  { key: 'streaming', label: '流式', format: boolCapability },
  { key: 'tools', label: '工具', format: (value) => enumCapability(value, { native: '原生', platform: '平台', none: '无' }) },
  { key: 'permissions', label: '权限', format: (value) => enumCapability(value, { native: '原生', bridge: '桥接', none: '无' }) },
  { key: 'images', label: '图片', format: imagesCapability },
  { key: 'resume', label: '恢复', format: boolCapability },
]

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // 后端存的是 TEXT 时也可能是坏 JSON；按「未探测」处理，不猜。
    }
  }
  return null
}

function boolCapability(value) {
  if (value === true) return '支持'
  if (value === false) return '不支持'
  return '未知'
}

function enumCapability(value, labels) {
  if (typeof value !== 'string' || value === '') return '未知'
  return labels[value] || value
}

function imagesCapability(value) {
  const images = parseObject(value)
  if (!images) return '未知'
  const parts = []
  if (images.input === true) parts.push('输入')
  if (images.output === true) parts.push('输出')
  if (parts.length > 0) return parts.join('+')
  if (images.input === false && images.output === false) return '无'
  return '未知'
}

/** Bot 的 runtimeKind；缺省按契约视为 dsh，未知字符串原样返回（不冒充 dsh）。 */
export function botRuntimeKind(bot) {
  const raw = bot && typeof bot === 'object' ? bot.runtimeKind ?? bot.runtime_kind : undefined
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  return DEFAULT_RUNTIME
}

/** 列表/标题里的短标签；未知值显示「未知」，不猜成某个已知运行时。 */
export function runtimeKindLabel(kind) {
  const option = RUNTIME_BY_VALUE.get(String(kind ?? ''))
  return option ? option.short : '未知'
}

/** 服务端缓存的能力对象；缺失/空对象/坏 JSON 都返回 null（= 未探测）。 */
export function botCapabilities(bot) {
  const raw = parseObject(
    (bot && (bot.capabilities ?? bot.runtimeCapabilities ?? bot.runtime_capabilities)) || null
  )
  if (!raw) return null
  const nested = parseObject(raw.capabilities)
  const capabilities = nested || raw
  const known = CAPABILITY_FIELDS.some(
    (field) => capabilities[field.key] !== undefined && capabilities[field.key] !== null
  )
  return known ? capabilities : null
}

/** 服务端探测结果（契约未强制；有就展示，不伪造）。 */
export function botRuntimeProbe(bot) {
  const raw = parseObject(
    (bot && (bot.runtimeProbe ?? bot.runtime_probe ?? bot.probe)) || null
  )
  if (!raw || typeof raw.ok !== 'boolean') return null
  const problems = Array.isArray(raw.problems)
    ? raw.problems.filter((item) => typeof item === 'string' && item.trim() !== '').slice(0, 3)
    : []
  return { ok: raw.ok === true, problems }
}

/** 紧凑能力摘要：known=false 表示「未探测」，items 中的「未知」不当作支持。 */
export function capabilitySummary(bot) {
  const capabilities = botCapabilities(bot)
  const probe = botRuntimeProbe(bot)
  if (!capabilities) return { known: false, items: [], probe }
  const items = CAPABILITY_FIELDS.map((field) => {
    const value = capabilities[field.key]
    return {
      key: field.key,
      label: field.label,
      value: field.format(value),
      known: value !== undefined && value !== null,
    }
  })
  return { known: true, items, probe }
}

function runtimeTagNode(bot) {
  const kind = botRuntimeKind(bot)
  const known = RUNTIME_BY_VALUE.has(kind)
  return el('span', {
    class: `runtime-tag${known ? '' : ' is-unknown'}`,
    text: known ? runtimeKindLabel(kind) : '未知',
    title: known ? `运行时：${runtimeKindLabel(kind)}` : `未知运行时：${kind}`,
  })
}

export function botStatusLabel(status) {
  if (status === 'paused') return '已暂停'
  if (status === 'active') return '在岗'
  return status || '未知'
}

export function parseList(text) {
  const seen = new Set()
  const values = []
  for (const part of String(text ?? '').split(/[\n,，;；]+/)) {
    const value = part.trim()
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    values.push(value)
  }
  return values
}

function normalizeBot(payload) {
  const bot = payload && typeof payload === 'object' && payload.bot ? payload.bot : payload
  if (!bot || typeof bot !== 'object') return null
  return {
    ...bot,
    skills: Array.isArray(bot.skills) ? bot.skills : [],
    tools: Array.isArray(bot.tools) ? bot.tools : [],
    toolsAllow: Array.isArray(bot.toolsAllow) ? bot.toolsAllow : [],
    toolsDeny: Array.isArray(bot.toolsDeny) ? bot.toolsDeny : [],
    memoryScopes: Array.isArray(bot.memoryScopes) ? bot.memoryScopes : [],
    status: bot.status === 'paused' ? 'paused' : 'active',
    runtimeKind: botRuntimeKind(bot),
  }
}

function statusBadge(status) {
  return ui.badge(botStatusLabel(status), status === 'paused' ? 'warn' : 'ok')
}

function botRow(ctx, bot) {
  const href = `#/bots/${encodeURIComponent(bot.id)}`
  const link = el('a', { class: 'bot-card', href })
  link.append(botAvatar(bot, 32))
  const main = el('div', { class: 'bot-card-main' })
  const top = el('div', { class: 'bot-card-top' })
  top.append(el('span', { class: 'bot-card-name', text: bot.name }))
  top.append(statusBadge(bot.status))
  top.append(runtimeTagNode(bot))
  main.append(top)
  if (bot.role) main.append(el('p', { class: 'bot-card-role', text: bot.role }))
  const meta = []
  if (bot.model) meta.push(`模型 ${bot.model}`)
  meta.push(`审批 ${APPROVAL_LABELS[bot.approval] || bot.approval || '未知'}`)
  if (bot.skills.length > 0) meta.push(`技能 ${bot.skills.length}`)
  main.append(el('p', { class: 'bot-card-meta muted', text: meta.join(' · ') }))
  link.append(main)
  link.append(el('span', { class: 'row-chev', 'aria-hidden': 'true', text: '›' }))

  const item = el('li', { class: 'bot-card-item' }, [link])
  const dmButton = el('button', {
    class: 'bot-dm-button',
    type: 'button',
    'aria-label': `和 ${bot.name} 私聊`,
    text: '私聊',
  })
  dmButton.addEventListener('click', async (event) => {
    event.preventDefault()
    event.stopPropagation()
    dmButton.disabled = true
    dmButton.textContent = '打开中…'
    try {
      await ctx.openBotDm(bot.id)
    } catch (error) {
      dmButton.textContent = '打开失败'
      dmButton.title = error instanceof Error ? error.message : String(error)
      setTimeout(() => {
        if (dmButton.isConnected) {
          dmButton.disabled = false
          dmButton.textContent = '私聊'
          dmButton.title = ''
        }
      }, 1800)
    }
  })
  item.append(dmButton)
  return item
}

function archivedFilterRow() {
  const row = el('div', { class: 'bot-filter-row' })
  const chip = el('button', {
    class: 'filter-chip',
    type: 'button',
    text: '已删除',
    disabled: true,
    title: '恢复接口未就绪：控制面没有列出已删除 Bot 或恢复的接口',
  })
  row.append(
    chip,
    el('p', {
      class: 'field-hint',
      text: '软删恢复未上线：DELETE /api/bots/:id 目前是硬删，也没有恢复接口，所以「已删除」只是禁用态。',
    })
  )
  return row
}

function listShell(ctx, bots) {
  const header = ui.pageHeader('Bot', {
    subtitle: bots.length ? `共 ${bots.length} 个 · 点开是设置；私聊直接进对话` : '长期身份；进房间的是它的脸',
    actions: ui.linkButton('新建 Bot', '#/bots/new', { variant: 'primary' }),
  })
  const board = el('div', { class: 'page-card' })
  board.append(archivedFilterRow())
  if (bots.length === 0) {
    board.append(
      ui.emptyState({
        title: '还没有 Bot',
        body: '先建一个 Bot，再把它拉进房间。名字在同一个工作区里唯一。',
        action: ui.linkButton('新建 Bot', '#/bots/new', { variant: 'primary' }),
      })
    )
  } else {
    board.append(el('ul', { class: 'bot-cards' }, bots.map((bot) => botRow(ctx, bot))))
  }
  return el('div', { class: 'stack' }, [header, board])
}

/**
 * @param {HTMLElement} root
 * @param {object} ctx {api, loadBots, navigate, requirePair, refreshSidebar}
 * @param {{create?: boolean}} [options]
 */
export async function mountBotsPage(root, ctx, options = {}) {
  root.replaceChildren(ui.loading(options.create ? '准备新建 Bot…' : '正在载入 Bot…'))
  let bots
  try {
    bots = await ctx.loadBots({ force: true })
  } catch (error) {
    if (isAuthError(error)) {
      ctx.requirePair()
      return
    }
    root.replaceChildren(
      ui.pageHeader('Bot'),
      ui.errorState({
        error,
        message: `Bot 列表载入失败：${error instanceof Error ? error.message : String(error)}`,
        onRetry: () => mountBotsPage(root, ctx, options),
        onPair: ctx.hasToken() ? undefined : true,
      })
    )
    return
  }

  if (options.create) {
    root.replaceChildren(createView(ctx, bots))
    const first = root.querySelector('input')
    if (first) first.focus()
    return
  }
  root.replaceChildren(listShell(ctx, bots))
}

function createView(ctx, bots) {
  const header = ui.pageHeader('新建 Bot', {
    back: { href: '#/bots', label: 'Bot 列表' },
    subtitle: '创建轻、设置重：这里只填身份，人设与能力在设置页里补。',
  })
  const name = ui.input({ id: 'bot-name', placeholder: '例如 选股师', maxlength: NAME_MAX, required: true })
  const role = ui.input({ id: 'bot-role', placeholder: '例如 选股', maxlength: ROLE_MAX })
  const model = ui.input({ id: 'bot-model', placeholder: '例如 deepseek-chat', maxlength: 80, required: true })
  const runtime = ui.select({
    id: 'bot-runtime',
    options: RUNTIME_OPTIONS.map((option) => ({
      value: option.value,
      label: option.value === DEFAULT_RUNTIME ? `${option.label}（默认）` : option.label,
    })),
    value: DEFAULT_RUNTIME,
  })
  const error = ui.inlineError()
  const submit = button({ label: '创建 Bot', variant: 'primary', type: 'submit' })
  const form = el('form', { class: 'form page-card', novalidate: true })

  form.append(
    ui.section('身份', [
      field({ label: '名字', control: name, id: 'bot-name', required: true, hint: `≤${NAME_MAX} 字，同一个工作区里不能重名` }),
      field({ label: '角色', control: role, id: 'bot-role', hint: `≤${ROLE_MAX} 字，只影响默认提示词` }),
    ])
  )
  form.append(
    ui.section(
      '模型',
      [
        field({
          label: '运行时',
          control: runtime,
          id: 'bot-runtime',
          hint: '默认 DSH。其它运行时需要服务端已装好对应 CLI 与凭据；能力以服务端探测为准。',
        }),
        field({
          label: '模型',
          control: model,
          id: 'bot-model',
          required: true,
          hint: '创建时固定，之后全局默认变了不影响它（服务端要求创建时必须给模型）',
        }),
      ],
      { description: '创建后模型不再跟随全局默认（docs/design/bots.md §2）。运行时决定房间里的 Agent 适配器（docs/design/agent-runtimes.md §10）。' }
    )
  )
  form.append(error)
  const foot = el('div', { class: 'form-foot' })
  foot.append(ui.linkButton('取消', '#/bots', { variant: 'ghost' }), submit)
  form.append(foot)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    ui.setError(error, '')
    ui.clearFieldInvalid(error)
    const cleanName = name.value.trim()
    const cleanRole = role.value.trim()
    if (cleanName === '') {
      ui.setError(error, '名字不能为空')
      ui.setFieldInvalid(name, true, error)
      name.focus()
      return
    }
    if (cleanName.length > NAME_MAX) {
      ui.setError(error, `名字最多 ${NAME_MAX} 字`)
      ui.setFieldInvalid(name, true, error)
      name.focus()
      return
    }
    if (cleanRole.length > ROLE_MAX) {
      ui.setError(error, `角色最多 ${ROLE_MAX} 字`)
      ui.setFieldInvalid(role, true, error)
      role.focus()
      return
    }
    if (model.value.trim() === '') {
      ui.setError(error, '模型不能为空（创建时固定）')
      ui.setFieldInvalid(model, true, error)
      model.focus()
      return
    }
    const conflict = memberNameConflict(cleanName, bots)
    if (conflict) {
      ui.setError(error, `已经有同名 Bot：${conflict.name}。换一个名字，或去它的设置页改名。`)
      ui.setFieldInvalid(name, true, error)
      name.focus()
      return
    }

    ui.setBusy(submit, true, '创建中…')
    try {
      const workspaceId = await ctx.ensureWorkspaceId()
      const payload = {
        workspaceId,
        name: cleanName,
        model: model.value.trim(),
        runtimeKind: runtime.value,
      }
      if (cleanRole !== '') payload.role = cleanRole
      const created = normalizeBot(await ctx.api.post('/api/bots', payload))
      try {
        await ctx.loadBots({ force: true })
        await ctx.loadRooms({ force: true })
        ctx.refreshSidebar?.()
      } catch {
        // 列表刷新失败不影响创建成功；设置页会自己再取一次。
      }
      if (created && typeof created.id === 'string' && created.id !== '') {
        // A new Bot is a new private conversation: open it immediately, like
        // adding a contact in a chat app. Its DM also appears in the sidebar.
        try {
          await ctx.openBotDm(created.id)
        } catch {
          ctx.navigate(`#/bots/${encodeURIComponent(created.id)}`)
        }
      } else {
        ctx.navigate('#/bots')
      }
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      ui.setError(error, cause instanceof Error ? cause.message : String(cause))
      ui.setBusy(submit, false)
    }
  })

  return el('div', { class: 'stack' }, [header, form])
}

/**
 * Bot 设置页：身份 / 人设 / 技能 / 工具 / 审批 / 记忆 / 模型 / 状态 / 危险区。
 */
export async function mountBotSettingsPage(root, ctx, botId) {
  root.replaceChildren(ui.loading('正在载入 Bot…'))
  const path = `/api/bots/${encodeURIComponent(botId)}`
  let bot = null
  let bots = []
  try {
    bots = await ctx.loadBots()
  } catch (error) {
    if (isAuthError(error)) {
      ctx.requirePair()
      return
    }
    // 列表失败不阻塞详情；详情自己会报错。
    bots = []
  }
  try {
    bot = normalizeBot(await ctx.api.get(path))
  } catch (error) {
    if (isAuthError(error)) {
      ctx.requirePair()
      return
    }
    const cached = bots.find((item) => item.id === botId)
    if (cached && error && error.status === 404) {
      bot = cached
    } else {
      root.replaceChildren(
        ui.pageHeader('Bot 设置', { back: { href: '#/bots', label: 'Bot 列表' } }),
        ui.errorState({
          error,
          message: `这个 Bot 载入失败：${error instanceof Error ? error.message : String(error)}`,
          onRetry: () => mountBotSettingsPage(root, ctx, botId),
        })
      )
      return
    }
  }

  function render() {
    root.replaceChildren(settingsView(ctx, bot, bots))
    const main = root.closest('main')
    if (main) main.focus()
  }
  render()
}

function settingsView(ctx, bot, bots) {
  const path = `/api/bots/${encodeURIComponent(bot.id)}`
  const header = el('header', { class: 'page-title-head' })
  header.append(el('a', { class: 'back-link', href: '#/bots', text: '← Bot 列表' }))
  const titleRow = el('div', { class: 'page-title-row bot-title-row' })
  let titleAvatar = botAvatar(bot, 40)
  titleRow.append(titleAvatar)
  const titleText = el('div', { class: 'bot-title-text' })
  titleText.append(el('h1', { class: 'page-title', text: bot.name }))
  if (bot.role) titleText.append(el('p', { class: 'page-subtitle muted', text: `角色：${bot.role}` }))
  titleRow.append(titleText)
  let statusNode = statusBadge(bot.status)
  titleRow.append(statusNode)
  let runtimeTitleTag = runtimeTagNode(bot)
  titleRow.append(runtimeTitleTag)
  const actions = el('div', { class: 'page-title-actions' })

  const dmButton = ui.button('私聊', {
    variant: 'primary',
    size: 'sm',
    onClick: async () => {
      ui.setBusy(dmButton, true, '打开中…')
      try {
        await ctx.openBotDm(bot.id)
      } catch (error) {
        ui.setStatus(globalStatus, `私聊打开失败：${error instanceof Error ? error.message : String(error)}`, 'error')
        ui.setBusy(dmButton, false)
      }
    },
  })
  actions.append(dmButton)

  const globalStatus = ui.statusLine('')
  const pauseButton = ui.button(bot.status === 'paused' ? '恢复' : '暂停', {
    variant: 'ghost',
    size: 'sm',
    onClick: () => toggleStatus(bot.status === 'paused' ? 'active' : 'paused'),
  })
  actions.append(pauseButton)

  async function toggleStatus(next) {
    ui.setBusy(pauseButton, true, next === 'paused' ? '暂停中…' : '恢复中…')
    ui.setStatus(globalStatus, '')
    try {
      await ctx.api.patch(path, { status: next })
      bot.status = next
      const nextBadge = statusBadge(next)
      statusNode.replaceWith(nextBadge)
      statusNode = nextBadge
      // 先改 dataset.label，finally 的 setBusy(false) 才不会把按钮文案还原成旧动作。
      pauseButton.dataset.label = next === 'paused' ? '恢复' : '暂停'
      pauseButton.textContent = pauseButton.dataset.label
      ui.setStatus(globalStatus, next === 'paused' ? '已暂停：不接新轮次，进行中的回合会跑完。' : '已恢复。')
      try {
        await ctx.loadBots({ force: true })
      } catch {
        // 侧栏刷新失败不影响本页。
      }
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      ui.setStatus(globalStatus, `操作失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error')
    } finally {
      ui.setBusy(pauseButton, false)
    }
  }

  header.append(titleRow, actions, globalStatus)

  // ---- 身份 ----
  const name = ui.input({ id: 'bot-setting-name', value: bot.name, maxlength: NAME_MAX, required: true })
  const role = ui.input({ id: 'bot-setting-role', value: bot.role || '', maxlength: ROLE_MAX })
  const persona = ui.textarea({ id: 'bot-setting-persona', value: bot.persona || '', rows: 8, maxlength: PERSONA_MAX, placeholder: '它长期是谁、怎么工作、在意什么…' })
  const skills = ui.textarea({ id: 'bot-setting-skills', value: bot.skills.join('\n'), rows: 3, placeholder: '每行一个，例如 stock-snapshot' })
  const toolsAllow = ui.textarea({ id: 'bot-setting-tools-allow', value: bot.toolsAllow.join('\n'), rows: 3, placeholder: '每行一个，例如 mcp__data__*' })
  const toolsDeny = ui.textarea({ id: 'bot-setting-tools-deny', value: bot.toolsDeny.join('\n'), rows: 3, placeholder: '每行一个，例如 bash' })
  const approval = ui.select({ id: 'bot-setting-approval', options: APPROVAL_OPTIONS, value: bot.approval || 'ask' })
  const memory = ui.checkboxList({
    legend: '记忆作用域',
    name: 'memory-scopes',
    items: MEMORY_OPTIONS.map((option) => ({ ...option, checked: bot.memoryScopes.includes(option.value) })),
  })
  const model = ui.input({ id: 'bot-setting-model', value: bot.model || '', maxlength: 80 })

  // ---- 运行时：选择 + 能力摘要（§10「UI 按能力渲染」）----
  // 缺 capabilities 时显示「未探测」，绝不显示成「支持」；credentialRef 只读展示，不编辑明文。
  function runtimeOptionsFor(kind) {
    const options = RUNTIME_OPTIONS.map((option) => ({
      value: option.value,
      label: option.value === DEFAULT_RUNTIME ? `${option.label}（默认）` : option.label,
    }))
    if (!RUNTIME_BY_VALUE.has(kind)) {
      options.unshift({ value: kind, label: `未知（${kind}）`, disabled: true })
    }
    return options
  }

  const currentRuntime = botRuntimeKind(bot)
  const runtime = ui.select({
    id: 'bot-setting-runtime',
    options: runtimeOptionsFor(currentRuntime),
    value: currentRuntime,
  })
  const runtimeBox = el('div', { class: 'runtime-detail' })

  function buildRuntimeDetail() {
    const nodes = []
    const summary = capabilitySummary(bot)
    const head = el('div', { class: 'runtime-capability-head' })
    head.append(el('span', { class: 'runtime-capability-label', text: summary.known ? '能力（服务端缓存）' : '能力' }))
    head.append(
      el('span', {
        class: `runtime-capability-state${summary.known ? '' : ' is-unknown'}`,
        text: summary.known ? '已上报' : '未探测',
      })
    )
    nodes.push(head)
    if (summary.known) {
      const list = el('div', { class: 'runtime-capabilities' })
      for (const item of summary.items) {
        const cell = el('span', { class: `runtime-capability${item.known ? '' : ' is-unknown'}` })
        cell.append(el('span', { class: 'runtime-capability-key', text: `${item.label} ` }))
        cell.append(el('strong', { class: 'runtime-capability-value', text: item.value }))
        list.append(cell)
      }
      nodes.push(list)
      if (summary.items.some((item) => !item.known)) {
        nodes.push(el('p', { class: 'field-hint', text: '部分能力服务端未上报，显示为「未知」；未知不等于支持。' }))
      }
      nodes.push(
        el('p', {
          class: 'field-hint',
          text: '能力来自服务端缓存；切换运行时后要等新的探测/协商刷新，缓存可能滞后。',
        })
      )
    } else {
      nodes.push(
        el('p', {
          class: 'field-hint',
          text: '未探测：服务端还没有这个运行时的能力数据（streaming / tools / permissions / images / resume），这里不假设它支持。',
        })
      )
    }
    const probe = summary.probe
    if (probe) {
      nodes.push(
        el('p', {
          class: `runtime-probe${probe.ok ? '' : ' is-warn'}`,
          text: `探测：${probe.ok ? '通过' : '未通过'}${probe.problems.length > 0 ? ` · ${probe.problems.join('；')}` : ''}`,
        })
      )
    } else {
      nodes.push(
        el('p', {
          class: 'field-hint',
          text: '探测状态未上报；可用性以服务端探测为准，UI 不据此宣称可用。',
        })
      )
    }
    const credentialRef =
      typeof bot.credentialRef === 'string'
        ? bot.credentialRef
        : typeof bot.credential_ref === 'string'
          ? bot.credential_ref
          : ''
    if (credentialRef !== '') {
      nodes.push(el('p', { class: 'runtime-credential', text: `凭据引用：${credentialRef}（只读；明文由服务端托管）` }))
    }
    return nodes
  }

  function refreshRuntimeUi() {
    const kind = botRuntimeKind(bot)
    ui.setSelectOptions(runtime, runtimeOptionsFor(kind), kind)
    runtimeBox.replaceChildren(...buildRuntimeDetail())
    const nextTag = runtimeTagNode(bot)
    runtimeTitleTag.replaceWith(nextTag)
    runtimeTitleTag = nextTag
  }

  runtimeBox.replaceChildren(...buildRuntimeDetail())

  // ---- 头像上传（addendum §C）：本地读成 dataURL，保存时才随 PATCH 发 avatar.image ----
  let avatarDraft = {
    image: isAvatarDataUrl(bot.avatar && bot.avatar.image) ? bot.avatar.image : '',
    dirty: false,
  }
  const avatarPreview = el('div', { class: 'avatar-editor-preview' })
  const avatarHint = el('p', { class: 'field-hint' })
  const avatarError = ui.inlineError()
  const avatarStatus = ui.statusLine('')
  const avatarFile = el('input', {
    class: 'input avatar-file',
    id: 'bot-setting-avatar',
    type: 'file',
    accept: AVATAR_ACCEPT,
    'aria-label': '上传 Bot 图标（PNG / JPEG / WebP / GIF，≤256KB）',
  })
  const avatarRemove = ui.button('移除图片', { variant: 'ghost', size: 'sm' })

  function avatarBase() {
    const base = bot.avatar && typeof bot.avatar === 'object' ? { ...bot.avatar } : {}
    if (avatarDraft.image === '') delete base.image
    else base.image = avatarDraft.image
    return base
  }

  function renderAvatar() {
    const base = avatarBase()
    avatarPreview.replaceChildren(botAvatar({ id: bot.id, avatar: base }, 64))
    avatarHint.textContent = `当前：${avatarLabel({ avatar: base })}${avatarDraft.dirty ? ' · 尚未保存' : ''}`
    avatarRemove.disabled = avatarDraft.image === ''
    avatarRemove.title = avatarDraft.image === '' ? '现在没有上传图片' : '移除图片；保存后恢复程序化图标'
  }

  avatarFile.addEventListener('change', async () => {
    const file = avatarFile.files && avatarFile.files[0]
    if (!file) return
    // 立刻清空 input：同一个文件再选一次也要触发 change；读取期间不让文件名残留。
    avatarFile.value = ''
    ui.setError(avatarError, '')
    ui.setStatus(avatarStatus, '正在读取图片…')
    const result = await readAvatarFile(file)
    if (!result.ok) {
      // 失败时不动 avatarDraft：预览和保存内容都保持原样。
      ui.setStatus(avatarStatus, '')
      ui.setError(avatarError, result.error)
      return
    }
    avatarDraft = { image: result.dataUrl, dirty: true }
    renderAvatar()
    ui.setStatus(avatarStatus, '图片已选好；点「保存」后才写入这个 Bot。')
  })

  avatarRemove.addEventListener('click', () => {
    if (avatarDraft.image === '') return
    avatarDraft = { image: '', dirty: true }
    renderAvatar()
    ui.setError(avatarError, '')
    ui.setStatus(avatarStatus, '图片已移除；点「保存」后恢复程序化图标。')
  })

  const avatarSide = el('div', { class: 'avatar-editor-side' })
  avatarSide.append(avatarHint, avatarFile, avatarRemove)
  const avatarEditor = el('div', { class: 'avatar-editor' }, [avatarPreview, avatarSide])
  const avatarField = el('div', { class: 'field' })
  avatarField.append(
    el('span', { class: 'field-label', text: '图标' }),
    avatarEditor,
    el('p', {
      class: 'field-hint',
      text: 'PNG / JPEG / WebP / GIF，≤256KB。上传图片优先；移除后回到按 Bot id 生成的程序化图标。',
    }),
    avatarError,
    avatarStatus
  )
  renderAvatar()

  const error = ui.inlineError()
  const statusLine = ui.statusLine('')
  const saveButton = ui.button('保存', { variant: 'primary', type: 'submit' })
  const saveFoot = el('div', { class: 'form-foot sticky-foot' })
  saveFoot.append(statusLine, saveButton)

  const form = el('form', { class: 'form', novalidate: true })
  form.append(
    ui.section('身份', [
      el('div', { class: 'field-grid' }, [
        ui.field('名称', name, { id: 'bot-setting-name', required: true }),
        ui.field('角色', role, { id: 'bot-setting-role' }),
      ]),
      avatarField,
    ])
  )
  form.append(
    ui.section('人设（SOUL）', [
      ui.field('人设', persona, {
        id: 'bot-setting-persona',
        hint: `≤${PERSONA_MAX} 字。保存后会记账：谁改的、改前是什么（版本留痕）。`,
      }),
    ])
  )
  const toolSourceBox = el('div', { class: 'tool-source-box' })
  const toolSourceSection = ui.section('工具来源', [toolSourceBox], {
    description: '来自这个 Bot 的 tools，或已安装插件 installs[].tools；没有来源的项不显示。',
  })
  toolSourceSection.hidden = true

  async function loadToolSources() {
    let rows = toolSourceRows({ bot, installs: [] })
    if (rows.length === 0) {
      try {
        const workspaceId = await ctx.ensureWorkspaceId()
        const data = await ctx.api.get(installsListPath(workspaceId))
        rows = toolSourceRows({ bot, installs: Array.isArray(data?.installs) ? data.installs : [] })
      } catch {
        // 拿不到安装记录就不显示工具来源；不猜一个插件名。
        return
      }
    }
    if (rows.length === 0) return
    const list = el('ul', { class: 'tool-source-list' })
    for (const row of rows) {
      const item = el('li', { class: 'tool-source-row' })
      item.append(el('span', { class: 'tool-source-name', text: row.name }))
      item.append(el('span', { class: 'tool-source-from muted', text: `← ${row.source}` }))
      list.append(item)
    }
    toolSourceBox.replaceChildren(list)
    toolSourceSection.hidden = false
  }

  form.append(
    ui.section('能力', [
      ui.field('技能', skills, { id: 'bot-setting-skills', hint: '每行一个技能名' }),
      el('div', { class: 'field-grid' }, [
        ui.field('工具允许', toolsAllow, { id: 'bot-setting-tools-allow', hint: '每行一个模式' }),
        ui.field('工具禁止', toolsDeny, { id: 'bot-setting-tools-deny', hint: '每行一个模式' }),
      ]),
      ui.field('审批', approval, {
        id: 'bot-setting-approval',
        hint: '决定工具调用前是否问你；默认每次询问。单次批准不等于长期授权。',
      }),
    ])
  )
  form.append(toolSourceSection)
  form.append(ui.section('记忆', [memory.node]))
  form.append(
    ui.section('模型', [
      ui.field('模型', model, {
        id: 'bot-setting-model',
        hint: '创建后固定；改这里会改这个 Bot 自己的模型，不影响其他 Bot。',
      }),
    ])
  )
  form.append(
    ui.section(
      '运行时',
      [
        ui.field('运行时', runtime, {
          id: 'bot-setting-runtime',
          hint: `默认 ${DEFAULT_RUNTIME}；改动只改这个 Bot。能力/可用性以服务端探测为准，未探测不会显示成「支持」。`,
        }),
        runtimeBox,
      ],
      { description: '运行时决定房间里的 Agent 适配器（docs/design/agent-runtimes.md §5/§6/§10）。' }
    )
  )

  // ---- 危险区 ----
  const deleteButton = ui.button('删除 Bot', { variant: 'ghost', size: 'sm' })
  const confirmRow = el('div', { class: 'danger-confirm', hidden: true })
  confirmRow.append(
    el('p', {
      class: 'danger-text',
      text: `删除「${bot.name}」？控制面目前的 DELETE 是硬删、没有恢复接口——删掉就回不来。设计目标是软删 7 天可恢复（未实现）。`,
    })
  )
  const cancelDelete = ui.button('取消', { variant: 'ghost', size: 'sm' })
  const confirmDelete = ui.button('确认删除', { variant: 'ghost', size: 'sm' })
  confirmRow.append(el('div', { class: 'danger-actions' }, [cancelDelete, confirmDelete]))
  const dangerStatus = ui.statusLine('')
  cancelDelete.addEventListener('click', () => {
    confirmRow.hidden = true
    deleteButton.focus()
  })
  deleteButton.addEventListener('click', () => {
    confirmRow.hidden = false
    confirmDelete.focus()
  })
  confirmDelete.addEventListener('click', async () => {
    ui.setBusy(confirmDelete, true, '删除中…')
    ui.setStatus(dangerStatus, '')
    try {
      await ctx.api.del(path)
      try {
        await ctx.loadBots({ force: true })
      } catch {
        // 忽略：已经删掉了。
      }
      ctx.navigate('#/bots')
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      ui.setStatus(dangerStatus, `删除失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error')
      ui.setBusy(confirmDelete, false)
    }
  })

  const restoreButton = ui.button('恢复已删除的 Bot', {
    variant: 'ghost',
    size: 'sm',
    disabled: true,
    title: '恢复接口未就绪：控制面没有列出已删除 Bot 或恢复的接口',
  })
  const restoreNote = el('p', {
    class: 'field-hint',
    text: '恢复入口是禁用态：没有「已删除」列表，也没有 POST 恢复接口。这里不假装能恢复。',
  })

  form.append(error, saveFoot)

  const danger = ui.section('危险区', [deleteButton, confirmRow, restoreButton, restoreNote, dangerStatus], {
    description: '暂停 = 不接新轮次，进行中的回合跑完；删除：设计为软删 7 天，但 API 未就绪，当前是硬删。',
  })
  danger.classList.add('danger-zone')
  form.append(danger)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    ui.setError(error, '')
    ui.clearFieldInvalid(error)
    ui.setStatus(statusLine, '')
    const beforeRuntime = botRuntimeKind(bot)
    const next = {
      name: name.value.trim(),
      role: role.value.trim(),
      persona: persona.value,
      skills: parseList(skills.value),
      toolsAllow: parseList(toolsAllow.value),
      toolsDeny: parseList(toolsDeny.value),
      approval: approval.value,
      memoryScopes: memory.getValues(),
      model: model.value.trim(),
      runtimeKind: runtime.value,
    }
    if (next.name === '') {
      ui.setError(error, '名称不能为空')
      ui.setFieldInvalid(name, true, error)
      name.focus()
      return
    }
    if (next.name.length > NAME_MAX) {
      ui.setError(error, `名称最多 ${NAME_MAX} 字`)
      ui.setFieldInvalid(name, true, error)
      name.focus()
      return
    }
    if (next.role.length > ROLE_MAX) {
      ui.setError(error, `角色最多 ${ROLE_MAX} 字`)
      ui.setFieldInvalid(role, true, error)
      role.focus()
      return
    }
    if (next.persona.length > PERSONA_MAX) {
      ui.setError(error, `人设最多 ${PERSONA_MAX} 字`)
      ui.setFieldInvalid(persona, true, error)
      persona.focus()
      return
    }
    if (next.model === '') {
      ui.setError(error, '模型不能为空（创建后固定）')
      ui.setFieldInvalid(model, true, error)
      model.focus()
      return
    }
    const conflict = memberNameConflict(
      next.name,
      bots.filter((item) => item.id !== bot.id)
    )
    if (conflict) {
      ui.setError(error, `已经有同名 Bot：${conflict.name}`)
      ui.setFieldInvalid(name, true, error)
      name.focus()
      return
    }

    const patch = {}
    for (const key of ['name', 'role', 'persona', 'approval', 'model']) {
      if (next[key] !== (bot[key] ?? '')) patch[key] = next[key]
    }
    for (const key of ['skills', 'toolsAllow', 'toolsDeny', 'memoryScopes']) {
      const before = Array.isArray(bot[key]) ? bot[key] : []
      if (JSON.stringify(before) !== JSON.stringify(next[key])) patch[key] = next[key]
    }
    if (next.runtimeKind !== beforeRuntime) patch.runtimeKind = next.runtimeKind
    // 头像只在用户真的换过/移除过时发；发空对象 = 清掉图片、回到程序化图标。
    if (avatarDraft.dirty) {
      if (avatarDraft.image !== '' && !isAvatarDataUrl(avatarDraft.image)) {
        ui.setError(error, '头像图片无效：只支持 PNG / JPEG / WebP / GIF，且不超过 256KB。')
        ui.setFieldInvalid(avatarFile, true, error)
        return
      }
      const avatar = bot.avatar && typeof bot.avatar === 'object' ? { ...bot.avatar } : {}
      delete avatar.image
      if (avatarDraft.image !== '') avatar.image = avatarDraft.image
      patch.avatar = avatar
    }
    if (Object.keys(patch).length === 0) {
      ui.setStatus(statusLine, '没有改动。')
      return
    }

    ui.setBusy(saveButton, true, '保存中…')
    try {
      const payload = await ctx.api.patch(path, patch)
      const updatedRaw = payload && (payload.bot || payload)
      const updated = normalizeBot(updatedRaw)
      const merged = { ...bot, ...next, ...(updated && updated.id === bot.id ? updated : {}) }
      Object.assign(bot, merged)
      // 旧后端可能忽略 runtimeKind 且不回该字段：不把「发出去的」当成「已保存的」。
      const runtimeAccepted =
        patch.runtimeKind === undefined
          ? true
          : Boolean(
              updatedRaw &&
                typeof updatedRaw === 'object' &&
                ('runtimeKind' in updatedRaw || 'runtime_kind' in updatedRaw)
            )
      if (patch.runtimeKind !== undefined) {
        bot.runtimeKind = runtimeAccepted ? botRuntimeKind(updatedRaw) : beforeRuntime
      }
      titleText.querySelector('.page-title').textContent = bot.name
      let subtitle = titleText.querySelector('.page-subtitle')
      if (bot.role && !subtitle) {
        subtitle = el('p', { class: 'page-subtitle muted' })
        titleText.append(subtitle)
      }
      if (subtitle) subtitle.textContent = bot.role ? `角色：${bot.role}` : ''
      if (subtitle && !bot.role) subtitle.remove()
      if (patch.avatar !== undefined) {
        // 以服务端返回的 avatar 为准；万一服务端没回，就用刚发出去的。
        bot.avatar = updated && updated.avatar && typeof updated.avatar === 'object' ? updated.avatar : patch.avatar
        const savedImage =
          bot.avatar && isAvatarDataUrl(bot.avatar.image) ? bot.avatar.image : ''
        avatarDraft = { image: savedImage, dirty: false }
        renderAvatar()
        const nextTitleAvatar = botAvatar(bot, 40)
        titleAvatar.replaceWith(nextTitleAvatar)
        titleAvatar = nextTitleAvatar
      }
      refreshRuntimeUi()
      const savedRuntime = botRuntimeKind(bot)
      if (patch.runtimeKind !== undefined && (!runtimeAccepted || savedRuntime !== patch.runtimeKind)) {
        ui.setStatus(
          statusLine,
          `已保存其它改动，但服务端没有接受 runtimeKind=${patch.runtimeKind}（该部署的后端可能未实现该字段）；运行时显示以服务端返回为准。`
        )
      } else {
        ui.setStatus(statusLine, '已保存。人设/能力的改动会留版本记录。')
      }
      try {
        await ctx.loadBots({ force: true })
      } catch {
        // 忽略：保存已经成功。
      }
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      const runtimeOnly =
        Object.keys(patch).length === 1 && Object.prototype.hasOwnProperty.call(patch, 'runtimeKind')
      const suffix = runtimeOnly
        ? '（只改运行时被拒绝：该部署的后端可能还不接受 runtimeKind 的 PATCH；可先同时改其它字段或等 API 上线）'
        : ''
      ui.setError(error, `保存失败：${cause instanceof Error ? cause.message : String(cause)}${suffix}`)
    } finally {
      ui.setBusy(saveButton, false)
    }
  })

  void loadToolSources()
  return el('div', { class: 'stack' }, [header, form])
}
