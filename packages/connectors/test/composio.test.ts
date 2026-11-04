// ComposioGatewayBackend：请求形状、headers、错误映射、key 不外泄、factory 分支。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test from 'node:test'

import {
  CONNECTOR_UPSTREAM,
  ComposioError,
  ComposioGatewayBackend,
  composioOptionsFromEnv,
} from '../src/composio.ts'
import { createGatewayBackend } from '../src/factory.ts'
import { HttpGatewayBackend } from '../src/http.ts'
import { CONNECTOR_NOT_CONFIGURED, StubGatewayBackend } from '../src/stub.ts'
import type { ConnectorCall, ConnectorGrant } from '../src/types.ts'

interface RecordedRequest {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: any
}

interface FakeBackend {
  baseUrl: string
  requests: RecordedRequest[]
  close: () => Promise<void>
}

type Handler = (req: IncomingMessage, body: any, res: ServerResponse) => void

async function startComposio(handler: Handler): Promise<FakeBackend> {
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

const KEY = 'cmp_key_secret_1'

function backendFor(baseUrl: string, timeoutMs?: number): ComposioGatewayBackend {
  return new ComposioGatewayBackend({
    baseUrl,
    apiKey: KEY,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
}

test('listConnections：GET /api/v1/connectedAccounts?user_id&appName，x-api-key 鉴权', async (t) => {
  const server = await startComposio((_req, _body, res) => {
    sendJson(res, 200, {
      items: [
        { id: 'ca_1', appName: 'github', status: 'ACTIVE', accountLabel: 'octocat' },
        { id: 'ca_2', appName: 'gmail', status: 'EXPIRED' },
        { id: 'bad' },
      ],
    })
  })
  t.after(() => server.close())

  const backend = backendFor(server.baseUrl)
  const connections = await backend.listConnections({ workspaceId: 'ws_1', userId: 'u_1', connector: 'github' })

  assert.deepEqual(connections, [
    { id: 'ca_1', connector: 'github', status: 'connected', accountLabel: 'octocat' },
    { id: 'ca_2', connector: 'gmail', status: 'expired' },
  ])
  assert.equal(server.requests.length, 1)
  assert.equal(server.requests[0]!.method, 'GET')
  assert.equal(server.requests[0]!.path, '/api/v1/connectedAccounts?user_id=u_1&appName=github')
  assert.equal(server.requests[0]!.headers['x-api-key'], KEY)
  assert.equal(server.requests[0]!.headers['authorization'], undefined)
})

test('listConnections：兼容数组与 snake_case，未知状态按 revoked', async (t) => {
  const server = await startComposio((_req, _body, res) => {
    sendJson(res, 200, [
      { id: 'ca_3', app_name: 'slack', status: 'active', account_label: 'team' },
      { id: 'ca_4', app_name: 'drive', status: 'FAILED' },
    ])
  })
  t.after(() => server.close())

  const connections = await backendFor(server.baseUrl).listConnections({ workspaceId: 'ws_1', userId: 'u_9' })
  assert.deepEqual(connections, [
    { id: 'ca_3', connector: 'slack', status: 'connected', accountLabel: 'team' },
    { id: 'ca_4', connector: 'drive', status: 'revoked' },
  ])
  assert.equal(server.requests[0]!.path, '/api/v1/connectedAccounts?user_id=u_9')
})

test('authorize（对象形式）：POST /api/v1/connectedAccounts，返回 redirect_url', async (t) => {
  const server = await startComposio((_req, _body, res) => {
    sendJson(res, 201, { id: 'ca_new', redirect_url: 'https://provider.example/oauth?x=1' })
  })
  t.after(() => server.close())

  const result = await backendFor(server.baseUrl).authorize({
    workspaceId: 'ws_1',
    userId: 'u_1',
    connector: 'github',
    redirectUri: 'https://roost.example/api/connectors/callback/github',
  })

  assert.deepEqual(result, { url: 'https://provider.example/oauth?x=1', connectionId: 'ca_new' })
  assert.deepEqual(server.requests[0]!.body, {
    appName: 'github',
    workspaceId: 'ws_1',
    userId: 'u_1',
    redirectUri: 'https://roost.example/api/connectors/callback/github',
  })
  assert.equal(server.requests[0]!.headers['x-api-key'], KEY)
})

test('authorize（旧 slug 形式）：仍发 POST，state 不发给上游', async (t) => {
  const server = await startComposio((_req, _body, res) => {
    sendJson(res, 200, { url: 'https://provider.example/oauth' })
  })
  t.after(() => server.close())

  const result = await backendFor(server.baseUrl).authorize('gmail', { workspaceId: 'ws_1', state: 'st_1' })
  assert.deepEqual(result, { url: 'https://provider.example/oauth' })
  assert.deepEqual(server.requests[0]!.body, { appName: 'gmail', workspaceId: 'ws_1' })
})

test('call：先列连接账号，再 POST /api/v1/tools/execute/{action}', async (t) => {
  const server = await startComposio((req, _body, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, { items: [{ id: 'ca_1', appName: 'github', status: 'ACTIVE' }] })
      return
    }
    sendJson(res, 200, { successful: true, data: { issues: [1, 2] } })
  })
  t.after(() => server.close())

  const result = await backendFor(server.baseUrl).call({
    workspaceId: 'ws_1',
    userId: 'u_1',
    connector: 'github',
    action: 'github_list_issues',
    args: { owner: 'roost' },
  })

  assert.deepEqual(result, {
    ok: true,
    data: { issues: [1, 2] },
    bytes: Buffer.byteLength(JSON.stringify({ issues: [1, 2] })),
  })
  assert.equal(server.requests.length, 2)
  assert.equal(server.requests[1]!.method, 'POST')
  assert.equal(server.requests[1]!.path, '/api/v1/tools/execute/github_list_issues')
  assert.deepEqual(server.requests[1]!.body, {
    connected_account_id: 'ca_1',
    user_id: 'u_1',
    arguments: { owner: 'roost' },
  })
  assert.equal(server.requests[1]!.headers['x-api-key'], KEY)
})

test('call（旧 ConnectorCall 形式）：user 退化为 workspace，idem 透传', async (t) => {
  const server = await startComposio((req, _body, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, { items: [{ id: 'ca_2', appName: 'gmail', status: 'ACTIVE' }] })
      return
    }
    sendJson(res, 200, { ok: true, data: { id: 'msg_1' } })
  })
  t.after(() => server.close())

  const call: ConnectorCall = {
    workspaceId: 'ws_1',
    botId: 'bot_1',
    slug: 'gmail',
    action: 'send_email',
    args: { to: 'a@b.c' },
    idem: 'idem_9',
  }
  const grant: ConnectorGrant = { workspaceId: 'ws_1', botId: 'bot_1', slug: 'gmail', access: 'write' }
  const result = await backendFor(server.baseUrl).call(call, grant)

  assert.equal(result.ok, true)
  assert.equal(server.requests[0]!.path, '/api/v1/connectedAccounts?user_id=ws_1&appName=gmail')
  assert.deepEqual(server.requests[1]!.body, {
    connected_account_id: 'ca_2',
    user_id: 'ws_1',
    arguments: { to: 'a@b.c' },
    idempotency_key: 'idem_9',
  })
})

