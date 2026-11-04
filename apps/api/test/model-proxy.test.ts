// apps/api/src/model-proxy-routes.ts：workspace 注入与代理委托。
//
// 用真实 node:http 起路由；proxy 既可以是假的（验证委托），也可以是真的
// createModelProxy（验证路由注入的 workspaceId 确实进了记账）。

import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import { createModelProxy, PROXY_WORKSPACE, resolveProxyWorkspace } from '../../../packages/budget/src/proxy.ts'
import type {
  ModelProxyHandler,
  ProxyUsageRecord,
} from '../../../packages/budget/src/proxy.ts'
import { handleModelProxy } from '../src/model-proxy-routes.ts'
import type { ModelProxyRouteContext } from '../src/model-proxy-routes.ts'

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
const KEY = 'sk-route-test-key'

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

interface RouteFixture {
  url: string
  close: () => Promise<void>
}

async function startRoute(ctx: ModelProxyRouteContext): Promise<RouteFixture> {
  const server = http.createServer((req, res) => {
    handleModelProxy(ctx, req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      if (!res.writableEnded) res.end('{"ok":false}')
    })
  })
  const url = await listen(server)
  return { url, close: () => closeServer(server) }
}

interface ApiResult {
  status: number
  text: string
  json: any
}

async function post(url: string, body: unknown): Promise<ApiResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, text, json: text === '' ? null : JSON.parse(text) }
}

test('handleModelProxy：解析到的 workspaceId 挂到 req 上再委托 proxy', async () => {
  let seen: string | null = null
  let calls = 0
  const proxy: ModelProxyHandler = async (req, res) => {
    calls += 1
    seen = resolveProxyWorkspace(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  }
  const route = await startRoute({ proxy, workspaceIdFrom: () => 'ws_route' })
  try {
    const result = await post(route.url, { messages: [] })
    assert.equal(result.status, 200)
    assert.equal(calls, 1)
    assert.equal(seen, 'ws_route')
  } finally {
    await route.close()
  }
})

test('handleModelProxy：缺 workspace 返回 400 workspace_required，不调用 proxy', async () => {
  let calls = 0
  const proxy: ModelProxyHandler = async (_req, res) => {
    calls += 1
    res.end('unexpected')
  }
  const route = await startRoute({ proxy, workspaceIdFrom: () => null })
  try {
    const result = await post(route.url, { messages: [] })
    assert.equal(result.status, 400)
    assert.equal(result.json.error.code, 'workspace_required')
    assert.equal(calls, 0)
  } finally {
    await route.close()
  }
})

test('handleModelProxy：非 POST 直接交给 proxy（统一的 405 出口）', async () => {
  let calls = 0
  let workspaceReads = 0
  const proxyModel: ModelProxyHandler = async (_req, res) => {
    calls += 1
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
    res.end('{"ok":false,"error":{"code":"method_not_allowed","message":"model proxy only accepts POST"}}')
  }
  const route = await startRoute({
    proxy: proxyModel,
    workspaceIdFrom: () => {
      workspaceReads += 1
      return null
    },
  })
  try {
    const response = await fetch(route.url, { method: 'GET' })
    assert.equal(response.status, 405)
    assert.equal(calls, 1)
    assert.equal(workspaceReads, 0)
  } finally {
    await route.close()
  }
})

test('handleModelProxy：workspaceIdFrom 抛错时 500，不调用 proxy', async () => {
  let calls = 0
  const proxy: ModelProxyHandler = async (_req, res) => {
    calls += 1
    res.end('unexpected')
  }
  const route = await startRoute({
    proxy,
    workspaceIdFrom: () => {
      throw new Error('boom')
    },
  })
  try {
    const result = await post(route.url, { messages: [] })
    assert.equal(result.status, 500)
    assert.equal(result.json.error.code, 'internal_error')
    assert.equal(calls, 0)
  } finally {
    await route.close()
  }
})

test('端到端：路由解析的 workspace 进入真实 proxy 的 token 记账', async () => {
  const upstreamRequests: Array<{ url: string; body: string; auth: string | undefined }> = []
  const upstream = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      upstreamRequests.push({
        url: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        auth: req.headers.authorization,
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":5,"completion_tokens":6}}')
    })()
  })
  const upstreamUrl = await listen(upstream)

  const usage: ProxyUsageRecord[] = []
  const proxy = createModelProxy({
    upstreamBase: upstreamUrl,
    key: KEY,
    now: () => NOW,
    recordUsage: (entry) => {
      usage.push(entry)
    },
  })
  // workspace 只来自路由（URL 查询参数），请求里没有 x-workspace-id 头。
  const route = await startRoute({
    proxy,
    workspaceIdFrom: (req) => new URL(req.url ?? '/', 'http://route.local').searchParams.get('workspaceId'),
  })

  try {
    const result = await post(`${route.url}/v1/chat/completions?workspaceId=ws_from_route`, {
      messages: [{ role: 'user', content: 'hello' }],
    })
    assert.equal(result.status, 200)
    assert.equal(upstreamRequests.length, 1)
    assert.equal(upstreamRequests[0]?.url, '/v1/chat/completions')
    assert.equal(upstreamRequests[0]?.auth, `Bearer ${KEY}`)
    assert.deepEqual(usage, [
      {
        workspaceId: 'ws_from_route',
        tokens: 11,
        estimated: false,
        at: NOW,
        idem: usage[0]?.idem,
      },
    ])
    assert.match(usage[0]?.idem ?? '', /^model:ws_from_route:/)
  } finally {
    await route.close()
    await closeServer(upstream)
  }
})

test('PROXY_WORKSPACE 是跨模块共享的 symbol（路由与 proxy 用同一个键）', () => {
  assert.equal(typeof PROXY_WORKSPACE, 'symbol')
  assert.equal(PROXY_WORKSPACE, Symbol.for('roost.modelProxy.workspaceId'))
})
