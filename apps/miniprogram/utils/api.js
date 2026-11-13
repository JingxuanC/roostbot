// 控制面 REST 封装。零依赖，不引入 npm 包（CONVENTIONS.md 第 1 条）。
//
// 约定：
//   * 认证用 Authorization: Bearer；后端已支持，且带 Bearer 的客户端跳过 CSRF。
//   * 后端错误统一 { ok:false, error:{ code, message } }，这里归一成 Error(code/message/status)。
//   * 不写假数据：拿不到就报错，由页面如实展示（CONVENTIONS.md 第 6 条）。
const { BASE_URL } = require('./config.js')
const auth = require('./auth.js')

function normalizeError(statusCode, data) {
  const body = data && typeof data === 'object' ? data : {}
  const detail = body.error && typeof body.error === 'object' ? body.error : {}
  const err = new Error(detail.message || `请求失败 (${statusCode})`)
  err.code = detail.code || 'http_error'
  err.status = statusCode
  return err
}

/**
 * 发一个请求，返回 Promise<响应体>。
 * 401 时清掉本地 token（跳转登录由页面决定，这里不耦合路由）。
 */
function request(method, path, options) {
  const opts = options || {}
  return new Promise((resolve, reject) => {
    const header = { 'content-type': 'application/json' }
    const token = auth.getToken()
    if (token) header['Authorization'] = `Bearer ${token}`

    wx.request({
      url: BASE_URL + path,
      method: method,
      data: opts.data,
      header: header,
      timeout: opts.timeout || 10000,
      success: (res) => {
        const status = res.statusCode
        if (status === 401) auth.clearToken()
        if (status >= 200 && status < 300) {
          resolve(res.data)
          return
        }
        reject(normalizeError(status, res.data))
      },
      fail: (e) => {
        const err = new Error((e && e.errMsg) || '网络请求失败')
        err.code = 'network_error'
        err.status = 0
        reject(err)
      }
    })
  })
}

/** 配对码换会话（无需 token）：POST /api/pairing/claim */
function claimPairing(code, deviceLabel) {
  if (!/^\d{6}$/.test(String(code))) {
    return Promise.reject(new Error('配对码必须是 6 位数字'))
  }
  // platform 枚举见 apps/api/src/port.ts:30；MVP 复用 'web'，不改后端。
  return request('POST', '/api/pairing/claim', {
    data: { code: String(code), deviceLabel: deviceLabel || '微信小程序', platform: 'web' }
  })
}

/** GET /api/auth/me：校验 token 是否有效 */
function getMe() {
  return request('GET', '/api/auth/me')
}

/** GET /api/rooms → { rooms: [{ id, name, replyMode, members, ... }] } */
function getRooms() {
  return request('GET', '/api/rooms')
}

/** GET /api/workspaces（M2 用） */
function getWorkspaces() {
  return request('GET', '/api/workspaces')
}

/** GET /api/rooms/:id/messages?after=<seq>（M1 消息轮询用） */
function getMessages(roomId, afterSeq) {
  const query = afterSeq === undefined || afterSeq === null ? '' : `?after=${Number(afterSeq)}`
  return request('GET', `/api/rooms/${encodeURIComponent(roomId)}/messages${query}`)
}

/** POST /api/auth/logout */
function logout() {
  return request('POST', '/api/auth/logout')
}

module.exports = {
  request,
  normalizeError,
  claimPairing,
  getMe,
  getRooms,
  getWorkspaces,
  getMessages,
  logout
}
