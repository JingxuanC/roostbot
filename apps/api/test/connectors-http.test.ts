// API 层接线验证：server.ts 默认用 createGatewayBackend(process.env)，
// 不在 ServerOptions 注入时也会走真实 HTTP 网关适配器。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test from 'node:test'

import { pairDevice, startSqliteHarness } from './helpers.ts'

interface RecordedRequest {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: any
}

async function startFakeGateway(): Promise<{
  baseUrl: string
  requests: RecordedRequest[]
  close: () => Promise<void>
}> {
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
    const send = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.method === 'GET' && req.url === '/connectors') {
      return send(200, [
        { slug: 'github', title: 'GitHub', actions: ['list_issues'] },
      ])
    }
    if (req.method === 'POST' && req.url === '/authorize') {
      return send(200, { url: 'https://provider.example/oauth' })
    }
    if (req.method === 'GET' && req.url?.startsWith('/status?')) {
      return send(200, { status: 'connected' })
    }
    send(404, { message: 'not found' })
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

test('server 默认按环境变量使用 HTTP 网关（目录/授权/回调）', async (t) => {
  const gateway = await startFakeGateway()
  const previous = {
    backend: process.env['ROOST_CONNECTOR_BACKEND'],
    url: process.env['ROOST_CONNECTOR_URL'],
    token: process.env['ROOST_CONNECTOR_TOKEN'],
  }
  t.after(() => {
    restoreEnv('ROOST_CONNECTOR_BACKEND', previous.backend)
    restoreEnv('ROOST_CONNECTOR_URL', previous.url)
    restoreEnv('ROOST_CONNECTOR_TOKEN', previous.token)
    return gateway.close()
  })

  process.env['ROOST_CONNECTOR_BACKEND'] = 'openconnector'
  process.env['ROOST_CONNECTOR_URL'] = gateway.baseUrl
  process.env['ROOST_CONNECTOR_TOKEN'] = 'tok_api_secret'

  const harness = await startSqliteHarness()
  t.after(() => harness.close())

  const token = await pairDevice(harness)
  const created = await harness.call('POST', '/api/workspaces', {
    token,
    body: { name: 'Connectors' },
  })
  assert.equal(created.status, 201)
  const workspaceId = created.json.workspace.id as string
  const harnessAccountId = created.json.workspace.ownerId ?? created.json.workspace.createdBy ?? created.json.workspace.accountId

  const listed = await harness.call('GET', `/api/connectors?workspaceId=${workspaceId}`, { token })
  assert.equal(listed.status, 200)
  assert.deepEqual(
    listed.json.connectors.map((connector: any) => connector.slug),
    ['github'],
  )
  assert.equal(listed.json.connectors[0].backend, 'openconnector')
  assert.equal(JSON.stringify(listed.json).includes('tok_api_secret'), false)

  const connected = await harness.call('POST', '/api/connectors/github/connect', {
    token,
    body: { workspaceId },
  })
  assert.equal(connected.status, 201)
  assert.equal(connected.json.url, 'https://provider.example/oauth')

  const callback = await harness.call(
    'GET',
    `/api/connectors/callback/github?state=${connected.json.state}&status=connected`,
    { token },
  )
  assert.equal(callback.status, 200)
  assert.equal(callback.json.connected, true)

  const gatewayCalls = gateway.requests.map((request) => `${request.method} ${request.path}`)
  assert.ok(gatewayCalls.includes('GET /connectors'))
  assert.ok(gatewayCalls.includes('POST /authorize'))
  assert.ok(gatewayCalls.some((call) => call.startsWith('GET /status?')))
  const authorize = gateway.requests.find((request) => request.path === '/authorize')
  assert.equal(authorize?.body.slug, 'github')
  assert.equal(typeof authorize?.body.accountId, 'string')
  assert.ok(authorize?.body.accountId.length > 0)
  assert.match(String(authorize?.body.connectionName), /^roost_[a-f0-9]{24}$/)
  const statusCall = gateway.requests.find((request) => request.path.startsWith('/status?'))
  assert.ok(statusCall)
  assert.equal(statusCall.headers['authorization'], 'Bearer tok_api_secret')
  assert.match(statusCall.path, /connectionName=roost_/)
  assert.match(statusCall.path, /accountId=/)
  // HTTP 适配器只在配置了 token 时发 Bearer；所有网关请求都应带上。
  for (const request of gateway.requests) {
    assert.equal(request.headers['authorization'], 'Bearer tok_api_secret')
  }
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}
