import assert from 'node:assert/strict'
import test from 'node:test'

import {
  claimPairingCode,
  createPairingCode,
  PAIRING_MAX_ATTEMPTS,
} from '../src/index.ts'
import { assertStoreError, withStore } from './helpers.ts'

const MINUTE = 60_000
const BASE = 1_800_000_000_000

function attemptsOf(store: Parameters<typeof claimPairingCode>[0], code: string): number {
  const row = store.db
    .prepare('SELECT attempts FROM pairing_codes WHERE code = ?')
    .get(code) as { attempts: number } | undefined
  assert.ok(row, `pairing code ${code} should exist`)
  return row.attempts
}

test('配对码只能兑换一次', async () => {
  await withStore((store) => {
    const created = createPairingCode(store, {
      accountId: 'ac_1',
      workspaceId: 'ws_1',
      code: '123456',
      expiresAt: BASE + 5 * MINUTE,
      now: BASE,
    })
    assert.deepEqual(created, {
      code: '123456',
      accountId: 'ac_1',
      workspaceId: 'ws_1',
      createdAt: BASE,
      expiresAt: BASE + 5 * MINUTE,
      usedAt: null,
      attempts: 0,
    })

    const claim = claimPairingCode(store, { code: '123456', now: BASE + 1000 })
    assert.deepEqual(claim, {
      code: '123456',
      accountId: 'ac_1',
      workspaceId: 'ws_1',
      createdAt: BASE,
      usedAt: BASE + 1000,
      attempts: 0,  // 成功会清零失败计数
    })

    // 第二次：单次使用，已用即拒。
    assertStoreError(
      () => claimPairingCode(store, { code: '123456', now: BASE + 2000 }),
      'PAIRING_CODE_USED',
    )
    assert.equal(attemptsOf(store, '123456'), 1)  // 已用码再试一次 = 1 次失败
  })
})

test('过期码拒绝兑换，且不置 used_at', async () => {
  await withStore((store) => {
    createPairingCode(store, {
      accountId: 'ac_1',
      code: '111111',
      expiresAt: BASE + 5 * MINUTE,
      now: BASE,
    })

    assertStoreError(
      () => claimPairingCode(store, { code: '111111', now: BASE + 5 * MINUTE }),
      'PAIRING_CODE_EXPIRED',
    )
    assert.equal(attemptsOf(store, '111111'), 1)

    const row = store.db
      .prepare('SELECT used_at FROM pairing_codes WHERE code = ?')
      .get('111111') as { used_at: number | null }
    assert.equal(row.used_at, null)
  })
})

test('未知码报 NOT_FOUND', async () => {
  await withStore((store) => {
    assertStoreError(
      () => claimPairingCode(store, { code: '999999', now: BASE }),
      'PAIRING_CODE_NOT_FOUND',
    )
  })
})

test('尝试次数上限 5：前 5 次按过期拒，第 6 次锁死', async () => {
  await withStore((store) => {
    assert.equal(PAIRING_MAX_ATTEMPTS, 5)

    createPairingCode(store, {
      accountId: 'ac_1',
      code: '222222',
      expiresAt: BASE + 5 * MINUTE,
      now: BASE,
    })

    for (let attempt = 1; attempt <= PAIRING_MAX_ATTEMPTS; attempt += 1) {
      assertStoreError(
        () => claimPairingCode(store, { code: '222222', now: BASE + 6 * MINUTE }),
        'PAIRING_CODE_EXPIRED',
      )
      assert.equal(attemptsOf(store, '222222'), attempt)
    }

    assertStoreError(
      () => claimPairingCode(store, { code: '222222', now: BASE + 6 * MINUTE }),
      'PAIRING_CODE_LOCKED',
    )
    // 锁死不再累加。
    assert.equal(attemptsOf(store, '222222'), PAIRING_MAX_ATTEMPTS)
  })
})

test('仍然有效的码不能被重复签发', async () => {
  await withStore((store) => {
    createPairingCode(store, {
      accountId: 'ac_1',
      code: '333333',
      expiresAt: BASE + 5 * MINUTE,
      now: BASE,
    })
    assertStoreError(
      () =>
        createPairingCode(store, {
          accountId: 'ac_2',
          code: '333333',
          expiresAt: BASE + 10 * MINUTE,
          now: BASE,
        }),
      'PAIRING_CODE_CONFLICT',
    )
  })
})

test('已过期的码可以重新签发（6 位数字空间有限）', async () => {
  await withStore((store) => {
    createPairingCode(store, {
      accountId: 'ac_1',
      code: '444444',
      expiresAt: BASE + 5 * MINUTE,
      now: BASE,
    })

    const reissued = createPairingCode(store, {
      accountId: 'ac_2',
      code: '444444',
      expiresAt: BASE + 20 * MINUTE,
      now: BASE + 10 * MINUTE,
    })
    assert.equal(reissued.accountId, 'ac_2')
    assert.equal(reissued.attempts, 0)
    assert.equal(reissued.createdAt, BASE + 10 * MINUTE)

    const claim = claimPairingCode(store, { code: '444444', now: BASE + 11 * MINUTE })
    assert.equal(claim.accountId, 'ac_2')
  })
})

test('maxAttempts 可由调用方覆盖（apps/api 的 StorePort 会传）', async () => {
  await withStore((store) => {
    createPairingCode(store, {
      accountId: 'ac_1',
      code: '777777',
      expiresAt: BASE + 5 * MINUTE,
      now: BASE,
    })

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      assertStoreError(
        () => claimPairingCode(store, { code: '777777', now: BASE + 6 * MINUTE, maxAttempts: 2 }),
        'PAIRING_CODE_EXPIRED',
      )
    }
    assertStoreError(
      () => claimPairingCode(store, { code: '777777', now: BASE + 6 * MINUTE, maxAttempts: 2 }),
      'PAIRING_CODE_LOCKED',
    )
    assertStoreError(
      () => claimPairingCode(store, { code: '777777', now: BASE + 6 * MINUTE, maxAttempts: 0 }),
      'INVALID_PAIRING_CODE',
    )
  })
})

test('配对码必须是 6 位数字，且 expiresAt 必须在未来', async () => {
  await withStore((store) => {
    assertStoreError(
      () => createPairingCode(store, { accountId: 'ac_1', code: '12345', expiresAt: BASE + MINUTE, now: BASE }),
      'INVALID_PAIRING_CODE',
    )
    assertStoreError(
      () => createPairingCode(store, { accountId: 'ac_1', code: 'ABCDEF', expiresAt: BASE + MINUTE, now: BASE }),
      'INVALID_PAIRING_CODE',
    )
    assertStoreError(
      () => createPairingCode(store, { accountId: 'ac_1', code: '555555', expiresAt: BASE, now: BASE }),
      'INVALID_PAIRING_CODE',
    )
    assertStoreError(
      () => claimPairingCode(store, { code: '55555', now: BASE }),
      'INVALID_PAIRING_CODE',
    )
  })
})

test('workspaceId 可空（auth.md §11 待决：绑账号还是绑 workspace）', async () => {
  await withStore((store) => {
    const created = createPairingCode(store, {
      accountId: 'ac_1',
      code: '666666',
      expiresAt: BASE + 5 * MINUTE,
      now: BASE,
    })
    assert.equal(created.workspaceId, null)

    const claim = claimPairingCode(store, { code: '666666', now: BASE + 1 })
    assert.equal(claim.workspaceId, null)
  })
})
