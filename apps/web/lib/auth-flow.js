// 账号流程的纯逻辑（docs/design/auth.md、docs/build/wave1.md §A/§D）。
//
// 约束：
//   1. 会话优先走 HttpOnly cookie（credentials:'include'），Bearer 只是兼容回退；
//   2. 写请求的 CSRF token 从 `roost_csrf` 非 HttpOnly cookie 读，自动加 `x-csrf-token`；
//   3. 这里不碰 DOM、不发请求，便于 node:test 直接测；
//   4. 所有失败都返回可显示的中文文案，不把失败说成成功。

export const PASSWORD_MIN_LENGTH = 12

const EMAIL_MAX = 254
const PASSWORD_MAX = 512
const TOKEN_MAX = 512
const AUTH_PATHS = new Set([
  '/login',
  '/register',
  '/verify-email',
  '/reset',
  '/reset-confirm',
])

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function pathOfHash(hash) {
  const raw = String(hash ?? '').trim()
  if (raw === '' || raw === '#') return '/'
  let path = raw.startsWith('#') ? raw.slice(1) : raw
  const query = path.indexOf('?')
  if (query !== -1) path = path.slice(0, query)
  if (!path.startsWith('/')) path = `/${path}`
  path = path.replace(/\/+$/, '')
  return path === '' ? '/' : path
}

/** 规范化邮箱：去空白 + 小写；不做“纠正”，只做确定无歧义的转换。 */
export function normalizeEmail(value) {
  return asText(value).toLowerCase()
}

/** 邮箱校验；返回空字符串表示通过，否则是给人看的原因。 */
export function validateEmail(value) {
  const email = normalizeEmail(value)
  if (email === '') return '请输入邮箱地址'
  if (email.length > EMAIL_MAX) return `邮箱地址最多 ${EMAIL_MAX} 个字符`
  // 只做保守校验：必须有 @ 与域名点，不尝试覆盖 RFC 5322 的所有写法。
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '邮箱地址格式不正确'
  return ''
}

/** 注册/重置密码的强度校验（auth.md §4：密码 ≥ 12 位）。 */
export function validatePassword(value) {
  const password = typeof value === 'string' ? value : ''
  if (password === '') return '请输入密码'
  if (password.length < PASSWORD_MIN_LENGTH) return `密码至少 ${PASSWORD_MIN_LENGTH} 位`
  if (password.length > PASSWORD_MAX) return `密码最多 ${PASSWORD_MAX} 个字符`
  return ''
}

function validatePasswordConfirm(password, confirm) {
  if (confirm === undefined) return ''
  if (String(confirm) !== String(password)) return '两次输入的密码不一致'
  return ''
}

function validateToken(value) {
  const token = asText(value)
  if (token === '') return '缺少验证 token；请从邮件里的链接打开本页'
  if (token.length > TOKEN_MAX) return '验证 token 太长，可能不是邮件里的链接'
  return ''
}

/** 登录：不强制 12 位（老账号可能更短），交给服务端判定。 */
export function loginPayload(values = {}) {
  const email = normalizeEmail(values.email)
  const password = typeof values.password === 'string' ? values.password : ''
  const emailError = validateEmail(email)
  if (emailError !== '') return { ok: false, field: 'email', message: emailError }
  if (password === '') return { ok: false, field: 'password', message: '请输入密码' }
  if (password.length > PASSWORD_MAX) return { ok: false, field: 'password', message: '密码太长' }
  return { ok: true, payload: { email, password } }
}

/** 注册：邮箱 + 密码 + 确认，一次返回第一个错误。 */
export function registerPayload(values = {}) {
  const email = normalizeEmail(values.email)
  const password = typeof values.password === 'string' ? values.password : ''
  const emailError = validateEmail(email)
  if (emailError !== '') return { ok: false, field: 'email', message: emailError }
  const passwordError = validatePassword(password)
  if (passwordError !== '') return { ok: false, field: 'password', message: passwordError }
  const confirmError = validatePasswordConfirm(password, values.confirm)
  if (confirmError !== '') return { ok: false, field: 'confirm', message: confirmError }
  return { ok: true, payload: { email, password } }
}

export function resetRequestPayload(values = {}) {
  const email = normalizeEmail(values.email)
  const emailError = validateEmail(email)
  if (emailError !== '') return { ok: false, field: 'email', message: emailError }
  return { ok: true, payload: { email } }
}

export function resetPayload(values = {}) {
  const token = asText(values.token)
  const tokenError = validateToken(token)
  if (tokenError !== '') return { ok: false, field: 'token', message: tokenError }
  const password = typeof values.password === 'string' ? values.password : ''
  const passwordError = validatePassword(password)
  if (passwordError !== '') return { ok: false, field: 'password', message: passwordError }
  const confirmError = validatePasswordConfirm(password, values.confirm)
  if (confirmError !== '') return { ok: false, field: 'confirm', message: confirmError }
  return { ok: true, payload: { token, password } }
}

export function verifyEmailPayload(values = {}) {
  const token = asText(values.token)
  const tokenError = validateToken(token)
  if (tokenError !== '') return { ok: false, field: 'token', message: tokenError }
  return { ok: true, payload: { token } }
}

