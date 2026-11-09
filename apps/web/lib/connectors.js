// 连接器页的纯逻辑：状态文案、动作展示、授权表单校验、错误降级判定。
//
// 数据契约（apps/api/src/connectors-routes.ts、docs/design/connectors.md §3/§4/§9）：
//   GET    /api/connectors?workspaceId=&botId=  → { connectors, connections, botGrants? }
//   POST   /api/connectors/:slug/connect        → 201 { url, state }
//   DELETE /api/connectors/:slug?workspaceId=   → 204
//   GET    /api/connectors/:slug/grants?workspaceId= → { grants }
//   PUT    /api/connectors/:slug/grants         → 200 { grant }
// 这里不发请求、不碰 DOM，方便 node:test 直接测。

export const MAX_ACTION_CHARS = 200
export const MAX_ACTIONS = 200

export const GRANT_ACCESS_OPTIONS = [
  { value: 'read', label: 'read · 只读' },
  { value: 'write', label: 'write · 读写' },
]

const STATUS_LABELS = {
  connected: '已连接',
  expired: '已过期',
  revoked: '已撤销',
}

const STATUS_KINDS = {
  connected: 'ok',
  expired: 'warn',
  revoked: 'danger',
}

const FORBIDDEN_ACTIONS = {
  view: '查看连接器',
  connect: '发起连接',
  disconnect: '断开连接',
  grants: '查看连接器授权',
  save: '修改连接器授权',
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

// ---- 状态 ------------------------------------------------------------------

/** 连接状态文案：connected/expired/revoked/null 已有固定说法，未知值原样显示。 */
export function connectorStatusLabel(status) {
  const text = asText(status)
  if (text === '') return '未连接'
  return STATUS_LABELS[text] || text
}

/** 状态徽章颜色：未知状态退回中性灰。 */
export function connectorStatusKind(status) {
  return STATUS_KINDS[asText(status)] || ''
}

/** 以服务端 connected 布尔为准，缺失时再看 status。 */
export function isConnectorConnected(card) {
  if (!plainObject(card)) return false
  if (card.connected === true) return true
  return asText(card.status) === 'connected'
}

/** 未连接时的按钮文案：过期/撤销后强调这是重连。 */
export function connectButtonLabel(status) {
  const text = asText(status)
  return text === 'expired' || text === 'revoked' ? '重新连接' : '连接'
}

// ---- 动作 ------------------------------------------------------------------

/** 动作清单：接受卡片或数组，去掉空值与重复项。 */
export function connectorActions(value) {
  const source = Array.isArray(value) ? value : plainObject(value)?.actions
  const list = []
  const seen = new Set()
  for (const item of Array.isArray(source) ? source : []) {
    const text = asText(item)
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    list.push(text)
  }
  return list
}

/** 动作展示文案；没有动作时诚实写「无」，不编默认动作。 */
export function actionsText(value) {
  const list = connectorActions(value)
  return list.length === 0 ? '无' : list.join('、')
}

// ---- 授权 ------------------------------------------------------------------

export function canConnectConnectors(role) {
  const value = asText(role)
  // 任意成员都可以连接自己的账号；角色未知时先放出控件，由服务端兜底。
  return value === '' || value === 'owner' || value === 'admin' || value === 'viewer'
}

export function canManageConnectors(role) {
  const value = asText(role)
  // 角色未知时先放出控件，让服务端 403 给出权威结果（与定时任务页一致）。
  return value === '' || value === 'owner' || value === 'admin'
}

export function grantAccessLabel(access) {
  const value = asText(access)
  if (value === 'read') return '只读'
  if (value === 'write') return '读写'
  return value === '' ? '未指定' : value
}

/** 在 grant 列表里找某个 Bot 的授权。 */
export function grantForBot(grants, botId) {
  const target = asText(botId)
  if (target === '') return null
  for (const grant of Array.isArray(grants) ? grants : []) {
    if (plainObject(grant) && asText(grant.botId) === target) return grant
  }
  return null
}

/**
 * 现有 grant 回填到表单：已知动作进复选框，未知动作进逗号输入。
 * actions=null 表示该权限下全部动作，不自动勾满（勾选会变成显式 allowlist）。
 */
export function grantActionSelection(grant, knownActions) {
  const known = connectorActions(knownActions)
  const listed = plainObject(grant) ? connectorActions(grant.actions) : []
  return {
    checked: listed.filter((action) => known.includes(action)),
    extraText: listed.filter((action) => !known.includes(action)).join(', '),
  }
}

/** 当前授权摘要；没有授权时明说，不显示成「全部动作」。 */
export function grantSummary(grant) {
  if (!plainObject(grant)) return '当前没有这个 Bot 的授权。'
  const actions = connectorActions(grant.actions)
  const scope = actions.length === 0 ? '全部动作' : `${actions.length} 个动作`
  return `当前：${grantAccessLabel(grant.access)} · ${scope}`
}

function normalizeActionList(items) {
  const list = []
  const seen = new Set()
  for (const item of Array.isArray(items) ? items : []) {
    const text = asText(item)
    if (text === '') continue
    if (text.length > MAX_ACTION_CHARS) {
      return { ok: false, error: `动作名不能超过 ${MAX_ACTION_CHARS} 个字符` }
    }
    if (seen.has(text)) continue
    seen.add(text)
    list.push(text)
  }
  if (list.length > MAX_ACTIONS) {
    return { ok: false, error: `动作最多 ${MAX_ACTIONS} 个` }
  }
  return { ok: true, actions: list }
}

/** 逗号输入（中英文逗号/换行都认）→ 动作数组。 */
export function parseActionInput(text) {
  const raw = typeof text === 'string' ? text : ''
  return normalizeActionList(raw.split(/[,，\n]/))
}

/**
 * 校验授权表单：access 必须是 read/write；动作可空（空 = 该权限下全部动作）。
 * @returns {{ok: true, access: string, actions: string[]|null} | {ok: false, error: string}}
 */
export function validateGrantForm(input = {}) {
  const access = asText(input.access)
  if (access !== 'read' && access !== 'write') {
    return { ok: false, error: '权限必须是 read（只读）或 write（读写）' }
  }
  const selected = normalizeActionList(input.selectedActions)
  if (!selected.ok) return selected
  const extra = parseActionInput(input.extraActions)
  if (!extra.ok) return extra
  const merged = normalizeActionList([...selected.actions, ...extra.actions])
  if (!merged.ok) return merged
  return {
    ok: true,
    access,
    actions: merged.actions.length === 0 ? null : merged.actions,
  }
}

/** PUT 请求体；actions 为空时省略（后端按 null 处理 = 全部动作）。 */
export function connectorGrantPayload(input = {}) {
  const workspaceId = asText(input.workspaceId)
  const botId = asText(input.botId)
  const access = asText(input.access)
  if (workspaceId === '' || botId === '' || (access !== 'read' && access !== 'write')) return null
  const payload = { workspaceId, botId, access }
  const connectionId = asText(input.connectionId)
  if (connectionId !== '') payload.connectionId = connectionId
  const normalized = normalizeActionList(input.actions)
  if (normalized.ok && normalized.actions.length > 0) payload.actions = normalized.actions
  return payload
}

// ---- 错误降级 --------------------------------------------------------------

/** 403 / forbidden：角色不足。 */
export function isConnectorForbidden(error) {
  const row = plainObject(error)
  if (!row) return false
  return row.status === 403 || asText(row.code) === 'forbidden'
}

/** 501 / connector.not_configured：网关没有配置（Stub 网关的预期行为）。 */
export function isConnectorNotConfigured(error) {
  const row = plainObject(error)
  if (!row) return false
  return row.status === 501 || asText(row.code) === 'connector.not_configured'
}

/** 404 路由缺失 / 405 / 501 / 503：连接器接口未就绪。 */
export function isConnectorNotReady(error) {
  const row = plainObject(error)
  if (!row) return false
  const status = row.status
  const code = asText(row.code)
  if (status === 405 || status === 501 || status === 503) return true
  return status === 404 && (code === 'not_found' || code === 'http_404')
}

/** 授权地址只允许 http/https，避免把服务端值直接当可执行 URL 打开。 */
export function isSafeAuthUrl(url) {
  const text = asText(url)
  if (text === '') return false
  try {
    const parsed = new URL(text)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

/** 操作失败文案：按 action 区分 403 的权限说法；501/503 如实说未就绪。 */
export function connectorErrorText(error, action = 'view') {
  const row = plainObject(error)
  if (!row) return '操作失败，请重试。'
  const status = row.status
  const code = asText(row.code)
  const message = asText(row.message)
  if (
    status === 401 ||
    code === 'unauthenticated' ||
    code === 'session_expired' ||
    code === 'session_revoked'
  ) {
    return '会话已失效，请重新配对。'
  }
  if (isConnectorForbidden(row)) {
    return `仅 owner/admin 可${FORBIDDEN_ACTIONS[action] || '管理连接器'}。`
  }
  if (isConnectorNotConfigured(row)) {
    return '连接器网关未配置（HTTP 501 · connector.not_configured）：控制面没有可用的连接器网关，无法发起授权。'
  }
  if (isConnectorNotReady(row)) {
    return `连接器接口未就绪（HTTP ${status ?? '?'}${code === '' ? '' : ` · ${code}`}）：这次没有发生状态变化。`
  }
  if (status === 404) {
    return '找不到这个连接器，请刷新列表后重试。'
  }
  if (message !== '') return message
  return `操作失败（HTTP ${status ?? '?'}${code === '' ? '' : ` · ${code}`}）。`
}
