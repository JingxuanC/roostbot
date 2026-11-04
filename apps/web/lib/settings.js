// 设置页的纯逻辑：成员角色、设备状态、时间与错误文案。
//
// 数据来源（docs/design/auth.md §5/§10、§13）：成员列表/改角色/移除、设备列表/吊销。
// 这里不发请求、不碰 DOM；视图只负责把模型渲染成 textContent。
//
// 「当前账号」标记：成员行没有“我是谁”字段，页面用工作区角色做安全推断——只有该角色
// 在成员列表里唯一时才能确定是当前账号；有歧义就不标记（诚实优先）。若后端以后在成员行
// 上返回 isCurrent/current，会优先采用。

const ROLE_LABELS = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
  viewer: '只读',
}

const ROLE_BADGE_KINDS = {
  owner: 'accent',
  admin: 'warn',
  member: 'ok',
  viewer: '',
}

const ROLE_ORDER = ['owner', 'admin', 'member', 'viewer']

const PLATFORM_LABELS = {
  web: '浏览器',
  desktop: '桌面端',
  ios: 'iOS',
  android: 'Android',
  cli: '命令行',
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string' && value.trim() !== '') {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber)) return asNumber
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Number.NaN
}

// ---- 角色 ------------------------------------------------------------------

/** 角色中文名；未知角色原样显示，空值给中性文案。 */
export function roleLabel(role) {
  const value = asText(role)
  if (value === '') return '未知角色'
  return ROLE_LABELS[value] || value
}

/** 角色徽章：label + pill 颜色。未知角色用默认灰色。 */
export function roleBadge(role) {
  const value = asText(role)
  if (value === '') return { role: '', label: '未知角色', kind: '' }
  return {
    role: value,
    label: ROLE_LABELS[value] || value,
    kind: ROLE_BADGE_KINDS[value] || '',
  }
}

/** 角色下拉选项：owner / admin / member / viewer。 */
export function roleOptions() {
  return ROLE_ORDER.map((value) => ({ value, label: ROLE_LABELS[value] }))
}

/** 只有 owner/admin 能改角色或移除成员（服务端仍会二次校验）。 */
export function canManageMembers(role) {
  const value = asText(role)
  return value === 'owner' || value === 'admin'
}

// ---- 成员 ------------------------------------------------------------------

/**
 * 推断当前账号的 accountId：
 * 1. 后端若给了 isCurrent/current，直接用；
 * 2. 否则只有「当前角色在成员列表里唯一」时才敢认，多个同角色成员一律不猜。
 */
export function inferCurrentAccountId(members, currentRole) {
  const rows = (Array.isArray(members) ? members : []).filter(plainObject)
  const flagged = rows.find((row) => row.isCurrent === true || row.current === true)
  if (flagged) return asText(flagged.accountId)
  const role = asText(currentRole)
  if (role === '') return ''
  const matches = rows.filter((row) => asText(row.role) === role)
  if (matches.length !== 1) return ''
  return asText(matches[0].accountId)
}

/**
 * 成员列表模型：按加入时间升序（同毫秒按 accountId），补角色徽章、加入时间、
 * 是否是当前账号、是否是最后一个 owner。
 * currentAccountId 为空时不标记「你」。
 */
export function memberRows(members, options = {}) {
  const currentAccountId = asText(options.currentAccountId)
  const rows = (Array.isArray(members) ? members : [])
    .filter(plainObject)
    .map((member) => {
      const accountId = asText(member.accountId)
      const role = asText(member.role)
      const badge = roleBadge(role)
      return {
        accountId,
        role,
        roleLabel: badge.label,
        roleKind: badge.kind,
        invitedBy: asText(member.invitedBy),
        createdAt: member.createdAt,
        joinedAtLabel: settingsTimeLabel(member.createdAt),
        isCurrent:
          member.isCurrent === true ||
          member.current === true ||
          (currentAccountId !== '' && accountId === currentAccountId),
        isLastOwner: false,
      }
    })

  rows.sort((left, right) => {
    const a = toMs(left.createdAt)
    const b = toMs(right.createdAt)
    const aValid = Number.isFinite(a)
    const bValid = Number.isFinite(b)
    if (aValid && bValid && a !== b) return a - b
    if (aValid !== bValid) return aValid ? -1 : 1
    return left.accountId.localeCompare(right.accountId)
  })

  const ownerCount = rows.filter((row) => row.role === 'owner').length
  for (const row of rows) row.isLastOwner = row.role === 'owner' && ownerCount === 1

  return { rows, count: rows.length, ownerCount }
}

// ---- 设备 ------------------------------------------------------------------

/** 平台中文名；未知平台原样显示。 */
export function platformLabel(platform) {
  const value = asText(platform)
  if (value === '') return '未知平台'
  return PLATFORM_LABELS[value] || value
}

/** 设备状态：吊销优先于「当前设备」。 */
export function deviceStatus(device) {
  const row = plainObject(device)
  if (!row) return { label: '状态未知', kind: '', revoked: false, current: false }
  const revoked = Boolean(row.revokedAt ?? row.revoked_at)
  if (revoked) return { label: '已吊销', kind: 'danger', revoked: true, current: false }
  if (row.isCurrent === true) return { label: '当前设备', kind: 'ok', revoked: false, current: true }
  return { label: '正常', kind: '', revoked: false, current: false }
}

