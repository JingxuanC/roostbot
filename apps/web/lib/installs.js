// 插件安装流水线的纯逻辑（docs/build/wave1.md §B/§D、docs/design/plugin-marketplace.md §7）。
//
// 这一层只负责：状态文案、权限披露、409 预检问题、202 审批/轮询计划、
// 已安装页的可用动作、Bot 工具来源。不发请求、不碰 DOM。
//
// 诚实原则：state=installing 只写“等待沙箱同步/安装中”，绝不写“安装成功”；
// failed 必须带服务端 error 原样显示；轮询到 60s 就停，不假装一直在跑。

export const INSTALL_POLL_INTERVAL_MS = 2_000
export const INSTALL_POLL_MAX_MS = 60_000

const STATE_LABELS = {
  preflight: '预检中',
  'awaiting-approval': '等待批准',
  installing: '安装中',
  installed: '已安装',
  failed: '失败',
  'rolling-back': '回滚中',
  'rolled-back': '已回滚',
  disabled: '已停用',
}

const STATE_KINDS = {
  preflight: 'warn',
  'awaiting-approval': 'warn',
  installing: 'accent',
  installed: 'ok',
  failed: 'danger',
  'rolling-back': 'warn',
  'rolled-back': 'warn',
  disabled: 'warn',
}

