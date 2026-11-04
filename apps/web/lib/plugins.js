// 插件市场的纯逻辑（docs/design/plugin-marketplace.md §3/§7/§8/§12）。
//
// 数据来自控制面只读接口（形状见 apps/api/src/marketplace-routes.ts）：
//   卡片：{slug,title,publisherId,category,tier,tierLabel,summary,latest,icon,
//          screenshots,updatedAt,installed,engines,permissions,requirements}
//   预检：{slug,version,tier,tierLabel,ok,problems,reasons,permissions,requires,engines}
//   安装：{id,workspaceId,slug,version,enabled,state,latest,updateAvailable,...}
//
// 这个模块不发请求、不碰 DOM，方便 node:test 直接测。
// 尤其注意：本批没有沙箱 sync，安装/升级后 state 会停在 installing；
// 文案只说「等待沙箱同步」，绝不说「已安装成功」。

const TIER_LABELS = {
  A: '直接可用',
  B: '需要授权资源',
  C: '需要界面容器',
  D: '仅桌面',
}

const TIER_KINDS = {
  A: 'ok',
  B: 'accent',
  C: 'warn',
  D: 'warn',
}

const INSTALL_STATE_LABELS = {
  installing: '等待沙箱同步',
  installed: '已安装',
  failed: '失败',
  disabling: '停用中',
}