/** 已吊销或没有 id 的设备不能吊销；按钮禁用而不是假装成功。 */
export function canRevokeDevice(device) {
  const row = plainObject(device)
  if (!row) return false
  if (asText(row.id) === '') return false
  return !Boolean(row.revokedAt ?? row.revoked_at)
}

/** 到期相对时间：已过期 / N 分钟后到期 / N 小时后到期 / N 天后到期。 */
export function expiryRelative(expiresAt, now = Date.now()) {
  const ms = toMs(expiresAt)
  if (!Number.isFinite(ms) || ms <= 0) return '时间未知'
  const delta = ms - now
  if (delta <= 0) return '已过期'
  if (delta < MINUTE) return '不到 1 分钟后到期'
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} 分钟后到期`
  if (delta < DAY) return `${Math.floor(delta / HOUR)} 小时后到期`
  return `${Math.floor(delta / DAY)} 天后到期`
}

/** 最近活跃：缺失就是「从未活跃」，不拿当前时间冒充。 */
export function lastSeenLabel(lastSeenAt, now = Date.now()) {
  const ms = toMs(lastSeenAt)
  if (!Number.isFinite(ms) || ms <= 0) return '从未活跃'
  const delta = now - ms
  if (delta < MINUTE) return '刚刚'
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)} 分钟前`
  if (delta < DAY) return `${Math.floor(delta / HOUR)} 小时前`
  return `${Math.floor(delta / DAY)} 天前`
}

/**
 * 设备列表模型：label 缺省用「未命名设备」；到期同时给相对与绝对时间；
 * 最近活跃缺失写「从未活跃」。按接口顺序展示（当前设备不强行置顶）。
 */
export function deviceRows(devices, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const rows = (Array.isArray(devices) ? devices : []).filter(plainObject).map((device) => {
    const id = asText(device.id)
    const status = deviceStatus(device)
    return {
      id,
      label: asText(device.label) || '未命名设备',
      platform: asText(device.platform),
      platformLabel: platformLabel(device.platform),
      createdAt: device.createdAt,
      createdAtLabel: settingsTimeLabel(device.createdAt),
      expiresAt: device.expiresAt,
      expiresAtLabel: settingsTimeLabel(device.expiresAt),
      expiryRelative: expiryRelative(device.expiresAt, now),
      lastSeenAt: device.lastSeenAt,
      lastSeenLabel: lastSeenLabel(device.lastSeenAt, now),
      status,
      canRevoke: canRevokeDevice(device),
    }
  })
  return { rows, count: rows.length }
}

// ---- 错误与降级 ------------------------------------------------------------

/** 404 路由缺失 / 405 / 501 / 503 未配置：接口还没就绪，不白屏也不假装成功。 */
export function isSettingsNotReady(error) {
  const row = plainObject(error)
  if (!row) return false
  const code = asText(row.code)
  if (row.status === 405 || row.status === 501) return true
  if (row.status === 503 && (code === 'runtime.not_configured' || code === 'devices_unavailable')) {
    return true
  }
  if (row.status === 404 && (code === 'not_found' || code === 'http_404')) return true
  return false
}

/** 403 / forbidden：角色不足。 */
export function isSettingsForbidden(error) {
  const row = plainObject(error)
  if (!row) return false
  return row.status === 403 || asText(row.code) === 'forbidden'
}

/** 成员操作失败文案：409 last_owner、403、404、503 都有明确说法。 */
export function memberErrorText(error) {
  const row = plainObject(error)
  if (!row) return '操作失败，请重试。'
  const code = asText(row.code)
  if (row.status === 409 || code === 'workspace.last_owner') {
    return '不能移除/降级最后一个 owner'
  }
  if (isSettingsForbidden(row)) return '仅 owner/admin 可管理成员'
  if (isSettingsNotReady(row)) return '成员/设备接口未就绪'
  if (row.status === 404 || code === 'member_not_found') {
    if (code === 'workspace_not_found') return '找不到这个工作区，或你不是它的成员'
    return '这个成员已不在工作区，请刷新后重试'
  }
  if (code === 'workspace.invalid_role') return '角色不合法'
  const message = asText(row.message)
  return message === '' ? '操作失败，请重试。' : `操作失败：${message}`
}

/** 设备操作失败文案：吊销失败不等于“已吊销”，按状态码分开说。 */
export function deviceErrorText(error) {
  const row = plainObject(error)
  if (!row) return '吊销失败，请重试。'
  const code = asText(row.code)
  if (isSettingsNotReady(row)) return '成员/设备接口未就绪'
  if (isSettingsForbidden(row)) return '没有权限吊销这台设备'
  if (row.status === 404 || code === 'device_not_found') {
    return '这台设备已不存在，请刷新后重试'
  }
  if (row.status === 401) return '会话已失效，请重新配对'
  const message = asText(row.message)
  return message === '' ? '吊销失败，请重试。' : `吊销失败：${message}`
}

// ---- 时间（与长期授权保持同一格式） ----------------------------------------

/** 本地时区、固定 yyyy-mm-dd hh:mm；坏值写「时间未知」，不用当前时间冒充。 */
export function settingsTimeLabel(value) {
  const ms = toMs(value)
  if (!Number.isFinite(ms) || ms <= 0) return '时间未知'
  const date = new Date(ms)
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