test('call：grant 与连接器不一致直接 denied，不发请求', async (t) => {
  const server = await startComposio((_req, _body, res) => {
    sendJson(res, 200, { items: [] })
  })
  t.after(() => server.close())

  const result = await backendFor(server.baseUrl).call(
    { workspaceId: 'ws_1', userId: 'u_1', connector: 'github', action: 'x' },
    { workspaceId: 'ws_1', botId: 'b', slug: 'gmail', access: 'read' },
  )
  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.code : '', 'denied')
  assert.match(result.ok === false ? result.reason ?? '' : '', /connector\.denied/)
  assert.equal(server.requests.length, 0)
})

test('call：没有连接账号 → needs_reauth；过期 → needs_reauth', async (t) => {
  const server = await startComposio((_req, _body, res) => {
    sendJson(res, 200, { items: [] })
  })
  t.after(() => server.close())

  const backend = backendFor(server.baseUrl)
  const missing = await backend.call({
    workspaceId: 'ws_1',
    userId: 'u_1',
    connector: 'github',
    action: 'list',
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.ok === false ? missing.code : '', 'needs_reauth')
  assert.match(missing.ok === false ? missing.reason ?? '' : '', /connector\.not_connected/)
  assert.equal(server.requests.length, 1)

  const expiredServer = await startComposio((_req, _body, res) => {
    sendJson(res, 200, { items: [{ id: 'ca_1', appName: 'github', status: 'EXPIRED' }] })
  })
  t.after(() => expiredServer.close())
  const expired = await backendFor(expiredServer.baseUrl).call({
    workspaceId: 'ws_1',
    userId: 'u_1',
    connector: 'github',
    action: 'list',
  })
  assert.equal(expired.ok === false ? expired.code : '', 'needs_reauth')
  assert.match(expired.ok === false ? expired.reason ?? '' : '', /connector\.needs_reauth/)
})

test('call：上游 500 → unavailable + connector.upstream', async (t) => {
  const server = await startComposio((_req, _body, res) => {
    sendJson(res, 500, { message: 'boom' })
  })
  t.after(() => server.close())

  const result = await backendFor(server.baseUrl).call({
    workspaceId: 'ws_1',
    userId: 'u_1',
    connector: 'github',
    action: 'list',
  })
  assert.deepEqual(result.ok, false)
  if (result.ok === false) {
    assert.equal(result.code, 'unavailable')
    assert.match(result.reason ?? '', /connector\.upstream/)
    assert.match(result.reason ?? '', /HTTP 500/)
  }
})

test('call：401 正文回显 key 时错误信息抹掉 key 并截断', async (t) => {
  const server = await startComposio((_req, _body, res) => {
    sendJson(res, 401, { message: `invalid api key ${KEY}` })
  })
  t.after(() => server.close())

  const error = await backendFor(server.baseUrl)
    .authorize({ workspaceId: 'w', userId: 'u', connector: 'github', redirectUri: 'https://r' })
    .then(
      () => null,
      (err: unknown) => err,
    )
  assert.ok(error instanceof ComposioError)
  assert.equal((error as ComposioError).code, CONNECTOR_UPSTREAM)
  const message = (error as Error).message
  assert.equal(message.includes(KEY), false)
  assert.match(message, /\[redacted\]/)

  const result = await backendFor(server.baseUrl).call({
    workspaceId: 'w',
    userId: 'u',
    connector: 'github',
    action: 'list',
  })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.reason?.includes(KEY) : true, false)
})

