// M5-5.2：DSH Web 反代 + 会话 cookie + 面板清单。
//
// 用随机端口的假上游验证路径/query/method/body 透传、前缀剥离、HTML 重写、响应头过滤、
// 502；用真实 SQLite harness 验证成员校验与 cookie 过期/篡改；memory port 验证 v0 语义。
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import test from 'node:test'

import {
  createInstall,
  upsertVersion,
} from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { dshSessionCookieName } from '../src/dsh-proxy-routes.ts'
import { hashSessionToken } from '../src/server.ts'
import { pairDevice, startHarness, startSqliteHarness } from './helpers.ts'
import type { Harness } from './helpers.ts'

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
const OWNER = 'acc_dsh_owner'
const OUTSIDER = 'acc_dsh_outsider'
const VIEWER = 'acc_dsh_viewer'

interface SeenRequest {
  method: string | undefined
  url: string | undefined
  headers: http.IncomingHttpHeaders
  body: string
}

interface FakeUpstream {
  port: number
  seen: SeenRequest[]
  close: () => Promise<void>
}

async function startUpstream(): Promise<FakeUpstream> {
  const seen: SeenRequest[] = []
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
    }
    const body = Buffer.concat(chunks).toString('utf8')
    const url = new URL(req.url ?? '/', 'http://upstream.local')
    seen.push({ method: req.method, url: req.url, headers: req.headers, body })

    if (url.pathname === '/panel') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
        'cache-control': 'public, max-age=60',
        'set-cookie': 'upstream=1; Path=/',
        'x-upstream': 'yes',
      })
      res.end(
        '<!doctype html><html><head><link href="/a.css"></head>' +
          '<body><a href="/next?x=1">n</a><img src="//cdn.example/x.png">' +
          '<form action="/submit"></form><script src="/app.js"></script></body></html>',
      )
      return
    }

    res.writeHead(200, {
      'content-type': 'application/json',
      'x-upstream': 'yes',
    })
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    port,
    seen,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err === undefined ? resolve() : reject(err)))
        server.closeAllConnections()
      }),
  }
}

async function createSession(harness: Harness, accountId: string): Promise<string> {
  const token = randomBytes(32).toString('hex')
  await harness.store.createSession({
    accountId,
    tokenHash: hashSessionToken(token),
    now: harness.clock.now(),
    expiresAt: harness.clock.now() + 3_600_000,
  })
  return token
}

async function bootstrap(harness: Harness): Promise<{ workspaceId: string; token: string }> {
  const workspace = await harness.store.createWorkspace({
    accountId: OWNER,
    name: 'dsh 反代测试',
    now: harness.clock.now(),
  })
  const token = await createSession(harness, OWNER)
  return { workspaceId: workspace.id, token }
}

async function dshCookie(harness: Harness, workspaceId: string, token: string): Promise<string> {
  const issued = await harness.call('POST', `/w/${workspaceId}/dsh/session`, { token })
  assert.equal(issued.status, 204, JSON.stringify(issued.json))
  const setCookie = issued.headers.getSetCookie()[0]
  assert.ok(setCookie !== undefined, 'session must set a cookie')
  return setCookie.split(';')[0]!
}

test('反代：前缀剥离、query/method/body 透传、请求头过滤', async (t) => {
  const upstream = await startUpstream()
  const harness = await startSqliteHarness({ dshWebPort: upstream.port })
  t.after(async () => {
    await harness.close()
    await upstream.close()
  })
  const { workspaceId, token } = await bootstrap(harness)
  const cookie = await dshCookie(harness, workspaceId, token)

  const get = await harness.call('GET', `/w/${workspaceId}/dsh/echo/deep?a=1&b=2`, {
    token,
    headers: { 'x-test-header': 'kept', cookie: 'foreign=1', 'x-runtime-token': 'secret' },
  })
  assert.equal(get.status, 200)
  const echoed = JSON.parse(get.text)
  assert.equal(echoed.method, 'GET')
  assert.equal(echoed.url, '/echo/deep?a=1&b=2')
  assert.equal(echoed.headers['x-test-header'], 'kept')
  assert.equal(echoed.headers['cookie'], undefined, 'cookie 不能带到上游')
  assert.equal(echoed.headers['authorization'], undefined, 'authorization 不能带到上游')
  assert.equal(echoed.headers['x-runtime-token'], undefined, '控制面内部头不能带到上游')
  assert.equal(get.headers.get('cache-control'), 'no-store')

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const result = await harness.call(method, `/w/${workspaceId}/dsh/echo`, {
      rawBody: JSON.stringify({ method }),
      headers: { cookie },
    })
    assert.equal(result.status, 200, method)
    const body = JSON.parse(result.text)
    assert.equal(body.method, method)
    assert.equal(body.body, JSON.stringify({ method }))
    assert.equal(body.url, '/echo')
  }

  const head = await harness.call('HEAD', `/w/${workspaceId}/dsh/echo`, { token })
  assert.equal(head.status, 200)
  assert.equal(upstream.seen.at(-1)?.method, 'HEAD')

  // 上游看到的路径都不带 /w/<id>/dsh 前缀。
  assert.ok(upstream.seen.every((entry) => entry.url?.startsWith('/echo')))
})