/** 从 `#/verify-email?token=...` 或 `#/reset-confirm?token=...` 读 token。 */
export function tokenFromHash(hash, name = 'token') {
  const raw = String(hash ?? '')
  const query = raw.indexOf('?')
  if (query === -1) return ''
  try {
    const params = new URLSearchParams(raw.slice(query + 1))
    return asText(params.get(name))
  } catch {
    return ''
  }
}

/** 失败话术：优先用服务端 message，再按 code/status 给稳定中文。 */
export function authFailureMessage(error, action = 'request') {
  const code = error && typeof error.code === 'string' ? error.code : ''
  const status = error && typeof error.status === 'number' ? error.status : 0
  const serverMessage = error instanceof Error ? asText(error.message) : asText(error)
  const prefix = action === 'login' ? '登录' : action === 'register' ? '注册' : action === 'verify' ? '验证' : action === 'reset' ? '重置密码' : '请求'
  if (code === 'network') return serverMessage || '连不上控制面：检查网络后重试。'
  if (code === 'auth.invalid_credentials') return '邮箱或密码不正确'
  if (code === 'auth.email_taken') return '这个邮箱已经注册；可以直接登录，或使用“忘记密码”。'
  if (code === 'auth.invalid_token' || code === 'auth.token_expired') {
    return '这个链接无效或已过期；请重新发起一次。'
  }
  if (code === 'auth.password_too_weak') return `密码不符合要求：至少 ${PASSWORD_MIN_LENGTH} 位`
  if (code === 'auth.rate_limited' || status === 429) return '尝试太频繁，请稍后再试。'
  if (status === 403) return '账号被禁用，或当前操作没有权限。'
  if (status === 404) return `${prefix}接口还没有上线（HTTP 404）；界面不会假装成功。`
  if (status === 405 || status === 501) return `${prefix}接口未就绪（HTTP ${status}）。`
  if (status === 503) return `${prefix}服务暂不可用（HTTP 503）：${serverMessage || '稍后重试。'}`
  if (serverMessage !== '') return serverMessage
  return `${prefix}失败${status > 0 ? `（HTTP ${status}）` : ''}`
}

/** 401 后要记住的原地址；登录/注册等账号页不记，避免登录成功又回登录页。 */
export function pendingRouteAfter(hash) {
  const raw = String(hash ?? '').trim()
  if (raw === '' || raw === '#' || raw === '#/') return ''
  if (isAuthHash(raw)) return ''
  return raw.startsWith('#') ? raw : `#${raw.startsWith('/') ? raw : `/${raw}`}`
}

/** 登录成功后的落点：只接受站内 hash，绝不跟随外部 URL。 */
export function nextRouteAfterAuth(pending, fallback = '#/bots') {
  const target = asText(pending)
  if (target === '' || target === '#' || target === '#/') return fallback
  if (!target.startsWith('#/')) return fallback
  if (isAuthHash(target)) return fallback
  return target
}

export function isAuthRouteName(name) {
  return (
    name === 'login' ||
    name === 'register' ||
    name === 'verifyEmail' ||
    name === 'reset' ||
    name === 'resetConfirm'
  )
}

export function isAuthHash(hash) {
  return AUTH_PATHS.has(pathOfHash(hash))
}

/** 从 `GET /api/auth/providers` 的任意常见形状里取 provider 列表。 */
export function authProviders(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.providers)
      ? payload.providers
      : []
  const seen = new Set()
  const rows = []
  for (const item of list) {
    const row = item && typeof item === 'object' ? item : null
    const id = row ? asText(row.id ?? row.provider ?? row.slug) : asText(item)
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const label = row ? asText(row.label ?? row.name ?? row.title) || id : id
    rows.push({ id, label })
  }
  return rows
}

/**
 * OIDC authorizeUrl 白名单：https；或 http 但主机是回环（本地开发）。
 * 拒绝 javascript:/data:、带凭据的 URL 与协议相对地址。
 */
export function isSafeAuthorizeUrl(value) {
  const raw = asText(value)
  if (raw === '' || raw.startsWith('//')) return false
  let url
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.username !== '' || url.password !== '') return false
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  const host = url.hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

/** 读 cookie；值会做一次 decodeURIComponent（失败时原样返回）。 */
export function readCookie(name, cookieSource) {
  const key = asText(name)
  if (key === '') return ''
  const source = typeof cookieSource === 'string' ? cookieSource : ''
  for (const part of source.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() !== key) continue
    const raw = part.slice(index + 1).trim()
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return ''
}

export function csrfTokenFromCookie(cookieSource) {
  return readCookie('roost_csrf', cookieSource)
}

export function isUnsafeMethod(method) {
  const value = String(method ?? '').toUpperCase()
  return value === 'POST' || value === 'PUT' || value === 'PATCH' || value === 'DELETE'
}

/** 写请求的 CSRF 头；读请求或没有 token 时返回空对象。 */
export function csrfHeaders(method, token) {
  if (!isUnsafeMethod(method)) return {}
  const value = asText(token)
  return value === '' ? {} : { 'x-csrf-token': value }
}

/** 登录/注册成功后展示的短提示。 */
export function authSuccessMessage(kind) {
  if (kind === 'register') return '账号已创建；验证邮件已发送。验证后再登录。'
  if (kind === 'login') return '已登录。'
  if (kind === 'verify') return '邮箱已验证，可以登录了。'
  if (kind === 'reset') return '密码已重置，可以用新密码登录。'
  return '完成。'
}
