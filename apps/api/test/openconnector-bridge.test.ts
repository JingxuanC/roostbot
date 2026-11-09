import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const BRIDGE = resolve(ROOT, 'deploy', 'openconnector-bridge.mjs')

interface Seen {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: any
}

async function startFakeOpenConnector(): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body: any
    try { body = raw === '' ? undefined : JSON.parse(raw) } catch { body = raw }
    seen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body })
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.method === 'POST' && req.url === '/v1/connections/github/connect') {
      return send(200, { data: { url: 'https://provider.example/oauth' } })
    }
    if (req.method === 'GET' && req.url === '/v1/connections') {
      return send(200, { data: [{ service: 'github', connectionName: 'roost_abc', status: 'active' }] })
    }
    if (req.method === 'POST' && req.url === '/v1/actions/github.list_issues') {
      return send(200, { data: { ok: true } })
    }
    if (req.method === 'GET' && req.url?.startsWith('/oauth/callback')) {
      res.writeHead(302, { location: 'https://roostbots.com/api/connectors/callback/github?state=s' })
      res.end()
      return
    }
    send(404, { message: 'not found' })
  })
  server.listen(0, '127.0.0.1')
  await new Promise<void>((resolvePromise) => server.once('listening', resolvePromise))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
    },
  }
}

async function startBridge(openConnectorUrl: string): Promise<{ url: string; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      BRIDGE_TOKEN: 'bridge_secret',
      OPENCONNECTOR_BASE: openConnectorUrl,
      OPENCONNECTOR_ADMIN_TOKEN: 'admin_secret',
      OPENCONNECTOR_RUNTIME_TOKEN: 'runtime_secret',
      BRIDGE_PORT: '0',
      ROOST_PUBLIC_BASE: 'https://roostbots.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const port = await new Promise<number>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`bridge did not start: ${output}`)), 10_000)
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
      const match = /listening on :(\d+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolvePromise(Number(match[1]))
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`bridge exited ${code}: ${output}`))
    })
  })
  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      child.kill('SIGTERM')
      await new Promise<void>((resolvePromise) => child.once('close', () => resolvePromise()))
    },
  }
}

test('OpenConnector bridge forwards named connections and proxies OAuth callback', async () => {
  const fake = await startFakeOpenConnector()
  const bridge = await startBridge(fake.url)
  try {
    const authorized = await fetch(`${bridge.url}/authorize`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge_secret', 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'github', workspaceId: 'ws_1', connectionName: 'roost_abc', state: 's1' }),
    })
    assert.equal(authorized.status, 200)
    assert.deepEqual(await authorized.json(), { url: 'https://provider.example/oauth' })
    const connect = fake.seen.find((row) => row.path === '/v1/connections/github/connect')
    assert.equal(connect?.body.connectionName, 'roost_abc')
    assert.match(String(connect?.body.returnUri), /state=s1/)

    const status = await fetch(`${bridge.url}/status?slug=github&connectionName=roost_abc`, {
      headers: { authorization: 'Bearer bridge_secret' },
    })
    assert.deepEqual(await status.json(), { status: 'connected' })

    const called = await fetch(`${bridge.url}/call`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge_secret', 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'github', action: 'list_issues', args: {}, connectionName: 'roost_abc' }),
    })
    assert.deepEqual(await called.json(), { ok: true, result: { ok: true } })
    const action = fake.seen.find((row) => row.path === '/v1/actions/github.list_issues')
    assert.equal(action?.headers['x-oo-connector-alias'], 'roost_abc')

    const callback = await fetch(`${bridge.url}/oauth/callback?code=x&state=s1`, { redirect: 'manual' })
    assert.equal(callback.status, 302)
    assert.equal(callback.headers.get('location'), 'https://roostbots.com/api/connectors/callback/github?state=s')
  } finally {
    await bridge.stop()
    await fake.close()
  }
})
