// 建群与房间设置（docs/design/rooms.md §6、docs/design/ui.md §3.11）。
// 成员 ≥2 才允许创建；host 默认第一个勾选；responder 三选一（member/everyone/mentions）。

import { avatar, el } from '../lib/dom.js'
import { isAuthError } from '../lib/api-client.js'
import { responderKind, roomMembers } from '../lib/rooms.js'
import * as ui from '../lib/ui.js'

const NAME_MAX = 60
const NOTICE_MAX = 2_000
const MEMBERS_MIN = 2

const RESPONDER_OPTIONS = [
  {
    value: 'member',
    label: '指定一个成员回答',
    description: '只有它进本轮发言队列（“管理员点名”）。',
  },
  {
    value: 'everyone',
    label: '所有人轮流回答',
    description: '全部成员进队列，host 先说。',
  },
  {
    value: 'mentions',
    label: '只回答被 @ 的人',
    description: '没人 @ 时取默认成员（host / 第一个成员）。',
  },
]

function cleanMember(item) {
  const botId = typeof item?.botId === 'string' ? item.botId : typeof item?.id === 'string' ? item.id : ''
  const name = typeof item?.name === 'string' && item.name.trim() !== '' ? item.name.trim() : ''
  return { botId, name }
}

/**
 * 谁回答的编辑器：三个 radio + （kind=member 时）成员下拉。
 * 返回 {node, getValue, refresh, showMemberPicker}
 */
function responderEditor(options = {}) {
  const value = options.value || {}
  const radios = ui.radioGroup({
    legend: '发言模式',
    name: `responder-${Math.random().toString(36).slice(2, 8)}`,
    value: value.kind === 'member' || value.kind === 'everyone' || value.kind === 'mentions' ? value.kind : '',
    options: RESPONDER_OPTIONS,
    hint: '决定一条用户消息开启的一轮里，哪些成员会进发言队列。',
  })
  const memberSelect = ui.select({ id: 'responder-member' })
  const memberField = ui.field('回答的成员', memberSelect)
  const autoNote = el('p', {
    class: 'field-hint warn-hint',
    text: '这个房间当前是 auto（v2 决策模型）；这里只能改成 v1 的三种模式，保存后按新模式执行。',
    hidden: value.kind !== 'auto',
  })

  let members = []
  function refresh(nextMembers) {
    members = (Array.isArray(nextMembers) ? nextMembers : []).map(cleanMember).filter((member) => member.botId !== '')
    const previous = memberSelect.value || value.botId || members[0]?.botId || ''
    const choose = members.some((member) => member.botId === previous) ? previous : members[0]?.botId || ''
    ui.setSelectOptions(
      memberSelect,
      members.map((member) => ({ value: member.botId, label: member.name || '未命名 Bot' })),
      choose
    )
    memberSelect.disabled = members.length === 0
    syncVisibility()
  }
  function syncVisibility() {
    memberField.hidden = radios.getValue() !== 'member'
  }
  refresh(options.members || [])
  radios.node.addEventListener('change', syncVisibility)

  const node = el('div', { class: 'responder-editor' }, [radios.node, memberField, autoNote])
  return {
    node,
    refresh,
    getValue() {
      const kind = radios.getValue()
      if (kind === '') return null
      if (kind === 'member') {
        const botId = memberSelect.value || members[0]?.botId || ''
        if (botId === '') return null
        return { kind, botId }
      }
      return { kind }
    },
  }
}

function normalizeRoom(payload) {
  const room = payload && typeof payload === 'object' && payload.room ? payload.room : payload
  if (!room || typeof room !== 'object') return null
  const round = room.round || (payload && typeof payload === 'object' ? payload.round : null) || null
  return {
    ...room,
    members: Array.isArray(room.members) ? room.members : [],
    round,
  }
}

function memberDisplayName(botId, room, bots) {
  const member = roomMembers(room).find((item) => item.botId === botId)
  if (member && member.name) return member.name
  const bot = (bots || []).find((item) => item.id === botId)
  return bot?.name || '成员'
}