test('HTML 重写与响应头过滤（CSP frame-ancestors、XFO、Set-Cookie、cache-control）', async (t) => {
  const upstream = await startUpstream()
  const harness = await startSqliteHarness({ dshWebPort: upstream.port })
  t.after(async () => {
    await harness.close()
    await upstream.close()
  })
  const { workspaceId } = await bootstrap(harness)
  const token = await createSession(harness, OWNER)
  const cookie = await dshCookie(harness, workspaceId, token)

  const response = await harness.call('GET', `/w/${workspaceId}/dsh/panel`, { headers: { cookie } })
  assert.equal(response.status, 200)
  const html = response.text

  assert.match(html, new RegExp(`href="/w/${workspaceId}/dsh/a\\.css"`))
  assert.match(html, new RegExp(`href="/w/${workspaceId}/dsh/next\\?x=1"`))
  assert.match(html, new RegExp(`action="/w/${workspaceId}/dsh/submit"`))
  assert.match(html, new RegExp(`src="/w/${workspaceId}/dsh/app\\.js"`))
  assert.match(html, /src="\/\/cdn\.example\/x\.png"/, '协议相对地址不能重写')
  assert.doesNotMatch(html, /href="\/a\.css"/)

  assert.equal(response.headers.get('x-frame-options'), null)
  assert.equal(response.headers.get('set-cookie'), null, '上游 Set-Cookie 不能种到控制面源')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('content-security-policy'), "default-src 'self'")
  assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(html)))
  assert.equal(response.headers.get('x-upstream'), 'yes', '其余响应头保留')
})

test('上游不可达返回 502 dsh.unavailable', async (t) => {
  // 先占一个端口再关掉，确保这里没人监听。
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  const deadPort = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => probe.close(() => resolve()))

  const harness = await startSqliteHarness({ dshWebPort: deadPort })
  t.after(() => harness.close())
  const { workspaceId, token } = await bootstrap(harness)

  const response = await harness.call('GET', `/w/${workspaceId}/dsh/anything`, { token })
  assert.equal(response.status, 502)
  assert.equal(response.json.error.code, 'dsh.unavailable')
})

test('鉴权：cookie 签发/校验、过期/篡改、Bearer、非成员 404', async (t) => {
  const upstream = await startUpstream()
  const harness = await startSqliteHarness({ dshWebPort: upstream.port })
  t.after(async () => {
    await harness.close()
    await upstream.close()
  })
  const { workspaceId, token } = await bootstrap(harness)
  const path = `/w/${workspaceId}/dsh/echo`

  const anonymous = await harness.call('GET', path)
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.json.error.code, 'unauthenticated')

  const sessionWithoutBearer = await harness.call('POST', `/w/${workspaceId}/dsh/session`)
  assert.equal(sessionWithoutBearer.status, 401)

  const issued = await harness.call('POST', `/w/${workspaceId}/dsh/session`, { token })
  assert.equal(issued.status, 204)
  const setCookie = issued.headers.getSetCookie()[0]!
  assert.match(setCookie, /^roost_dsh_[0-9a-f]{16}=/)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Lax/)
  assert.match(setCookie, /Max-Age=900/)
  assert.match(setCookie, new RegExp(`Path=/w/${workspaceId}/dsh/`))
  const cookie = setCookie.split(';')[0]!

  const viaCookie = await harness.call('GET', path, { headers: { cookie } })
  assert.equal(viaCookie.status, 200)

  const viaBearer = await harness.call('GET', path, { token })
  assert.equal(viaBearer.status, 200)

  // 篡改签名：把 cookie 值最后一个字符换掉。
  const tampered = cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A')
  const tamperedResult = await harness.call('GET', path, { headers: { cookie: tampered } })
  assert.equal(tamperedResult.status, 401)

  // 过期：cookie Max-Age 900 秒，推进 901 秒后失效（Bearer 不走 cookie 路径）。
  harness.clock.advance(901_000)
  const expired = await harness.call('GET', path, { headers: { cookie } })
  assert.equal(expired.status, 401)

  // 非成员：能登录，但不能拿 session，也不能用 Bearer 反代。
  const outsiderToken = await createSession(harness, OUTSIDER)
  const outsiderSession = await harness.call('POST', `/w/${workspaceId}/dsh/session`, {
    token: outsiderToken,
  })
  assert.equal(outsiderSession.status, 404)
  assert.equal(outsiderSession.json.error.code, 'workspace_not_found')
  const outsiderProxy = await harness.call('GET', path, { token: outsiderToken })
  assert.equal(outsiderProxy.status, 404)

  // workspace 不存在与"非成员"同样 404，不泄漏存在性。
  const missing = await harness.call('POST', '/w/ws_missing/dsh/session', { token })
  assert.equal(missing.status, 404)

  // 另一 workspace 的 cookie 名不匹配，不能拿来用。
  const crossCookie = `${dshSessionCookieName('ws_other_workspace')}=${cookie.split('=')[1]}`
  const crossResult = await harness.call('GET', path, { headers: { cookie: crossCookie } })
  assert.equal(crossResult.status, 401)
})

