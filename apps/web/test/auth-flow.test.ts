import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ApiError, createApiClient } from '../lib/api-client.js'
import {
  authFailureMessage,
  authProviders,
  csrfHeaders,
  csrfTokenFromCookie,
  isAuthHash,
  isSafeAuthorizeUrl,
  loginPayload,
  nextRouteAfterAuth,
  normalizeEmail,
  pendingRouteAfter,
  readCookie,
  registerPayload,
  resetPayload,
  resetRequestPayload,
  tokenFromHash,
  validateEmail,
  validatePassword,
  verifyEmailPayload,
} from '../lib/auth-flow.js'
import { routeMatch } from '../lib/routing.js'

test('邮箱规范化与校验：去空白、小写、必须有 @ 与域名点', () => {
  assert.equal(normalizeEmail('  Foo@Example.COM '), 'foo@example.com')
  assert.equal(validateEmail('Foo@Example.COM'), '')
  for (const bad of ['', 'foo', 'foo@bar', 'foo bar@x.com', '@x.com']) {
    assert.notEqual(validateEmail(bad), '', bad)
  }
})

test('注册密码 ≥ 12 位；登录不强制长度（老账号仍可登录）', () => {
  assert.match(validatePassword('short'), /12/)
  assert.equal(validatePassword('123456789012'), '')
  const login = loginPayload({ email: 'a@b.com', password: 'short' })
  assert.equal(login.ok, true)
})

test('loginPayload 规范化邮箱并返回最小 payload', () => {
  assert.deepEqual(loginPayload({ email: ' Foo@Example.com ', password: 'pw' }), {
    ok: true,
    payload: { email: 'foo@example.com', password: 'pw' },
  })
  const bad = loginPayload({ email: 'nope', password: 'pw' })
  assert.equal(bad.ok, false)
  assert.equal(bad.field, 'email')
})

test('register / reset / verify payload：两次密码一致、token 必填', () => {
  const short = registerPayload({ email: 'a@b.com', password: 'short', confirm: 'short' })
  assert.equal(short.ok, false)
  assert.equal(short.field, 'password')

  const mismatch = registerPayload({ email: 'a@b.com', password: '123456789012', confirm: '123456789013' })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.field, 'confirm')

  const ok = registerPayload({ email: 'a@b.com', password: '123456789012', confirm: '123456789012' })
  assert.deepEqual(ok, { ok: true, payload: { email: 'a@b.com', password: '123456789012' } })

  assert.equal(resetRequestPayload({ email: 'a@b.com' }).ok, true)
  assert.equal(resetPayload({ token: '', password: '123456789012', confirm: '123456789012' }).field, 'token')
  assert.equal(verifyEmailPayload({ token: '  ' }).ok, false)
})

test('pendingRouteAfter：只记受保护地址，不把登录页记成回跳目标', () => {
  assert.equal(pendingRouteAfter('#/plugins/market'), '#/plugins/market')
  assert.equal(pendingRouteAfter('plugins'), '#/plugins')
  for (const hash of ['', '#', '#/', '#/login', '#/register?x=1', '#/verify-email?token=t', '#/reset', '#/reset-confirm']) {
    assert.equal(pendingRouteAfter(hash), '', hash)
  }
})

test('nextRouteAfterAuth：只接受站内 hash，并且不跳回登录页', () => {
  assert.equal(nextRouteAfterAuth('#/bots/b1'), '#/bots/b1')
  assert.equal(nextRouteAfterAuth(''), '#/bots')
  assert.equal(nextRouteAfterAuth('#/login'), '#/bots')
  assert.equal(nextRouteAfterAuth('https://evil.example/x'), '#/bots')
  assert.equal(nextRouteAfterAuth('#/bots', '#/approvals'), '#/bots')
  assert.equal(nextRouteAfterAuth('', '#/approvals'), '#/approvals')
})

test('账号路由识别与 token 读取', () => {
  assert.equal(isAuthHash('#/login'), true)
  assert.equal(isAuthHash('#/reset-confirm?token=t'), true)
  assert.equal(isAuthHash('#/bots'), false)
  assert.equal(tokenFromHash('#/verify-email?token=abc%201', 'token'), 'abc 1')
  assert.equal(tokenFromHash('#/verify-email', 'token'), '')
})

