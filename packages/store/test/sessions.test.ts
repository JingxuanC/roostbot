// 会话（auth.md §9）：token 只按 hash 查、活跃时间可更新、有效期只能往后推。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createSession,
  findSessionById,
  findSessionByTokenHash,
  revokeSession,
  touchSession,
} from '../src/index.ts'
import { assertStoreError, withStore } from './helpers.ts'

const BASE = 1_760_000_000_000
const DAY = 86_400_000

function addDevice(store: Parameters<typeof createSession>[0], id = 'dev_1', accountId = 'acc_1') {
  store.db
    .prepare('INSERT INTO devices (id, account_id, label, platform, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, accountId, 'test device', 'web', BASE)
}

function seed(store: Parameters<typeof createSession>[0]) {
  addDevice(store)
  return createSession(store, {
    id: 'ses_1',
    accountId: 'acc_1',
    deviceId: 'dev_1',
    tokenHash: 'a'.repeat(64),
    createdAt: BASE,
    expiresAt: BASE + 30 * DAY,
  })
}

test('创建后能按 hash 找到，且找不到明文 token', async () => {
  await withStore((store) => {
    const session = seed(store)
    assert.equal(session.tokenHash, 'a'.repeat(64))
    assert.equal(session.lastSeenAt, null)

    const found = findSessionByTokenHash(store, 'a'.repeat(64))
    assert.ok(found)
    assert.equal(found.id, 'ses_1')

    // 明文 token 不存在任何列：拿明文查不到。
    assert.equal(findSessionByTokenHash(store, 'plaintext-token'), null)
    assert.equal(findSessionById(store, 'ses_1')?.accountId, 'acc_1')
  })
})

test('token hash 唯一：同一 hash 不能建两个会话', async () => {
  await withStore((store) => {
    seed(store)
    addDevice(store, 'dev_2', 'acc_1')
    assertStoreError(
      () =>
        createSession(store, {
          id: 'ses_2',
          accountId: 'acc_1',
          deviceId: 'dev_2',
          tokenHash: 'a'.repeat(64),
          createdAt: BASE,
          expiresAt: BASE + 30 * DAY,
        }),
      'SESSION_EXISTS',
    )
  })
})

test('有效期必须晚于创建时间', async () => {
  await withStore((store) => {
    addDevice(store)
    assertStoreError(
      () =>
        createSession(store, {
          id: 'ses_3',
          accountId: 'acc_1',
          deviceId: 'dev_1',
          tokenHash: 'b'.repeat(64),
          createdAt: BASE,
          expiresAt: BASE,
        }),
      'INVALID_SESSION',
    )
  })
})

test('touch 记活跃时间，且只能把有效期往后推', async () => {
  await withStore((store) => {
    seed(store)
    const touched = touchSession(store, 'ses_1', { lastSeenAt: BASE + DAY })
    assert.equal(touched.lastSeenAt, BASE + DAY)
    assert.equal(touched.expiresAt, BASE + 30 * DAY)

    // 想把有效期缩短：不允许，保持原值。
    const shortened = touchSession(store, 'ses_1', { lastSeenAt: BASE + 2 * DAY, expiresAt: BASE })
    assert.equal(shortened.expiresAt, BASE + 30 * DAY)

    // 往后延：允许（auth.md §3 的续期）。
    const extended = touchSession(store, 'ses_1', {
      lastSeenAt: BASE + 3 * DAY,
      expiresAt: BASE + 180 * DAY,
    })
    assert.equal(extended.expiresAt, BASE + 180 * DAY)
  })
})

test('touch / revoke 不存在的会话要报错', async () => {
  await withStore((store) => {
    assertStoreError(() => touchSession(store, 'ses_x', { lastSeenAt: BASE }), 'SESSION_NOT_FOUND')
    assertStoreError(() => revokeSession(store, 'ses_x', BASE), 'SESSION_NOT_FOUND')
  })
})

test('设备必须属于该账号', async () => {
  await withStore((store) => {
    addDevice(store, 'dev_9', 'acc_2')
    assertStoreError(
      () =>
        createSession(store, {
          id: 'ses_9',
          accountId: 'acc_1',
          deviceId: 'dev_9',
          tokenHash: 'c'.repeat(64),
          createdAt: BASE,
          expiresAt: BASE + DAY,
        }),
      'DEVICE_ACCOUNT_MISMATCH',
    )
  })
})

test('吊销后仍能按 hash 查到，但带 revokedAt（鉴权层据此拒绝）', async () => {
  await withStore((store) => {
    seed(store)
    const revoked = revokeSession(store, 'ses_1', BASE + DAY)
    assert.equal(revoked.revokedAt, BASE + DAY)
    assert.equal(findSessionByTokenHash(store, 'a'.repeat(64))?.revokedAt, BASE + DAY)
  })
})
