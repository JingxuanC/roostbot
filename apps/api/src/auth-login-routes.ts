// 账号登录路由（docs/build/wave1.md §A、docs/design/auth.md §4/§10）。
//
//   POST /api/auth/register             {email,password}          → 201 {accountId}
//   POST /api/auth/verify-email         {token}                   → 200 {}
//   POST /api/auth/verify-email/resend  {email}                   → 202 {}
//   POST /api/auth/login                {email,password}          → 200 {accountId, csrfToken} + Set-Cookie
//   POST /api/auth/logout                                         → 204（清 cookie + 吊销当前会话）
//   GET  /api/auth/me                                             → 200 {accountId, email}
//   POST /api/auth/password/reset-request {email}                 → 202 {}
//   POST /api/auth/password/reset       {token,password}          → 200 {}
//   POST /api/auth/oidc/start           {provider}                → 200 {authorizeUrl}
//   GET  /api/auth/oidc/callback        ?code&state               → 302 / + Set-Cookie
//   GET  /api/auth/providers                                      → 200 {providers}
//
// 约定（与 server.ts 一致）：
//   * 只导出 handler，路由表与 Origin 校验由 server.ts / Lead 接线；这里不写任何 dispatch。
//   * 所有响应 no-store（sendJson / 本文件的 sendNoContent 都显式写）；错误统一
//     { ok:false, error:{ code, message } }，code 稳定、message 中文。
//   * 账号与令牌存在 SQLite（rawStore）；memory port 下这些接口返回 503 auth.unavailable，
//     不假装成功（CONVENTIONS.md 第 6 条）。
//   * CSRF：写操作要求 `x-csrf-token` 与 `roost_csrf` cookie 一致；带 Bearer 的客户端跳过
//     （兼容已有配对客户端）。Origin 校验仍由 server.ts 统一做，本文件不重复。
//
// 登录失败语义（契约允许两种，这里选可区分）：
//   账号不存在 / 密码错 / 账号禁用 → 401 auth.invalid_credentials（同一句中文，不泄漏邮箱是否存在）
//   密码对但邮箱未验证       → 401 auth.email_unverified（前端据此提示重发验证邮件）

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  consumeAuthToken,
  createAccountWithPassword,
  createAuthToken,
  findAccountByEmail,
  findAccountById,
  hashPassword,
  isEmailShaped,
  markEmailVerified,
  normalizeEmail,
  setPassword,
  upsertOidcAccount,
  verifyPassword,
} from '../../../packages/store/src/accounts-auth.ts'
import type { Account } from '../../../packages/store/src/accounts-auth.ts'
import { grantTokenCredit, SIGNUP_CREDIT_TOKENS } from '../../../packages/store/src/token-credits.ts'
import { isStoreError } from '../../../packages/store/src/errors.ts'
import { appendEvent } from '../../../packages/store/src/events.ts'
import { listSessionsByAccount, revokeSession } from '../../../packages/store/src/sessions.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import type { DevicePlatform, SessionRecord, StorePort } from './port.ts'
import {
  SESSION_TTL_MS,
  authenticate,
  hashSessionToken,
  isPlainObject,
  readJsonBody,
  sendError,
  sendJson,
} from './server.ts'

// ---- 常量 --------------------------------------------------------------------

export const SESSION_COOKIE = 'roost_session'
export const CSRF_COOKIE = 'roost_csrf'
export const CSRF_HEADER = 'x-csrf-token'

/** 邮箱验证链接 24 小时；密码重置 30 分钟；OIDC state 10 分钟（够走完一次登录）。 */
export const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000
export const OIDC_STATE_TTL_MS = 10 * 60 * 1000

export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 200

const EMAIL_MAX = 254
const SESSION_TOKEN_PATTERN = /^[0-9a-f]{64}$/
const BEARER_PATTERN = /^Bearer[ ]+(\S+)$/
/** OIDC state 在登录前签发，还没有账号可绑；用固定哨兵 id（不是真实账号）。 */
const OIDC_STATE_ACCOUNT = 'oidc:state'

// ---- 注入接口 ----------------------------------------------------------------

export interface VerificationMail {
  to: string
  token: string
  expiresAt: number
}

export interface PasswordResetMail {
  to: string
  token: string
  expiresAt: number
}

/**
 * 邮件发送口。默认实现只写日志（wave1.md §A：「mailer 注入，默认写日志」）。
 * 生产接入 SMTP/API 时注入自己的实现；抛错只记日志，不影响注册/重置请求本身。
 */
export interface Mailer {
  sendVerificationEmail?(mail: VerificationMail): void | Promise<void>
  sendPasswordResetEmail?(mail: PasswordResetMail): void | Promise<void>
}

export interface OidcAuthorizeInput {
  state: string
  codeChallenge: string
  redirectUri: string
}

export interface OidcExchangeInput {
  code: string
  codeVerifier: string
  redirectUri: string
}

