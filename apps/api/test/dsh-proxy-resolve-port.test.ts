// dsh-proxy-routes：按 workspace 解析面板转发端口（resolvePort）优先，固定 dshWebPort 回退。
//
// server.ts 的接线由 Lead 做，所以这里直接对 handleDshRequest/handleDshStatus 起一个
// 薄 HTTP 壳，用两个假上游证明"请求到底打在哪个端口上"，以及两者都没有时的 503。

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { test } from 'node:test'

import {
  handleDshRequest,
  handleDshStatus,
  resolveDshTargetPort,
} from '../src/dsh-proxy-routes.ts'
import type { DshRouteContext } from '../src/dsh-proxy-routes.ts'
import { hashSessionToken } from '../src/server.ts'
import { startHarness } from './helpers.ts'

interface FakeUpstream {
  port: number
  hits: number
  close: () => Promise<void>
}

async function startUpstream(marker: string): Promise<FakeUpstream> {
  let hits = 0
  const server = http.createServer((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ marker }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    get hits() {
      return hits
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  } as FakeUpstream
}

interface ProxyShell {
  url: string
  close: () => Promise<void>
}

/** 把 handleDshRequest / handleDshStatus 挂到一个真 HTTP 服务器上（模拟 Lead 的 server 接线）。 */
async function startShell(ctx: DshRouteContext): Promise<ProxyShell> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local')
    const statusMatch = /^\/api\/workspaces\/([^/]+)\/dsh\/status$/.exec(url.pathname)
    if (statusMatch !== null) {
      void handleDshStatus(ctx, req, res, decodeURIComponent(statusMatch[1]!))
      return
    }
    void handleDshRequest(ctx, req, res, url).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500)
        res.end('{}')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

