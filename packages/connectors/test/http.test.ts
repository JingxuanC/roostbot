// HttpGatewayBackend：假网关（随机端口）验证契约、Bearer、idem、错误映射与超时。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test from 'node:test'

import { HttpGatewayBackend } from '../src/index.ts'
import type { ConnectorCall, ConnectorGrant } from '../src/index.ts'

interface RecordedRequest {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: any
}

interface FakeGateway {
  baseUrl: string
  requests: RecordedRequest[]
  close: () => Promise<void>
}

type Handler = (req: IncomingMessage, body: any, res: ServerResponse) => void

async function startGateway(handler: Handler): Promise<FakeGateway> {
  const requests: RecordedRequest[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body: any
    if (raw !== '') {
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
    }
    requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body })
    handler(req, body, res)
  })
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const CALL: ConnectorCall = {
  workspaceId: 'ws_1',
  botId: 'bot_1',
  slug: 'github',
  action: 'list_issues',
  args: { owner: 'roost' },
  idem: 'idem_1',
}
const GRANT: ConnectorGrant = {
  workspaceId: 'ws_1',
  botId: 'bot_1',
  slug: 'github',
  access: 'read',
}

test('listConnectors：GET /connectors，映射目录并发送 Bearer', async (t) => {
  const gateway = await startGateway((_req, _body, res) => {
    sendJson(res, 200, [
      { slug: 'github', title: 'GitHub', actions: ['list_issues', 'create_pr'] },
      { slug: 'gmail', title: '', actions: ['send_email'] },
      { slug: '', title: 'ignored', actions: [] },
    ])
  })
  t.after(() => gateway.close())

  const backend = new HttpGatewayBackend({
    baseUrl: `${gateway.baseUrl}/`,
    token: 'tok_123',
    backendId: 'openconnector',
  })
  const catalog = await backend.listConnectors()

  assert.deepEqual(catalog, [
    {
      slug: 'github',
      title: 'GitHub',
      backend: 'openconnector',
      actions: [
        { name: 'list_issues', access: 'read' },
        { name: 'create_pr', access: 'read' },
      ],
    },
    {
      slug: 'gmail',
      title: 'gmail',
      backend: 'openconnector',
      actions: [{ name: 'send_email', access: 'read' }],
    },
  ])
  assert.equal(gateway.requests.length, 1)
  assert.equal(gateway.requests[0]!.method, 'GET')
  assert.equal(gateway.requests[0]!.path, '/connectors')
  assert.equal(gateway.requests[0]!.headers['authorization'], 'Bearer tok_123')
})

test('authorize：POST /authorize 透传 slug/workspaceId/state', async (t) => {
  const gateway = await startGateway((_req, _body, res) => {
    sendJson(res, 200, { url: 'https://provider.example/oauth?state=st_1' })
  })
  t.after(() => gateway.close())

  const backend = new HttpGatewayBackend({ baseUrl: gateway.baseUrl, backendId: 'openconnector' })
  const authorized = await backend.authorize('github', { workspaceId: 'ws_1', state: 'st_1' })

  assert.deepEqual(authorized, { url: 'https://provider.example/oauth?state=st_1' })
  assert.deepEqual(gateway.requests[0]!.body, {
    slug: 'github',
    workspaceId: 'ws_1',
    state: 'st_1',
  })
})

test('status：GET /status 带 slug/workspaceId', async (t) => {
  const gateway = await startGateway((_req, _body, res) => {
    sendJson(res, 200, { status: 'connected', accountLabel: 'octocat@example.com' })
  })
  t.after(() => gateway.close())

  const backend = new HttpGatewayBackend({ baseUrl: gateway.baseUrl, backendId: 'composio' })
  const status = await backend.status('github', { workspaceId: 'ws_1' })

  assert.equal(status, 'connected')
  assert.equal(gateway.requests[0]!.method, 'GET')
  assert.equal(gateway.requests[0]!.path, '/status?slug=github&workspaceId=ws_1')
})

test('status：未知状态按协议错误抛出', async (t) => {
  const gateway = await startGateway((_req, _body, res) => {
    sendJson(res, 200, { status: 'half-open' })
  })
  t.after(() => gateway.close())

  const backend = new HttpGatewayBackend({ baseUrl: gateway.baseUrl, backendId: 'openconnector' })
  await assert.rejects(() => backend.status('github'), /unknown status/)
})