test('面板清单：未安装 []、按 manifest 返回、禁用不返回、成员校验', async (t) => {
  const harness = await startSqliteHarness()
  t.after(() => harness.close())
  const { workspaceId, token } = await bootstrap(harness)
  const viewerToken = await createSession(harness, VIEWER)
  const path = `/api/workspaces/${workspaceId}/panels`

  const unauthorized = await harness.call('GET', path)
  assert.equal(unauthorized.status, 401)

  const empty = await harness.call('GET', path, { token })
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.json, { panels: [] })

  seedPanelPlugin(harness.rawStore!, workspaceId, {
    slug: 'panel-enabled',
    enabled: true,
    version: '1.0.0',
    panels: [
      { name: 'main', title: '主面板', slot: 'main', path: '/main' },
      { name: 'side', slot: 'sidebar' },
    ],
  })
  seedPanelPlugin(harness.rawStore!, workspaceId, {
    slug: 'panel-disabled',
    enabled: false,
    version: '1.0.0',
    panels: [{ name: 'hidden' }],
  })
  // 纯数量声明（旧格式）没有名字：不返回，也不猜。
  seedPanelPlugin(harness.rawStore!, workspaceId, {
    slug: 'panel-count-only',
    enabled: true,
    version: '1.0.0',
    panels: 7,
  })

  const listed = await harness.call('GET', path, { token })
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.json.panels, [
    { pluginSlug: 'panel-enabled', name: 'main', title: '主面板', slot: 'main', path: '/main' },
    { pluginSlug: 'panel-enabled', name: 'side', slot: 'sidebar' },
  ])

  // 非成员 404；加入成员后 viewer 也可以看。
  const outsider = await harness.call('GET', path, { token: viewerToken })
  assert.equal(outsider.status, 404)
  harness.rawStore!.db
    .prepare(
      'INSERT INTO workspace_members (workspace_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(workspaceId, VIEWER, 'viewer', OWNER, harness.clock.now())
  const viewer = await harness.call('GET', path, { token: viewerToken })
  assert.equal(viewer.status, 200)
  assert.equal(viewer.json.panels.length, 2)
})

test('memory port：反代按 v0 语义可用，面板清单 503', async (t) => {
  const upstream = await startUpstream()
  const harness = await startHarness({ dshWebPort: upstream.port })
  t.after(async () => {
    await harness.close()
    await upstream.close()
  })
  const token = await pairDevice(harness)
  const workspaceId = 'ws_memory_mode'

  // memory 没有成员表：session 不校验 workspace 归属（与 members-routes 的 v0 语义一致）。
  const issued = await harness.call('POST', `/w/${workspaceId}/dsh/session`, { token })
  assert.equal(issued.status, 204)
  const cookie = issued.headers.getSetCookie()[0]!.split(';')[0]!

  const proxied = await harness.call('GET', `/w/${workspaceId}/dsh/echo?memory=1`, {
    headers: { cookie },
  })
  assert.equal(proxied.status, 200)
  assert.equal(JSON.parse(proxied.text).url, '/echo?memory=1')

  const panels = await harness.call('GET', `/api/workspaces/${workspaceId}/panels`, { token })
  assert.equal(panels.status, 503)
  assert.equal(panels.json.error.code, 'runtime.not_configured')
})

// ---- 测试小工具 --------------------------------------------------------------

function seedPanelPlugin(
  store: Store,
  workspaceId: string,
  input: { slug: string; enabled: boolean; version: string; panels: unknown },
): void {
  upsertVersion(store, {
    slug: input.slug,
    version: input.version,
    integrity: `sha512-${input.slug}`,
    manifest: { panels: input.panels },
    permissions: {},
    publishedAt: NOW,
  })
  createInstall(store, {
    workspaceId,
    slug: input.slug,
    version: input.version,
    enabled: input.enabled,
    lock: '{"kind":"test"}',
    installedBy: OWNER,
    installedAt: NOW,
  })
}