async function bootstrap(): Promise<{
  ctxBase: Pick<DshRouteContext, 'store' | 'now' | 'signingSecret'>
  workspaceId: string
  token: string
  close: () => Promise<void>
}> {
  const harness = await startHarness()
  const accountId = 'acc_panel_forward'
  const workspace = await harness.store.createWorkspace({
    accountId,
    name: '面板转发测试',
    now: harness.clock.now(),
  })
  const token = randomBytes(32).toString('hex')
  await harness.store.createSession({
    accountId,
    tokenHash: hashSessionToken(token),
    now: harness.clock.now(),
    expiresAt: harness.clock.now() + 3_600_000,
  })
  return {
    ctxBase: {
      store: harness.store,
      now: harness.clock.now,
      signingSecret: 'test-signing-secret',
    },
    workspaceId: workspace.id,
    token,
    close: harness.close,
  }
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

test('resolvePort 优先：请求打到 workspace 的转发端口，固定端口一次都不碰', async (t) => {
  const base = await bootstrap()
  const fallback = await startUpstream('fallback')
  const resolved = await startUpstream('resolved')
  const shell = await startShell({
    ...base.ctxBase,
    dshWebPort: fallback.port,
    resolvePort: (workspaceId) => (workspaceId === base.workspaceId ? resolved.port : undefined),
  })
  t.after(async () => {
    await shell.close()
    await fallback.close()
    await resolved.close()
    await base.close()
  })

  const response = await fetch(
    `${shell.url}/w/${base.workspaceId}/dsh/panels/main?a=1`,
    { headers: authHeaders(base.token) }
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { marker: 'resolved' })
  assert.equal(resolved.hits, 1)
  assert.equal(fallback.hits, 0)

  // 另一个 workspace 没有解析端口 → 回退固定端口（旧行为）。
  const other = 'ws_someone_else'
  const fallbackResponse = await fetch(`${shell.url}/w/${other}/dsh/`, {
    headers: authHeaders(base.token),
  })
  assert.equal(fallbackResponse.status, 200)
  assert.deepEqual(await fallbackResponse.json(), { marker: 'fallback' })
  assert.equal(fallback.hits, 1)
})

test('resolvePort 返回 undefined → 回退 dshWebPort（保留旧行为）', async (t) => {
  const base = await bootstrap()
  const fallback = await startUpstream('fallback')
  const shell = await startShell({
    ...base.ctxBase,
    dshWebPort: fallback.port,
    resolvePort: () => undefined,
  })
  t.after(async () => {
    await shell.close()
    await fallback.close()
    await base.close()
  })

  const response = await fetch(`${shell.url}/w/${base.workspaceId}/dsh/`, {
    headers: authHeaders(base.token),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { marker: 'fallback' })
})

test('resolvePort 抛错 / 返回非法端口 → 回退固定端口，不让反代 500', async (t) => {
  const base = await bootstrap()
  const fallback = await startUpstream('fallback')
  let mode: 'throw' | 'invalid' = 'throw'
  const shell = await startShell({
    ...base.ctxBase,
    dshWebPort: fallback.port,
    resolvePort: () => {
      if (mode === 'throw') throw new Error('panel map exploded')
      return 0
    },
  })
  t.after(async () => {
    await shell.close()
    await fallback.close()
    await base.close()
  })

  for (const current of ['throw', 'invalid'] as const) {
    mode = current
    const response = await fetch(`${shell.url}/w/${base.workspaceId}/dsh/`, {
      headers: authHeaders(base.token),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { marker: 'fallback' })
  }
  assert.equal(fallback.hits, 2)
})

test('既没有 resolvePort 也没有 dshWebPort → 503 dsh.not_running（不是 502）', async (t) => {
  const base = await bootstrap()
  const shell = await startShell({ ...base.ctxBase })
  t.after(async () => {
    await shell.close()
    await base.close()
  })

  const response = await fetch(`${shell.url}/w/${base.workspaceId}/dsh/`, {
    headers: authHeaders(base.token),
  })
  assert.equal(response.status, 503)
  const body = (await response.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'dsh.not_running')
})

test('上游不可达仍是 502 dsh.unavailable（503 只表示"没端口"）', async (t) => {
  const base = await bootstrap()
  // 拿一个刚释放的端口：几乎肯定没人监听。
  const dead = await startUpstream('dead')
  const port = dead.port
  await dead.close()

  const shell = await startShell({
    ...base.ctxBase,
    dshWebPort: port,
    resolvePort: () => port,
  })
  t.after(async () => {
    await shell.close()
    await base.close()
  })

  const response = await fetch(`${shell.url}/w/${base.workspaceId}/dsh/`, {
    headers: authHeaders(base.token),
  })
  assert.equal(response.status, 502)
  const body = (await response.json()) as { error: { code: string } }
  assert.equal(body.error.code, 'dsh.unavailable')
})

test('status 探活也按 workspace 解析：有转发 → available，true；没有 → false', async (t) => {
  const base = await bootstrap()
  const resolved = await startUpstream('resolved')
  const shell = await startShell({
    ...base.ctxBase,
    resolvePort: (workspaceId) => (workspaceId === base.workspaceId ? resolved.port : undefined),
  })
  const shellWithout = await startShell({ ...base.ctxBase })
  t.after(async () => {
    await shell.close()
    await shellWithout.close()
    await resolved.close()
    await base.close()
  })

  const available = await fetch(`${shell.url}/api/workspaces/${base.workspaceId}/dsh/status`, {
    headers: authHeaders(base.token),
  })
  assert.equal(available.status, 200)
  assert.deepEqual(await available.json(), { available: true, status: 200 })

  const unavailable = await fetch(
    `${shellWithout.url}/api/workspaces/${base.workspaceId}/dsh/status`,
    { headers: authHeaders(base.token) }
  )
  assert.equal(unavailable.status, 200)
  assert.deepEqual(await unavailable.json(), { available: false })
})

test('resolveDshTargetPort 是纯函数：优先 resolvePort、校验非法值', () => {
  const base = { store: {} as never, now: () => 0, signingSecret: 's' }
  assert.equal(
    resolveDshTargetPort({ ...base, dshWebPort: 4099, resolvePort: () => 5100 }, 'ws'),
    5100
  )
  assert.equal(resolveDshTargetPort({ ...base, dshWebPort: 4099 }, 'ws'), 4099)
  assert.equal(resolveDshTargetPort({ ...base }, 'ws'), undefined)
  assert.equal(resolveDshTargetPort({ ...base, dshWebPort: 4099, resolvePort: () => 0 }, 'ws'), 4099)
  assert.equal(resolveDshTargetPort({ ...base, dshWebPort: 0 }, 'ws'), undefined)
})
