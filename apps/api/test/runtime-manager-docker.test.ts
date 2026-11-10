import assert from 'node:assert/strict'
import test from 'node:test'

import { dockerRuntimeManager, dockerRuntimeProvider } from '../src/runtime-manager-docker.ts'
import type { RuntimeEnsureOutcome, RuntimeProvider, RuntimeProviderStatus, RuntimeSpec } from '../src/runtime-provider.ts'

function fakeProvider(overrides: Partial<RuntimeProvider> = {}): RuntimeProvider & { specs: RuntimeSpec[] } {
  const specs: RuntimeSpec[] = []
  const provider: RuntimeProvider & { specs: RuntimeSpec[] } = {
    specs,
    id: 'docker',
    capabilities: () => ({
      isolation: 'container', persistentWorkspace: true, logs: true, exec: false,
      suspend: false, resume: false, networkPolicy: false, resourceLimits: true, secrets: 'env',
    }),
    async probe() { return { ok: true, problems: [], capabilities: provider.capabilities() } },
    async ensure(spec): Promise<RuntimeEnsureOutcome> {
      specs.push(spec)
      return {
        handle: { provider: 'docker', name: 'roost-ws-test', workspaceId: spec.workspaceId },
        status: { handle: { provider: 'docker', name: 'roost-ws-test', workspaceId: spec.workspaceId }, phase: 'ready' },
        created: true,
      }
    },
    async status(): Promise<RuntimeProviderStatus | null> { return null },
    async stop() {},
    ...overrides,
  }
  return provider
}

test('docker manager issues a runtime token and builds the container spec', async () => {
  const provider = fakeProvider()
  const manager = dockerRuntimeManager({
    workerUrl: 'http://worker',
    workerToken: 'agent-token',
    cpHost: '172.17.43.89',
    cpPort: 8787,
    runtimeToken: 'fallback',
    tokenIssuer: (workspaceId) => ({ id: 'rtk_1', token: 'rt_token', workspaceId, expiresAt: 1 }),
    provider,
  })
  const ensured = await manager.ensure('ws_1')
  assert.deepEqual(ensured, { sandbox: 'roost-ws-test', phase: 'ready', tokenId: 'rtk_1' })
  assert.equal(provider.specs.length, 1)
  const spec = provider.specs[0]!
  assert.equal(spec.workspaceId, 'ws_1')
  assert.equal(spec.network, 'host')
  assert.equal(spec.env?.ROOST_API, 'http://172.17.43.89:8787')
  assert.equal(spec.env?.ROOST_RUNTIME_TOKEN, 'rt_token')
  assert.equal(spec.env?.ROOST_WORKSPACE_ID, 'ws_1')
  assert.equal(spec.env?.ROOST_READY_FILE, '/workspace/.roost/ready')
  assert.equal(spec.env?.ROOST_MULTI_RUNTIME, '1')
  assert.equal(spec.env?.DEEPSEEK_API_KEY, 'rt_token')
})

test('docker manager reuses a ready runtime without issuing a new token', async () => {
  let statusCalls = 0
  const provider = fakeProvider({
    async status(key) {
      statusCalls += 1
      return {
        handle: { provider: 'docker', name: 'roost-ws-existing', workspaceId: key.workspaceId },
        phase: 'ready',
      }
    },
  })
  let issued = 0
  const manager = dockerRuntimeManager({
    workerUrl: 'http://worker', workerToken: 'agent-token',
    cpHost: '127.0.0.1', cpPort: 8787, runtimeToken: 'fallback',
    tokenIssuer: (workspaceId) => { issued += 1; return { id: 'rtk_new', token: 't', workspaceId, expiresAt: 1 } },
    provider,
  })
  assert.deepEqual(await manager.ensure('ws_ready'), { sandbox: 'roost-ws-existing', phase: 'ready' })
  assert.equal(statusCalls, 1)
  assert.equal(issued, 0)
  assert.equal(provider.specs.length, 0)
})

test('docker provider maps worker responses and errors', async () => {
  const calls: string[] = []
  const provider = dockerRuntimeProvider({
    workerUrl: 'http://worker/', workerToken: 'agent-token',
    cpHost: '127.0.0.1', cpPort: 8787, runtimeToken: 'fallback',
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      calls.push(String(url))
      const path = new URL(String(url)).pathname
      if (path === '/v1/ensure') {
        return new Response(JSON.stringify({ ok: true, sandbox: 'roost-ws-x', phase: 'ready', created: true }), { status: 200 })
      }
      if (path === '/v1/status') {
        if (String(url).includes('ws_bad')) return new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 500 })
        return new Response(JSON.stringify({ ok: true, status: { sandbox: 'roost-ws-x', phase: 'ready' } }), { status: 200 })
      }
      if (path === '/v1/logs') return new Response(JSON.stringify({ ok: true, logs: 'hello' }), { status: 200 })
      return new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: 500 })
    }) as typeof fetch,
  })
  const ensured = await provider.ensure({ workspaceId: 'ws_x', env: { A: 'b' } })
  assert.equal(ensured.handle.name, 'roost-ws-x')
  assert.equal(ensured.created, true)
  const status = await provider.status({ workspaceId: 'ws_x' })
  assert.equal(status?.phase, 'ready')
  assert.equal(await provider.logs?.({ workspaceId: 'ws_x' }), 'hello')
  await assert.rejects(
    () => (provider as unknown as { status(k: unknown): Promise<unknown> }).status({ workspaceId: 'ws_bad' }),
    /boom/,
  )
  assert.ok(calls.some((url) => url.endsWith('/v1/ensure')))
})


test('multi-worker pool places workspaces deterministically without one global host', async () => {
  const origins: string[] = []
  const provider = dockerRuntimeProvider({
    workerUrl: 'http://a',
    workerUrls: ['http://a', 'http://b'],
    workerToken: 'worker-token',
    cpHost: '127.0.0.1',
    cpPort: 8787,
    runtimeToken: 'fallback',
    fetchImpl: (async (url: string | URL) => {
      const parsed = new URL(String(url))
      origins.push(parsed.origin)
      if (parsed.pathname === '/v1/ensure') {
        return new Response(JSON.stringify({ ok: true, sandbox: `roost-ws-${parsed.origin.slice(-1)}`, phase: 'ready', created: true }), { status: 200 })
      }
      if (parsed.pathname === '/healthz') return new Response(JSON.stringify({ ok: true }), { status: 200 })
      return new Response(JSON.stringify({ ok: true, status: { sandbox: 'roost-ws', phase: 'ready' } }), { status: 200 })
    }) as typeof fetch,
  })
  for (let i = 0; i < 20; i += 1) {
    await provider.ensure({ workspaceId: `ws_${i}`, env: {} })
  }
  assert.ok(new Set(origins).size >= 2, `expected both workers, got ${[...new Set(origins)].join(',')}`)
  assert.equal((await provider.probe()).ok, true)
})
