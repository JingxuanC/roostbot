// 启动链路集成：openShellRuntimeManager.ensure 必须先拉到锁才创建沙箱（TODO 4.3.4）。
// 用真实 HTTP 控制面（startServer）+ 假 ensureSandbox，验证顺序与失败语义。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ProfileLock } from '../../../packages/plugins/src/profile-lock.ts'
import { createMemoryStore } from '../src/memory-store.ts'
import { openShellRuntimeManager } from '../src/runtime-manager-openshell.ts'
import { startServer } from '../src/server.ts'

const RUNTIME_TOKEN = 'rt_test_0123456789abcdef'

async function withControlPlane(fn: (base: string, port: number) => Promise<void>, runtimeToken: string | undefined = RUNTIME_TOKEN): Promise<void> {
  const { url, close, server } = await startServer({
    store: createMemoryStore(),
    port: 0,
    host: '127.0.0.1',
    runtimeToken
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    await fn(url, port)
  } finally {
    await close()
  }
}

function config(port: number, events: string[]) {
  return {
    image: 'roost/agent:dev',
    cpHost: '127.0.0.1',
    cpPort: port,
    runtimeToken: RUNTIME_TOKEN,
    ensureSandbox: async (workspaceId: string, lockId: string) => {
      events.push(`ensure:${workspaceId}:${lockId}`)
      return { sandbox: `user-${workspaceId.slice(-8)}`, phase: 'ready' as const }
    },
    fetchImpl: (async (...args: Parameters<typeof fetch>) => {
      events.push('fetch-lock')
      return fetch(...args)
    }) as typeof fetch
  }
}

test('ensure 先拉锁（HTTP 打到 sync 接口）再创建沙箱，锁 id 透传', async () => {
  await withControlPlane(async (base, port) => {
    const events: string[] = []
    const manager = openShellRuntimeManager(config(port, events))
    const result = await manager.ensure('ws_123')
    assert.equal(result.phase, 'ready')
    assert.deepEqual(events.map((e) => e.split(':')[0]), ['fetch-lock', 'ensure'])

    // 透传的锁 id 就是 sync 接口现在服务的那把锁。
    const ensureCall = events.find((e) => e.startsWith('ensure:'))!
    const lockId = ensureCall.split(':')[2]
    const res = await fetch(`${base}/api/internal/plugins/sync`, {
      method: 'POST',
      headers: { 'x-runtime-token': RUNTIME_TOKEN }
    })
    const body = (await res.json()) as { lock: ProfileLock }
    assert.equal(lockId, body.lock.id)
  })
})

test('锁拉不到（sync 接口关闭 = 404）：ensure 失败，不创建沙箱', async () => {
  await withControlPlane(async (_base, port) => {
    const events: string[] = []
    const manager = openShellRuntimeManager(config(port, events))
    await assert.rejects(() => manager.ensure('ws_123'), /profile lock sync failed: .*404/)
    assert.deepEqual(events, ['fetch-lock'])
  }, '')
})

test('锁拉不到（runtime token 不对 = 401）：ensure 失败，不创建沙箱', async () => {
  await withControlPlane(async (_base, port) => {
    const events: string[] = []
    const bad = { ...config(port, events), runtimeToken: 'wrong' }
    const manager = openShellRuntimeManager(bad)
    await assert.rejects(() => manager.ensure('ws_123'), /profile lock sync failed: .*401/)
    assert.deepEqual(events, ['fetch-lock'])
  })
})

test('锁拉不到（控制面不可达）：ensure 失败，不创建沙箱', async () => {
  const events: string[] = []
  const manager = openShellRuntimeManager({
    ...config(1, events), // 端口 1 没人听
    fetchImpl: undefined // 用真实 fetch，证明网络错误也被如实抛出
  })
  await assert.rejects(() => manager.ensure('ws_123'), /profile lock sync failed: .*unreachable/)
  assert.deepEqual(events, [])
})
