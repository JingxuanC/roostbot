// 审批的纯逻辑（docs/build/m4-addendum.md §B/§C、docs/build/m4-contract.md §2）。
//
// 审批行来自 GET /api/approvals：
//   {id, workspaceId, kind, requester, requesterKind, payload, status,
//    createdAt, decidedAt, decidedBy, action, target, consequence}
// kind=create_room 的 payload：{name, purpose, memberBotIds}。
// 长期授权来自 GET /api/approval-grants：
//   {id, workspaceId, kind, action, target, grantedBy, grantedAt, revokedAt}
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
 * 卡片主展示：优先用接口给的 action / target / consequence（要做什么 / 作用对象 / 影响什么）。
 * 三个都没给时回退到 approvalSummary 的 payload 字段；部分缺失时只展示已有的，
 * 不把 undefined 打到界面上。标题优先用 action，让人一眼看到「要做什么」。
 */
export function approvalFacts(approval) {
  const summary = approvalSummary(approval)
  const row = plainObject(approval) ? approval : {}
  const action = asText(row.action)
  const target = asText(row.target)
  const consequence = asText(row.consequence)

  const facts = []
  if (action !== '') facts.push({ label: '要做什么', value: action })
  if (target !== '') facts.push({ label: '作用对象', value: target })
  if (consequence !== '') facts.push({ label: '影响什么', value: consequence })

  const usedPrimaryFields = facts.length > 0
  return {
    ...summary,
    action,
    target,
    consequence,
    title: usedPrimaryFields && action !== '' ? action : summary.title,
    facts: usedPrimaryFields ? facts : summary.fields,
    usedPrimaryFields,
  }
}

/**
 * 请求方展示：bot 用 bots 列表解析名字（头像由视图用 botAvatar 渲染）；
 * user 显示「用户 · <id>」；未知 kind 中性显示 id，不冒充 Bot/用户。
 */
export function approvalRequester(approval, bots = []) {
  const row = plainObject(approval) ? approval : {}
  const id = asText(row.requester)
  const kind = asText(row.requesterKind)
  const list = Array.isArray(bots) ? bots : []
  const bot = id === '' ? null : list.find((item) => plainObject(item) && asText(item.id) === id) || null
  const botName = bot ? asText(bot.name) : ''

  if (kind === 'user') {
    return { kind: 'user', id, name: id === '' ? '用户' : `用户 · ${id}`, bot: null }
  }
  if (kind === 'bot') {
    return { kind: 'bot', id, name: botName !== '' ? botName : '一个 Bot', bot }
  }
  if (kind !== '') {
    return { kind, id, name: id === '' ? '未知请求方' : `请求方 · ${id}`, bot: null }
  }
  return { kind: 'unknown', id, name: id === '' ? '未知请求方' : `请求方 · ${id}`, bot: null }
}

const DECIDED_LABELS = {
  approved: '已允许（一次）',
  rejected: '已拒绝（一次）',
}

/**
 * 已决策卡片的一行历史：状态 + 决策人 + 时间。
 * pending 返回 null（由视图渲染按钮）；未知终态原样兜底，不显示 undefined。
 */
export function approvalDecisionHistory(approval) {
  const row = plainObject(approval) ? approval : {}
  const status = asText(row.status)
  if (status === '' || status === 'pending') return null

  const label = DECIDED_LABELS[status] || `已处理（${approvalStatusLabel(status)}）`
  const decidedBy = asText(row.decidedBy)
  const decidedAt = row.decidedAt ?? row.decided_at
  const parts = [label, decidedBy === '' ? '决策人未知' : `决策人 ${decidedBy}`, approvalTimeLabel(decidedAt)]
  return { status, label, decidedBy, decidedAt, text: parts.join(' · ') }
}

function timeValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string' && value.trim() !== '') {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber)) return asNumber
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Number.NEGATIVE_INFINITY
}

function compareTimeDesc(left, right) {
  const a = timeValue(left)
  const b = timeValue(right)
  if (a === b) return 0
  return b > a ? 1 : -1
}

/**
 * 审批列表模型：pending 在前（新请求优先），已决策按 decidedAt 倒序、最多 limit 条。
 * 同时展示历史，避免「没有待批准」时整页空白。
 */
export function approvalListModel(approvals, options = {}) {
  const limit =
    Number.isSafeInteger(options.limit) && options.limit >= 0 ? options.limit : 20
  const rows = (Array.isArray(approvals) ? approvals : []).filter(plainObject)
  const pending = rows.filter((row) => row.status === 'pending')
  const decided = rows.filter((row) => row.status !== 'pending')

  pending.sort(
    (left, right) =>
      compareTimeDesc(left.createdAt ?? left.created_at, right.createdAt ?? right.created_at) ||
      asText(left.id).localeCompare(asText(right.id))
  )
  decided.sort(
    (left, right) =>
      compareTimeDesc(
        left.decidedAt ?? left.decided_at ?? left.createdAt ?? left.created_at,
        right.decidedAt ?? right.decided_at ?? right.createdAt ?? right.created_at
      ) || asText(left.id).localeCompare(asText(right.id))
  )

  return { pending, decided: decided.slice(0, limit) }
}

/**
 * 长期授权展示模型：kind / action / target / 授权人 / 时间。
 * action/target 为空表示只匹配「请求里同样没填」的情况，界面显示（未指定）而不是留白。
 */
export function approvalGrantsView(grants) {
  const rows = (Array.isArray(grants) ? grants : []).filter(plainObject).map((grant) => {
    const kind = asText(grant.kind)
    const action = asText(grant.action)
    const target = asText(grant.target)
    return {
      id: asText(grant.id),
      kind,
      kindLabel: approvalKindLabel(kind),
      action,
      target,
      actionLabel: action === '' ? '（未指定）' : action,
      targetLabel: target === '' ? '（未指定）' : target,
      grantedBy: asText(grant.grantedBy) || '未知',
      grantedAt: grant.grantedAt,
      grantedAtLabel: approvalTimeLabel(grant.grantedAt),
    }
  })
  return { rows, count: rows.length }
}

/**
 * 组装 POST /api/approval-grants 的正文：空 action/target 不发（服务端等价于 NULL，精确匹配）。
 * workspaceId 或 kind 为空返回 null，由视图报错，不发出注定失败的请求。
 */
export function approvalGrantPayload(input = {}) {
  const workspaceId = asText(input.workspaceId)
  const kind = asText(input.kind)
  if (workspaceId === '' || kind === '') return null
  const payload = { workspaceId, kind }
  const action = asText(input.action)
  const target = asText(input.target)
  if (action !== '') payload.action = action
  if (target !== '') payload.target = target
  return payload
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
