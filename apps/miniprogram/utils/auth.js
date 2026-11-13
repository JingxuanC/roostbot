// 会话 token 存小程序本地。后端 pairing/claim 下发 sessionToken + expiresAt，
// 后续所有请求以 Authorization: Bearer <sessionToken> 携带（server.ts:660 已支持）。
const TOKEN_KEY = 'roost_token'
const EXPIRES_KEY = 'roost_token_expires'

function getToken() {
  const token = wx.getStorageSync(TOKEN_KEY)
  if (!token) return ''
  const expiresAt = Number(wx.getStorageSync(EXPIRES_KEY) || 0)
  if (expiresAt > 0 && Date.now() >= expiresAt) {
    clearToken()
    return ''
  }
  return String(token)
}

function saveSession(sessionToken, expiresAt) {
  if (!sessionToken) throw new Error('claim 响应缺少 sessionToken')
  wx.setStorageSync(TOKEN_KEY, String(sessionToken))
  if (expiresAt) wx.setStorageSync(EXPIRES_KEY, String(expiresAt))
}

function clearToken() {
  wx.removeStorageSync(TOKEN_KEY)
  wx.removeStorageSync(EXPIRES_KEY)
}

function isLoggedIn() {
  return getToken() !== ''
}

module.exports = { getToken, saveSession, clearToken, isLoggedIn, TOKEN_KEY, EXPIRES_KEY }