const INSTALL_STATE_KINDS = {
  installing: 'warn',
  installed: 'ok',
  failed: 'danger',
  disabling: 'warn',
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeTier(tier) {
  return asText(tier).toUpperCase()
}

function stringList(value) {
  const seen = new Set()
  const list = []
  for (const item of Array.isArray(value) ? value : []) {
    const text = asText(item)
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    list.push(text)
  }
  return list
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** A/B/C/D 的中文名；接口没给 tierLabel 或给了未知值时兜底，不把 undefined 打到界面。 */
export function pluginTierLabel(tier, fallback = '') {
  const value = normalizeTier(tier)
  if (value === '') return asText(fallback) || '级别未知'
  return TIER_LABELS[value] || asText(fallback) || value
}

/** 徽章文案：`B 级 · 需要授权资源`。 */
export function pluginTierBadgeText(tier, tierLabel) {
  const value = normalizeTier(tier)
  if (value === '') return asText(tierLabel) || '级别未知'
  return `${value} 级 · ${pluginTierLabel(value, tierLabel)}`
}

/** 徽章颜色：A 绿、B 主色、C/D 警示。 */
export function pluginTierKind(tier) {
  return TIER_KINDS[normalizeTier(tier)] || ''
}

/** 本批只允许 A/B 级安装（§12：C 需要 DSH Web，D 仅桌面）。 */
export function pluginInstallableTier(tier) {
  const value = normalizeTier(tier)
  return value === 'A' || value === 'B'
}

/** 不能安装时的诚实原因；A/B 返回空字符串。 */
export function pluginInstallBlockReason(tier) {
  const value = normalizeTier(tier)
  if (value === 'A' || value === 'B') return ''
  if (value === 'C') return 'C 级需要 DSH Web 界面容器，v1 暂不支持安装。'
  if (value === 'D') return 'D 级仅桌面可用，云端不支持安装。'
  return '只有 A/B 级插件可以安装。'
}

/** 字节数 → 人读的磁盘占用。0/非法值返回 `0 B`，由权限摘要决定是否显示「无」。 */
export function formatDiskBytes(bytes) {
  const value = nonNegativeNumber(bytes)
  if (value === 0) return '0 B'
  if (value >= 1e9) return `${trimNumber(value / 1e9)} GB`
  if (value >= 1e6) return `${Math.ceil(value / 1e6)} MB`
  if (value >= 1e3) return `${Math.ceil(value / 1e3)} KB`
  return `${Math.round(value)} B`
}

function trimNumber(value) {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/**
 * 权限摘要（plugin-marketplace.md §3/§7）：网络域、凭据、磁盘、面板、数据面。
 * source 可以是预检结果（requires），也可以是卡片/版本（requirements），
 * 两者缺失时回退到 permissions 里的同名字段。
 */
export function pluginPermissionItems(source) {
  const row = plainObject(source) || {}
  const permissions = plainObject(row.permissions) || {}
  const requires = plainObject(row.requires) || plainObject(row.requirements) || {}

  const network = stringList(requires.network).length > 0 ? stringList(requires.network) : stringList(permissions.network)
  const credentials = stringList(requires.credentials).length > 0 ? stringList(requires.credentials) : stringList(permissions.credentials)
  const binaries = stringList(requires.binaries).length > 0 ? stringList(requires.binaries) : stringList(permissions.binaries)
  const dataMounts = stringList(requires.dataMounts).length > 0 ? stringList(requires.dataMounts) : stringList(permissions.dataMounts)
  const diskBytes = nonNegativeNumber(requires.diskBytes) > 0 ? requires.diskBytes : nonNegativeNumber(permissions.diskBytes)
  const panelCount = nonNegativeNumber(requires.panels) > 0 ? requires.panels : nonNegativeNumber(permissions.panels)
  const toolCount = nonNegativeNumber(permissions.tools)
  const skillCount = nonNegativeNumber(permissions.skills)

  const items = [
    { label: '网络域', value: network.length > 0 ? network.join('、') : '无', missing: network.length === 0 },
    { label: '凭据', value: credentials.length > 0 ? credentials.join('、') : '无', missing: credentials.length === 0 },
    { label: '磁盘', value: diskBytes > 0 ? formatDiskBytes(diskBytes) : '无', missing: diskBytes === 0 },
    { label: '面板', value: panelCount > 0 ? `${panelCount} 个` : '无', missing: panelCount === 0 },
    { label: '数据面', value: dataMounts.length > 0 ? dataMounts.join('、') : '无', missing: dataMounts.length === 0 },
    { label: '二进制', value: binaries.length > 0 ? binaries.join('、') : '无', missing: binaries.length === 0 },
  ]
  if (toolCount > 0) items.push({ label: '工具', value: `${toolCount} 个`, missing: false })
  if (skillCount > 0) items.push({ label: '技能', value: `${skillCount} 个`, missing: false })
  return items
}

/** 安装状态文案。installing 必须是「等待沙箱同步」，不是「已安装」。 */
export function pluginInstallStateLabel(state) {
  const value = asText(state)
  if (value === '') return '状态未知'
  return INSTALL_STATE_LABELS[value] || value
}

/** 徽章文案：保留原始 state，后面跟中文解释，避免只有中文看不出接口状态。 */
export function pluginInstallStateBadge(state) {
  const value = asText(state)
  if (value === '') return '状态未知'
  return `${value} · ${pluginInstallStateLabel(value)}`
}

export function pluginInstallStateKind(state) {
  return INSTALL_STATE_KINDS[asText(state)] || ''
}

/** 更新可用：服务端布尔值优先；没有再比较 latest/version。 */
export function pluginUpdateAvailable(install) {
  const row = plainObject(install) || {}
  if (typeof row.updateAvailable === 'boolean') return row.updateAvailable
  const latest = asText(row.latest)
  const version = asText(row.version)
  return latest !== '' && version !== '' && latest !== version
}

export const INSTALL_RECORDED_MESSAGE = '安装已记录（state=installing），等待沙箱同步。'
export const INSTALL_ALREADY_MESSAGE = '这个插件已经记录过安装（state=installing），等待沙箱同步。'
export const INSTALL_SYNC_NOTE =
  '本批没有沙箱同步：安装/升级只会写记录，state 停在 installing；界面不会把等待同步当成安装完成。'

/**
 * 安装接口（202/200）的界面文案。重复安装（alreadyInstalled）单独说清楚。
 * 即使服务端将来返回 installed，也不冒充「成功」以外的状态。
 */
export function pluginInstallResultMessage(result) {
  const row = plainObject(result) || {}
  if (row.alreadyInstalled === true) return INSTALL_ALREADY_MESSAGE
  const install = plainObject(row.install) || {}
  const state = asText(install.state) || 'installing'
  if (state === 'installing') return INSTALL_RECORDED_MESSAGE
  return `安装已记录（state=${state}）。`
}

/** 插件详情地址；slug 为空时回市场。 */
export function pluginDetailHref(slug) {
  const value = asText(slug)
  return value === '' ? '#/plugins' : `#/plugins/${encodeURIComponent(value)}`
}

/**
 * 图标/截图 URL 白名单：只允许 http(s) 绝对地址，或同源路径。
 * javascript:、data:、blob:、协议相对的 //host、带反斜杠/控制字符的值一律拒绝。
 */
export function safeAssetUrl(value) {
  const raw = asText(value)
  if (raw === '') return ''
  if (/[ -\\]/.test(raw)) return ''
  if (raw.startsWith('//')) return ''
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
      return raw
    } catch {
      return ''
    }
  }
  // 其它 scheme（javascript:、data:、file: …）一律拒绝；剩下的就是同源路径。
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return ''
  return raw
}