/** 建群页。 */
export async function mountNewRoomPage(root, ctx) {
  root.replaceChildren(ui.loading('正在载入 Bot 列表…'))
  let bots = []
  try {
    bots = await ctx.loadBots({ force: true })
  } catch (error) {
    if (isAuthError(error)) {
      ctx.requirePair()
      return
    }
    root.replaceChildren(
      ui.pageHeader('新建房间', { back: { href: '#/', label: '首页' } }),
      ui.errorState({
        error,
        message: `Bot 列表载入失败：${error instanceof Error ? error.message : String(error)}`,
        onRetry: () => mountNewRoomPage(root, ctx),
        onPair: ctx.hasToken() ? undefined : true,
      })
    )
    return
  }

  if (bots.length === 0) {
    root.replaceChildren(
      ui.pageHeader('新建房间', { back: { href: '#/', label: '首页' } }),
      ui.emptyState({
        title: '还没有 Bot 可以拉进房间',
        body: '一个群至少要 2 个 Bot。先去建两个，再回来建群。',
        action: ui.linkButton('新建 Bot', '#/bots/new', { variant: 'primary' }),
        secondary: ui.linkButton('看 Bot 列表', '#/bots', { variant: 'ghost' }),
      })
    )
    return
  }

  root.replaceChildren(createRoomView(ctx, bots))
  const first = root.querySelector('input')
  if (first) first.focus()
}

