// Shared RuntimeProvider contract. Any provider (Docker, local, K8s, gVisor)
// must pass this shape: ready only after ensure, reuse is explicit, stop clears.
import assert from 'node:assert/strict'
import test from 'node:test'

import { dockerRuntimeProvider } from '../src/runtime-manager-docker.ts'
import type { RuntimeProvider, RuntimeSpec } from '../src/runtime-provider.ts'

async function assertRuntimeProviderContract(provider: RuntimeProvider, spec: RuntimeSpec): Promise<void> {
  const probe = await provider.probe()
  assert.equal(probe.ok, true)
  assert.equal(typeof probe.capabilities.isolation, 'string')

  const first = await provider.ensure(spec)
  assert.equal(first.created, true)
  assert.equal(first.status.phase, 'ready')
  assert.equal(first.handle.workspaceId, spec.workspaceId)

  const live = await provider.status({ workspaceId: spec.workspaceId })
  assert.equal(live?.phase, 'ready')

  const again = await provider.ensure(spec)
  assert.equal(again.created, false)
  assert.equal(again.handle.name, first.handle.name)

  await provider.stop({ workspaceId: spec.workspaceId }, { remove: true })
  assert.equal(await provider.status({ workspaceId: spec.workspaceId }), null)
}

test('Docker provider satisfies the shared RuntimeProvider contract', async () => {
  let running: string | null = null
  let ready = false
  const provider = dockerRuntimeProvider({
    workerUrl: 'http://worker',
    workerToken: 'worker-token',
    cpHost: '127.0.0.1',
    cpPort: 8787,
    runtimeToken: 'fallback',
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname
      if (path === '/healthz') return new Response(JSON.stringify({ ok: true }), { status: 200 })
      if (path === '/v1/ensure') {
        const created = running === null
        running = running ?? 'roost-ws-contract'
        ready = true
        return new Response(JSON.stringify({ ok: true, sandbox: running, phase: 'ready', created }), { status: 200 })
      }
      if (path === '/v1/status') {
        return new Response(JSON.stringify({ ok: true, status: ready && running !== null ? { sandbox: running, phase: 'ready' } : null }), { status: 200 })
      }
      if (path === '/v1/stop') {
        running = null
        ready = false
        return new Response(JSON.stringify({ ok: true, removed: true }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: false, error: 'not found' }), { status: 404 })
    }) as typeof fetch,
  })
  await assertRuntimeProviderContract(provider, { workspaceId: 'ws_contract', env: { A: 'b' } })
})
