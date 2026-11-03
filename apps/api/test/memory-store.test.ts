// StorePort 的内存实现：契约本身要成立（单次使用、碰撞拒绝、锁定与解锁）。
// 这些用例是给 Lead 接真实 store 时的对照表。
import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryStore } from '../src/memory-store.ts'
import { PairingCodeCollisionError } from '../src/port.ts'

const T0 = Date.UTC(2026, 10, 3, 12, 0, 0)
const CLAIM = { maxAttempts: 5, lockMs: 10 * 60 * 1000 }

test('createPairingCode：活着的码不可被覆盖（抛 PairingCodeCollisionError）', async () => {
  const store = createMemoryStore()
  await store.createPairingCode({ code: '123456', accountId: 'acc', now: T0, expiresAt: T0 + 60_000 })

  await assert.rejects(
    store.createPairingCode({ code: '123456', accountId: 'other', now: T0 + 1, expiresAt: T0 + 120_000 }),
    PairingCodeCollisionError
  )
})

test('createPairingCode：已用或已过期的码可以重新分配', async () => {
  const store = createMemoryStore()
  await store.createPairingCode({ code: '111111', accountId: 'acc', now: T0, expiresAt: T0 + 1000 })
  await store.claimPairingCode({ code: '111111', now: T0 + 10, ...CLAIM })

  const reused = await store.createPairingCode({ code: '111111', accountId: 'acc', now: T0 + 20, expiresAt: T0 + 5000 })
  assert.equal(reused.attempts, 0)
  assert.equal(reused.usedAt, undefined)

  const expired = await store.createPairingCode({ code: '222222', accountId: 'acc', now: T0, expiresAt: T0 + 1000 })
  assert.ok(expired.expiresAt > T0)
  const afterExpiry = await store.createPairingCode({ code: '222222', accountId: 'acc', now: T0 + 2000, expiresAt: T0 + 9000 })
  assert.equal(afterExpiry.createdAt, T0 + 2000)
})

test('claimPairingCode：第一次成功，第二次 used', async () => {
  const store = createMemoryStore()
  await store.createPairingCode({ code: '333333', accountId: 'acc', now: T0, expiresAt: T0 + 60_000 })

  const first = await store.claimPairingCode({ code: '333333', now: T0 + 1, ...CLAIM })
  assert.equal(first.ok, true)
  if (first.ok) assert.equal(first.pairing.usedAt, T0 + 1)

  const second = await store.claimPairingCode({ code: '333333', now: T0 + 2, ...CLAIM })
  assert.deepEqual(second, { ok: false, reason: 'used' })
})

test('claimPairingCode：过期 / 不存在', async () => {
  const store = createMemoryStore()
  await store.createPairingCode({ code: '444444', accountId: 'acc', now: T0, expiresAt: T0 + 1000 })

  const expired = await store.claimPairingCode({ code: '444444', now: T0 + 1001, ...CLAIM })
  assert.deepEqual(expired, { ok: false, reason: 'expired' })

  const missing = await store.claimPairingCode({ code: '999999', now: T0, ...CLAIM })
  assert.deepEqual(missing, { ok: false, reason: 'invalid' })
})

test('claimPairingCode：错满 5 次锁定，锁过期后次数清零', async () => {
  const store = createMemoryStore()
  await store.createPairingCode({ code: '555555', accountId: 'acc', now: T0, expiresAt: T0 + 1000 })

  const now = T0 + 2000 // 已过期，但仍记录错误次数
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.deepEqual(await store.claimPairingCode({ code: '555555', now, ...CLAIM }), { ok: false, reason: 'expired' })
  }

  assert.deepEqual(await store.claimPairingCode({ code: '555555', now, ...CLAIM }), { ok: false, reason: 'locked' })
  assert.deepEqual(await store.claimPairingCode({ code: '555555', now: now + 60_000, ...CLAIM }), {
    ok: false,
    reason: 'locked'
  })
  // 锁过期后回到 expired（次数已清零，不会立刻又锁）
  assert.deepEqual(await store.claimPairingCode({ code: '555555', now: now + CLAIM.lockMs + 1, ...CLAIM }), {
    ok: false,
    reason: 'expired'
  })
})

test('createWorkspace / listWorkspaces：创建者是 owner，账号隔离', async () => {
  const store = createMemoryStore()
  const created = await store.createWorkspace({ accountId: 'acc_a', name: 'Nest', now: T0 })
  assert.equal(created.role, 'owner')
  assert.equal(created.tenantId, 'acc_a')
  assert.equal(created.state, 'stopped')
  assert.equal(created.profileVersion, 'dev')

  const mine = await store.listWorkspaces({ accountId: 'acc_a' })
  assert.equal(mine.length, 1)
  assert.equal(mine[0]!.id, created.id)

  const theirs = await store.listWorkspaces({ accountId: 'acc_b' })
  assert.deepEqual(theirs, [])
})

test('listWorkspaces：按 createdAt 升序', async () => {
  const store = createMemoryStore()
  const later = await store.createWorkspace({ accountId: 'acc', name: 'B', now: T0 + 5000 })
  const earlier = await store.createWorkspace({ accountId: 'acc', name: 'A', now: T0 })

  const listed = await store.listWorkspaces({ accountId: 'acc' })
  assert.deepEqual(
    listed.map((workspace) => workspace.id),
    [earlier.id, later.id]
  )
})

test('createSession / findSessionByToken：只按 hash 查，明文字段不存在', async () => {
  const store = createMemoryStore()
  const session = await store.createSession({
    accountId: 'acc',
    tokenHash: 'a'.repeat(64),
    now: T0,
    expiresAt: T0 + 1000,
    workspaceId: 'ws_1',
    platform: 'desktop'
  })

  assert.match(session.id, /^ses_[0-9a-f]{18}$/)
  assert.match(session.deviceId, /^dev_[0-9a-f]{18}$/)

  const found = await store.findSessionByToken('a'.repeat(64))
  assert.ok(found !== null)
  assert.equal(found.deviceId, session.deviceId)
  assert.equal(found.workspaceId, 'ws_1')

  assert.equal(await store.findSessionByToken('b'.repeat(64)), null)
  await assert.rejects(
    store.createSession({ accountId: 'acc', tokenHash: 'a'.repeat(64), now: T0, expiresAt: T0 + 1000 }),
    /already exists/
  )
})
