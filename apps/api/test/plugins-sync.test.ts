// POST /api/internal/plugins/sync：沙箱启动前拉 profile 锁（TODO 4.3.4）。
// 鉴权与锁内容；启动链路的集成在 runtime-manager-openshell.test.ts。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { verifyProfileLock } from '../../../packages/plugins/src/profile-lock.ts'
import type { ProfileLock } from '../../../packages/plugins/src/profile-lock.ts'
import { createMemoryStore } from '../src/memory-store.ts'
import { loadBaselineProfileLock, BASELINE_PROFILE_DIR } from '../src/profile-lock.ts'
import { startServer } from '../src/server.ts'

const RUNTIME_TOKEN = 'rt_test_0123456789abcdef'
const REPO_PROFILE = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../runtime/profile')

async function withApi(fn: (base: string) => Promise<void>, runtimeToken: string | undefined = RUNTIME_TOKEN): Promise<void> {
  const store = createMemoryStore()
  const { url, close } = await startServer({ store, port: 0, host: '127.0.0.1', runtimeToken, streamPollMs: 40 })
  try {
    await fn(url)
  } finally {
    await close()
  }
}

test('基线锁：内容来自 apps/runtime/profile，integrity 稳定', async () => {
  const a = await loadBaselineProfileLock({ now: () => 1 })
  const b = await loadBaselineProfileLock({ now: () => 2 })
  assert.equal(a.source, 'baseline-profile')
  assert.equal(a.packageJson, readFileSync(resolve(REPO_PROFILE, 'package.json'), 'utf8'))
  assert.equal(a.patch, readFileSync(resolve(REPO_PROFILE, 'cordis.patch.yml'), 'utf8'))
  assert.equal(a.lockfile, null)
  // integrity 与 generatedAt 无关
  assert.equal(a.integrity, b.integrity)
  assert.equal(a.id, b.id)
  assert.notEqual(a.generatedAt, b.generatedAt)
  assert.equal(verifyProfileLock(a), true)
  assert.equal(BASELINE_PROFILE_DIR, REPO_PROFILE)
})

test('基线 profile 目录缺失：抛错而不是返回假锁', async () => {
  await assert.rejects(() => loadBaselineProfileLock({ profileDir: '/nonexistent/profile' }), /baseline profile unreadable/)
})

test('没配置 runtime token：sync 接口 404（不暴露存在性）', async () => {
  await withApi(async (base) => {
    const res = await fetch(`${base}/api/internal/plugins/sync`, {
      method: 'POST',
      headers: { 'x-runtime-token': RUNTIME_TOKEN }
    })
    assert.equal(res.status, 404)
  }, '')
})

test('无 token / 错 token 401；GET 404', async () => {
  await withApi(async (base) => {
    const none = await fetch(`${base}/api/internal/plugins/sync`, { method: 'POST' })
    assert.equal(none.status, 401)

    const wrong = await fetch(`${base}/api/internal/plugins/sync`, {
      method: 'POST',
      headers: { 'x-runtime-token': 'nope' }
    })
    assert.equal(wrong.status, 401)

    const get = await fetch(`${base}/api/internal/plugins/sync`, {
      headers: { 'x-runtime-token': RUNTIME_TOKEN }
    })
    assert.equal(get.status, 404)
  })
})

test('对 token 200：返回可通过 integrity 校验的锁文档（两种鉴权头等价）', async () => {
  await withApi(async (base) => {
    const byHeader = await fetch(`${base}/api/internal/plugins/sync`, {
      method: 'POST',
      headers: { 'x-runtime-token': RUNTIME_TOKEN }
    })
    assert.equal(byHeader.status, 200)
    const body = (await byHeader.json()) as { lock: ProfileLock }
    assert.equal(verifyProfileLock(body.lock), true)
    assert.equal(body.lock.source, 'baseline-profile')
    assert.equal(body.lock.packageJson, readFileSync(resolve(REPO_PROFILE, 'package.json'), 'utf8'))

    const byAuth = await fetch(`${base}/api/internal/plugins/sync`, {
      method: 'POST',
      headers: { authorization: `Runtime ${RUNTIME_TOKEN}` }
    })
    assert.equal(byAuth.status, 200)
    const other = (await byAuth.json()) as { lock: ProfileLock }
    assert.equal(other.lock.integrity, body.lock.integrity)
  })
})