function createRoomView(ctx, bots) {
  const header = ui.pageHeader('新建房间', {
    back: { href: '#/', label: '首页' },
    subtitle: '一个群至少 2 个 Bot；没写第一句时，host 会先问这个群要做什么。',
  })

  const name = ui.input({ id: 'room-name', placeholder: '留空则按成员名生成', maxlength: NAME_MAX })
  const notice = ui.textarea({
    id: 'room-notice',
    rows: 3,
    maxlength: NOTICE_MAX,
    placeholder: '每个成员说话前必读的共享说明（可选）',
  })

  const selected = []
  const countHint = el('p', { class: 'field-hint', text: '' })
  const memberList = ui.checkboxList({
    legend: '选择要拉进房间的 Bot',
    name: 'room-members',
    items: bots.map((bot) => ({
      value: bot.id,
      label: bot.name,
      description: [bot.role, bot.model, bot.status === 'paused' ? '已暂停' : ''].filter(Boolean).join(' · '),
      leading: avatar(bot.id, 24),
      disabled: false,
    })),
    // 勾选顺序就是 host 的默认顺序：先勾的当 host。
    onChange: (event) => {
      const input = event.target
      if (!(input instanceof HTMLInputElement)) return
      const index = selected.indexOf(input.value)
      if (input.checked && index === -1) selected.push(input.value)
      if (!input.checked && index !== -1) selected.splice(index, 1)
      sync()
    },
  })

  const hostSelect = ui.select({ id: 'room-host' })
  const hostField = ui.field('主持人（host）', hostSelect, {
    hint: '默认是第一个勾选的成员；host 在本轮里先说话。',
  })

  const responder = responderEditor({ members: [], value: { kind: 'everyone' } })

  const error = ui.inlineError()
  const submit = ui.button('创建房间', { variant: 'primary', type: 'submit', disabled: true })

  function selectedBots() {
    return selected
      .map((botId) => bots.find((bot) => bot.id === botId))
      .filter(Boolean)
  }

  function sync() {
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      if (!bots.some((bot) => bot.id === selected[index])) selected.splice(index, 1)
    }
    const chosen = selectedBots()
    const previousHost = hostSelect.value
    ui.setSelectOptions(
      hostSelect,
      chosen.map((bot) => ({ value: bot.id, label: bot.name })),
      chosen.some((bot) => bot.id === previousHost) ? previousHost : chosen[0]?.id
    )
    hostSelect.disabled = chosen.length === 0
    responder.refresh(chosen)
    const count = chosen.length
    submit.disabled = count < MEMBERS_MIN
    countHint.textContent =
      count === 0
        ? `已选 0 个 · 至少 ${MEMBERS_MIN} 个 Bot 才能建群`
        : count < MEMBERS_MIN
          ? `已选 ${count} 个 · 还需要选择 ${MEMBERS_MIN - count} 个 Bot`
          : `已选 ${count} 个 · 可以创建`
    countHint.classList.toggle('is-ready', count >= MEMBERS_MIN)
    ui.setError(error, '')
  }

  const form = el('form', { class: 'form page-card', novalidate: true })
  form.append(
    ui.section('房间', [
      ui.field('名称', name, { id: 'room-name', hint: `可空，≤${NAME_MAX} 字；留空时服务端按成员名生成` }),
      ui.field('公告', notice, { id: 'room-notice', hint: `≤${NOTICE_MAX} 字。成员每次说话前都会读到它。` }),
    ])
  )
  memberList.node.append(countHint)
  form.append(ui.section('成员', [memberList.node]))
  form.append(ui.section('主持与派发', [hostField, responder.node]))
  form.append(error)
  const foot = el('div', { class: 'form-foot' })
  foot.append(ui.linkButton('取消', '#/', { variant: 'ghost' }), submit)
  form.append(foot)

  sync()

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    ui.setError(error, '')
    if (selected.length < MEMBERS_MIN) {
      ui.setError(error, `至少需要 ${MEMBERS_MIN} 个 Bot 才能建群`)
      return
    }
    const cleanName = name.value.trim()
    if (cleanName.length > NAME_MAX) {
      ui.setError(error, `名称最多 ${NAME_MAX} 字`)
      name.focus()
      return
    }
    if (notice.value.length > NOTICE_MAX) {
      ui.setError(error, `公告最多 ${NOTICE_MAX} 字`)
      notice.focus()
      return
    }
    const hostBotId = hostSelect.value || selected[0]
    const responderValue = responder.getValue()
    if (responderValue === null) {
      ui.setError(error, '请选择「谁回答」以及回答的成员')
      return
    }
    if (responderValue.kind === 'member' && !selected.includes(responderValue.botId)) {
      ui.setError(error, '指定的回答成员不在已选成员里，请重新选择')
      return
    }

    ui.setBusy(submit, true, '创建中…')
    try {
      const workspaceId = await ctx.ensureWorkspaceId()
      const payload = {
        workspaceId,
        memberBotIds: [...selected],
        hostBotId,
        responder: responderValue,
      }
      if (cleanName !== '') payload.name = cleanName
      if (notice.value.trim() !== '') payload.notice = notice.value.trim()
      const room = normalizeRoom(await ctx.api.post('/api/rooms', payload))
      try {
        await ctx.loadRooms({ force: true })
      } catch {
        // 列表刷新失败不影响创建成功。
      }
      if (room && typeof room.id === 'string' && room.id !== '') {
        ctx.navigate(`#/rooms/${encodeURIComponent(room.id)}`)
      } else {
        ctx.navigate('#/')
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

/** 房间设置页。 */
export async function mountRoomSettingsPage(root, ctx, roomId) {
  root.replaceChildren(ui.loading('正在载入房间…'))
  let room
  try {
    room = await ctx.loadRoom(roomId, { force: true })
  } catch (error) {
    if (isAuthError(error)) {
      ctx.requirePair()
      return
    }
    root.replaceChildren(
      ui.pageHeader('房间设置', { back: { href: `#/rooms/${encodeURIComponent(roomId)}`, label: '返回房间' } }),
      ui.errorState({
        error,
        message: `房间载入失败：${error instanceof Error ? error.message : String(error)}`,
        onRetry: () => mountRoomSettingsPage(root, ctx, roomId),
        onPair: ctx.hasToken() ? undefined : true,
      })
    )
    return
  }
  if (!room) {
    root.replaceChildren(
      ui.pageHeader('房间设置', { back: { href: '#/', label: '首页' } }),
      ui.emptyState({ title: '找不到这个房间', body: '它可能已被删除，或者链接不对。', action: ui.linkButton('回首页', '#/', { variant: 'primary' }) })
    )
    return
  }

  let bots = []
  let botsError = null
  try {
    bots = await ctx.loadBots()
  } catch (error) {
    if (isAuthError(error)) {
      ctx.requirePair()
      return
    }
    botsError = error
  }

  root.replaceChildren(roomSettingsView(ctx, room, bots, botsError))
  const main = root.closest('main')
  if (main) main.focus()
}

function roomSettingsView(ctx, room, bots, botsError) {
  const path = `/api/rooms/${encodeURIComponent(room.id)}`
  const name = ui.input({ id: 'room-setting-name', value: room.name || '', maxlength: NAME_MAX })
  const notice = ui.textarea({
    id: 'room-setting-notice',
    value: room.notice || room.bulletin || '',
    rows: 3,
    maxlength: NOTICE_MAX,
  })

  const header = ui.pageHeader('房间设置', {
    back: { href: `#/rooms/${encodeURIComponent(room.id)}`, label: '返回房间' },
    subtitle: room.name || '',
  })

  const sectionStatus = ui.statusLine('')
  const saveButton = ui.button('保存', { variant: 'primary', type: 'submit' })
  const formError = ui.inlineError()
  const form = el('form', { class: 'form', novalidate: true })

  // ---- 成员 ----
  const membersBody = el('div', { class: 'member-rows' })
  const membersHint = el('p', { class: 'field-hint', text: '' })
  const memberError = ui.inlineError()
  const memberStatus = ui.statusLine('')
  const addSelect = ui.select({ id: 'room-add-member' })
  const addButton = ui.button('添加', { variant: 'ghost', size: 'sm' })
  const addRow = el('div', { class: 'add-member-row' }, [addSelect, addButton])

  function applyRoom(next) {
    if (!next) return
    room = next
    renderMembers()
    refreshAddOptions()
    responder.refresh(currentMembers())
  }

  function currentMembers() {
    return roomMembers(room).map((member) => ({
      botId: member.botId,
      name: memberDisplayName(member.botId, room, bots),
    }))
  }

  function renderMembers() {
    const members = roomMembers(room)
    membersBody.replaceChildren()
    membersHint.textContent =
      members.length < MEMBERS_MIN
        ? `现在只有 ${members.length} 个成员；一个群至少 ${MEMBERS_MIN} 个，建议先加人。`
        : `共 ${members.length} 个成员 · 上限 12`
    for (const member of members) {
      const row = el('div', { class: 'member-row' })
      row.append(avatar(member.botId, 24))
      const text = el('div', { class: 'member-text' })
      text.append(el('span', { class: 'member-name', text: memberDisplayName(member.botId, room, bots) }))
      if (member.role === 'host') text.append(ui.badge('host', 'accent'))
      row.append(text)
      const remove = ui.button('移除', { variant: 'ghost', size: 'sm' })
      if (members.length <= MEMBERS_MIN) {
        remove.disabled = true
        remove.title = `至少保留 ${MEMBERS_MIN} 个成员`
      } else if (member.role === 'host') {
        remove.title = '移除 host 后服务端会自动把另一个成员设为 host'
      }
      remove.addEventListener('click', () => removeMember(member.botId, remove))
      row.append(remove)
      membersBody.append(row)
    }
  }

  function refreshAddOptions() {
    const inRoom = new Set(roomMembers(room).map((member) => member.botId))
    const candidates = (bots || []).filter((bot) => !inRoom.has(bot.id))
    ui.setSelectOptions(
      addSelect,
      candidates.map((bot) => ({ value: bot.id, label: `${bot.name}${bot.status === 'paused' ? '（已暂停）' : ''}` })),
      candidates[0]?.id
    )
    addSelect.disabled = candidates.length === 0
    addButton.disabled = candidates.length === 0
    if (candidates.length === 0) {
      addSelect.replaceChildren(el('option', { value: '', text: botsError ? '（Bot 列表载入失败）' : '（所有 Bot 都在这个房间里）' }))
      addSelect.disabled = true
      addButton.disabled = true
    }
  }

  async function reloadRoom() {
    const fresh = await ctx.loadRoom(room.id, { force: true })
    if (fresh) applyRoom(fresh)
  }

  async function removeMember(botId, button) {
    ui.setError(memberError, '')
    ui.setStatus(memberStatus, '')
    const label = memberDisplayName(botId, room, bots)
    ui.setBusy(button, true, '移除中…')
    try {
      await ctx.api.del(`${path}/members/${encodeURIComponent(botId)}`)
      const before = roomMembers(room).filter((member) => member.botId !== botId)
      room = { ...room, members: before }
      renderMembers()
      refreshAddOptions()
      responder.refresh(currentMembers())
      ui.setStatus(memberStatus, `已移除 ${label}`)
      try {
        await reloadRoom()
      } catch {
        // 本地已经反映；服务端刷新失败不影响这次操作的成功。
      }
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      ui.setError(memberError, `移除失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      ui.setBusy(button, false)
    }
  }

  addButton.addEventListener('click', async () => {
    const botId = addSelect.value
    if (!botId) return
    ui.setError(memberError, '')
    ui.setStatus(memberStatus, '')
    ui.setBusy(addButton, true, '添加中…')
    try {
      await ctx.api.post(`${path}/members`, { botIds: [botId] })
      try {
        await reloadRoom()
      } catch {
        const bot = (bots || []).find((item) => item.id === botId)
        room = {
          ...room,
          members: [...roomMembers(room), { botId, role: 'member', name: bot?.name || '' }],
        }
        renderMembers()
        refreshAddOptions()
        responder.refresh(currentMembers())
      }
      ui.setStatus(memberStatus, `已添加 ${(bots || []).find((item) => item.id === botId)?.name || '成员'}`)
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      ui.setError(memberError, `添加失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      ui.setBusy(addButton, false)
    }
  })

  // ---- 谁回答 ----
  const initialResponder = room.responder || {
    kind: responderKind(room) === 'member' ? 'member' : responderKind(room) || 'everyone',
    botId: room.hostBotId,
  }
  const responder = responderEditor({ members: currentMembers(), value: initialResponder })

  // ---- 删除房间 ----
  const deleteButton = ui.button('删除房间', { variant: 'ghost', size: 'sm' })
  const confirmRow = el('div', { class: 'danger-confirm', hidden: true })
  confirmRow.append(
    el('p', { class: 'danger-text', text: `删除「${room.name || '这个房间'}」？房间里的消息会一起消失，无法在界面上恢复。` })
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
      const rooms = ctx.store.rooms.filter((item) => item.id !== room.id)
      ctx.store.rooms = rooms
      ctx.navigate('#/')
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      const missing = cause && cause.status === 404
      ui.setStatus(
        dangerStatus,
        missing
          ? `删除失败：控制面还没有房间删除接口（HTTP 404）。${cause instanceof Error ? cause.message : ''}`
          : `删除失败：${cause instanceof Error ? cause.message : String(cause)}`,
        'error'
      )
      ui.setBusy(confirmDelete, false)
    }
  })

  form.append(
    ui.section('房间', [
      ui.field('名称', name, { id: 'room-setting-name', required: true, hint: `≤${NAME_MAX} 字` }),
      ui.field('公告', notice, { id: 'room-setting-notice', hint: `≤${NOTICE_MAX} 字，成员每次说话前必读` }),
    ])
  )
  form.append(ui.section('成员', [membersBody, membersHint, addRow, memberError, memberStatus]))
  form.append(ui.section('谁回答', [responder.node]))
  form.append(formError, el('div', { class: 'form-foot sticky-foot' }, [sectionStatus, saveButton]))

  const danger = ui.section('危险区', [deleteButton, confirmRow, dangerStatus], {
    description: '删除房间会连同成员关系一起消失；当前接口还没有 DELETE /api/rooms/:id（契约 §2 未列）。',
  })
  danger.classList.add('danger-zone')
  form.append(danger)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    ui.setError(formError, '')
    ui.setStatus(sectionStatus, '')
    const cleanName = name.value.trim()
    if (cleanName === '') {
      ui.setError(formError, '房间名称不能为空')
      name.focus()
      return
    }
    if (cleanName.length > NAME_MAX) {
      ui.setError(formError, `名称最多 ${NAME_MAX} 字`)
      name.focus()
      return
    }
    if (notice.value.length > NOTICE_MAX) {
      ui.setError(formError, `公告最多 ${NOTICE_MAX} 字`)
      notice.focus()
      return
    }
    const responderValue = responder.getValue()
    if (responderValue === null) {
      ui.setError(formError, '请选择「谁回答」以及回答的成员')
      return
    }
    const patch = {}
    if (cleanName !== (room.name || '')) patch.name = cleanName
    const currentNotice = room.notice || room.bulletin || ''
    if (notice.value !== currentNotice) patch.notice = notice.value
    const currentKind = responderKind(room)
    const currentBot = room.responder && room.responder.botId ? room.responder.botId : room.hostBotId
    if (responderValue.kind !== currentKind || (responderValue.kind === 'member' && responderValue.botId !== currentBot)) {
      patch.responder = responderValue
    }
    if (Object.keys(patch).length === 0) {
      ui.setStatus(sectionStatus, '没有改动。')
      return
    }
    if (responderValue.kind === 'member' && !roomMembers(room).some((member) => member.botId === responderValue.botId)) {
      ui.setError(formError, '指定的回答成员不在房间里')
      return
    }

    ui.setBusy(saveButton, true, '保存中…')
    try {
      const payload = await ctx.api.patch(path, patch)
      const updated = normalizeRoom(payload)
      if (updated && updated.id === room.id) {
        room = { ...room, ...updated, members: updated.members.length > 0 ? updated.members : room.members }
      } else {
        room = {
          ...room,
          name: patch.name ?? room.name,
          notice: patch.notice ?? room.notice,
          responder: patch.responder ?? room.responder,
        }
      }
      const subtitleNode = header.querySelector('.page-subtitle')
      if (subtitleNode) subtitleNode.textContent = room.name
      renderMembers()
      refreshAddOptions()
      responder.refresh(currentMembers())
      ui.setStatus(sectionStatus, '已保存。')
      try {
        await ctx.loadRooms({ force: true })
      } catch {
        // 忽略：保存已经成功。
      }
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      ui.setError(formError, `保存失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      ui.setBusy(saveButton, false)
    }
  })

  renderMembers()
  refreshAddOptions()

  return el('div', { class: 'stack' }, [header, form])
}
