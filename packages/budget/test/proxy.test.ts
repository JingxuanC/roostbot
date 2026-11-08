// packages/budget/src/proxy.ts：真实 HTTP 代理 + fake upstream。
//
// 覆盖：转发形状、非流式/流式 usage、字符估算、限流 429、上游错误透传、
// 网络错误 502、workspace 校验、请求体上限、key 不泄露。

import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import { createModelProxy } from '../src/proxy.ts'
import type { ModelProxyHandler, ModelProxyOptions, ProxyUsageRecord } from '../src/proxy.ts'

const KEY = 'sk-test-SECRET-model-key-9f3a'
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)

interface RecordedRequest {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

interface Upstream {
  url: string
  requests: RecordedRequest[]
  close: () => Promise<void>
}

type UpstreamHandler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void

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

async function startUpstream(handler: UpstreamHandler): Promise<Upstream> {
  const requests: RecordedRequest[] = []
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      handler(req, res, body)
    })()
  })
  const url = await listen(server)
  return { url, requests, close: () => closeServer(server) }
}

function jsonHandler(payload: unknown, status = 200, contentType = 'application/json; charset=utf-8'): UpstreamHandler {
  const text = JSON.stringify(payload)
  return (_req, res) => {
    res.writeHead(status, { 'content-type': contentType })
    res.end(text)
  }
}

interface ProxyFixture {
  url: string
  usage: ProxyUsageRecord[]
  close: () => Promise<void>
}

async function startProxy(options: Partial<ModelProxyOptions> & { upstreamBase: string }): Promise<ProxyFixture> {
  const usage: ProxyUsageRecord[] = []
  const proxy = createModelProxy({
    key: KEY,
    now: () => NOW,
    recordUsage: (entry) => {
      usage.push(entry)
    },
    ...options,
  })
  const server = http.createServer((req, res) => {
    proxy(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      if (!res.writableEnded) res.end('{"ok":false}')
    })
  })
  const url = await listen(server)
  return { url, usage, close: () => closeServer(server) }
}

interface ApiResult {
  status: number
  headers: Headers
  text: string
  json: any
}

