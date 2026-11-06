// 房间相关的纯逻辑：谁回答、成员名、轮次 slot 状态。
// 全部不碰 DOM；数据缺字段时返回空/兜底值，不抛异常（接口可能还没上线）。

const STATUS_LABELS = {
  waiting: '排队中',
  speaking: '正在说',
  posted: '已回答',
  passed: '静默',
  failed: '失败',
  missed: '未响应',
  working: '处理中',
  left: '已离开',
  'waiting-approval': '等审批',
  needs_input: '在等你',
}

const STATUS_KINDS = {
  waiting: 'pending',
  speaking: 'active',
  working: 'active',
  posted: 'ok',
  passed: 'muted',
  failed: 'danger',
  missed: 'danger',
  left: 'info',
  'waiting-approval': 'warn',
  needs_input: 'warn',
}

const ROUND_STATE_LABELS = {
  running: '本轮进行中',
  done: '本轮已结束',
  stopped: '本轮已停止',
}

/** 成员数组：过滤掉残缺项，字段按契约 camelCase。 */
export function roomMembers(room) {
  const raw = room && Array.isArray(room.members) ? room.members : []
  const members = []
  for (const item of raw) {
    if (!item || typeof item.botId !== 'string' || item.botId === '') continue
    members.push({
      botId: item.botId,
      role: item.role === 'host' ? 'host' : 'member',
      name: typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim() : '',
    })
  }
  return members
}

export function memberName(member) {
  return member && typeof member.name === 'string' ? member.name : ''
}

/**
 * 房间来源徽章（docs/build/m4-addendum.md §C）：只给 Bot 建的房间打标。
 * 用户建的房间没有徽章，避免把「正常」也做成噪音。
 */
export function roomOriginLabel(room) {
  if (!room || room.createdByKind !== 'bot') return ''
  return '由 Bot 创建'
}

/**
 * 徽章的 title：必须带 createdBy（addendum §C）。没有 createdBy 时也不编一个，
 * 只写「由 Bot 创建」。
 */
export function roomOriginTitle(room) {
  if (roomOriginLabel(room) === '') return ''
  const createdBy = room && typeof room.createdBy === 'string' ? room.createdBy.trim() : ''
  return createdBy === '' ? '由 Bot 创建' : `由 Bot 创建 · 创建者 ${createdBy}`
}

export function memberById(room, botId) {
  if (typeof botId !== 'string' || botId === '') return null
  return roomMembers(room).find((member) => member.botId === botId) || null
}

/**
 * 谁回答的 kind。M4 用 room.responder.kind；M3 只有 replyMode，映射过来：
 * admin → member（host），everyone → everyone，mentions → mentions。
 */
export function responderKind(room) {
  const responder = room && room.responder
  if (responder && typeof responder.kind === 'string' && responder.kind !== '') {
    return responder.kind
  }
  const replyMode = room && typeof room.replyMode === 'string' ? room.replyMode : ''
  if (replyMode === 'admin') return 'member'
  if (replyMode === 'everyone' || replyMode === 'mentions') return replyMode
  return ''
}

/** kind=member 时实际会回答的 Bot；按契约的 fallback 链取 host / 第一个成员。 */
export function responderBotId(room) {
  const kind = responderKind(room)
  const members = roomMembers(room)
  const responder = (room && room.responder) || {}
  if (kind === 'member') {
    return responder.botId || room.hostBotId || members[0]?.botId || ''
  }
  if (kind === 'auto') {
    return responder.fallbackBotId || room.hostBotId || members[0]?.botId || ''
  }
  return ''
}

/**
 * 输入框下方的「谁会回答」提示（docs/design/ui.md §3.12）。
 * 没有成员时说"还没有成员会回答"，不假装有人会答。
 */
export function whoAnswersLabel(room) {
  if (!room) return ''
  const members = roomMembers(room)
  const kind = responderKind(room)
  if (kind === 'everyone') {
    return members.length > 0 ? '所有人轮流回答' : '还没有成员会回答'
  }
  if (kind === 'mentions') return '只回答被 @ 的人'
  if (kind === 'auto') return '由系统决定谁回答'
  if (kind === 'member') {
    const member = memberById(room, responderBotId(room))
    if (member && member.name !== '') return `${member.name} 会回答`
    return members.length > 0 ? '指定的成员 会回答' : '还没有成员会回答'
  }
  return members.length > 0 ? '成员会回答' : '还没有成员会回答'
}

export function slotStatusLabel(status) {
  return STATUS_LABELS[status] || (typeof status === 'string' && status !== '' ? status : '未知状态')
}

export function slotStatusKind(status) {
  return STATUS_KINDS[status] || 'info'
}

export function roundStateLabel(state) {
  return ROUND_STATE_LABELS[state] || ''
}

export function roundSlots(round) {
  return round && Array.isArray(round.slots) ? round.slots.filter((slot) => slot && typeof slot.botId === 'string') : []
}

/** 正在说话的 slot（speaking 字段或 status=speaking 都认）。 */
export function speakingSlot(round) {
  const slots = roundSlots(round)
  const speaking = round && typeof round.speaking === 'string' ? round.speaking : ''
  return (
    slots.find((slot) => slot.status === 'speaking') ||
    (speaking !== '' ? slots.find((slot) => slot.botId === speaking) : null) ||
    null
  )
}

/**
 * 渲染用的轮次条目。nameOf 由调用方注入（从 room.members / Bot 列表找名字）。
 * 没有 round 或 slots 时返回空数组 —— 界面就不渲染这一块。
 */
export function roundStatusItems(round, nameOf = () => '') {
  return roundSlots(round).map((slot) => {
    let name = typeof slot.name === 'string' ? slot.name.trim() : ''
    if (name === '') {
      try {
        name = String(nameOf(slot.botId) || '').trim()
      } catch {
        name = ''
      }
    }
    return {
      botId: slot.botId,
      name: name === '' ? '成员' : name,
      status: slot.status,
      label: slotStatusLabel(slot.status),
      kind: slotStatusKind(slot.status),
      note: typeof slot.note === 'string' ? slot.note : '',
      by: typeof slot.by === 'string' ? slot.by : '',
    }
  })
}
