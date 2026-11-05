// 设备会话持久化（配对 token 与最近房间）。
//
// 配对成功后控制面返回 sessionToken；之前只存在内存里，手机浏览器刷新/重新打开就丢。
// 这里用 localStorage 记住 token（同源、只存 token，不存账号密码）和最近房间，
// 让「打开就是房间」在移动端成立。所有读写都包在 try/catch 里：隐私模式/禁用存储时退化为内存会话。

export const TOKEN_KEY = 'roost.sessionToken'
export const ROOM_KEY = 'roost.lastRoom'

function storage() {
  try {
    const candidate = globalThis.localStorage
    return candidate && typeof candidate.getItem === 'function' ? candidate : null
  } catch {
    return null
  }
}

export function readSessionToken() {
  const store = storage()
  if (store === null) return null
  try {
    const value = store.getItem(TOKEN_KEY)
    return typeof value === 'string' && value !== '' ? value : null
  } catch {
    return null
  }
}

export function writeSessionToken(token) {
  if (typeof token !== 'string' || token === '') return false
  const store = storage()
  if (store === null) return false
  try {
    store.setItem(TOKEN_KEY, token)
    return true
  } catch {
    return false
  }
}

export function clearSessionToken() {
  const store = storage()
  if (store === null) return
  try {
    store.removeItem(TOKEN_KEY)
    store.removeItem(ROOM_KEY)
  } catch {
    // 清不掉也不影响当前内存会话。
  }
}

export function readLastRoom() {
  const store = storage()
  if (store === null) return null
  try {
    const value = store.getItem(ROOM_KEY)
    return typeof value === 'string' && value.startsWith('#/rooms/') ? value : null
  } catch {
    return null
  }
}

export function writeLastRoom(hash) {
  if (typeof hash !== 'string' || !hash.startsWith('#/rooms/')) return false
  const store = storage()
  if (store === null) return false
  try {
    store.setItem(ROOM_KEY, hash)
    return true
  } catch {
    return false
  }
}