test('call：连接被拒（ECONNREFUSED）→ unavailable + connector.upstream', async (t) => {
  const probe = await startComposio((_req, _body, res) => sendJson(res, 200, {}))
  const baseUrl = probe.baseUrl
  await probe.close()

  const result = await backendFor(baseUrl, 500).call({
    workspaceId: 'ws_1',
    userId: 'u_1',
    connector: 'github',
    action: 'list',
  })
  assert.equal(result.ok, false)
  if (result.ok === false) {
    assert.equal(result.code, 'unavailable')
    assert.match(result.reason ?? '', /connector\.upstream/)
  }
})

test('call：超时 → unavailable，reason 带 timeout', async (t) => {
  const server = await startComposio(() => {
    // 故意不结束响应。
  })
  t.after(() => server.close())

  const started = Date.now()
  const result = await backendFor(server.baseUrl, 40).call({
    workspaceId: 'ws_1',
    userId: 'u_1',
    connector: 'github',
    action: 'list',
  })
  assert.equal(result.ok, false)
  if (result.ok === false) {
    assert.equal(result.code, 'unavailable')
    assert.match(result.reason ?? '', /timed out after 40ms/)
  }
  assert.ok(Date.now() - started < 2000)
})

test('未配置：listConnections/authorize 抛 connector.not_configured，call 返回 unavailable', async () => {
  const backend = new ComposioGatewayBackend({ baseUrl: 'https://backend.composio.dev', apiKey: '' })
  assert.equal(backend.configured, false)

  await assert.rejects(
    () => backend.listConnections({ workspaceId: 'w', userId: 'u' }),
    (err: unknown) => {
      assert.ok(err instanceof ComposioError)
      assert.equal((err as ComposioError).code, CONNECTOR_NOT_CONFIGURED)
      assert.match((err as Error).message, /ROOST_COMPOSIO_API_KEY/)
      return true
    },
  )
  await assert.rejects(
    () => backend.authorize({ workspaceId: 'w', userId: 'u', connector: 'github', redirectUri: 'https://r' }),
    (err: unknown) => err instanceof ComposioError && err.code === CONNECTOR_NOT_CONFIGURED,
  )

  const result = await backend.call({
    workspaceId: 'w',
    userId: 'u',
    connector: 'github',
    action: 'list',
  })
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason ?? '' : '', /connector\.not_configured/)
  assert.equal(result.ok === false ? result.reason?.includes(KEY) : true, false)
})