export interface OidcUserInfo {
  /** OIDC `sub`：稳定、不随邮箱变。 */
  subject: string
  email: string
  /** 提供方是否验证过邮箱；false 时拒绝登录。undefined 视为已验证（多数提供方只在 false 时给值）。 */
  emailVerified?: boolean
}

/**
 * OIDC 提供方注入口（测试用假实现；生产用 oidcProviderFromEnv 按 env 拼）。
 * 只包含路由需要的三步：拼授权地址、换 token、取 userinfo。PKCE 由路由生成。
 */
export interface OidcProvider {
  authorizeUrl(input: OidcAuthorizeInput): string
  exchange(input: OidcExchangeInput): Promise<{ accessToken: string }>
  userinfo(input: { accessToken: string }): Promise<OidcUserInfo>
}

/** 单个 provider（测试常用）或 {provider 名 → provider}。 */
export type OidcConfig = OidcProvider | Record<string, OidcProvider>

/**
 * 路由上下文。`store`/`now` 与 server.ts 的 AuthContext 同形；
 * rawStore 是账号与令牌的真实存储（memory port 没有 accounts 表）。
 */
export interface AuthRoutesContext {
  store: StorePort
  now: () => number
  rawStore?: Store
  mailer?: Mailer
  oidc?: OidcConfig | null
  /** 加 Secure（ROOST_SECURE_COOKIES=1 时由 Lead 传入）。 */
  secureCookies?: boolean
  /** 会话有效期；默认 SESSION_TTL_MS（30 天）。 */
  sessionTtlMs?: number
  /** false = 关闭 CSRF 校验（默认开）。仅测试/特殊内网部署使用。 */
  csrf?: boolean
}

// ---- Cookie 工具 -------------------------------------------------------------

export interface SessionCookieOptions {
  secure?: boolean
  maxAgeSeconds?: number
  path?: string
}

function readCookieHeader(header: string | undefined, name: string): string | null {
  if (header === undefined || header === '') return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    return part.slice(index + 1).trim()
  }
  return null
}

/** 同一响应可以带多个 Set-Cookie：读回已有值再追加，避免互相覆盖。 */
function appendSetCookie(res: ServerResponse, cookie: string): void {
  const current = res.getHeader('set-cookie')
  const list: string[] =
    current === undefined ? [] : Array.isArray(current) ? current.map((item) => String(item)) : [String(current)]
  list.push(cookie)
  res.setHeader('set-cookie', list)
}

function cookieSuffix(options: SessionCookieOptions, maxAgeSeconds: number): string {
  const parts = ['SameSite=Lax', `Path=${options.path ?? '/'}`, `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`]
  if (options.secure === true) parts.push('Secure')
  return parts.join('; ')
}

/** `roost_session=<token>; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000[; Secure]` */
export function setSessionCookie(res: ServerResponse, token: string, options: SessionCookieOptions = {}): void {
  const maxAge = options.maxAgeSeconds ?? Math.floor(SESSION_TTL_MS / 1000)
  appendSetCookie(res, `${SESSION_COOKIE}=${token}; HttpOnly; ${cookieSuffix(options, maxAge)}`)
}

/** `roost_csrf=<token>`：**不是** HttpOnly，同源前端要读出来放进 x-csrf-token。 */
export function setCsrfCookie(res: ServerResponse, token: string, options: SessionCookieOptions = {}): void {
  const maxAge = options.maxAgeSeconds ?? Math.floor(SESSION_TTL_MS / 1000)
  appendSetCookie(res, `${CSRF_COOKIE}=${token}; ${cookieSuffix(options, maxAge)}`)
}

