// ADR 0004「独立源」：反代放到同 host、不同端口。
//
// 验证：主端口签发的会话 cookie 对反代端口同样有效（cookie 不区分端口）；反代端口只服务
// /w/.../dsh/* 且不做 Origin 校验；/api/config 返回 dshBase；/api/workspaces/:id/dsh/status
// 由控制面代探；close() 同时释放两个监听。
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import type { IncomingMessage } from 'node:http'

import {
  hashSessionToken,
  hostnameFromHostHeader,
  isAllowedOrigin,
  parseAllowedOrigins,
} from '../src/server.ts'
import { startHarness, startSqliteHarness } from './helpers.ts'
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

/** 直接构造请求头：用来模拟反代设置的 Host / X-Forwarded-Proto。 */
function originReq(
  origin: string | undefined,
  headers: Record<string, string> = {},
): Pick<IncomingMessage, 'headers'> {
  return {
    headers: {
      ...(origin === undefined ? {} : { origin }),
      ...headers,
    },
  } as unknown as Pick<IncomingMessage, 'headers'>
}

/** 临时设置环境变量；startServer 在启动时读取白名单，配置推导在请求时读取。 */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** 走原生 http.request 才能覆盖 Host 头（fetch 不允许设置 Host）。 */
function rawRequest(
  harness: Harness,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; json: any }> {
  const target = new URL(harness.baseUrl)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: target.hostname,
        port: Number(target.port),
        method,
        path,
        headers: {
          ...headers,
          ...(body === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, json: text === '' ? null : JSON.parse(text) })
        })
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
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

test('isAllowedOrigin：回环 / 同源 / 白名单放行，跨源与 null 拒绝', () => {
  // 回环 Origin 继续允许。
  assert.equal(isAllowedOrigin(originReq('http://127.0.0.1:5173')), true)
  assert.equal(isAllowedOrigin(originReq('http://localhost:8787')), true)
  assert.equal(isAllowedOrigin(originReq('http://[::1]:8787')), true)

  // 同源 https：Origin 与 X-Forwarded-Proto + Host 完全一致。
  assert.equal(
    isAllowedOrigin(
      originReq('https://roost.example.com', { host: 'roost.example.com', 'x-forwarded-proto': 'https' }),
    ),
    true,
  )
  // 非默认端口；Host 大小写不影响比较。
  assert.equal(
    isAllowedOrigin(
      originReq('https://roost.example.com:8443', {
        host: 'Roost.Example.com:8443',
        'x-forwarded-proto': 'https',
      }),
    ),
    true,
  )
  // 默认端口可省略：Origin:443 与 Host:443 等价。
  assert.equal(
    isAllowedOrigin(
      originReq('https://roost.example.com:443', {
        host: 'roost.example.com:443',
        'x-forwarded-proto': 'https',
      }),
    ),
    true,
  )
  // 缺省 X-Forwarded-Proto 按 http。
  assert.equal(
    isAllowedOrigin(originReq('http://roost.example.com', { host: 'roost.example.com' })),
    true,
  )

  // 跨源、scheme 不一致、端口不一致都拒绝。
  assert.equal(
    isAllowedOrigin(
      originReq('https://evil.example', { host: 'roost.example.com', 'x-forwarded-proto': 'https' }),
    ),
    false,
  )
  assert.equal(
    isAllowedOrigin(
      originReq('http://roost.example.com', { host: 'roost.example.com', 'x-forwarded-proto': 'https' }),
    ),
    false,
  )
  assert.equal(
    isAllowedOrigin(
      originReq('https://roost.example.com:8443', {
        host: 'roost.example.com',
        'x-forwarded-proto': 'https',
      }),
    ),
    false,
  )

  // Origin: null 永远拒绝（即使白名单里有其它条目）。
  assert.equal(
    isAllowedOrigin(originReq('null'), { allowedOrigins: ['https://roost.example.com'] }),
    false,
  )

  // 显式白名单精确命中才放行。
  assert.equal(
    isAllowedOrigin(originReq('https://panel.example.com'), {
      allowedOrigins: ['https://panel.example.com'],
    }),
    true,
  )
  assert.equal(isAllowedOrigin(originReq('https://panel.example.com'), { allowedOrigins: [] }), false)

  // 通配与 null 条目被忽略。
  assert.deepEqual(parseAllowedOrigins('https://a.example, *,null, https://b.example/'), [
    'https://a.example',
    'https://b.example',
  ])

  // 非浏览器客户端没有 Origin，继续放行。
  assert.equal(isAllowedOrigin(originReq(undefined)), true)
})