async function call(
  url: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResult> {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  const contentType = response.headers.get('content-type') ?? ''
  let json: any = null
  if (text !== '' && contentType.includes('application/json')) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return {
    status: response.status,
    headers: response.headers,
    text,
    json,
  }
}

const CHAT_BODY = { model: 'test-model', messages: [{ role: 'user', content: 'hello there' }] }

test('只接受 POST：GET 返回 405 且不访问上游', async () => {
  const upstream = await startUpstream(jsonHandler({ ok: true }))
  const proxy = await startProxy({ upstreamBase: upstream.url })
  try {
    const result = await call(proxy.url, 'GET', undefined, { 'x-roost-workspace-id': 'ws_a' })
    assert.equal(result.status, 405)
    assert.equal(result.json.error.code, 'method_not_allowed')
    assert.equal(result.headers.get('allow'), 'POST')
    assert.equal(upstream.requests.length, 0)
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('转发 POST：固定上游路径、body 与头透传、authorization 换成注入 key', async () => {
  const upstream = await startUpstream(
    jsonHandler({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  )
  const proxy = await startProxy({ upstreamBase: upstream.url })
  try {
    const result = await call(proxy.url, 'POST', CHAT_BODY, {
      'x-roost-workspace-id': 'ws_a',
      authorization: `Bearer ${KEY}`,
      'x-trace-id': 'trace-1',
      'x-runtime-token': 'rt_secret',
    })
    assert.equal(result.status, 200)

    const seen = upstream.requests[0]!
    assert.equal(seen.method, 'POST')
    assert.equal(seen.url, '/v1/chat/completions')
    assert.equal(seen.headers.authorization, `Bearer ${KEY}`)
    assert.equal(seen.headers['x-trace-id'], 'trace-1')
    assert.equal(seen.headers['x-runtime-token'], undefined)
    assert.equal(seen.headers['x-roost-workspace-id'], undefined)
    // zstd/br from Grok Build must never reach the upstream: the proxy cannot
    // relay content-encoding, so it always asks for identity bytes.
    assert.equal(seen.headers['accept-encoding'], 'identity')
    assert.equal(seen.body, JSON.stringify(CHAT_BODY))
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('非流式 usage 记账：prompt + completion，estimated=false，幂等键来自 idempotency-key', async () => {
  const upstream = await startUpstream(
    jsonHandler({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
  )
  const proxy = await startProxy({ upstreamBase: upstream.url })
  try {
    const result = await call(proxy.url, 'POST', CHAT_BODY, {
      'x-roost-workspace-id': 'ws_a',
      'idempotency-key': 'call-1',
    })
    assert.equal(result.status, 200)
    assert.equal(upstream.requests[0]?.headers['idempotency-key'], 'call-1')
    assert.deepEqual(proxy.usage, [
      {
        workspaceId: 'ws_a',
        tokens: 10,
        estimated: false,
        at: NOW,
        idem: 'model:ws_a:call-1',
      },
    ])
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('非流式无 usage：按请求/响应字符数估算并标 estimated=true', async () => {
  const upstream = await startUpstream(jsonHandler({ choices: [{ message: { content: 'abcdefgh' } }] }))
  const proxy = await startProxy({ upstreamBase: upstream.url })
  try {
    const result = await call(
      proxy.url,
      'POST',
      { messages: [{ role: 'user', content: 'abcdefgh' }] },
      { 'x-roost-workspace-id': 'ws_a' },
    )
    assert.equal(result.status, 200)
    assert.equal(proxy.usage.length, 1)
    assert.equal(proxy.usage[0]?.estimated, true)
    assert.equal(proxy.usage[0]?.tokens, 4) // 8 chars + 8 chars → 2 + 2
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('非流式响应正文与 content-type 原样返回', async () => {
  const payload = '{"id":"chatcmpl-1","choices":[{"message":{"content":"你好"}}],"usage":{"prompt_tokens":2,"completion_tokens":4}}'
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-upstream': 'fake' })
    res.end(payload)
  })
  const proxy = await startProxy({ upstreamBase: upstream.url })
  try {
    const result = await call(proxy.url, 'POST', CHAT_BODY, { 'x-roost-workspace-id': 'ws_a' })
    assert.equal(result.status, 200)
    assert.equal(result.text, payload)
    assert.match(result.headers.get('content-type') ?? '', /application\/json/)
    assert.equal(proxy.usage[0]?.tokens, 6)
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('流式：SSE 边转发边解析尾部 usage（含跨 chunk 的 JSON）', async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    res.write('data: {"choices":[{"delta":{"content":"Hel')
    res.write('lo"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n')
    res.write('data: {"usage":{"prompt_tokens":12,"completion_tokens":34},"choices":[]}\n\n')
    res.end('data: [DONE]\n\n')
  })
  const proxy = await startProxy({ upstreamBase: upstream.url })
  try {
    const result = await call(proxy.url, 'POST', CHAT_BODY, {
      'x-roost-workspace-id': 'ws_a',
      'idempotency-key': 'stream-1',
    })
    assert.equal(result.status, 200)
    assert.match(result.headers.get('content-type') ?? '', /text\/event-stream/)
    assert.ok(result.text.includes('"Hello"'))
    assert.ok(result.text.includes('[DONE]'))
    assert.deepEqual(proxy.usage, [
      {
        workspaceId: 'ws_a',
        tokens: 46,
        estimated: false,
        at: NOW,
        idem: 'model:ws_a:stream-1',
      },
    ])
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('流式无 usage：按 delta 字符估算并标 estimated=true', async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"hello world"}}]}\n\n')
    res.end('data: [DONE]\n\n')
  })
  const proxy = await startProxy({ upstreamBase: upstream.url })
  try {
    const result = await call(
      proxy.url,
      'POST',
      { messages: [{ role: 'user', content: 'x' }] },
      { 'x-roost-workspace-id': 'ws_a' },
    )
    assert.equal(result.status, 200)
    assert.ok(result.text.includes('hello world'))
    assert.equal(proxy.usage.length, 1)
    assert.equal(proxy.usage[0]?.estimated, true)
    // "x" → 1 token；"hello world"（11 字符）→ 3 tokens。
    assert.equal(proxy.usage[0]?.tokens, 4)
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('限流：limiter 返回 Retry-After 时 429，且不访问上游、不记账', async () => {
  const upstream = await startUpstream(jsonHandler({ ok: true }))
  const calls: Array<[string, string, number]> = []
  const proxy = await startProxy({
    upstreamBase: upstream.url,
    limiter: {
      consume(kind, workspaceId, now) {
        calls.push([kind, workspaceId, now])
        return 7
      },
    },
  })
  try {
    const result = await call(proxy.url, 'POST', CHAT_BODY, { 'x-roost-workspace-id': 'ws_a' })
    assert.equal(result.status, 429)
    assert.equal(result.json.error.code, 'rate_limited')
    assert.equal(result.headers.get('retry-after'), '7')
    assert.deepEqual(calls, [['modelProxy', 'ws_a', NOW]])
    assert.equal(upstream.requests.length, 0)
    assert.equal(proxy.usage.length, 0)
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('限流放行（null）时继续转发', async () => {
  const upstream = await startUpstream(jsonHandler({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } }))
  const proxy = await startProxy({
    upstreamBase: upstream.url,
    limiter: { consume: () => null },
  })
  try {
    const result = await call(proxy.url, 'POST', CHAT_BODY, { 'x-roost-workspace-id': 'ws_a' })
    assert.equal(result.status, 200)
    assert.equal(upstream.requests.length, 1)
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('上游 4xx/5xx 原样返回状态与 body，不记账', async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json', 'retry-after': '3' })
    res.end('{"error":{"message":"bad request"}}')
  })
  const proxy = await startProxy({ upstreamBase: upstream.url })
  try {
    const result = await call(proxy.url, 'POST', CHAT_BODY, { 'x-roost-workspace-id': 'ws_a' })
    assert.equal(result.status, 400)
    assert.equal(result.text, '{"error":{"message":"bad request"}}')
    assert.equal(result.headers.get('retry-after'), '3')
    assert.equal(proxy.usage.length, 0)
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('上游 5xx 原样返回，不记账', async () => {
  const upstream = await startUpstream(jsonHandler({ error: 'boom' }, 503))
  const proxy = await startProxy({ upstreamBase: upstream.url })
  try {
    const result = await call(proxy.url, 'POST', CHAT_BODY, { 'x-roost-workspace-id': 'ws_a' })
    assert.equal(result.status, 503)
    assert.deepEqual(result.json, { error: 'boom' })
    assert.equal(proxy.usage.length, 0)
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('网络错误：502 upstream_unavailable', async () => {
  const dead = await startUpstream(jsonHandler({ ok: true }))
  const deadUrl = dead.url
  await dead.close()

  const proxy = await startProxy({ upstreamBase: deadUrl })
  try {
    const result = await call(proxy.url, 'POST', CHAT_BODY, { 'x-roost-workspace-id': 'ws_a' })
    assert.equal(result.status, 502)
    assert.equal(result.json.error.code, 'upstream_unavailable')
    assert.equal(proxy.usage.length, 0)
  } finally {
    await proxy.close()
  }
})

test('缺少 workspaceId：400 workspace_required，不访问上游', async () => {
  const upstream = await startUpstream(jsonHandler({ ok: true }))
  const proxy = await startProxy({ upstreamBase: upstream.url })
  try {
    const result = await call(proxy.url, 'POST', CHAT_BODY)
    assert.equal(result.status, 400)
    assert.equal(result.json.error.code, 'workspace_required')
    assert.equal(upstream.requests.length, 0)
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('workspace 解析优先级：options.workspaceIdFrom 高于请求头', async () => {
  const upstream = await startUpstream(jsonHandler({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  const proxy = await startProxy({
    upstreamBase: upstream.url,
    workspaceIdFrom: () => 'ws_option',
  })
  try {
    const result = await call(proxy.url, 'POST', CHAT_BODY, { 'x-roost-workspace-id': 'ws_header' })
    assert.equal(result.status, 200)
    assert.equal(proxy.usage[0]?.workspaceId, 'ws_option')
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('请求体超过上限：413 payload_too_large，不访问上游', async () => {
  const upstream = await startUpstream(jsonHandler({ ok: true }))
  const proxy = await startProxy({ upstreamBase: upstream.url, maxBodyBytes: 16 })
  try {
    const result = await call(proxy.url, 'POST', CHAT_BODY, { 'x-roost-workspace-id': 'ws_a' })
    assert.equal(result.status, 413)
    assert.equal(result.json.error.code, 'payload_too_large')
    assert.equal(upstream.requests.length, 0)
  } finally {
    await proxy.close()
    await upstream.close()
  }
})

test('key 不出现在响应、日志或记账回调里', async () => {
  const logs: string[] = []
  const original = { log: console.log, warn: console.warn, error: console.error }
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '))
  console.warn = (...args: unknown[]) => logs.push(args.map(String).join(' '))
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '))

  const upstream = await startUpstream(jsonHandler({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  let proxy: ProxyFixture | null = null
  try {
    proxy = await startProxy({ upstreamBase: upstream.url })
    const ok = await call(proxy.url, 'POST', CHAT_BODY, { 'x-roost-workspace-id': 'ws_a' })
    assert.equal(ok.status, 200)
    assert.ok(!ok.text.includes(KEY))
    for (const value of ok.headers.values()) assert.ok(!value.includes(KEY))

    const failed = await call(proxy.url, 'POST', CHAT_BODY, {})
    assert.equal(failed.status, 400)
    assert.ok(!failed.text.includes(KEY))

    assert.ok(!JSON.stringify(proxy.usage).includes(KEY))
    assert.deepEqual(
      logs.filter((line) => line.includes(KEY)),
      [],
    )
  } finally {
    if (proxy !== null) await proxy.close()
    await upstream.close()
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
  }
})