test('call：透传 idem/args/workspaceId/botId，成功结果带字节数', async (t) => {
  const result = { items: [{ id: 1 }] }
  const gateway = await startGateway((_req, _body, res) => {
    sendJson(res, 200, { ok: true, result })
  })
  t.after(() => gateway.close())

  const backend = new HttpGatewayBackend({
    baseUrl: gateway.baseUrl,
    token: 'tok_123',
    backendId: 'openconnector',
  })
  const response = await backend.call(CALL, GRANT)

  assert.deepEqual(response, {
    ok: true,
    data: result,
    bytes: Buffer.byteLength(JSON.stringify(result), 'utf8'),
  })
  assert.deepEqual(gateway.requests[0]!.body, {
    slug: 'github',
    action: 'list_issues',
    args: { owner: 'roost' },
    workspaceId: 'ws_1',
    botId: 'bot_1',
    idem: 'idem_1',
  })
  assert.equal(gateway.requests[0]!.headers['authorization'], 'Bearer tok_123')
})

test('call：契约失败体映射为 CallResult，未知 code 回退 provider_error', async (t) => {
  const gateway = await startGateway((_req, body, res) => {
    if (body.action === 'list_issues') {
      return sendJson(res, 200, { ok: false, code: 'needs_reauth', message: 'token expired' })
    }
    return sendJson(res, 200, { ok: false, code: 'exploded', message: 'bad' })
  })
  t.after(() => gateway.close())

  const backend = new HttpGatewayBackend({ baseUrl: gateway.baseUrl, backendId: 'openconnector' })
  const reauth = await backend.call(CALL, GRANT)
  assert.deepEqual(reauth, { ok: false, code: 'needs_reauth', reason: 'token expired' })

  const unknown = await backend.call({ ...CALL, action: 'create_pr' }, GRANT)
  assert.deepEqual(unknown, { ok: false, code: 'provider_error', reason: 'bad' })
})

test('call：5xx 映射 unavailable，错误信息截断且不含 token', async (t) => {
  const token = 'tok_super_secret'
  const gateway = await startGateway((_req, _body, res) => {
    sendJson(res, 503, { message: `upstream down for ${token} ${'x'.repeat(500)}` })
  })
  t.after(() => gateway.close())

  const backend = new HttpGatewayBackend({ baseUrl: gateway.baseUrl, token, backendId: 'openconnector' })
  const response = await backend.call(CALL, GRANT)

  assert.equal(response.ok, false)
  if (response.ok) return
  assert.equal(response.code, 'unavailable')
  assert.match(response.reason ?? '', /HTTP 503/)
  assert.equal((response.reason ?? '').includes(token), false)
  assert.ok((response.reason ?? '').length <= 201)
})

test('listConnectors：5xx 抛错，且不把 token 写进错误字符串', async (t) => {
  const token = 'tok_super_secret'
  const gateway = await startGateway((_req, _body, res) => {
    sendJson(res, 500, { message: `bad token ${token}` })
  })
  t.after(() => gateway.close())

  const backend = new HttpGatewayBackend({ baseUrl: gateway.baseUrl, token, backendId: 'openconnector' })
  await assert.rejects(
    () => backend.listConnectors(),
    (err: Error) => {
      assert.match(err.message, /HTTP 500/)
      assert.equal(err.message.includes(token), false)
      return true
    },
  )
})

test('超时：短 timeout 返回 unavailable，不挂起', async (t) => {
  const gateway = await startGateway(() => {
    // 故意不响应。
  })
  t.after(() => gateway.close())

  const backend = new HttpGatewayBackend({
    baseUrl: gateway.baseUrl,
    backendId: 'openconnector',
    timeoutMs: 50,
  })
  const startedAt = Date.now()
  const response = await backend.call(CALL, GRANT)
  const elapsed = Date.now() - startedAt

  assert.equal(response.ok, false)
  if (response.ok) return
  assert.equal(response.code, 'unavailable')
  assert.match(response.reason ?? '', /timed out/)
  assert.ok(elapsed < 2_000, `expected timeout quickly, took ${elapsed}ms`)
})

test('baseUrl 只接受 http/https，拒绝凭据与 query/hash', () => {
  const make = (baseUrl: string) =>
    new HttpGatewayBackend({ baseUrl, backendId: 'openconnector' })

  assert.throws(() => make('ftp://gateway.example'), /http\(s\)/)
  assert.throws(() => make('not-a-url'), /http\(s\)/)
  assert.throws(() => make('http://user:pass@gateway.example'), /credentials/)
  assert.throws(() => make('http://gateway.example?x=1'), /query or hash/)
  assert.equal(make('http://gateway.example///').id, 'openconnector')
})