export function clearSessionCookie(res: ServerResponse, options: SessionCookieOptions = {}): void {
  appendSetCookie(
    res,
    `${SESSION_COOKIE}=; HttpOnly; ${cookieSuffix(options, 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  )
}

export function clearCsrfCookie(res: ServerResponse, options: SessionCookieOptions = {}): void {
  appendSetCookie(res, `${CSRF_COOKIE}=; ${cookieSuffix(options, 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`)
}

function cookieOptionsFor(ctx: AuthRoutesContext): SessionCookieOptions {
  const ttlMs = ctx.sessionTtlMs ?? SESSION_TTL_MS
  return {
    secure: ctx.secureCookies ?? process.env.ROOST_SECURE_COOKIES === '1',
    maxAgeSeconds: Math.max(1, Math.floor(ttlMs / 1000)),
  }
}

// ---- CSRF --------------------------------------------------------------------

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function bearerTokenOf(req: IncomingMessage): string | null {
  const header = firstHeader(req.headers.authorization)
  if (typeof header !== 'string') return null
  const match = BEARER_PATTERN.exec(header.trim())
  return match === null ? null : match[1]!
}

function sameSecret(a: string, b: string): boolean {
  // 先各自 sha256 再比，长度不同也不会让 timingSafeEqual 抛错。
  const left = createHash('sha256').update(a, 'utf8').digest()
  const right = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(left, right)
}

/**
 * CSRF 校验：`x-csrf-token` 头必须与 `roost_csrf` cookie 一致。
 * Bearer 客户端跳过（auth.md §7 的自定义头要求针对 cookie 会话；Bearer 本身不是浏览器自动带的）。
 * 返回 false 由调用方写 403 —— 保持纯判断，方便单测。
 */
export function requireCsrf(ctx: AuthRoutesContext, req: IncomingMessage): boolean {
  if (ctx.csrf === false) return true
  if (bearerTokenOf(req) !== null) return true
  const header = firstHeader(req.headers[CSRF_HEADER])
  const cookie = readCookieHeader(firstHeader(req.headers.cookie), CSRF_COOKIE)
  if (typeof header !== 'string' || header === '' || cookie === null || cookie === '') return false
  return sameSecret(header, cookie)
}

// ---- 鉴权（Bearer 或会话 cookie）--------------------------------------------

export type RequestAuth =
  | { ok: true; session: SessionRecord; via: 'bearer' | 'cookie' }
  | { ok: false; status: number; code: string; message: string }

function authFailure(message: string, code = 'unauthenticated', status = 401): RequestAuth {
  return { ok: false, status, code, message }
}

/** 先 Bearer（与已有客户端/接口一致），没有 Authorization 头再试 `roost_session` cookie。 */
export async function authenticateRequest(ctx: AuthRoutesContext, req: IncomingMessage): Promise<RequestAuth> {
  if (bearerTokenOf(req) !== null) {
    const result = await authenticate(ctx, req)
    if (!result.ok) return authFailure(result.message, result.code, result.status)
    return { ok: true, session: result.session, via: 'bearer' }
  }

  const token = readCookieHeader(firstHeader(req.headers.cookie), SESSION_COOKIE)
  if (token === null || !SESSION_TOKEN_PATTERN.test(token)) return authFailure('missing session cookie')
  const session = await ctx.store.findSessionByToken(hashSessionToken(token))
  if (session === null) return authFailure('unknown session cookie')
  if (session.revokedAt !== undefined) return authFailure('session revoked', 'session_revoked')
  if (session.expiresAt <= ctx.now()) return authFailure('session expired; log in again', 'session_expired')
  return { ok: true, session, via: 'cookie' }
}

// ---- 小工具 ------------------------------------------------------------------

function requireStore(ctx: AuthRoutesContext, res: ServerResponse): Store | null {
  if (ctx.rawStore === undefined) {
    sendError(res, 503, 'auth.unavailable', '账号登录需要 SQLite 存储（memory 模式没有 accounts 表）')
    return null
  }
  return ctx.rawStore
}

async function readObjectBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const body = await readJsonBody(req)
  if (!body.ok) {
    sendError(res, body.status, body.code, body.message)
    return null
  }
  if (!isPlainObject(body.value)) {
    sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
    return null
  }
  return body.value
}

function readEmail(value: unknown): string | null {
  if (!isEmailShaped(value)) return null
  const email = normalizeEmail(value)
  return email.length > EMAIL_MAX ? null : email
}

/** 口令策略：12..200 字符（auth.md §4「密码 ≥ 12 位」），不 trim、不做更细的字符规则。 */
function readPassword(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) return null
  return value
}

/** 登录时只看形状，不套策略：老账号可能是短口令，策略只约束新建/重置。 */
function readLoginPassword(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > 1024) return null
  return value
}

function readAuthTokenValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return SESSION_TOKEN_PATTERN.test(value) ? value : null
}

function sendNoContent(res: ServerResponse): void {
  if (res.writableEnded) return
  res.writeHead(204, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end()
}

function logError(where: string, err: unknown): void {
  console.error(`roost api: auth ${where} failed`, err)
}

function csrfRejection(res: ServerResponse): void {
  sendError(res, 403, 'auth.csrf', '缺少或错误的 CSRF 令牌，请刷新页面重试')
}

const DEFAULT_MAILER: Mailer = {
  sendVerificationEmail(mail) {
    // 默认只写日志：没有 SMTP 配置时，运维从日志里拿链接（生产请注入 mailer）。
    console.log(`roost api: [auth] verification for ${mail.to}: ${mail.token} (expires ${mail.expiresAt})`)
  },
  sendPasswordResetEmail(mail) {
    console.log(`roost api: [auth] password reset for ${mail.to}: ${mail.token} (expires ${mail.expiresAt})`)
  },
}

function mailerFor(ctx: AuthRoutesContext): Mailer {
  return ctx.mailer ?? DEFAULT_MAILER
}

async function deliverVerification(ctx: AuthRoutesContext, to: string, token: string, expiresAt: number): Promise<void> {
  try {
    await mailerFor(ctx).sendVerificationEmail?.({ to, token, expiresAt })
  } catch (err) {
    // 邮件失败不回滚账号：用户可以走 resend。
    logError('mail(verify)', err)
  }
}

async function deliverPasswordReset(ctx: AuthRoutesContext, to: string, token: string, expiresAt: number): Promise<void> {
  try {
    await mailerFor(ctx).sendPasswordResetEmail?.({ to, token, expiresAt })
  } catch (err) {
    logError('mail(reset)', err)
  }
}

// ---- 会话签发 ----------------------------------------------------------------

interface IssuedSession {
  token: string
  csrfToken: string
  session: SessionRecord
}

async function issueSession(
  ctx: AuthRoutesContext,
  res: ServerResponse,
  accountId: string,
  platform: DevicePlatform,
): Promise<IssuedSession | null> {
  const now = ctx.now()
  const ttlMs = ctx.sessionTtlMs ?? SESSION_TTL_MS
  const token = randomBytes(32).toString('hex')
  const csrfToken = randomBytes(32).toString('hex')
  try {
    const session = await ctx.store.createSession({
      accountId,
      tokenHash: hashSessionToken(token),
      now,
      expiresAt: now + ttlMs,
      deviceLabel: platform,
      platform,
    })
    const options = cookieOptionsFor(ctx)
    setSessionCookie(res, token, options)
    setCsrfCookie(res, csrfToken, options)
    return { token, csrfToken, session }
  } catch (err) {
    logError('session', err)
    sendError(res, 500, 'internal_error', 'session creation failed')
    return null
  }
}

// ---- register ----------------------------------------------------------------

export async function handleRegister(
  ctx: AuthRoutesContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const store = requireStore(ctx, res)
  if (store === null) return
  const body = await readObjectBody(req, res)
  if (body === null) return

  const email = readEmail(body['email'])
  if (email === null) {
    sendError(res, 400, 'auth.invalid_email', '邮箱格式不对，请填写完整的邮箱地址')
    return
  }
  const password = readPassword(body['password'])
  if (password === null) {
    sendError(
      res,
      400,
      'auth.weak_password',
      `密码至少 ${PASSWORD_MIN_LENGTH} 位、最多 ${PASSWORD_MAX_LENGTH} 位`,
    )
    return
  }

  const now = ctx.now()
  let account: Account
  try {
    account = createAccountWithPassword(store, { email, password, now })
  } catch (err) {
    if (isStoreError(err) && err.code === 'ACCOUNT_EXISTS') {
      sendError(res, 409, 'auth.email_taken', '这个邮箱已经注册过了：直接登录，或用「忘记密码」重置')
      return
    }
    logError('register', err)
    sendError(res, 500, 'internal_error', 'account creation failed')
    return
  }

  try {
    const issued = createAuthToken(store, {
      accountId: account.id,
      kind: 'email_verify',
      ttlMs: EMAIL_VERIFY_TTL_MS,
      now,
    })
    await deliverVerification(ctx, account.email, issued.token, issued.expiresAt)
  } catch (err) {
    // 账号已建好：重发验证邮件可以补救，所以不让注册失败。
    logError('register(token)', err)
  }

  sendJson(res, 201, { accountId: account.id })
}

// ---- verify-email / resend ---------------------------------------------------

export async function handleVerifyEmail(
  ctx: AuthRoutesContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const store = requireStore(ctx, res)
  if (store === null) return
  const body = await readObjectBody(req, res)
  if (body === null) return

  const token = readAuthTokenValue(body['token'])
  if (token === null) {
    sendError(res, 400, 'auth.token_invalid', '验证链接无效、已经用过或已过期')
    return
  }

  const now = ctx.now()
  const consumed = consumeAuthToken(store, { token, kind: 'email_verify', now })
  if (consumed === null) {
    sendError(res, 400, 'auth.token_invalid', '验证链接无效、已经用过或已过期')
    return
  }

  try {
    markEmailVerified(store, consumed.accountId, now)
    // 注册赠送：邮箱验证通过才发，一次性、90 天有效；失败不能反过来让验证失败。
    try {
      grantTokenCredit(store, { accountId: consumed.accountId, amount: SIGNUP_CREDIT_TOKENS, at: now })
    } catch (err) {
      logError('signup-credit', err)
    }
  } catch (err) {
    if (isStoreError(err) && err.code === 'ACCOUNT_NOT_FOUND') {
      sendError(res, 400, 'auth.token_invalid', '验证链接对应的账号不存在')
      return
    }
    logError('verify-email', err)
    sendError(res, 500, 'internal_error', 'email verification failed')
    return
  }

  sendJson(res, 200, {})
}

export async function handleResendVerification(
  ctx: AuthRoutesContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const store = requireStore(ctx, res)
  if (store === null) return
  const body = await readObjectBody(req, res)
  if (body === null) return

  const email = readEmail(body['email'])
  if (email === null) {
    sendError(res, 400, 'auth.invalid_email', '邮箱格式不对，请填写完整的邮箱地址')
    return
  }

  // 202 一律返回：不让调用方区分「这个邮箱有没有账号」。
  const account = findAccountByEmail(store, email)
  if (account !== null && account.emailVerifiedAt === null && account.disabledAt === null) {
    try {
      const now = ctx.now()
      const issued = createAuthToken(store, {
        accountId: account.id,
        kind: 'email_verify',
        ttlMs: EMAIL_VERIFY_TTL_MS,
        now,
      })
      await deliverVerification(ctx, account.email, issued.token, issued.expiresAt)
    } catch (err) {
      logError('resend-verification', err)
    }
  }

  sendJson(res, 202, {})
}

// ---- login / logout / me -----------------------------------------------------

/** 账号不存在时也跑一次 scrypt，避免「响应快 = 邮箱没注册」的时序侧信道。 */
let timingDummyHash: string | null = null
function burnPasswordCheck(password: string): boolean {
  if (timingDummyHash === null) timingDummyHash = hashPassword(randomBytes(24).toString('hex'))
  verifyPassword(password, timingDummyHash)
  return false
}

export async function handleLogin(
  ctx: AuthRoutesContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const store = requireStore(ctx, res)
  if (store === null) return
  const body = await readObjectBody(req, res)
  if (body === null) return

  const email = readEmail(body['email'])
  if (email === null) {
    sendError(res, 400, 'auth.invalid_email', '邮箱格式不对，请填写完整的邮箱地址')
    return
  }
  const password = readLoginPassword(body['password'])
  if (password === null) {
    sendError(res, 400, 'invalid_body', '密码不能为空')
    return
  }

  const account = findAccountByEmail(store, email)
  const storedHash = account === null ? null : account.passwordHash
  const passwordOk = storedHash === null ? burnPasswordCheck(password) : verifyPassword(password, storedHash)

  if (account === null || storedHash === null || !passwordOk || account.disabledAt !== null) {
    sendError(res, 401, 'auth.invalid_credentials', '邮箱或密码不正确')
    return
  }
  if (account.emailVerifiedAt === null) {
    sendError(res, 401, 'auth.email_unverified', '邮箱还没验证：请先点验证邮件里的链接，或重新发送验证邮件')
    return
  }

  try {
    grantTokenCredit(store, { accountId: account.id, amount: SIGNUP_CREDIT_TOKENS, at: ctx.now() })
  } catch (err) {
    logError('signup-credit(oidc)', err)
  }

  const issued = await issueSession(ctx, res, account.id, 'web')
  if (issued === null) return

  sendJson(res, 200, { accountId: account.id, csrfToken: issued.csrfToken })
}

export async function handleLogout(
  ctx: AuthRoutesContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!requireCsrf(ctx, req)) {
    csrfRejection(res)
    return
  }

  const auth = await authenticateRequest(ctx, req)
  const options = cookieOptionsFor(ctx)

  if (auth.ok && ctx.rawStore !== undefined && auth.session.revokedAt === undefined) {
    const store = ctx.rawStore
    const at = ctx.now()
    try {
      revokeSession(store, auth.session.id, at)
      // 吊销事实进事件日志（与 DELETE /api/devices/:id 同一形状）。
      appendEvent(store, {
        at: new Date(at).toISOString(),
        domain: 'auth',
        kind: 'auth.session.revoked',
        actor: { kind: 'user', id: auth.session.accountId },
        subject: { kind: 'session', id: auth.session.id },
        payload: { deviceId: auth.session.deviceId, self: true },
      })
    } catch (err) {
      // 会话可能已经被别的设备吊销；退出仍然成功（cookie 一定会清掉）。
      logError('logout', err)
    }
  }

  clearSessionCookie(res, options)
  clearCsrfCookie(res, options)
  sendNoContent(res)
}

export async function handleMe(ctx: AuthRoutesContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticateRequest(ctx, req)
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
    return
  }
  const store = requireStore(ctx, res)
  if (store === null) return

  const account = findAccountById(store, auth.session.accountId)
  if (account === null) {
    sendError(res, 401, 'unauthenticated', '这个会话对应的账号不存在')
    return
  }
  sendJson(res, 200, { accountId: account.id, email: account.email })
}

// ---- password reset ----------------------------------------------------------

export async function handlePasswordResetRequest(
  ctx: AuthRoutesContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const store = requireStore(ctx, res)
  if (store === null) return
  const body = await readObjectBody(req, res)
  if (body === null) return

  const email = readEmail(body['email'])
  if (email === null) {
    sendError(res, 400, 'auth.invalid_email', '邮箱格式不对，请填写完整的邮箱地址')
    return
  }

  // 账号不存在也返回 202（不泄漏邮箱是否注册）。
  const account = findAccountByEmail(store, email)
  if (account !== null && account.disabledAt === null) {
    try {
      const now = ctx.now()
      const issued = createAuthToken(store, {
        accountId: account.id,
        kind: 'password_reset',
        ttlMs: PASSWORD_RESET_TTL_MS,
        now,
      })
      await deliverPasswordReset(ctx, account.email, issued.token, issued.expiresAt)
    } catch (err) {
      logError('reset-request', err)
    }
  }

  sendJson(res, 202, {})
}

/**
 * 改密成功 = 账号的其它会话全部吊销（auth.md §7「设备丢失可一键吊销」的同一条原则：
 * 改密后旧会话不该继续可用）。当前请求如果是 Bearer/cookie 会话，也在吊销之列 —— 前端改密后重登。
 */
function revokeSessionsForAccount(store: Store, accountId: string, at: number): void {
  const rows = listSessionsByAccount(store, accountId)
  for (const row of rows) {
    if (row.revokedAt !== null || row.deviceRevokedAt !== null) continue
    if (row.expiresAt <= at) continue
    revokeSession(store, row.id, at)
    try {
      appendEvent(store, {
        at: new Date(at).toISOString(),
        domain: 'auth',
        kind: 'auth.session.revoked',
        actor: { kind: 'user', id: accountId },
        subject: { kind: 'session', id: row.id },
        payload: { deviceId: row.deviceId, self: false, reason: 'password_reset' },
      })
    } catch (err) {
      logError('reset(revoke event)', err)
    }
  }
}

export async function handlePasswordReset(
  ctx: AuthRoutesContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const store = requireStore(ctx, res)
  if (store === null) return
  const body = await readObjectBody(req, res)
  if (body === null) return

  const token = readAuthTokenValue(body['token'])
  if (token === null) {
    sendError(res, 400, 'auth.token_invalid', '重置链接无效、已经用过或已过期')
    return
  }
  const password = readPassword(body['password'])
  if (password === null) {
    sendError(
      res,
      400,
      'auth.weak_password',
      `密码至少 ${PASSWORD_MIN_LENGTH} 位、最多 ${PASSWORD_MAX_LENGTH} 位`,
    )
    return
  }

  const now = ctx.now()
  const consumed = consumeAuthToken(store, { token, kind: 'password_reset', now })
  if (consumed === null) {
    sendError(res, 400, 'auth.token_invalid', '重置链接无效、已经用过或已过期')
    return
  }

  try {
    setPassword(store, consumed.accountId, password, now)
  } catch (err) {
    if (isStoreError(err) && err.code === 'ACCOUNT_NOT_FOUND') {
      sendError(res, 400, 'auth.token_invalid', '重置链接对应的账号不存在')
      return
    }
    logError('reset', err)
    sendError(res, 500, 'internal_error', 'password reset failed')
    return
  }

  revokeSessionsForAccount(store, consumed.accountId, now)
  sendJson(res, 200, {})
}

// ---- OIDC --------------------------------------------------------------------

const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  github: 'GitHub',
  feishu: '飞书',
  keycloak: 'Keycloak',
  logto: 'Logto',
  casdoor: 'Casdoor',
  authentik: 'Authentik',
  zitadel: 'Zitadel',
  ory: 'Ory',
}

function requestScheme(req: IncomingMessage): 'http' | 'https' {
  const raw = firstHeader(req.headers['x-forwarded-proto'])
  const proto = raw?.split(',')[0]?.trim().toLowerCase()
  return proto === 'https' ? 'https' : 'http'
}

/** 回跳地址：默认按请求的 Host 拼（同源部署），可用 ROOST_OIDC_REDIRECT_URI 覆盖。 */
export function oidcRedirectUri(req: IncomingMessage): string {
  const configured = process.env.ROOST_OIDC_REDIRECT_URI
  if (configured !== undefined && configured.trim() !== '') return configured.trim()
  const host = firstHeader(req.headers.host) ?? '127.0.0.1'
  return `${requestScheme(req)}://${host}/api/auth/oidc/callback`
}

function envKey(provider: string, suffix: string): string {
  return `ROOST_OIDC_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${suffix}`
}

/**
 * 按 env 拼一个真实 OIDC 提供方（零依赖，用全局 fetch）：
 *   ROOST_OIDC_<PROVIDER>_CLIENT_ID / _SECRET / _AUTHORIZE_URL / _TOKEN_URL / _USERINFO_URL / _SCOPE
 * 缺任何一项（CLIENT_ID/AUTHORIZE_URL/TOKEN_URL/USERINFO_URL）视为未配置 → null。
 */
export function oidcProviderFromEnv(
  provider: string,
  env: Record<string, string | undefined> = process.env,
): OidcProvider | null {
  const clientId = env[envKey(provider, 'CLIENT_ID')]
  const clientSecret = env[envKey(provider, 'SECRET')] ?? env[envKey(provider, 'CLIENT_SECRET')]
  const authorizeEndpoint = env[envKey(provider, 'AUTHORIZE_URL')]
  const tokenEndpoint = env[envKey(provider, 'TOKEN_URL')]
  const userinfoEndpoint = env[envKey(provider, 'USERINFO_URL')]
  if (
    clientId === undefined ||
    authorizeEndpoint === undefined ||
    tokenEndpoint === undefined ||
    userinfoEndpoint === undefined
  ) {
    return null
  }
  const scope = env[envKey(provider, 'SCOPE')] ?? 'openid email profile'

  return {
    authorizeUrl(input) {
      const url = new URL(authorizeEndpoint)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', clientId)
      url.searchParams.set('redirect_uri', input.redirectUri)
      url.searchParams.set('scope', scope)
      url.searchParams.set('state', input.state)
      url.searchParams.set('code_challenge', input.codeChallenge)
      url.searchParams.set('code_challenge_method', 'S256')
      return url.toString()
    },

    async exchange(input) {
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: clientId,
        code_verifier: input.codeVerifier,
      })
      if (clientSecret !== undefined) form.set('client_secret', clientSecret)
      const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
      })
      if (!response.ok) throw new Error(`token endpoint returned ${response.status}`)
      const payload = (await response.json()) as { access_token?: unknown }
      if (typeof payload.access_token !== 'string' || payload.access_token === '') {
        throw new Error('token endpoint returned no access_token')
      }
      return { accessToken: payload.access_token }
    },

    async userinfo(input) {
      const response = await fetch(userinfoEndpoint, {
        headers: { authorization: `Bearer ${input.accessToken}`, accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`userinfo endpoint returned ${response.status}`)
      const payload = (await response.json()) as Record<string, unknown>
      const subject = payload['sub'] ?? payload['id']
      const email = payload['email']
      const verified = payload['email_verified'] ?? payload['verified_email']
      return {
        subject: typeof subject === 'string' ? subject : String(subject ?? ''),
        email: typeof email === 'string' ? email : '',
        ...(typeof verified === 'boolean' ? { emailVerified: verified } : {}),
      }
    },
  }
}

/** 单个 provider 注入直接命中（方便测试）；map 注入按名字取；都没有再读 env。 */
export function resolveOidcProvider(ctx: AuthRoutesContext, provider: string): OidcProvider | null {
  const config = ctx.oidc
  if (config !== undefined && config !== null) {
    if (typeof (config as OidcProvider).authorizeUrl === 'function') return config as OidcProvider
    const map = config as Record<string, OidcProvider>
    const hit = map[provider] ?? map[provider.toLowerCase()]
    if (hit !== undefined && typeof hit.authorizeUrl === 'function') return hit
  }
  return oidcProviderFromEnv(provider)
}

function configuredProviderIds(ctx: AuthRoutesContext): string[] {
  const ids = new Set<string>()
  const config = ctx.oidc
  if (config !== undefined && config !== null) {
    if (typeof (config as OidcProvider).authorizeUrl === 'function') {
      ids.add('custom')
    } else {
      for (const key of Object.keys(config as Record<string, OidcProvider>)) ids.add(key)
    }
  }
  // 任意 ROOST_OIDC_<PROVIDER>_CLIENT_ID 都可启用（Keycloak / Logto / Casdoor / 自建），
  // 不再要求提供方出现在 label 白名单里；label 只是展示名。
  for (const name of Object.keys(process.env)) {
    const match = /^ROOST_OIDC_([A-Z0-9_]+)_CLIENT_ID$/.exec(name)
    if (match !== null) ids.add(match[1]!.toLowerCase())
  }
  return [...ids].filter((id) => resolveOidcProvider(ctx, id) !== null).sort()
}

/** 供前端决定要不要显示 OIDC 按钮（wave1.md §D）。 */
export async function handleListProviders(
  ctx: AuthRoutesContext,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const providers = configuredProviderIds(ctx).map((id) => ({
    id,
    label: PROVIDER_LABELS[id] ?? id,
  }))
  sendJson(res, 200, { providers })
}

export async function handleOidcStart(
  ctx: AuthRoutesContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const store = requireStore(ctx, res)
  if (store === null) return
  const body = await readObjectBody(req, res)
  if (body === null) return

  const raw = body['provider']
  const providerName = typeof raw === 'string' ? raw.trim() : ''
  if (providerName === '') {
    sendError(res, 400, 'invalid_body', 'provider 不能为空（例如 google / github）')
    return
  }

  const provider = resolveOidcProvider(ctx, providerName)
  if (provider === null) {
    sendError(res, 404, 'auth.oidc_unavailable', `没有配置 OIDC 提供方 ${providerName}`)
    return
  }

  const now = ctx.now()
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const redirectUri = oidcRedirectUri(req)

  let state: string
  try {
    state = createAuthToken(store, {
      accountId: OIDC_STATE_ACCOUNT,
      kind: 'oidc_state',
      ttlMs: OIDC_STATE_TTL_MS,
      payload: { provider: providerName, codeVerifier, redirectUri },
      now,
    }).token
  } catch (err) {
    logError('oidc/start', err)
    sendError(res, 500, 'internal_error', 'could not start OIDC login')
    return
  }

  // 只有 http(s) 的授权地址才回给前端，避免 javascript: 之类被当成跳转目标。
  const authorizeUrl = provider.authorizeUrl({ state, codeChallenge, redirectUri })
  if (!/^https?:\/\//i.test(authorizeUrl)) {
    sendError(res, 502, 'auth.oidc_failed', 'OIDC 提供方返回的授权地址不合法')
    return
  }
  sendJson(res, 200, { authorizeUrl })
}

function safeNext(value: unknown): string {
  // 只允许站内绝对路径，杜绝 open redirect。
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/'
}

export async function handleOidcCallback(
  ctx: AuthRoutesContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const store = requireStore(ctx, res)
  if (store === null) return

  const code = url.searchParams.get('code')
  const stateToken = url.searchParams.get('state')
  if (code === null || code === '' || stateToken === null || stateToken === '') {
    sendError(res, 400, 'auth.oidc_state', 'OIDC 回调缺少 code 或 state')
    return
  }
  if (!SESSION_TOKEN_PATTERN.test(stateToken)) {
    sendError(res, 400, 'auth.oidc_state', 'OIDC state 无效、已经用过或已过期')
    return
  }

  const now = ctx.now()
  const consumed = consumeAuthToken(store, { token: stateToken, kind: 'oidc_state', now })
  if (consumed === null) {
    sendError(res, 400, 'auth.oidc_state', 'OIDC state 无效、已经用过或已过期')
    return
  }

  const payload = consumed.payload ?? {}
  const providerName = typeof payload['provider'] === 'string' ? payload['provider'] : null
  const codeVerifier = typeof payload['codeVerifier'] === 'string' ? payload['codeVerifier'] : null
  const redirectUri =
    typeof payload['redirectUri'] === 'string' ? payload['redirectUri'] : oidcRedirectUri(req)
  if (providerName === null || codeVerifier === null) {
    sendError(res, 400, 'auth.oidc_state', 'OIDC state 内容不完整')
    return
  }

  const provider = resolveOidcProvider(ctx, providerName)
  if (provider === null) {
    sendError(res, 404, 'auth.oidc_unavailable', `没有配置 OIDC 提供方 ${providerName}`)
    return
  }

  let info
  try {
    const tokens = await provider.exchange({ code, codeVerifier, redirectUri })
    info = await provider.userinfo({ accessToken: tokens.accessToken })
  } catch (err) {
    logError('oidc/callback', err)
    sendError(res, 502, 'auth.oidc_failed', 'OIDC 登录失败，请稍后重试')
    return
  }

  if (typeof info.subject !== 'string' || info.subject === '' || !isEmailShaped(info.email)) {
    sendError(res, 502, 'auth.oidc_failed', 'OIDC 提供方没有返回可用的 sub / email')
    return
  }
  if (info.emailVerified === false) {
    sendError(res, 403, 'auth.email_unverified', 'OIDC 提供方没有验证这个邮箱，不能用来登录')
    return
  }

  let account: Account
  try {
    account = upsertOidcAccount(store, { subject: info.subject, email: info.email, now })
  } catch (err) {
    if (isStoreError(err) && err.code === 'ACCOUNT_EXISTS') {
      sendError(res, 409, 'auth.email_taken', '这个邮箱已有密码账号：请使用密码登录；当前版本不支持自动合并 OIDC 账号')
      return
    }
    logError('oidc/callback(account)', err)
    sendError(res, 500, 'internal_error', 'OIDC account upsert failed')
    return
  }

  try {
    grantTokenCredit(store, { accountId: account.id, amount: SIGNUP_CREDIT_TOKENS, at: ctx.now() })
  } catch (err) {
    logError('signup-credit(oidc)', err)
  }

  const issued = await issueSession(ctx, res, account.id, 'web')
  if (issued === null) return

  const target = safeNext(payload['next'])
  if (res.writableEnded) return
  res.writeHead(302, { location: target, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end()
}

/** 暴露给 Lead 的注册表：路径 → handler（method 由 server.ts 决定）。 */
export const AUTH_LOGIN_ROUTES = {
  register: handleRegister,
  verifyEmail: handleVerifyEmail,
  resendVerification: handleResendVerification,
  login: handleLogin,
  logout: handleLogout,
  me: handleMe,
  passwordResetRequest: handlePasswordResetRequest,
  passwordReset: handlePasswordReset,
  providers: handleListProviders,
  oidcStart: handleOidcStart,
  oidcCallback: handleOidcCallback,
} as const
