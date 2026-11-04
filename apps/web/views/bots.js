// Bot 列表与设置页（docs/design/bots.md §4、docs/design/ui.md §3.7）。
// 页面只做展示与表单；请求都经 ctx.api，错误显示在原地。

import { avatar, el } from '../lib/dom.js'
import { isAuthError } from '../lib/api-client.js'
import { memberNameConflict } from '../lib/mentions.js'
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
  { value: 'ask', label: '每次询问（默认）' },
  { value: 'edits', label: '只有编辑免问' },
  { value: 'auto', label: '自动执行' },
  { value: 'full', label: '完全放开（危险）' },
]

const MEMORY_OPTIONS = [
  { value: 'team', label: '团队', description: '所有房间都能读到' },
  { value: 'room', label: '房间', description: '只在这个房间生效' },
  { value: 'member', label: '个人', description: '只跟这个 Bot 有关' },
]

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
    toolsAllow: Array.isArray(bot.toolsAllow) ? bot.toolsAllow : [],
    toolsDeny: Array.isArray(bot.toolsDeny) ? bot.toolsDeny : [],
    memoryScopes: Array.isArray(bot.memoryScopes) ? bot.memoryScopes : [],
    status: bot.status === 'paused' ? 'paused' : 'active',
  }
}

function statusBadge(status) {
  return ui.badge(botStatusLabel(status), status === 'paused' ? 'warn' : 'ok')
}

function botRow(bot) {
  const href = `#/bots/${encodeURIComponent(bot.id)}`
  const link = el('a', { class: 'bot-card', href })
  link.append(avatar(bot.id, 32))
  const main = el('div', { class: 'bot-card-main' })
  const top = el('div', { class: 'bot-card-top' })
  top.append(el('span', { class: 'bot-card-name', text: bot.name }))
  top.append(statusBadge(bot.status))
  main.append(top)
  if (bot.role) main.append(el('p', { class: 'bot-card-role', text: bot.role }))
  const meta = []
  if (bot.model) meta.push(`模型 ${bot.model}`)
  meta.push(`审批 ${APPROVAL_LABELS[bot.approval] || bot.approval || '未知'}`)
  if (bot.skills.length > 0) meta.push(`技能 ${bot.skills.length}`)
  main.append(el('p', { class: 'bot-card-meta muted', text: meta.join(' · ') }))
  link.append(main)
  link.append(el('span', { class: 'row-chev', 'aria-hidden': 'true', text: '›' }))
  return el('li', { class: 'bot-card-item' }, [link])
}

