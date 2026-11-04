// ADR 0004「独立源」：反代放到同 host、不同端口。
//
// 验证：主端口签发的会话 cookie 对反代端口同样有效（cookie 不区分端口）；反代端口只服务
// /w/.../dsh/* 且不做 Origin 校验；/api/config 返回 dshBase；/api/workspaces/:id/dsh/status
// 由控制面代探；close() 同时释放两个监听。
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import test from 'node:test'

import { hashSessionToken, hostnameFromHostHeader } from '../src/server.ts'
import { startSqliteHarness } from './helpers.ts'
import type { Harness } from './helpers.ts'

const OWNER = 'acc_dsh_origin_owner'
const OUTSIDER = 'acc_dsh_origin_outsider'

interface FakeUpstream {
  port: number
  close: () => Promise<void>
}

async function startUpstream(): Promise<FakeUpstream> {
  const server = http.createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url, method: req.method }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err === undefined ? resolve() : reject(err)))
        server.closeAllConnections()
      }),
  }
}

/** 占一个端口再关掉，得到确定没人监听的端口。 */
async function deadPort(): Promise<number> {
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
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
    name: 'dsh 独立源测试',
    now: harness.clock.now(),
  })
  const token = await createSession(harness, OWNER)
  return { workspaceId: workspace.id, token }
}

/** 在主端口签发 cookie（浏览器里 Set-Cookie 不带 Domain，因此对所有端口生效）。 */
async function dshCookie(harness: Harness, workspaceId: string, token: string): Promise<string> {
  const issued = await harness.call('POST', `/w/${workspaceId}/dsh/session`, { token })
  assert.equal(issued.status, 204, JSON.stringify(issued.json))
  const setCookie = issued.headers.getSetCookie()[0]
  assert.ok(setCookie !== undefined)
  return setCookie.split(';')[0]!
}

async function proxyFetch(
  harness: Harness,
  method: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; headers: Headers; text: string }> {
  assert.ok(harness.dshProxyUrl !== undefined, '反代端口必须已启动')
  const response = await fetch(`${harness.dshProxyUrl}${path}`, { method, ...init })
  return { status: response.status, headers: response.headers, text: await response.text() }
}

test('独立端口代理 /w/.../dsh：主端口 cookie 跨端口有效，无 cookie 401', async (t) => {
  const upstream = await startUpstream()
  const harness = await startSqliteHarness({ dshWebPort: upstream.port, dshProxyPort: 0 })
  t.after(async () => {
    await harness.close()
    await upstream.close()
  })

  assert.match(harness.dshProxyUrl ?? '', /^http:\/\/127\.0\.0\.1:\d+$/)
  const proxyPort = new URL(harness.dshProxyUrl!).port
  assert.notEqual(proxyPort, new URL(harness.baseUrl).port, '反代端口必须不同于主控制面端口')

  const { workspaceId, token } = await bootstrap(harness)
  const cookie = await dshCookie(harness, workspaceId, token)

  const withCookie = await proxyFetch(harness, 'GET', `/w/${workspaceId}/dsh/echo?via=proxy`, {
    headers: { cookie },
  })
  assert.equal(withCookie.status, 200)
  assert.equal(JSON.parse(withCookie.text).url, '/echo?via=proxy')

  const anonymous = await proxyFetch(harness, 'GET', `/w/${workspaceId}/dsh/echo`)
  assert.equal(anonymous.status, 401)
  assert.equal(JSON.parse(anonymous.text).error.code, 'unauthenticated')

  // 反代端口不做主控制面的 Origin 校验：非法 Origin 也只是"没凭据"的 401，不是 403。
  const badOrigin = await proxyFetch(harness, 'POST', `/w/${workspaceId}/dsh/echo`, {
    headers: { origin: 'https://evil.example' },
  })
  assert.equal(badOrigin.status, 401)

  // 主控制面路由不受第二个监听影响。
  const health = await harness.call('GET', '/healthz')
  assert.equal(health.status, 200)
  const workspaces = await harness.call('GET', '/api/workspaces', { token })
  assert.equal(workspaces.status, 200)
})

