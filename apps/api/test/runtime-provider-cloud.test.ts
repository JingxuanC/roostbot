import assert from 'node:assert/strict'
import test from 'node:test'

import { daytonaRuntimeProvider } from '../src/runtime-provider-daytona.ts'
import { kubernetesRuntimeProvider } from '../src/runtime-provider-kubernetes.ts'

async function assertContract(provider, spec): Promise<void> {
  const probe = await provider.probe()
  assert.equal(probe.ok, true, JSON.stringify(probe.problems))
  const first = await provider.ensure(spec)
  assert.equal(first.created, true)
  assert.equal(first.status.phase, 'ready')
  const again = await provider.ensure(spec)
  assert.equal(again.created, false)
  assert.equal(again.handle.name, first.handle.name)
  assert.equal((await provider.status({ workspaceId: spec.workspaceId }))?.phase, 'ready')
  await provider.stop({ workspaceId: spec.workspaceId }, { remove: true })
  assert.equal(await provider.status({ workspaceId: spec.workspaceId }), null)
}

test('Daytona provider creates a sandbox with a persistent volume and reuses it', async () => {
  const sandboxes = new Map<string, { name: string; state: string }>()
  let volumeId = ''
  const requests: Array<{ method: string; path: string; body?: any }> = []
  const provider = daytonaRuntimeProvider({
    apiKey: 'daytona-test-key',
    apiUrl: 'https://daytona.test/api',
    snapshot: 'roost-snapshot',
    volumeName: 'roost-workspaces',
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const parsed = new URL(String(url))
      const path = parsed.pathname.replace('/api', '')
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      requests.push({ method, path, body })
      if (path === '/sandbox' && method === 'GET') return new Response('[]', { status: 200 })
      if (path === '/volumes/by-name/roost-workspaces' && method === 'GET') {
        return volumeId === ''
          ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
          : new Response(JSON.stringify({ id: volumeId, name: 'roost-workspaces', state: 'ready' }), { status: 200 })
      }
      if (path === '/volumes' && method === 'POST') {
        volumeId = 'vol-1'
        return new Response(JSON.stringify({ id: volumeId, name: body.name, state: 'ready' }), { status: 200 })
      }
      if (path.startsWith('/sandbox/') && method === 'GET') {
        const name = decodeURIComponent(path.slice('/sandbox/'.length))
        const sandbox = sandboxes.get(name)
        return sandbox === undefined
          ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
          : new Response(JSON.stringify(sandbox), { status: 200 })
      }
      if (path === '/sandbox' && method === 'POST') {
        const sandbox = { name: body.name, state: 'started' }
        sandboxes.set(body.name, sandbox)
        return new Response(JSON.stringify(sandbox), { status: 200 })
      }
      if (path.endsWith('/stop') && method === 'POST') {
        const name = decodeURIComponent(path.slice('/sandbox/'.length, -'/stop'.length))
        const sandbox = sandboxes.get(name)
        if (sandbox !== undefined) sandbox.state = 'stopped'
        return new Response(JSON.stringify(sandbox ?? {}), { status: 200 })
      }
      if (path.startsWith('/sandbox/') && method === 'DELETE') {
        sandboxes.delete(decodeURIComponent(path.slice('/sandbox/'.length)))
        return new Response('{}', { status: 200 })
      }
      return new Response(JSON.stringify({ error: `unhandled ${method} ${path}` }), { status: 500 })
    }) as typeof fetch,
  })
  await assertContract(provider, {
    workspaceId: 'ws_daytona',
    image: 'roost-snapshot',
    env: { ROOST_WORKSPACE_ID: 'ws_daytona' },
    resources: { cpus: 2, memoryMb: 2048 },
  })
  const create = requests.find((request) => request.method === 'POST' && request.path === '/sandbox')
  assert.equal(create?.body.snapshot, 'roost-snapshot')
  assert.deepEqual(create?.body.volumes, [{ volumeId: 'vol-1', mountPath: '/workspace', subpath: 'ws_daytona' }])
  assert.equal(create?.body.autoStopInterval, 0)
})

test('Kubernetes provider creates a PVC + long-lived Pod with the ready marker probe', async () => {
  const pods = new Map<string, any>()
  const pvcs = new Map<string, any>()
  const requests: Array<{ method: string; path: string; body?: any }> = []
  const provider = kubernetesRuntimeProvider({
    apiUrl: 'https://k8s.test',
    token: 'k8s-test-token',
    namespace: 'roost',
    image: 'roost/agent:multi-runtime',
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const path = new URL(String(url)).pathname
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      requests.push({ method, path, body })
      if (path === '/api/v1/namespaces/roost' && method === 'GET') return new Response('{}', { status: 200 })
      if (path === '/api/v1/namespaces/roost/persistentvolumeclaims' && method === 'POST') {
        pvcs.set(body.metadata.name, body)
        return new Response(JSON.stringify(body), { status: 201 })
      }
      if (path.startsWith('/api/v1/namespaces/roost/persistentvolumeclaims/') && method === 'GET') {
        const name = decodeURIComponent(path.split('/').pop() ?? '')
        return pvcs.has(name)
          ? new Response(JSON.stringify(pvcs.get(name)), { status: 200 })
          : new Response(JSON.stringify({ message: 'not found' }), { status: 404 })
      }
      if (path === '/api/v1/namespaces/roost/pods' && method === 'POST') {
        const pod = { ...body, status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } }
        pods.set(body.metadata.name, pod)
        return new Response(JSON.stringify(pod), { status: 201 })
      }
      if (path.startsWith('/api/v1/namespaces/roost/pods/') && path.endsWith('/log')) {
        return new Response('room-agent ready\n', { status: 200 })
      }
      if (path.startsWith('/api/v1/namespaces/roost/pods/') && method === 'GET') {
        const name = decodeURIComponent(path.split('/').slice(-1)[0] ?? '')
        return pods.has(name)
          ? new Response(JSON.stringify(pods.get(name)), { status: 200 })
          : new Response(JSON.stringify({ message: 'not found' }), { status: 404 })
      }
      if (path.startsWith('/api/v1/namespaces/roost/pods/') && method === 'DELETE') {
        const name = decodeURIComponent(path.split('/').slice(-1)[0] ?? '')
        pods.delete(name)
        return new Response('{}', { status: 200 })
      }
      return new Response(JSON.stringify({ message: `unhandled ${method} ${path}` }), { status: 500 })
    }) as typeof fetch,
  })
  await assertContract(provider, {
    workspaceId: 'ws_k8s',
    image: 'roost/agent:multi-runtime',
    env: { ROOST_WORKSPACE_ID: 'ws_k8s' },
    resources: { cpus: 2, memoryMb: 2048 },
  })
  const podBody = requests.find((request) => request.method === 'POST' && request.path === '/api/v1/namespaces/roost/pods')?.body
  assert.equal(podBody.spec.containers[0].readinessProbe.exec.command.join(' '), 'test -f /workspace/.roost/ready')
  assert.deepEqual(podBody.spec.volumes, [{ name: 'workspace', persistentVolumeClaim: { claimName: 'roost-ws-' + podBody.metadata.name.slice('roost-ws-'.length) + '-workspace' } }])
  assert.equal(await provider.logs?.({ workspaceId: 'ws_k8s' }), 'room-agent ready\n')
})