function listShell(ctx, bots) {
  const header = ui.pageHeader('Bot', {
    subtitle: bots.length ? `共 ${bots.length} 个 · 点开是设置，不是聊天` : '长期身份；进房间的是它的脸',
    actions: ui.linkButton('新建 Bot', '#/bots/new', { variant: 'primary' }),
  })
  const board = el('div', { class: 'page-card' })
  if (bots.length === 0) {
    board.append(
      ui.emptyState({
        title: '还没有 Bot',
        body: '先建一个 Bot，再把它拉进房间。名字在同一个工作区里唯一。',
        action: ui.linkButton('新建 Bot', '#/bots/new', { variant: 'primary' }),
      })
    )
  } else {
    board.append(el('ul', { class: 'bot-cards' }, bots.map(botRow)))
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
  const error = ui.inlineError()
  const submit = ui.button('创建 Bot', { variant: 'primary', type: 'submit' })
  const form = el('form', { class: 'form page-card', novalidate: true })

  form.append(
    ui.section('身份', [
      ui.field('名字', name, { id: 'bot-name', required: true, hint: `≤${NAME_MAX} 字，同一个工作区里不能重名` }),
      ui.field('角色', role, { id: 'bot-role', hint: `≤${ROLE_MAX} 字，只影响默认提示词` }),
    ])
  )
  form.append(
    ui.section(
      '模型',
      [
        ui.field('模型', model, {
          id: 'bot-model',
          required: true,
          hint: '创建时固定，之后全局默认变了不影响它（服务端要求创建时必须给模型）',
        }),
      ],
      { description: '创建后模型不再跟随全局默认（docs/design/bots.md §2）。' }
    )
  )
  form.append(error)
  const foot = el('div', { class: 'form-foot' })
  foot.append(ui.linkButton('取消', '#/bots', { variant: 'ghost' }), submit)
  form.append(foot)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    ui.setError(error, '')
    const cleanName = name.value.trim()
    const cleanRole = role.value.trim()
    if (cleanName === '') {
      ui.setError(error, '名字不能为空')
      name.focus()
      return
    }
    if (cleanName.length > NAME_MAX) {
      ui.setError(error, `名字最多 ${NAME_MAX} 字`)
      name.focus()
      return
    }
    if (cleanRole.length > ROLE_MAX) {
      ui.setError(error, `角色最多 ${ROLE_MAX} 字`)
      role.focus()
      return
    }
    if (model.value.trim() === '') {
      ui.setError(error, '模型不能为空（创建时固定）')
      model.focus()
      return
    }
    const conflict = memberNameConflict(cleanName, bots)
    if (conflict) {
      ui.setError(error, `已经有同名 Bot：${conflict.name}。换一个名字，或去它的设置页改名。`)
      name.focus()
      return
    }

    ui.setBusy(submit, true, '创建中…')
    try {
      const workspaceId = await ctx.ensureWorkspaceId()
      const payload = { workspaceId, name: cleanName, model: model.value.trim() }
      if (cleanRole !== '') payload.role = cleanRole
      const created = normalizeBot(await ctx.api.post('/api/bots', payload))
      try {
        await ctx.loadBots({ force: true })
      } catch {
        // 列表刷新失败不影响创建成功；设置页会自己再取一次。
      }
      if (created && typeof created.id === 'string' && created.id !== '') {
        ctx.navigate(`#/bots/${encodeURIComponent(created.id)}`)
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
  titleRow.append(avatar(bot.id, 40))
  const titleText = el('div', { class: 'bot-title-text' })
  titleText.append(el('h1', { class: 'page-title', text: bot.name }))
  if (bot.role) titleText.append(el('p', { class: 'page-subtitle muted', text: `角色：${bot.role}` }))
  titleRow.append(titleText)
  let statusNode = statusBadge(bot.status)
  titleRow.append(statusNode)
  const actions = el('div', { class: 'page-title-actions' })

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
      pauseButton.textContent = next === 'paused' ? '恢复' : '暂停'
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
  form.append(ui.section('记忆', [memory.node]))
  form.append(
    ui.section('模型', [
      ui.field('模型', model, {
        id: 'bot-setting-model',
        hint: '创建后固定；改这里会改这个 Bot 自己的模型，不影响其他 Bot。',
      }),
    ])
  )

  // ---- 危险区 ----
  const deleteButton = ui.button('删除 Bot', { variant: 'ghost', size: 'sm' })
  const confirmRow = el('div', { class: 'danger-confirm', hidden: true })
  confirmRow.append(
    el('p', { class: 'danger-text', text: `删除「${bot.name}」？软删，7 天内可以恢复；期间房间里的位置会显示「已删除」。` })
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

  form.append(error, saveFoot)

  const danger = ui.section('危险区', [deleteButton, confirmRow, dangerStatus], {
    description: '暂停 = 不接新轮次，进行中的回合跑完；删除 = 软删 7 天（docs/design/bots.md §5）。',
  })
  danger.classList.add('danger-zone')
  form.append(danger)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    ui.setError(error, '')
    ui.setStatus(statusLine, '')
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
    }
    if (next.name === '') {
      ui.setError(error, '名称不能为空')
      name.focus()
      return
    }
    if (next.name.length > NAME_MAX) {
      ui.setError(error, `名称最多 ${NAME_MAX} 字`)
      name.focus()
      return
    }
    if (next.role.length > ROLE_MAX) {
      ui.setError(error, `角色最多 ${ROLE_MAX} 字`)
      role.focus()
      return
    }
    if (next.persona.length > PERSONA_MAX) {
      ui.setError(error, `人设最多 ${PERSONA_MAX} 字`)
      persona.focus()
      return
    }
    if (next.model === '') {
      ui.setError(error, '模型不能为空（创建后固定）')
      model.focus()
      return
    }
    const conflict = memberNameConflict(
      next.name,
      bots.filter((item) => item.id !== bot.id)
    )
    if (conflict) {
      ui.setError(error, `已经有同名 Bot：${conflict.name}`)
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
    if (Object.keys(patch).length === 0) {
      ui.setStatus(statusLine, '没有改动。')
      return
    }

    ui.setBusy(saveButton, true, '保存中…')
    try {
      const payload = await ctx.api.patch(path, patch)
      const updated = normalizeBot(payload && (payload.bot || payload))
      const merged = { ...bot, ...next, ...(updated && updated.id === bot.id ? updated : {}) }
      Object.assign(bot, merged)
      titleText.querySelector('.page-title').textContent = bot.name
      let subtitle = titleText.querySelector('.page-subtitle')
      if (bot.role && !subtitle) {
        subtitle = el('p', { class: 'page-subtitle muted' })
        titleText.append(subtitle)
      }
      if (subtitle) subtitle.textContent = bot.role ? `角色：${bot.role}` : ''
      if (subtitle && !bot.role) subtitle.remove()
      ui.setStatus(statusLine, '已保存。人设/能力的改动会留版本记录。')
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
      ui.setError(error, `保存失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      ui.setBusy(saveButton, false)
    }
  })

  return el('div', { class: 'stack' }, [header, form])
}