test('反代端口其它路径一律 404；close() 后两个端口都释放', async (t) => {
  const upstream = await startUpstream()
  const harness = await startSqliteHarness({ dshWebPort: upstream.port, dshProxyPort: 0 })
  const proxyUrl = harness.dshProxyUrl!
  const baseUrl = harness.baseUrl
  try {
    for (const path of ['/', '/healthz', '/api/config', '/api/workspaces/ws/dsh/status', '/w']) {
      const response = await fetch(`${proxyUrl}${path}`)
      assert.equal(response.status, 404, path)
      const body = JSON.parse(await response.text())
      assert.equal(body.ok, false)
      assert.equal(body.error.code, 'not_found')
    }

    const health = await fetch(`${baseUrl}/healthz`)
    assert.equal(health.status, 200)
    await health.text()
  } finally {
    await harness.close()
    await upstream.close()
  }

  await assert.rejects(fetch(`${baseUrl}/healthz`), '主端口应已关闭')
  await assert.rejects(fetch(`${proxyUrl}/w/ws/dsh/`), '反代端口应已关闭')
})

test('GET /api/config：启用反代返回 host:port，未启用返回 null', async (t) => {
  const upstream = await startUpstream()
  const withProxy = await startSqliteHarness({ dshWebPort: upstream.port, dshProxyPort: 0 })
  const withoutProxy = await startSqliteHarness({ dshWebPort: upstream.port })
  t.after(async () => {
    await withProxy.close()
    await withoutProxy.close()
    await upstream.close()
  })

  const enabled = await withProxy.call('GET', '/api/config')
  assert.equal(enabled.status, 200)
  assert.equal(enabled.json.dshBase, withProxy.dshProxyUrl)

  const disabled = await withoutProxy.call('GET', '/api/config')
  assert.equal(disabled.status, 200)
  assert.equal(disabled.json.dshBase, null)

  const wrongMethod = await withProxy.call('POST', '/api/config')
  assert.equal(wrongMethod.status, 404)
})

test('hostnameFromHostHeader：去端口、保留 IPv6 方括号、非法回退', () => {
  assert.equal(hostnameFromHostHeader('127.0.0.1:8787'), '127.0.0.1')
  assert.equal(hostnameFromHostHeader('localhost:8787'), 'localhost')
  assert.equal(hostnameFromHostHeader('example.com'), 'example.com')
  assert.equal(hostnameFromHostHeader('[::1]:4098'), '[::1]')
  assert.equal(hostnameFromHostHeader('[::1]'), '[::1]')
  assert.equal(hostnameFromHostHeader(undefined), '127.0.0.1')
  assert.equal(hostnameFromHostHeader(''), '127.0.0.1')
  assert.equal(hostnameFromHostHeader('bad host:80'), '127.0.0.1')
  assert.equal(hostnameFromHostHeader('[broken'), '127.0.0.1')
  assert.equal(hostnameFromHostHeader('a.b/c:80'), '127.0.0.1')
})

test('GET /api/workspaces/:id/dsh/status：可达 true、不可达 false、非成员 404', async (t) => {
  const upstream = await startUpstream()
  const reachable = await startSqliteHarness({ dshWebPort: upstream.port })
  const unreachable = await startSqliteHarness({ dshWebPort: await deadPort() })
  t.after(async () => {
    await reachable.close()
    await unreachable.close()
    await upstream.close()
  })

  const { workspaceId, token } = await bootstrap(reachable)
  const path = `/api/workspaces/${workspaceId}/dsh/status`

  const unauthorized = await reachable.call('GET', path)
  assert.equal(unauthorized.status, 401)

  const up = await reachable.call('GET', path, { token })
  assert.equal(up.status, 200)
  assert.deepEqual(up.json, { available: true, status: 200 })

  const outsiderToken = await createSession(reachable, OUTSIDER)
  const outsider = await reachable.call('GET', path, { token: outsiderToken })
  assert.equal(outsider.status, 404)
  assert.equal(outsider.json.error.code, 'workspace_not_found')

  const { workspaceId: unreachableWorkspace, token: unreachableToken } = await bootstrap(unreachable)
  const down = await unreachable.call('GET', `/api/workspaces/${unreachableWorkspace}/dsh/status`, {
    token: unreachableToken,
  })
  assert.equal(down.status, 200, '探活失败不能是 5xx')
  assert.deepEqual(down.json, { available: false })
})