test('写操作：同源 Origin 与 ROOST_ALLOWED_ORIGINS 白名单不再 403', async (t) => {
  const sameOrigin = await startHarness()
  t.after(() => sameOrigin.close())

  const viaSameOrigin = await rawRequest(
    sameOrigin,
    'POST',
    '/api/pairing/code',
    {
      origin: 'https://roost.example.com',
      host: 'roost.example.com',
      'x-forwarded-proto': 'https',
    },
    JSON.stringify({ accountId: 'acc_same_origin' }),
  )
  assert.equal(viaSameOrigin.status, 200, JSON.stringify(viaSameOrigin.json))

  await withEnv({ ROOST_ALLOWED_ORIGINS: 'https://panel.example.com' }, async () => {
    // 白名单在启动时读取，必须在 startHarness 之前设置。
    const allowListed = await startHarness()
    t.after(() => allowListed.close())
    const viaAllowList = await rawRequest(
      allowListed,
      'POST',
      '/api/pairing/code',
      { origin: 'https://panel.example.com', host: '127.0.0.1' },
      JSON.stringify({ accountId: 'acc_allow_list' }),
    )
    assert.equal(viaAllowList.status, 200, JSON.stringify(viaAllowList.json))
  })
})

test('GET /api/config：X-Forwarded-Proto=https + Host + 公网端口推导 https', async (t) => {
  const upstream = await startUpstream()
  t.after(() => upstream.close())

  await withEnv(
    { ROOST_DSH_PUBLIC_ORIGIN: undefined, ROOST_DSH_PROXY_PUBLIC_PORT: '8443' },
    async () => {
      const harness = await startSqliteHarness({ dshWebPort: upstream.port, dshProxyPort: 0 })
      t.after(() => harness.close())
      const config = await rawRequest(harness, 'GET', '/api/config', {
        host: 'roost.example.com',
        'x-forwarded-proto': 'https',
      })
      assert.equal(config.status, 200)
      assert.equal(config.json.dshBase, 'https://roost.example.com:8443')
    },
  )
})

test('GET /api/config：PUBLIC_ORIGIN 优先、非法值回退、https+443 省略端口', async (t) => {
  const upstream = await startUpstream()
  t.after(() => upstream.close())

  await withEnv(
    {
      ROOST_DSH_PUBLIC_ORIGIN: 'https://panel.example.com:9443',
      ROOST_DSH_PROXY_PUBLIC_PORT: '8443',
    },
    async () => {
      const harness = await startSqliteHarness({ dshWebPort: upstream.port, dshProxyPort: 0 })
      t.after(() => harness.close())
      const config = await rawRequest(harness, 'GET', '/api/config', {
        host: 'roost.example.com',
        'x-forwarded-proto': 'https',
      })
      assert.equal(config.json.dshBase, 'https://panel.example.com:9443')
    },
  )

  // 带路径的 PUBLIC_ORIGIN 不是合法 origin，忽略后回退自动推导。
  await withEnv(
    {
      ROOST_DSH_PUBLIC_ORIGIN: 'https://panel.example.com/path',
      ROOST_DSH_PROXY_PUBLIC_PORT: '8443',
    },
    async () => {
      const harness = await startSqliteHarness({ dshWebPort: upstream.port, dshProxyPort: 0 })
      t.after(() => harness.close())
      const config = await rawRequest(harness, 'GET', '/api/config', {
        host: 'roost.example.com',
        'x-forwarded-proto': 'https',
      })
      assert.equal(config.json.dshBase, 'https://roost.example.com:8443')
    },
  )

  await withEnv(
    { ROOST_DSH_PUBLIC_ORIGIN: undefined, ROOST_DSH_PROXY_PUBLIC_PORT: '443' },
    async () => {
      const harness = await startSqliteHarness({ dshWebPort: upstream.port, dshProxyPort: 0 })
      t.after(() => harness.close())
      const config = await rawRequest(harness, 'GET', '/api/config', {
        host: 'roost.example.com',
        'x-forwarded-proto': 'https',
      })
      assert.equal(config.json.dshBase, 'https://roost.example.com')
    },
  )
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