test('composioOptionsFromEnv：trim、超时解析、空值视为未配置', () => {
  assert.deepEqual(
    composioOptionsFromEnv({
      ROOST_COMPOSIO_BASE_URL: ' https://backend.composio.dev/ ',
      ROOST_COMPOSIO_API_KEY: ' cmp_key ',
      ROOST_COMPOSIO_TIMEOUT_MS: '2500',
    }),
    { baseUrl: 'https://backend.composio.dev/', apiKey: 'cmp_key', timeoutMs: 2500 },
  )
  assert.deepEqual(
    composioOptionsFromEnv({ ROOST_COMPOSIO_API_KEY: '   ', ROOST_COMPOSIO_TIMEOUT_MS: '-5' }),
    { baseUrl: '', apiKey: '' },
  )
})

test('status：按连接账号状态映射；没有 userId 时 revoked', async (t) => {
  const server = await startComposio((_req, _body, res) => {
    sendJson(res, 200, {
      items: [
        { id: 'ca_1', appName: 'github', status: 'ACTIVE' },
        { id: 'ca_2', appName: 'gmail', status: 'EXPIRED' },
      ],
    })
  })
  t.after(() => server.close())

  const backend = backendFor(server.baseUrl)
  assert.equal(await backend.status('github', { workspaceId: 'ws_1', userId: 'u_1' }), 'connected')
  assert.equal(await backend.status('gmail', { workspaceId: 'ws_1', userId: 'u_1' }), 'expired')
  assert.equal(await backend.status('drive', { workspaceId: 'ws_1', userId: 'u_1' }), 'revoked')
  assert.equal(await backend.status('github', { workspaceId: 'ws_1' }), 'revoked')
  assert.equal(server.requests.length, 3)
})

test('getConnection：GET /api/v1/connectedAccounts/{id}，404 返回 null', async (t) => {
  const server = await startComposio((req, _body, res) => {
    if (req.url === '/api/v1/connectedAccounts/ca_1') {
      sendJson(res, 200, { id: 'ca_1', appName: 'github', status: 'ACTIVE', accountLabel: 'octocat' })
      return
    }
    sendJson(res, 404, { message: 'not found' })
  })
  t.after(() => server.close())

  const backend = backendFor(server.baseUrl)
  assert.deepEqual(await backend.getConnection('ca_1'), {
    id: 'ca_1',
    connector: 'github',
    status: 'connected',
    accountLabel: 'octocat',
  })
  assert.equal(await backend.getConnection('missing'), null)
  assert.equal(server.requests[0]!.headers['x-api-key'], KEY)
})