const TERMINAL_STATES = new Set(['installed', 'failed', 'rolled-back'])
const ACTIONS = new Set(['update', 'disable', 'enable', 'uninstall', 'rollback'])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function objectOf(value) {
  return isObject(value) ? value : null
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function textList(value) {
  const seen = new Set()
  const rows = []
  for (const item of Array.isArray(value) ? value : []) {
    const text = asText(item)
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    rows.push(text)
  }
  return rows
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function formatBytes(bytes) {
  const value = nonNegativeNumber(bytes)
  if (value === 0) return ''
  if (value >= 1e9) return `${trimNumber(value / 1e9)} GB`
  if (value >= 1e6) return `${Math.ceil(value / 1e6)} MB`
  if (value >= 1e3) return `${Math.ceil(value / 1e3)} KB`
  return `${Math.round(value)} B`
}

function trimNumber(value) {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** 状态 → 中文；未知状态原样返回，不吞掉接口值。 */
export function installStateLabel(state) {
  const value = asText(state)
  if (value === '') return '状态未知'
  return STATE_LABELS[value] || value
}

/** 状态 → 徽章：`awaiting-approval · 等待批准`。 */
export function installStateBadge(state) {
  const value = asText(state)
  if (value === '') return '状态未知'
  return `${value} · ${installStateLabel(value)}`
}

export function installStateKind(state) {
  return STATE_KINDS[asText(state)] || ''
}

export function isInstallTerminal(state) {
  return TERMINAL_STATES.has(asText(state))
}

export function isInstallAwaitingApproval(state) {
  return asText(state) === 'awaiting-approval'
}

/**
 * 权限披露：固定顺序 network / credentials / disk / binaries / panels，
 * 兼容 permissions 与 requirements/requires 两种形状（manifest 与预检结果）。
 * 返回 [{key,label,text,missing}]；没有声明的项显示“无”，不隐藏“它要什么”。
 */
export function permissionDisclosure(source) {
  const row = objectOf(source) || {}
  const permissions = objectOf(row.permissions) || {}
  const requirements = objectOf(row.requirements) || objectOf(row.requires) || {}

  const pickList = (key) => {
    const fromRequirements = textList(requirements[key])
    return fromRequirements.length > 0 ? fromRequirements : textList(permissions[key])
  }
  const pick = (key) => {
    const value = requirements[key]
    if (value !== undefined && value !== null && value !== '') return value
    return permissions[key]
  }

  const network = pickList('network')
  const credentials = pickList('credentials')
  const binaries = pickList('binaries')
  const dataMounts = pickList('dataMounts')

  const diskValue = pick('disk')
  const diskBytes = nonNegativeNumber(pick('diskBytes'))
  const diskText =
    asText(diskValue) !== ''
      ? asText(diskValue)
      : diskBytes > 0
        ? formatBytes(diskBytes)
        : ''

  const panelsValue = pick('panels')
  let panelsText = ''
  if (typeof panelsValue === 'number' && Number.isFinite(panelsValue) && panelsValue > 0) {
    panelsText = `${panelsValue} 个`
  } else if (Array.isArray(panelsValue)) {
    const names = textList(panelsValue)
    if (names.length > 0) panelsText = names.join('、')
  } else if (asText(panelsValue) !== '') {
    panelsText = asText(panelsValue)
  }

  const rows = [
    { key: 'network', label: '网络域', text: network.length > 0 ? network.join('、') : '无', missing: network.length === 0 },
    { key: 'credentials', label: '凭据', text: credentials.length > 0 ? credentials.join('、') : '无', missing: credentials.length === 0 },
    { key: 'disk', label: '磁盘', text: diskText === '' ? '无' : diskText, missing: diskText === '' },
    { key: 'binaries', label: '二进制', text: binaries.length > 0 ? binaries.join('、') : '无', missing: binaries.length === 0 },
    { key: 'panels', label: '面板', text: panelsText === '' ? '无' : panelsText, missing: panelsText === '' },
  ]
  if (dataMounts.length > 0) {
    rows.push({ key: 'dataMounts', label: '数据面', text: dataMounts.join('、'), missing: false })
  }
  return rows
}

/**
 * POST install 的 409 plugin.preflight：从 ApiError.body 取 problems。
 * 不是这个错误返回 null，调用方继续走普通错误分支。
 */
export function preflightFromError(error) {
  if (!error || error.status !== 409) return null
  const body = objectOf(error.body) || {}
  const nested = objectOf(body.error) || {}
  const rawProblems = Array.isArray(body.problems)
    ? body.problems
    : Array.isArray(nested.problems)
      ? nested.problems
      : []
  // 契约 code 是 plugin.preflight；有些代理会把它压成 http_409，但 problems 还在。
  if (error.code !== 'plugin.preflight' && rawProblems.length === 0) return null
  const problems = rawProblems.map((problem) => {
    if (typeof problem === 'string') return { code: 'problem', detail: problem }
    const row = objectOf(problem) || {}
    const code = asText(row.code) || 'problem'
    const detail = asText(row.detail) || asText(row.message)
    return { code, detail }
  })
  const permissions = objectOf(body.permissions) || objectOf(nested.permissions)
  return {
    problems,
    permissions,
    tier: asText(body.tier) || asText(nested.tier),
    message: asText(nested.message) || asText(body.message) || '预检未通过',
  }
}

/** 规整 202/200 响应，决定界面下一步显示什么。 */
export function installResponsePlan(payload) {
  const body = objectOf(payload) || {}
  const job = objectOf(body.job)
  const approval = objectOf(body.approval)
  const install = objectOf(body.install)
  if (approval !== null || (job && asText(job.state) === 'awaiting-approval')) {
    return { kind: 'approval', job, approval, install }
  }
  if (job !== null) return { kind: 'job', job, approval: null, install }
  if (install !== null) return { kind: 'install', job: null, approval: null, install }
  return { kind: 'unknown', job: null, approval: null, install: null }
}

/** 轮询用的 install id：job.installId / job.install_id / body.install.id。 */
export function installIdFromResponse(payload) {
  const body = objectOf(payload) || {}
  const job = objectOf(body.job) || {}
  const install = objectOf(body.install) || {}
  return asText(job.installId) || asText(job.install_id) || asText(install.id) || asText(body.installId)
}

/**
 * 2s 轮询、最多 60s、页面隐藏时暂停。返回 pause / wait / stop。
 * startedAt=0 表示还没开始（先等一拍）。
 */
export function pollDecision(options = {}) {
  const visible = options.visible !== false
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const startedAt = Number.isFinite(options.startedAt) ? options.startedAt : 0
  const state = asText(options.state)
  if (!visible) return 'pause'
  if (startedAt <= 0) return 'wait'
  if (now - startedAt >= INSTALL_POLL_MAX_MS) return 'stop'
  if (isInstallTerminal(state)) return 'stop'
  return 'wait'
}

/** 已安装页每个动作是否可用；不冒充“有更新”或“能回滚”。 */
export function installActions(install) {
  const row = objectOf(install) || {}
  const state = asText(row.state)
  const latest = asText(row.latest)
  const version = asText(row.version)
  const updateAvailable =
    typeof row.updateAvailable === 'boolean' ? row.updateAvailable : latest !== '' && latest !== version
  const rollbackVersion = asText(row.previousVersion) || asText(row.rollbackVersion)
  return {
    update: Boolean(updateAvailable && latest !== '' && latest !== version),
    updateVersion: latest,
    disable: row.enabled !== false,
    enable: row.enabled === false,
    uninstall: true,
    rollback: rollbackVersion !== '' || state === 'failed' || state === 'rolled-back',
    rollbackVersion,
  }
}

export function installsListPath(workspaceId) {
  const id = asText(workspaceId)
  return id === '' ? '/api/plugin-installs' : `/api/plugin-installs?workspaceId=${encodeURIComponent(id)}`
}

export function installDetailPath(installId) {
  const id = asText(installId)
  return id === '' ? '/api/plugin-installs' : `/api/plugin-installs/${encodeURIComponent(id)}`
}

/** 动作 → 真实请求路径；未知动作返回空字符串（调用方不应发请求）。 */
export function installActionPath(installId, action) {
  const id = asText(installId)
  const name = asText(action)
  if (id === '' || !ACTIONS.has(name)) return ''
  return `/api/plugin-installs/${encodeURIComponent(id)}/${name}`
}

/** 动作请求体：update 必须带目标版本，其它动作不带 body。 */
export function installActionRequest(install, action, options = {}) {
  const row = objectOf(install) || {}
  const id = asText(row.id)
  const name = asText(action)
  const path = installActionPath(id, name)
  if (path === '') return null
  if (name === 'update') {
    const version = asText(options.version) || asText(row.latest)
    if (version === '') return null
    return { path, body: { version } }
  }
  return { path, body: undefined }
}

/**
 * Bot 工具来源：优先 bot.tools 自带的 source；没有时用 installs[].tools 反查。
 * 只返回有 source 的项；没有来源就不显示，绝不猜一个插件名。
 */
export function toolSourceRows(options = {}) {
  const bot = objectOf(options.bot) || {}
  const installs = Array.isArray(options.installs) ? options.installs : []

  const nameOf = (tool) => {
    if (typeof tool === 'string') return asText(tool)
    const row = objectOf(tool) || {}
    return asText(row.name) || asText(row.id) || asText(row.tool) || asText(row.ref)
  }
  const ownSourceOf = (tool) => {
    if (typeof tool === 'string') return ''
    const row = objectOf(tool) || {}
    return asText(row.source) || asText(row.sourceLabel) || asText(row.pluginSlug) || asText(row.pluginTitle)
  }

  const installRows = []
  const sourceByName = new Map()
  for (const install of installs) {
    const row = objectOf(install) || {}
    const installSource =
      asText(row.title) || asText(row.slug) || asText(row.pluginTitle) || asText(row.pluginSlug)
    for (const tool of Array.isArray(row.tools) ? row.tools : []) {
      const name = nameOf(tool)
      if (name === '') continue
      const source = ownSourceOf(tool) || installSource
      if (source === '') continue
      installRows.push({ name, source })
      if (!sourceByName.has(name)) sourceByName.set(name, source)
    }
  }

  const rows = []
  const seen = new Set()
  for (const tool of Array.isArray(bot.tools) ? bot.tools : []) {
    const name = nameOf(tool)
    if (name === '') continue
    const source = ownSourceOf(tool) || sourceByName.get(name) || ''
    if (source === '') continue
    const key = `${name}\u0000${source}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ name, source })
  }
  // bot 详情没给 tools 时，退回 installs[].tools；仍然只显示有来源的。
  if (rows.length === 0) {
    for (const row of installRows) {
      const key = `${row.name}\u0000${row.source}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(row)
    }
  }
  return rows
}

/** 安装任务失败时把服务端 error 原样带出来。 */
export function installJobError(job) {
  const row = objectOf(job) || {}
  return asText(row.error) || asText(row.message)
}

/** 审批链接：只有真的需要批准时才给。 */
export function installApprovalHref() {
  return '#/approvals'
}
