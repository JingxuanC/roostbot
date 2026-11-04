// 审批的纯逻辑（docs/build/m4-addendum.md §B/§C、docs/build/m4-contract.md §2）。
//
// 审批行来自 GET /api/approvals：
//   {id, workspaceId, kind, requester, payload, status, createdAt, decidedAt, decidedBy}
// kind=create_room 的 payload：{name, purpose, memberBotIds}。
// 这个模块只把行整理成渲染模型，不发请求、不碰 DOM；接口缺失时由视图降级。

const KIND_LABELS = {
  create_room: '建群',
}

const STATUS_LABELS = {
  pending: '待批准',
  approved: '已批准',
  rejected: '已拒绝',
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function memberIdsOf(payload) {
  if (!payload) return []
  const raw = Array.isArray(payload.memberBotIds)
    ? payload.memberBotIds
    : Array.isArray(payload.members)
      ? payload.members.map((member) => (plainObject(member) ? member.botId || member.id : member))
      : []
  const seen = new Set()
  const ids = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/** 请求类型的中文名；未知类型原样显示（不猜）。 */
export function approvalKindLabel(kind) {
  const value = asText(kind)
  if (value === '') return '请求'
  return KIND_LABELS[value] || value
}

/** 状态文案；未知状态原样显示。 */
export function approvalStatusLabel(status) {
  const value = asText(status)
  if (value === '') return '状态未知'
  return STATUS_LABELS[value] || value
}

/** 只有 pending 且 id 可用的审批能操作；已批准的不能再点。 */
export function canDecide(approval) {
  if (!plainObject(approval)) return false
  if (typeof approval.id !== 'string' || approval.id.trim() === '') return false
  return approval.status === 'pending'
}

/**
 * 卡片底部的按钮。顺序与文案按 addendum：批准 / 拒绝。
 * decision 用 API 的终态值 approved / rejected（apps/api/src/bot-rooms-routes.ts）。
 * 非 pending 返回空数组 —— 界面就不渲染按钮，不假装还能改主意。
 */
export function approvalActions(approval) {
  if (!canDecide(approval)) return []
  return [
    { decision: 'approved', label: '批准', variant: 'primary' },
    { decision: 'rejected', label: '拒绝', variant: 'ghost' },
  ]
}

/**
 * 把审批行整理成卡片摘要：kind / 标题 / payload 字段。
 * 缺字段时给中性占位，不把 undefined 打到界面上。
 */
export function approvalSummary(approval) {
  const row = plainObject(approval) ? approval : {}
  const kind = asText(row.kind)
  const kindLabel = approvalKindLabel(kind)
  const payload = plainObject(row.payload) || {}
  const name = asText(payload.name)
  const purpose = asText(payload.purpose)
  const memberIds = memberIdsOf(payload)

  const fields = []
  if (kind === 'create_room') {
    fields.push({ label: '房间名', value: name === '' ? '（未命名，按成员名生成）' : name })
    fields.push({ label: '用途', value: purpose === '' ? '（没写用途）' : purpose })
    fields.push({
      label: '成员',
      value: memberIds.length === 0 ? '（未指定）' : `${memberIds.length} 个`,
    })
  } else {
    for (const [key, value] of Object.entries(payload)) {
      if (fields.length >= 4) break
      if (key === 'name' || key === 'purpose' || key === 'memberBotIds' || key === 'members') continue
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        fields.push({ label: key, value: String(value) })
      }
    }
    if (fields.length === 0) {
      fields.push({ label: '请求内容', value: '（接口没有给可显示的字段）' })
    }
  }

  return {
    kind,
    kindLabel,
    title: kind === 'create_room' ? (name === '' ? '建群请求' : `建群 · ${name}`) : kindLabel,
    name,
    purpose,
    memberIds,
    memberCount: memberIds.length,
    fields,
  }
}

/**
 * 时间：接受毫秒数 / Date / 可解析字符串。本地时区，固定 yyyy-mm-dd hh:mm。
 * 缺时间时写「时间未知」，不拿当前时间冒充。
 */
export function approvalTimeLabel(value) {
  let ms = Number.NaN
  if (typeof value === 'number') ms = value
  else if (value instanceof Date) ms = value.getTime()
  else if (typeof value === 'string' && value.trim() !== '') {
    const asNumber = Number(value)
    ms = Number.isFinite(asNumber) ? asNumber : Date.parse(value)
  }
  if (!Number.isFinite(ms) || ms <= 0) return '时间未知'
  const date = new Date(ms)
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
