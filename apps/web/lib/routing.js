// Hash 路由：纯函数，不碰 location / DOM，方便 node:test 直接测。
//
// 路由表（docs/build/m4-contract.md §5）：
//   #/                  配对
//   #/rooms/new         建群
//   #/rooms/:id         房间
//   #/rooms/:id/settings 房间设置
//   #/bots              Bot 列表（+ 新建入口）
//   #/bots/new          新建 Bot
//   #/bots/:id          Bot 设置
//   兼容旧地址 #room    房间预览（假数据）

const ROUTES = new Set([
  'pair',
  'room',
  'roomNew',
  'roomSettings',
  'bots',
  'botNew',
  'bot',
  'approvals',
  'notFound',
])

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
  const path = normalizeHash(hash)
  const route = (name, params = {}) => ({ name, params, path })
  if (path === '/') return route('pair')
  // 需要你 / 待审批（addendum §C）：固定一层，不带参数。
  if (path === '/approvals') return route('approvals')

  const segments = path.split('/').filter(Boolean)
  const decoded = []
  for (const segment of segments) {
    const value = decodeSegment(segment)
    if (value === null || value === '') return route('notFound')
    decoded.push(value)
  }

  // 兼容 v0 的 #room：房间页预览，没有 id。
  if (decoded.length === 1 && decoded[0] === 'room') return route('room', { id: null })

  if (decoded[0] === 'bots') {
    if (decoded.length === 1) return route('bots')
    if (decoded.length === 2 && decoded[1] === 'new') return route('botNew')
    if (decoded.length === 2) return route('bot', { id: decoded[1] })
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

/** 供测试与调用方确认路由名是已知值。 */
export function isKnownRoute(name) {
  return ROUTES.has(name)
}