test('authProviders 兼容数组与 {providers}，去重并给出中文/默认标签', () => {
  assert.deepEqual(authProviders({ providers: [{ id: 'google', name: 'Google' }, 'github', { provider: 'google' }] }), [
    { id: 'google', label: 'Google' },
    { id: 'github', label: 'github' },
  ])
  assert.deepEqual(authProviders(null), [])
})

test('authorizeUrl 白名单：https、或 http 回环；拒绝 javascript/data/带凭据/协议相对', () => {
  assert.equal(isSafeAuthorizeUrl('https://accounts.google.com/o/oauth2/auth?x=1'), true)
  assert.equal(isSafeAuthorizeUrl('http://127.0.0.1:8787/callback'), true)
  assert.equal(isSafeAuthorizeUrl('http://localhost:8787/callback'), true)
  for (const bad of ['', 'javascript:alert(1)', 'data:text/html,x', '//evil.example/x', 'http://evil.example/x', 'https://user:pass@x.example/']) {
    assert.equal(isSafeAuthorizeUrl(bad), false, bad)
  }
})

test('CSRF：从 roost_csrf cookie 读；只给写请求加 x-csrf-token', () => {
  assert.equal(readCookie('roost_csrf', 'a=1; roost_csrf=tok%2B1; b=2'), 'tok+1')
  assert.equal(csrfTokenFromCookie('roost_csrf=abc'), 'abc')
  assert.deepEqual(csrfHeaders('POST', 'abc'), { 'x-csrf-token': 'abc' })
  assert.deepEqual(csrfHeaders('GET', 'abc'), {})
  assert.deepEqual(csrfHeaders('DELETE', ''), {})
})

test('authFailureMessage：401/404/429/网络都有可读文案', () => {
  assert.match(authFailureMessage(new ApiError('auth.invalid_credentials', 'x', { status: 401 }), 'login'), /邮箱或密码/)
  assert.match(authFailureMessage(new ApiError('http_404', 'x', { status: 404 }), 'register'), /还没有上线/)
  assert.match(authFailureMessage(new ApiError('http_429', 'x', { status: 429 }), 'login'), /频繁/)
  assert.match(authFailureMessage(new ApiError('network', '连不上 API'), 'login'), /连不上/)
})

test('routeMatch：账号页与 query token、#/installs 都是独立路由', () => {
  assert.deepEqual(routeMatch('#/login'), { name: 'login', params: {}, path: '/login' })
  assert.equal(routeMatch('#/register').name, 'register')
  const verify = routeMatch('#/verify-email?token=abc')
  assert.equal(verify.name, 'verifyEmail')
  assert.equal(verify.params.token, 'abc')
  const reset = routeMatch('#/reset-confirm?token=t1')
  assert.equal(reset.name, 'resetConfirm')
  assert.equal(reset.params.token, 't1')
  assert.equal(routeMatch('#/reset').name, 'reset')
  assert.equal(routeMatch('#/installs').name, 'installs')
})

test('api-client：写请求自动带 CSRF，Bearer 回退仍在，GET 不带 CSRF', async () => {
  const calls: Array<{ url: string; init: any }> = []
  const api = createApiClient({
    getToken: () => 'tok_legacy',
    getCsrfToken: () => 'csrf_123',
    fetchImpl: async (url: string, init: any) => {
      calls.push({ url, init })
      return { ok: true, status: 200, statusText: '', text: async () => '{"ok":true}' }
    },
  })
  await api.post('/api/plugins', { a: 1 })
  await api.get('/api/bots')
  assert.equal(calls[0].init.headers['x-csrf-token'], 'csrf_123')
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok_legacy')
  assert.equal(calls[1].init.headers['x-csrf-token'], undefined)
})

test('api-client：setCsrfToken 兜底，cookie 读不到时写请求仍能带 token', async () => {
  const calls: Array<{ url: string; init: any }> = []
  const api = createApiClient({
    fetchImpl: async (url: string, init: any) => {
      calls.push({ url, init })
      return { ok: true, status: 200, statusText: '', text: async () => '{}' }
    },
  })
  api.setCsrfToken('from_login')
  await api.del('/api/plugin-installs/x')
  assert.equal(calls[0].init.headers['x-csrf-token'], 'from_login')
})
