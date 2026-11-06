// Hash 路由：纯函数，不碰 location / DOM，方便 node:test 直接测。
//
// 路由表（docs/build/m4-contract.md §5）：
//   #/                  配对
//   #/login             账号登录（cookie + CSRF）
//   #/register          注册账号（邮箱 + 密码）
//   #/verify-email      验证邮箱（?token=）
//   #/reset             申请重置密码
//   #/reset-confirm     用邮件 token 重置密码（?token=）
//   #/installs          已安装插件（更新/启停/卸载/回滚）
//   #/rooms/new         建群
//   #/rooms/:id         房间
//   #/rooms/:id/settings 房间设置
//   #/bots              Bot 列表（+ 新建入口）
//   #/bots/new          新建 Bot
//   #/bots/:id          Bot 设置
//   #/plugins           插件页（默认「市场」，页内可切「已安装」）
//   #/plugins/:slug     插件详情
//   #/panels            插件面板（DSH Web iframe 容器）
//   #/settings          设置（长期授权）
//   #/usage             用量（token / 工具调用 / 成本 / 配额）
//   #/schedules         定时任务（cron / 运行历史）
//   #/connectors        连接器（目录 + 按 Bot 授权）
//   兼容旧地址 #room    房间预览（假数据）
//
// 多端深链（ui.md §4，M5-5.4）：进入时先按下面三条解析，再由
// canonicalWorkspaceRoute 对照当前 workspace 规范化成上面的内部路由：
//   #/w/:workspaceId/room/:roomId
//   #/w/:workspaceId/bot/:botId
//   #/w/:workspaceId/approvals

const ROUTES = new Set([
  'pair',
  'login',
  'register',
  'verifyEmail',
  'reset',
  'resetConfirm',
  'installs',
  'room',
  'roomNew',
  'roomSettings',
  'bots',
  'botNew',
  'bot',
  'plugins',
  'plugin',
  'panels',
  'approvals',
  'settings',
  'usage',
  'schedules',
  'routines',
  'home',
  'connectors',
  'workspaceRoom',
  'workspaceBot',
  'workspaceApprovals',
  'notFound',
])

const WORKSPACE_ROUTES = new Set(['workspaceRoom', 'workspaceBot', 'workspaceApprovals'])

