// 账号登录路由的 HTTP 测试。
//
// 这一批路由的 dispatch 由 Lead 接进 server.ts，所以测试自己起一个最小 http 服务器：
// 真实 SQLite（临时目录里的真库）+ store-adapter + 只挂 auth 路由。这样断言的是 Cookie、
// Set-Cookie、302、CSRF 这些传输层行为，而不是直接调 handler 的返回值。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import { getTokenCreditBalance, SIGNUP_CREDIT_TOKENS } from '../../../packages/store/src/token-credits.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import {
  handleListProviders,
  handleLogin,
  handleLogout,
  handleMe,
  handleOidcCallback,
  handleOidcStart,
  handlePasswordReset,
  handlePasswordResetRequest,
  handleRegister,
  handleVerifyEmail,
  requireCsrf,
  type AuthRoutesContext,
  type Mailer,
  type OidcAuthorizeInput,
  type OidcExchangeInput,
  type OidcProvider,
} from '../src/auth-login-routes.ts'
import { createStorePort } from '../src/store-adapter.ts'
import { manualClock } from './helpers.ts'

const PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'a brand new passphrase'

interface SentMail {
  kind: 'verify' | 'reset'
  to: string
  token: string
  expiresAt: number
}

interface CallOptions {
  body?: unknown
  token?: string
  cookie?: string
  headers?: Record<string, string>
  redirect?: RequestRedirect
}

interface AuthResponse {
  status: number
  json: any
  headers: Headers
  cookies: string[]
}

interface AuthHarness {
  ctx: AuthRoutesContext
  rawStore: Store
  mail: SentMail[]
  call: (method: string, path: string, options?: CallOptions) => Promise<AuthResponse>
  close: () => Promise<void>
}

/** 从 Set-Cookie 列表里挑出 name=value，拼成下一次请求的 Cookie 头。 */
function cookieHeaderFrom(cookies: string[], names: string[]): string {
  const pairs: string[] = []
  for (const cookie of cookies) {
    const pair = cookie.split(';')[0]!
    const name = pair.slice(0, pair.indexOf('='))
    if (names.includes(name)) pairs.push(pair)
  }
  return pairs.join('; ')
}

function cookieValueFrom(cookies: string[], name: string): string | null {
  for (const cookie of cookies) {
    const pair = cookie.split(';')[0]!
    const index = pair.indexOf('=')
    if (pair.slice(0, index) === name) return pair.slice(index + 1)
  }
  return null
}

function findCookie(cookies: string[], name: string): string | undefined {
  return cookies.find((cookie) => cookie.startsWith(`${name}=`))
}