test('getConnection：上游 500 → connector.upstream', async (t) => {
  const server = await startComposio((_req, _body, res) => {
    sendJson(res, 500, { message: 'boom' })
  })
  t.after(() => server.close())

  await assert.rejects(
    () => backendFor(server.baseUrl).getConnection('ca_1'),
    (err: unknown) => err instanceof ComposioError && err.code === CONNECTOR_UPSTREAM,
  )
})

test('factory：composio env 齐全 → ComposioGatewayBackend，日志不含 key', () => {
  const logs: string[] = []
  const backend = createGatewayBackend(
    {
      ROOST_CONNECTOR_BACKEND: 'composio',
      ROOST_COMPOSIO_BASE_URL: 'http://127.0.0.1:8099',
      ROOST_COMPOSIO_API_KEY: 'cmp_factory_key',
      ROOST_COMPOSIO_TIMEOUT_MS: '1000',
    },
    { log: (message) => logs.push(message) },
  )
  assert.ok(backend instanceof ComposioGatewayBackend)
  assert.equal(backend.id, 'composio')
  assert.equal(logs.join('\n').includes('cmp_factory_key'), false)
})

test('factory：composio env 不全但仍有 ROOST_CONNECTOR_URL → 保留旧 HTTP 回退', () => {
  const logs: string[] = []
  const backend = createGatewayBackend(
    {
      ROOST_CONNECTOR_BACKEND: 'composio',
      ROOST_CONNECTOR_URL: 'http://127.0.0.1:8090',
      ROOST_COMPOSIO_API_KEY: 'cmp_factory_key',
    },
    { log: (message) => logs.push(message) },
  )
  assert.ok(backend instanceof HttpGatewayBackend)
  assert.equal(backend.id, 'composio')
  assert.match(logs.join('\n'), /composio env incomplete/)
  assert.equal(logs.join('\n').includes('cmp_factory_key'), false)
})

test('factory：composio env 不全且无 URL → stub + 日志，不回显 key', async () => {
  const logs: string[] = []
  const backend = createGatewayBackend(
    {
      ROOST_CONNECTOR_BACKEND: 'composio',
      ROOST_COMPOSIO_API_KEY: 'cmp_factory_key',
    },
    { log: (message) => logs.push(message) },
  )
  assert.ok(backend instanceof StubGatewayBackend)
  assert.match(logs.join('\n'), /ROOST_COMPOSIO_BASE_URL/)
  assert.match(logs.join('\n'), /ROOST_COMPOSIO_API_KEY/)
  assert.equal(logs.join('\n').includes('cmp_factory_key'), false)
  await assert.rejects(() => backend.authorize('github'), new RegExp(CONNECTOR_NOT_CONFIGURED))
})

test('factory：composio base URL 非法 → stub，日志不回显 URL', () => {
  const logs: string[] = []
  const backend = createGatewayBackend(
    {
      ROOST_CONNECTOR_BACKEND: 'composio',
      ROOST_COMPOSIO_BASE_URL: 'ftp://backend.example',
      ROOST_COMPOSIO_API_KEY: 'cmp_factory_key',
    },
    { log: (message) => logs.push(message) },
  )
  assert.ok(backend instanceof StubGatewayBackend)
  assert.match(logs.join('\n'), /invalid ROOST_COMPOSIO_BASE_URL/)
  assert.equal(logs.join('\n').includes('ftp://backend.example'), false)
})

test('factory：openconnector 走通用 HTTP 网关，不受 composio 影响', () => {
  const backend = createGatewayBackend({
    ROOST_CONNECTOR_BACKEND: 'openconnector',
    ROOST_CONNECTOR_URL: 'http://127.0.0.1:8090',
  })
  assert.ok(backend instanceof HttpGatewayBackend)
  assert.equal(backend.id, 'openconnector')
})