/** 去掉 #、补前导 /、去掉尾斜杠；空 hash 视为首页。 */
export function normalizeHash(hash) {
  let raw = String(hash ?? '')
  if (raw.startsWith('#')) raw = raw.slice(1)
  raw = raw.trim()
  if (raw === '') return '/'
  if (!raw.startsWith('/')) raw = `/${raw}`
  raw = raw.replace(/\/+$/, '')
  return raw === '' ? '/' : raw
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/**
 * @param {string} hash 形如 '#/bots/bot_1'（也接受 'bots/bot_1'、'#room'）
 * @returns {{name: string, params: Record<string, string|null>, path: string}}
 */
export function routeMatch(hash) {
  const normalized = normalizeHash(hash)
  const queryIndex = normalized.indexOf('?')
  const path = queryIndex === -1 ? normalized : normalized.slice(0, queryIndex)
  const query = new URLSearchParams(queryIndex === -1 ? '' : normalized.slice(queryIndex + 1))
  // 路径段参数优先；query 里同名的值不覆盖它（避免 ?id= 改掉真实路径）。
  const route = (name, params = {}) => {
    const merged = { ...params }
    for (const [key, value] of query) {
      if (!(key in merged)) merged[key] = value
    }
    return { name, params: merged, path }
  }
  if (path === '/') return route('pair')
  // 账号流程：固定一层；token 从 ?token= 读。
  if (path === '/login') return route('login')
  if (path === '/register') return route('register')
  if (path === '/verify-email') return route('verifyEmail')
  if (path === '/reset') return route('reset')
  if (path === '/reset-confirm') return route('resetConfirm')
  // 已安装插件：固定一层，不带参数。
  if (path === '/installs') return route('installs')
  // 需要你 / 待审批（addendum §C）：固定一层，不带参数。
  if (path === '/approvals') return route('approvals')
  // 设置（长期授权）：固定一层，不带参数。
  if (path === '/settings') return route('settings')
  // 用量：固定一层，不带参数。
  if (path === '/usage') return route('usage')
  // 定时任务：固定一层，不带参数。
  if (path === '/schedules') return route('schedules')
  if (path === '/routines') return route('routines')
  if (path === '/home') return route('home')
  // 连接器：固定一层，不带参数。
  if (path === '/connectors') return route('connectors')
  // 插件面板（ADR 0004）：固定一层，不带参数；面板路径由页面内清单决定。
  if (path === '/panels') return route('panels')

  const segments = path.split('/').filter(Boolean)
  const decoded = []
  for (const segment of segments) {
    const value = decodeSegment(segment)
    if (value === null || value === '') return route('notFound')
    decoded.push(value)
  }

  // 兼容 v0 的 #room：房间页预览，没有 id。
  if (decoded.length === 1 && decoded[0] === 'room') return route('room', { id: null })

  // 多端深链：#/w/:workspaceId/{room|bot}/:id 或 #/w/:workspaceId/approvals。
  // 结构不完整或多了段一律 notFound，不在解析阶段猜测。
  if (decoded[0] === 'w') {
    if (decoded.length === 3 && decoded[2] === 'approvals') {
      return route('workspaceApprovals', { workspaceId: decoded[1] })
    }
    if (decoded.length === 4 && decoded[2] === 'room') {
      return route('workspaceRoom', { workspaceId: decoded[1], id: decoded[3] })
    }
    if (decoded.length === 4 && decoded[2] === 'bot') {
      return route('workspaceBot', { workspaceId: decoded[1], id: decoded[3] })
    }
    return route('notFound')
  }

  if (decoded[0] === 'bots') {
    if (decoded.length === 1) return route('bots')
    if (decoded.length === 2 && decoded[1] === 'new') return route('botNew')
    if (decoded.length === 2) return route('bot', { id: decoded[1] })
    return route('notFound')
  }

  // 插件市场（plugin-marketplace.md §7）：列表固定一层，详情带 slug。
  if (decoded[0] === 'plugins') {
    if (decoded.length === 1) return route('plugins')
    if (decoded.length === 2) return route('plugin', { slug: decoded[1] })
    return route('notFound')
  }

  if (decoded[0] === 'rooms') {
    if (decoded.length === 2 && decoded[1] === 'new') return route('roomNew')
    if (decoded.length === 2) return route('room', { id: decoded[1] })
    if (decoded.length === 3 && decoded[2] === 'settings') {
      return route('roomSettings', { id: decoded[1] })
    }
    return route('notFound')
  }

  return route('notFound')
}

/**
 * 把多端深链规范化成现有内部路由。纯函数：workspaceId 由调用方先解析（ensureWorkspaceId）。
 *
 * - 与本账号当前 workspace 一致：`{ status: 'ok', match, hash }`，hash 用于 replaceState，
 *   match 是 routeMatch 同形状的内部路由（room / bot / approvals）。
 * - 不一致：`{ status: 'mismatch', workspaceId }`。调用方展示空态，不静默跳到别的 workspace。
 * - 不是深链路由：返回 null。
 *
 * @param {{name: string, params: Record<string, string|null>}} route
 * @param {string} workspaceId 当前账号的 workspaceId
 */
export function canonicalWorkspaceRoute(route, workspaceId) {
  if (!route || typeof route !== 'object' || !WORKSPACE_ROUTES.has(route.name)) return null
  const params = route.params && typeof route.params === 'object' ? route.params : {}
  const current = typeof workspaceId === 'string' ? workspaceId.trim() : ''
  if (current === '' || params.workspaceId !== current) {
    return {
      status: 'mismatch',
      workspaceId: typeof params.workspaceId === 'string' ? params.workspaceId : '',
    }
  }
  if (route.name === 'workspaceApprovals') {
    return {
      status: 'ok',
      match: { name: 'approvals', params: {}, path: '/approvals' },
      hash: '#/approvals',
    }
  }
  const id = typeof params.id === 'string' ? params.id : ''
  if (id === '') return { status: 'invalid' }
  const isRoom = route.name === 'workspaceRoom'
  const segment = isRoom ? 'rooms' : 'bots'
  return {
    status: 'ok',
    match: { name: isRoom ? 'room' : 'bot', params: { id }, path: `/${segment}/${id}` },
    hash: `#/${segment}/${encodeURIComponent(id)}`,
  }
}

/** 供测试与调用方确认路由名是已知值。 */
export function isKnownRoute(name) {
  return ROUTES.has(name)
}
