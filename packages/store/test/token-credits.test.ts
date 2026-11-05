import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore } from '../src/index.ts'
import {
  SIGNUP_CREDIT_TTL_MS,
  SIGNUP_CREDIT_TOKENS,
  consumeTokenCredit,
  getTokenCreditBalance,
  grantTokenCredit
} from '../src/token-credits.ts'

const DAY = 86_400_000
const T0 = 1_800_000_000_000

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-credit-'))
  return { store: openStore(join(dir, 'db.sqlite')), dir }
}

test('注册赠送 100w、90 天有效，重复发放幂等', () => {
  const { store, dir } = setup()
  try {
    const first = grantTokenCredit(store, { accountId: 'acc_1', amount: SIGNUP_CREDIT_TOKENS, at: T0 })
    assert.equal(first.created, true)
    assert.equal(first.grant.remaining, SIGNUP_CREDIT_TOKENS)
    assert.equal(first.grant.expiresAt, T0 + SIGNUP_CREDIT_TTL_MS)
    const again = grantTokenCredit(store, { accountId: 'acc_1', amount: SIGNUP_CREDIT_TOKENS, at: T0 + 1 })
    assert.equal(again.created, false)
    assert.equal(again.grant.id, first.grant.id)
    const balance = getTokenCreditBalance(store, 'acc_1', T0)
    assert.equal(balance.balance, SIGNUP_CREDIT_TOKENS)
    assert.equal(balance.expiresAt, T0 + SIGNUP_CREDIT_TTL_MS)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('过期后不计入余额；消费优先最早过期的 grant', () => {
  const { store, dir } = setup()
  try {
    grantTokenCredit(store, { accountId: 'acc_1', amount: 100, ttlMs: 10 * DAY, idem: 'g1', at: T0 })
    grantTokenCredit(store, { accountId: 'acc_1', amount: 50, ttlMs: 90 * DAY, idem: 'g2', at: T0 })
    assert.equal(getTokenCreditBalance(store, 'acc_1', T0 + 11 * DAY).balance, 50)
    assert.equal(getTokenCreditBalance(store, 'acc_1', T0 + 91 * DAY).balance, 0)

    const result = consumeTokenCredit(store, { accountId: 'acc_1', tokens: 80, at: T0 + DAY })
    assert.equal(result.consumed, 80)
    assert.equal(result.balance, 70)
    // 再消费 80：先扣旧 grant 剩余 20，再扣新 grant 60。
    assert.equal(consumeTokenCredit(store, { accountId: 'acc_1', tokens: 80, at: T0 + 2 * DAY }).balance, 0)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('额度不足只扣可用部分；相同 idem 重放不重复扣', () => {
  const { store, dir } = setup()
  try {
    grantTokenCredit(store, { accountId: 'acc_1', amount: 30, at: T0 })
    const first = consumeTokenCredit(store, { accountId: 'acc_1', tokens: 100, idem: 'usage-1', at: T0 })
    assert.equal(first.consumed, 30)
    assert.equal(first.balance, 0)
    const replay = consumeTokenCredit(store, { accountId: 'acc_1', tokens: 100, idem: 'usage-1', at: T0 + 1 })
    assert.equal(replay.consumed, 30)
    assert.equal(replay.balance, 0)
    assert.equal(consumeTokenCredit(store, { accountId: 'acc_1', tokens: 1, at: T0 + 2 }).consumed, 0)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