async function startAuthHarness(
  options: { oidc?: AuthRoutesContext['oidc']; secureCookies?: boolean; csrf?: boolean } = {},
): Promise<AuthHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'roost-auth-http-'))
  const rawStore = openStore(join(dir, 'workspace.db'))
  const clock = manualClock()
  const mail: SentMail[] = []
  const mailer: Mailer = {
    sendVerificationEmail(message) {
      mail.push({ kind: 'verify', to: message.to, token: message.token, expiresAt: message.expiresAt })
    },
    sendPasswordResetEmail(message) {
      mail.push({ kind: 'reset', to: message.to, token: message.token, expiresAt: message.expiresAt })
    },
  }
  const ctx: AuthRoutesContext = {
    store: createStorePort(rawStore),
    now: clock.now,
    rawStore,
    mailer,
    ...(options.oidc === undefined ? {} : { oidc: options.oidc }),
    ...(options.secureCookies === undefined ? {} : { secureCookies: options.secureCookies }),
    ...(options.csrf === undefined ? {} : { csrf: options.csrf }),
  }

  const table: Record<string, { method: string; run: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> }> = {
    '/api/auth/register': { method: 'POST', run: (req, res) => handleRegister(ctx, req, res) },
    '/api/auth/verify-email': { method: 'POST', run: (req, res) => handleVerifyEmail(ctx, req, res) },
    '/api/auth/login': { method: 'POST', run: (req, res) => handleLogin(ctx, req, res) },
    '/api/auth/logout': { method: 'POST', run: (req, res) => handleLogout(ctx, req, res) },
    '/api/auth/me': { method: 'GET', run: (req, res) => handleMe(ctx, req, res) },
    '/api/auth/password/reset-request': { method: 'POST', run: (req, res) => handlePasswordResetRequest(ctx, req, res) },
    '/api/auth/password/reset': { method: 'POST', run: (req, res) => handlePasswordReset(ctx, req, res) },
    '/api/auth/providers': { method: 'GET', run: (req, res) => handleListProviders(ctx, req, res) },
    '/api/auth/oidc/start': { method: 'POST', run: (req, res) => handleOidcStart(ctx, req, res) },
    '/api/auth/oidc/callback': { method: 'GET', run: (req, res, url) => handleOidcCallback(ctx, req, res, url) },
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://control-plane.local')
    const path = url.pathname.replace(/\/+$/, '') === '' ? '/' : url.pathname.replace(/\/+$/, '')
    const route = table[path]
    if (route === undefined || route.method !== (req.method ?? 'GET')) {
      req.resume()
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'no route' } }))
      return
    }
    route.run(req, res, url).catch((err: unknown) => {
      console.error('auth test route failed', err)
      if (!res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: { code: 'internal_error' } }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const baseUrl = `http://127.0.0.1:${port}`

  const call = async (method: string, path: string, callOptions: CallOptions = {}): Promise<AuthResponse> => {
    const headers: Record<string, string> = { ...(callOptions.headers ?? {}) }
    if (callOptions.token !== undefined) headers['authorization'] = `Bearer ${callOptions.token}`
    if (callOptions.cookie !== undefined) headers['cookie'] = callOptions.cookie
    let body: string | undefined
    if (callOptions.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(callOptions.body)
    }
    const init: RequestInit = { method, headers, ...(body === undefined ? {} : { body }) }
    if (callOptions.redirect !== undefined) init.redirect = callOptions.redirect
    const response = await fetch(`${baseUrl}${path}`, init)
    const text = await response.text()
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    return {
      status: response.status,
      headers: response.headers,
      json: text === '' ? null : (JSON.parse(text) as unknown),
      cookies,
    }
  }

  return {
    ctx,
    rawStore,
    mail,
    call,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rawStore.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 走完注册 + 验证 + 登录，返回会话 token 与两枚 cookie。 */
async function registerAndLogin(harness: AuthHarness, email = 'alice@example.com'): Promise<{
  accountId: string
  token: string
  csrfToken: string
  cookie: string
  cookies: string[]
}> {
  const registered = await harness.call('POST', '/api/auth/register', { body: { email, password: PASSWORD } })
  assert.equal(registered.status, 201, JSON.stringify(registered.json))
  const verifyToken = harness.mail.filter((item) => item.to === email && item.kind === 'verify').at(-1)!.token
  const verified = await harness.call('POST', '/api/auth/verify-email', { body: { token: verifyToken } })
  assert.equal(verified.status, 200, JSON.stringify(verified.json))

  const login = await harness.call('POST', '/api/auth/login', { body: { email, password: PASSWORD } })
  assert.equal(login.status, 200, JSON.stringify(login.json))
  const sessionToken = cookieValueFrom(login.cookies, 'roost_session')
  assert.ok(sessionToken !== null)
  return {
    accountId: (registered.json as { accountId: string }).accountId,
    token: sessionToken!,
    csrfToken: (login.json as { csrfToken: string }).csrfToken,
    cookie: cookieHeaderFrom(login.cookies, ['roost_session', 'roost_csrf']),
    cookies: login.cookies,
  }
}

// ---- 注册 / 验证 --------------------------------------------------------------

test('register：201 + 发验证邮件；同邮箱重名 → 409 auth.email_taken', async () => {
  const harness = await startAuthHarness()
  try {
    const created = await harness.call('POST', '/api/auth/register', {
      body: { email: '  Alice@Example.com ', password: PASSWORD },
    })
    assert.equal(created.status, 201)
    assert.match((created.json as { accountId: string }).accountId, /^acc_/)
    assert.equal(created.headers.get('cache-control'), 'no-store')
    assert.equal(harness.mail.length, 1)
    assert.equal(harness.mail[0]!.kind, 'verify')
    assert.equal(harness.mail[0]!.to, 'alice@example.com')
    assert.match(harness.mail[0]!.token, /^[0-9a-f]{64}$/)
    assert.ok(harness.mail[0]!.expiresAt > harness.ctx.now())

    const duplicate = await harness.call('POST', '/api/auth/register', {
      body: { email: 'ALICE@example.com', password: 'another password!' },
    })
    assert.equal(duplicate.status, 409)
    assert.equal((duplicate.json as any).error.code, 'auth.email_taken')

    const weak = await harness.call('POST', '/api/auth/register', { body: { email: 'b@example.com', password: 'short' } })
    assert.equal(weak.status, 400)
    assert.equal((weak.json as any).error.code, 'auth.weak_password')

    const badEmail = await harness.call('POST', '/api/auth/register', { body: { email: 'nope', password: PASSWORD } })
    assert.equal(badEmail.status, 400)
    assert.equal((badEmail.json as any).error.code, 'auth.invalid_email')
  } finally {
    await harness.close()
  }
})

test('verify-email 单次：第一次 200，第二次 400 auth.token_invalid', async () => {
  const harness = await startAuthHarness()
  try {
    const registered = await harness.call('POST', '/api/auth/register', {
      body: { email: 'v@example.com', password: PASSWORD },
    })
    assert.equal(registered.status, 201)
    const token = harness.mail.at(-1)!.token

    const first = await harness.call('POST', '/api/auth/verify-email', { body: { token } })
    assert.equal(first.status, 200)
    assert.deepEqual(first.json, {})

    const second = await harness.call('POST', '/api/auth/verify-email', { body: { token } })
    assert.equal(second.status, 400)
    assert.equal((second.json as any).error.code, 'auth.token_invalid')

    // 验证后密码登录才通
    const login = await harness.call('POST', '/api/auth/login', { body: { email: 'v@example.com', password: PASSWORD } })
    assert.equal(login.status, 200)
  } finally {
    await harness.close()
  }
})

test('login：邮箱未验证 → 401 auth.email_unverified；登录成功设 roost_session(HttpOnly) + roost_csrf', async () => {
  const harness = await startAuthHarness()
  try {
    await harness.call('POST', '/api/auth/register', { body: { email: 'u@example.com', password: PASSWORD } })

    const unverified = await harness.call('POST', '/api/auth/login', {
      body: { email: 'u@example.com', password: PASSWORD },
    })
    assert.equal(unverified.status, 401)
    assert.equal((unverified.json as any).error.code, 'auth.email_unverified')

    await harness.call('POST', '/api/auth/verify-email', { body: { token: harness.mail.at(-1)!.token } })
    const login = await harness.call('POST', '/api/auth/login', { body: { email: 'u@example.com', password: PASSWORD } })
    assert.equal(login.status, 200)
    assert.equal(login.headers.get('cache-control'), 'no-store')
    const body = login.json as { accountId: string; csrfToken: string }
    assert.match(body.accountId, /^acc_/)
    assert.match(body.csrfToken, /^[0-9a-f]{64}$/)

    const sessionCookie = findCookie(login.cookies, 'roost_session')
    const csrfCookie = findCookie(login.cookies, 'roost_csrf')
    assert.ok(sessionCookie !== undefined, 'missing roost_session set-cookie')
    assert.match(sessionCookie!, /HttpOnly/)
    assert.match(sessionCookie!, /SameSite=Lax/)
    assert.match(sessionCookie!, /Path=\//)
    assert.match(sessionCookie!, /Max-Age=2592000/)
    // CSRF cookie 必须可被同源 JS 读到：不能 HttpOnly
    assert.ok(csrfCookie !== undefined, 'missing roost_csrf set-cookie')
    assert.doesNotMatch(csrfCookie!, /HttpOnly/)
    assert.equal(cookieValueFrom(login.cookies, 'roost_csrf'), body.csrfToken)

    // 错误口令与不存在的邮箱拿到同一个 code
    const wrong = await harness.call('POST', '/api/auth/login', { body: { email: 'u@example.com', password: 'wrong password' } })
    assert.equal(wrong.status, 401)
    assert.equal((wrong.json as any).error.code, 'auth.invalid_credentials')
    const unknown = await harness.call('POST', '/api/auth/login', { body: { email: 'ghost@example.com', password: PASSWORD } })
    assert.equal(unknown.status, 401)
    assert.equal((unknown.json as any).error.code, 'auth.invalid_credentials')
  } finally {
    await harness.close()
  }
})

test('Secure 由 ctx.secureCookies 控制（ROOST_SECURE_COOKIES=1 的接线位）', async () => {
  const harness = await startAuthHarness({ secureCookies: true })
  try {
    await harness.call('POST', '/api/auth/register', { body: { email: 's@example.com', password: PASSWORD } })
    await harness.call('POST', '/api/auth/verify-email', { body: { token: harness.mail.at(-1)!.token } })
    const login = await harness.call('POST', '/api/auth/login', { body: { email: 's@example.com', password: PASSWORD } })
    assert.equal(login.status, 200)
    const sessionCookie = findCookie(login.cookies, 'roost_session')!
    assert.match(sessionCookie, /; Secure$/)
  } finally {
    await harness.close()
  }
})

// ---- CSRF / me / logout -------------------------------------------------------

test('Cookie 写操作没带 CSRF → 403 auth.csrf；带对了就 204', async () => {
  const harness = await startAuthHarness()
  try {
    const session = await registerAndLogin(harness, 'csrf@example.com')

    const missing = await harness.call('POST', '/api/auth/logout', { cookie: session.cookie })
    assert.equal(missing.status, 403)
    assert.equal((missing.json as any).error.code, 'auth.csrf')

    const wrong = await harness.call('POST', '/api/auth/logout', {
      cookie: session.cookie,
      headers: { 'x-csrf-token': 'f'.repeat(64) },
    })
    assert.equal(wrong.status, 403)

    const ok = await harness.call('POST', '/api/auth/logout', {
      cookie: session.cookie,
      headers: { 'x-csrf-token': session.csrfToken },
    })
    assert.equal(ok.status, 204)
  } finally {
    await harness.close()
  }
})

test('me：cookie 与 Bearer 都能读；logout 清 cookie 并吊销会话', async () => {
  const harness = await startAuthHarness()
  try {
    const session = await registerAndLogin(harness, 'me@example.com')

    const viaCookie = await harness.call('GET', '/api/auth/me', { cookie: session.cookie })
    assert.equal(viaCookie.status, 200)
    assert.deepEqual(viaCookie.json, { accountId: session.accountId, email: 'me@example.com' })

    const viaBearer = await harness.call('GET', '/api/auth/me', { token: session.token })
    assert.equal(viaBearer.status, 200)
    assert.equal((viaBearer.json as { accountId: string }).accountId, session.accountId)

    const anonymous = await harness.call('GET', '/api/auth/me')
    assert.equal(anonymous.status, 401)

    const loggedOut = await harness.call('POST', '/api/auth/logout', {
      cookie: session.cookie,
      headers: { 'x-csrf-token': session.csrfToken },
    })
    assert.equal(loggedOut.status, 204)
    const clearedSession = findCookie(loggedOut.cookies, 'roost_session')!
    const clearedCsrf = findCookie(loggedOut.cookies, 'roost_csrf')!
    assert.match(clearedSession, /Max-Age=0/)
    assert.match(clearedCsrf, /Max-Age=0/)

    // 旧 cookie 不再有效（会话已吊销）
    const afterLogout = await harness.call('GET', '/api/auth/me', { cookie: session.cookie })
    assert.equal(afterLogout.status, 401)
    assert.equal((afterLogout.json as any).error.code, 'session_revoked')
  } finally {
    await harness.close()
  }
})

test('Bearer 跳过 CSRF：无 x-csrf-token 也能 logout 204', async () => {
  const harness = await startAuthHarness()
  try {
    const session = await registerAndLogin(harness, 'bearer@example.com')
    const loggedOut = await harness.call('POST', '/api/auth/logout', { token: session.token })
    assert.equal(loggedOut.status, 204)
    const afterLogout = await harness.call('GET', '/api/auth/me', { token: session.token })
    assert.equal(afterLogout.status, 401)
  } finally {
    await harness.close()
  }
})

test('requireCsrf 单元行为：Bearer / 关闭开关 / cookie 对比', async () => {
  const harness = await startAuthHarness()
  try {
    const csrfToken = 'a'.repeat(64)
    const request = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage
    assert.equal(requireCsrf(harness.ctx, request({ 'x-csrf-token': csrfToken, cookie: `roost_csrf=${csrfToken}` })), true)
    assert.equal(requireCsrf(harness.ctx, request({ cookie: `roost_csrf=${csrfToken}` })), false)
    assert.equal(requireCsrf(harness.ctx, request({ 'x-csrf-token': csrfToken })), false)
    assert.equal(requireCsrf(harness.ctx, request({ 'x-csrf-token': 'b'.repeat(64), cookie: `roost_csrf=${csrfToken}` })), false)
    assert.equal(requireCsrf(harness.ctx, request({ authorization: 'Bearer anything' })), true)
    assert.equal(requireCsrf({ ...harness.ctx, csrf: false }, request({})), true)
  } finally {
    await harness.close()
  }
})

// ---- 密码重置 ----------------------------------------------------------------

test('reset-request 一律 202；reset 单次、改密后旧口令失效且旧会话被吊销', async () => {
  const harness = await startAuthHarness()
  try {
    const session = await registerAndLogin(harness, 'reset@example.com')

    const unknown = await harness.call('POST', '/api/auth/password/reset-request', { body: { email: 'ghost@example.com' } })
    assert.equal(unknown.status, 202)
    const requested = await harness.call('POST', '/api/auth/password/reset-request', { body: { email: 'reset@example.com' } })
    assert.equal(requested.status, 202)
    const resetMail = harness.mail.filter((item) => item.kind === 'reset').at(-1)!
    assert.equal(resetMail.to, 'reset@example.com')

    const weak = await harness.call('POST', '/api/auth/password/reset', {
      body: { token: resetMail.token, password: 'short' },
    })
    assert.equal(weak.status, 400)
    assert.equal((weak.json as any).error.code, 'auth.weak_password')

    const reset = await harness.call('POST', '/api/auth/password/reset', {
      body: { token: resetMail.token, password: NEW_PASSWORD },
    })
    assert.equal(reset.status, 200)

    const replay = await harness.call('POST', '/api/auth/password/reset', {
      body: { token: resetMail.token, password: 'yet another passphrase' },
    })
    assert.equal(replay.status, 400)
    assert.equal((replay.json as any).error.code, 'auth.token_invalid')

    // 改密前签发的会话已吊销
    const oldSession = await harness.call('GET', '/api/auth/me', { cookie: session.cookie })
    assert.equal(oldSession.status, 401)

    const oldPassword = await harness.call('POST', '/api/auth/login', {
      body: { email: 'reset@example.com', password: PASSWORD },
    })
    assert.equal(oldPassword.status, 401)
    assert.equal((oldPassword.json as any).error.code, 'auth.invalid_credentials')
    const newPassword = await harness.call('POST', '/api/auth/login', {
      body: { email: 'reset@example.com', password: NEW_PASSWORD },
    })
    assert.equal(newPassword.status, 200)
  } finally {
    await harness.close()
  }
})

// ---- OIDC --------------------------------------------------------------------

function fakeProvider(): {
  provider: OidcProvider
  calls: { authorize?: OidcAuthorizeInput; exchange?: OidcExchangeInput; userinfoToken?: string }
} {
  const calls: { authorize?: OidcAuthorizeInput; exchange?: OidcExchangeInput; userinfoToken?: string } = {}
  const provider: OidcProvider = {
    authorizeUrl(input) {
      calls.authorize = input
      const url = new URL('https://idp.example.com/authorize')
      url.searchParams.set('state', input.state)
      url.searchParams.set('code_challenge', input.codeChallenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('redirect_uri', input.redirectUri)
      return url.toString()
    },
    async exchange(input) {
      calls.exchange = input
      return { accessToken: 'access-token-1' }
    },
    async userinfo(input) {
      calls.userinfoToken = input.accessToken
      return { subject: 'sub-oidc-1', email: 'Oidc@Example.com' }
    },
  }
  return { provider, calls }
}

test('邮箱验证通过发放注册赠送 100 万 tokens（一次性、90 天）', async () => {
  const harness = await startAuthHarness()
  try {
    const registered = await harness.call('POST', '/api/auth/register', {
      body: { email: 'grant@example.com', password: PASSWORD },
    })
    assert.equal(registered.status, 201)
    const mail = harness.mail.find((item) => item.kind === 'verify')
    assert.ok(mail)
    assert.equal(getTokenCreditBalance(harness.rawStore, harness.rawStore.db.prepare('SELECT id FROM accounts WHERE email = ?').get('grant@example.com').id).balance, 0)
    const verified = await harness.call('POST', '/api/auth/verify-email', { body: { token: mail.token } })
    assert.equal(verified.status, 200)
    const accountId = harness.rawStore.db.prepare('SELECT id FROM accounts WHERE email = ?').get('grant@example.com').id
    const balance = getTokenCreditBalance(harness.rawStore, accountId)
    assert.equal(balance.balance, SIGNUP_CREDIT_TOKENS)
    // 重放/再次验证不会重复发
    await harness.call('POST', '/api/auth/verify-email', { body: { token: mail.token } })
    assert.equal(getTokenCreditBalance(harness.rawStore, accountId).balance, SIGNUP_CREDIT_TOKENS)
  } finally {
    await harness.close()
  }
})

test('OIDC 未配置：start 404 auth.oidc_unavailable，providers 为空', async () => {
  const harness = await startAuthHarness()
  try {
    const start = await harness.call('POST', '/api/auth/oidc/start', { body: { provider: 'google' } })
    assert.equal(start.status, 404)
    assert.equal((start.json as any).error.code, 'auth.oidc_unavailable')
    const providers = await harness.call('GET', '/api/auth/providers')
    assert.equal(providers.status, 200)
    assert.deepEqual(providers.json, { providers: [] })
  } finally {
    await harness.close()
  }
})

test('OIDC start：下发 authorizeUrl（含 state + PKCE S256）；providers 列出注入的 provider', async () => {
  const { provider, calls } = fakeProvider()
  const harness = await startAuthHarness({ oidc: { github: provider } })
  try {
    const start = await harness.call('POST', '/api/auth/oidc/start', { body: { provider: 'github' } })
    assert.equal(start.status, 200)
    const authorizeUrl = new URL((start.json as { authorizeUrl: string }).authorizeUrl)
    const state = authorizeUrl.searchParams.get('state')!
    assert.match(state, /^[0-9a-f]{64}$/)
    assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(authorizeUrl.searchParams.get('code_challenge'), calls.authorize!.codeChallenge)
    assert.equal(authorizeUrl.searchParams.get('redirect_uri'), calls.authorize!.redirectUri)

    const providers = await harness.call('GET', '/api/auth/providers')
    assert.deepEqual(providers.json, { providers: [{ id: 'github', label: 'GitHub' }] })

    // state 不匹配（库里没这个 state）→ 400
    const mismatch = await harness.call(
      'GET',
      `/api/auth/oidc/callback?code=code-1&state=${'f'.repeat(64)}`,
      { redirect: 'manual' },
    )
    assert.equal(mismatch.status, 400)
    assert.equal((mismatch.json as any).error.code, 'auth.oidc_state')
  } finally {
    await harness.close()
  }
})

test('任意 OIDC 提供方（Keycloak/Casdoor/Logto）凭 env 即可出现在 providers', async () => {
  const env = {
    ROOST_OIDC_KEYCLOAK_CLIENT_ID: 'roostbot',
    ROOST_OIDC_KEYCLOAK_SECRET: 'secret',
    ROOST_OIDC_KEYCLOAK_AUTHORIZE_URL: 'https://id.example/realms/roost/protocol/openid-connect/auth',
    ROOST_OIDC_KEYCLOAK_TOKEN_URL: 'https://id.example/realms/roost/protocol/openid-connect/token',
    ROOST_OIDC_KEYCLOAK_USERINFO_URL: 'https://id.example/realms/roost/protocol/openid-connect/userinfo',
    ROOST_OIDC_KEYCLOAK_SCOPE: 'openid email profile',
  }
  const before = new Map(Object.keys(env).map((key) => [key, process.env[key]]))
  Object.assign(process.env, env)
  const harness = await startAuthHarness()
  try {
    const providers = await harness.call('GET', '/api/auth/providers')
    assert.deepEqual(providers.json, { providers: [{ id: 'keycloak', label: 'Keycloak' }] })
    const start = await harness.call('POST', '/api/auth/oidc/start', { body: { provider: 'keycloak' } })
    assert.equal(start.status, 200)
    assert.match((start.json as { authorizeUrl: string }).authorizeUrl, /^https:\/\/id\.example\/realms\/roost\//)
  } finally {
    await harness.close()
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('OIDC callback：PKCE 校验通过 → 建 OIDC 账号 + 302 + cookie；state 重放 → 400', async () => {
  const { provider, calls } = fakeProvider()
  const harness = await startAuthHarness({ oidc: { github: provider } })
  try {
    const start = await harness.call('POST', '/api/auth/oidc/start', { body: { provider: 'github' } })
    const authorizeUrl = new URL((start.json as { authorizeUrl: string }).authorizeUrl)
    const state = authorizeUrl.searchParams.get('state')!
    const challenge = authorizeUrl.searchParams.get('code_challenge')!

    const callback = await harness.call('GET', `/api/auth/oidc/callback?code=code-1&state=${state}`, {
      redirect: 'manual',
    })
    assert.equal(callback.status, 302)
    assert.equal(callback.headers.get('location'), '/')
    assert.equal(callback.headers.get('cache-control'), 'no-store')
    const sessionToken = cookieValueFrom(callback.cookies, 'roost_session')
    assert.ok(sessionToken !== null)

    // PKCE：路由送给 exchange 的 verifier 必须和授权时的 challenge 对上
    const verifier = calls.exchange!.codeVerifier
    assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge)
    assert.equal(calls.exchange!.code, 'code-1')
    assert.equal(calls.userinfoToken, 'access-token-1')

    const me = await harness.call('GET', '/api/auth/me', { cookie: cookieHeaderFrom(callback.cookies, ['roost_session']) })
    assert.equal(me.status, 200)
    assert.equal((me.json as { email: string }).email, 'oidc@example.com')

    // state 单次：重放同一个 state → 400
    const replay = await harness.call('GET', `/api/auth/oidc/callback?code=code-1&state=${state}`, {
      redirect: 'manual',
    })
    assert.equal(replay.status, 400)
    assert.equal((replay.json as any).error.code, 'auth.oidc_state')
  } finally {
    await harness.close()
  }
})
