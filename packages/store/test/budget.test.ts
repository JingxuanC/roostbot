// 预算：预留-结算、周期重置、幂等与聚合（docs/design/budget.md §4–§6、§10）。

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BUDGET_ERROR_CODES,
  ensureQuota,
  findExhaustedWorkspaceQuota,
  getQuota,
  isSoftLimitReached,
  listQuotas,
  openStore,
  periodEnd,
  quotaRatio,
  recordUsage,
  reserve,
  setQuotaLimit,
  settle,
  storeErrorTag,
  sumUsage,
} from '../src/index.ts'
import type { Quota, Store } from '../src/index.ts'
import { createWorkspace } from '../src/workspaces.ts'

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
const WS = 'ws_budget'

function withStore(fn: (store: Store) => void): void {
  const store = openStore(':memory:')
  try {
    createWorkspace(store, {
      id: WS,
      tenantId: 'tenant_budget',
      name: '预算工作区',
      profileVersion: 'v1',
      createdAt: NOW,
    })
    fn(store)
  } finally {
    store.close()
  }
}

function dayQuota(store: Store, limitValue: number, metric: 'tokens' | 'runs' = 'tokens'): Quota {
  return ensureQuota(store, {
    scope: 'workspace',
    scopeId: WS,
    period: 'day',
    metric,
    limitValue,
    at: NOW,
  })
}

function eventKinds(store: Store): string[] {
  return store.db
    .prepare("SELECT kind FROM events WHERE domain = 'billing' ORDER BY seq")
    .all()
    .map((row) => (row as { kind: string }).kind)
}

function tagOf(fn: () => unknown): string | null {
  try {
    fn()
  } catch (err) {
    return storeErrorTag(err)
  }
  return null
}

test('reserve：足够则 reserved 增加并写 billing.reserve', () => {
  withStore((store) => {
    const quota = dayQuota(store, 1000)
    const result = reserve(store, {
      scope: 'workspace',
      scopeId: WS,
      period: 'day',
      metric: 'tokens',
      runId: 'run_1',
      workspaceId: WS,
      amount: 300,
      at: NOW,
    })

    assert.equal(result.remaining, 700)
    assert.equal(result.quota.reserved, 300)
    assert.equal(result.quota.usedValue, 0)
    assert.equal(result.reservation.amount, 300)
    assert.equal(result.reservation.quotaId, quota.id)
    assert.equal(getQuota(store, quota.id)!.reserved, 300)
    assert.deepEqual(eventKinds(store), ['billing.reserve'])
  })
})

test('reserve：不足抛 QUOTA_EXHAUSTED，不写预留与事件', () => {
  withStore((store) => {
    const quota = dayQuota(store, 100)
    assert.equal(
      tagOf(() =>
        reserve(store, {
          quotaId: quota.id,
          runId: 'run_big',
          workspaceId: WS,
          amount: 101,
          at: NOW,
        }),
      ),
      BUDGET_ERROR_CODES.quotaExhausted,
    )
    assert.equal(getQuota(store, quota.id)!.reserved, 0)
    const rows = store.db.prepare('SELECT COUNT(*) AS n FROM reservations').get() as { n: number | bigint }
    assert.equal(Number(rows.n), 0)
    assert.deepEqual(eventKinds(store), [])
  })
})

test('reserve：顺序并发下剩余量严格递减，不超卖', () => {
  withStore((store) => {
    const quota = dayQuota(store, 100)
    const first = reserve(store, { quotaId: quota.id, runId: 'run_a', workspaceId: WS, amount: 60, at: NOW })
    assert.equal(first.remaining, 40)

    assert.equal(
      tagOf(() => reserve(store, { quotaId: quota.id, runId: 'run_b', workspaceId: WS, amount: 41, at: NOW })),
      BUDGET_ERROR_CODES.quotaExhausted,
    )
    assert.equal(getQuota(store, quota.id)!.reserved, 60)
  })
})

test('settle：reserved 减、used 加；actual 可大于 amount；重复结算幂等', () => {
  withStore((store) => {
    const quota = dayQuota(store, 1000)
    const reserved = reserve(store, { quotaId: quota.id, runId: 'run_1', workspaceId: WS, amount: 100, at: NOW })

    const settled = settle(store, { reservationId: reserved.reservation.id, actual: 150, at: NOW + 1 })
    assert.equal(settled.quota!.usedValue, 150)
    assert.equal(settled.quota!.reserved, 0)
    assert.equal(settled.remaining, 850)
    assert.equal(settled.reservation.actual, 150)
    assert.equal(settled.reservation.settledAt, NOW + 1)

    // 第二次用不同 actual：原样返回第一次的结算结果，不重复加 used。
    const again = settle(store, { reservationId: reserved.reservation.id, actual: 999, at: NOW + 2 })
    assert.equal(again.reservation.actual, 150)
    assert.equal(again.quota!.usedValue, 150)
    assert.equal(eventKinds(store).filter((kind) => kind === 'billing.settle').length, 1)
  })
})

test('周期重置：UTC 日边界后 used/reserved 清零并推进 resets_at', () => {
  withStore((store) => {
    const quota = dayQuota(store, 100)
    assert.equal(quota.resetsAt, Date.UTC(2026, 10, 5, 0, 0, 0))

    reserve(store, { quotaId: quota.id, runId: 'run_1', workspaceId: WS, amount: 80, at: NOW })
    settle(store, {
      reservationId: reserve(store, { quotaId: quota.id, runId: 'run_2', workspaceId: WS, amount: 20, at: NOW }).reservation.id,
      actual: 20,
      at: NOW,
    })
    // 上面先预留 80（reserved=80），再预留 20（正好用满），再结算 20（used=20, reserved=80）。
    assert.equal(getQuota(store, quota.id)!.usedValue, 20)

    const nextDay = Date.UTC(2026, 10, 5, 0, 0, 0)
    const after = reserve(store, { quotaId: quota.id, runId: 'run_3', workspaceId: WS, amount: 90, at: nextDay })
    assert.equal(after.quota.usedValue, 0)
    assert.equal(after.quota.reserved, 90)
    assert.equal(after.quota.resetsAt, Date.UTC(2026, 10, 6, 0, 0, 0))
  })
})

test('periodEnd：UTC 日 / 月边界', () => {
  assert.equal(periodEnd('day', Date.UTC(2026, 10, 4, 23, 59, 59)), Date.UTC(2026, 10, 5, 0, 0, 0))
  assert.equal(periodEnd('month', Date.UTC(2026, 10, 4, 12, 0, 0)), Date.UTC(2026, 11, 1, 0, 0, 0))
})

test('recordUsage：同 turnId+source 重放去重，只写一条行与事件', () => {
  withStore((store) => {
    const input = {
      workspaceId: WS,
      runId: 'run_1',
      turnId: 'turn_1',
      botId: 'bot_a',
      model: 'model-x',
      inputTokens: 100,
      outputTokens: 40,
      cachedTokens: 10,
      toolCalls: 2,
      costUsd: 0.02,
      source: 'provider_report',
      at: NOW,
    }
    const first = recordUsage(store, input)
    assert.equal(first.deduped, false)
    const second = recordUsage(store, { ...input, at: NOW + 1000 })
    assert.equal(second.deduped, true)
    assert.equal(second.row.id, first.row.id)

    const count = store.db.prepare('SELECT COUNT(*) AS n FROM usage_rows').get() as { n: number | bigint }
    assert.equal(Number(count.n), 1)
    assert.equal(eventKinds(store).filter((kind) => kind === 'billing.usage').length, 1)
  })
})

test('sumUsage：按 bot/model 聚合 [from, to)', () => {
  withStore((store) => {
    recordUsage(store, {
      workspaceId: WS, turnId: 't1', botId: 'bot_a', model: 'm1', inputTokens: 100, outputTokens: 50,
      cachedTokens: 10, toolCalls: 1, costUsd: 0.1, source: 'provider_report', at: NOW,
    })
    recordUsage(store, {
      workspaceId: WS, turnId: 't2', botId: 'bot_a', model: 'm2', inputTokens: 20, outputTokens: 30,
      cachedTokens: 0, toolCalls: 2, costUsd: 0.2, source: 'provider_report', at: NOW + 1,
    })
    recordUsage(store, {
      workspaceId: WS, turnId: 't3', botId: 'bot_b', model: 'm1', inputTokens: 5, outputTokens: 5,
      cachedTokens: 0, toolCalls: 0, costUsd: 0.05, source: 'estimated', at: NOW + 2,
    })
    // 区间外（to 为开区间）。
    recordUsage(store, {
      workspaceId: WS, turnId: 't4', botId: 'bot_c', model: 'm9', inputTokens: 999, source: 'estimated', at: NOW + 5000,
    })

    const summary = sumUsage(store, { workspaceId: WS, from: NOW, to: NOW + 5000 })
    assert.deepEqual(summary.totals, {
      inputTokens: 125,
      outputTokens: 85,
      cachedTokens: 10,
      tokens: 220,
      toolCalls: 3,
      costUsd: 0.35000000000000003,
      rows: 3,
    })
    assert.deepEqual(
      summary.byBot.map((group) => [group.key, group.tokens, group.toolCalls]),
      [['bot_a', 210, 3], ['bot_b', 10, 0]],
    )
    assert.deepEqual(
      summary.byModel.map((group) => [group.key, group.tokens]),
      [['m1', 170], ['m2', 50]],
    )
  })
})

test('80% 软限：warning 不阻断，billing.cap 每周期只写一次', () => {
  withStore((store) => {
    const quota = dayQuota(store, 1000)
    const settleReservation = (amount: number, actual: number, at: number): void => {
      const reserved = reserve(store, { quotaId: quota.id, runId: `run_${at}`, workspaceId: WS, amount, at })
      settle(store, { reservationId: reserved.reservation.id, actual, at })
    }

    settleReservation(400, 400, NOW)
    assert.equal(isSoftLimitReached(getQuota(store, quota.id)!), false)

    settleReservation(500, 400, NOW + 1)
    assert.equal(isSoftLimitReached(getQuota(store, quota.id)!), true)
    assert.equal(quotaRatio(getQuota(store, quota.id)!), 0.8)

    settleReservation(100, 100, NOW + 2)
    assert.equal(eventKinds(store).filter((kind) => kind === 'billing.cap').length, 1)
  })
})

test('setQuotaLimit 只改 limit 并写 billing.quota.changed；ensureQuota 不覆盖', () => {
  withStore((store) => {
    const quota = dayQuota(store, 100)
    const same = ensureQuota(store, {
      scope: 'workspace', scopeId: WS, period: 'day', metric: 'tokens', limitValue: 999, at: NOW,
    })
    assert.equal(same.id, quota.id)
    assert.equal(same.limitValue, 100)

    const updated = setQuotaLimit(store, { id: quota.id, limitValue: 500, by: 'acc_owner', at: NOW + 1 })
    assert.equal(updated.limitValue, 500)
    assert.deepEqual(eventKinds(store), ['billing.quota.changed'])
  })
})

test('listQuotas 与准入判定：workspace + tenant，日 runs/tokens 耗尽才拦', () => {
  withStore((store) => {
    const tokens = dayQuota(store, 100, 'tokens')
    ensureQuota(store, {
      scope: 'workspace', scopeId: WS, period: 'month', metric: 'tokens', limitValue: 1000, at: NOW,
    })
    ensureQuota(store, {
      scope: 'tenant', scopeId: 'tenant_budget', period: 'day', metric: 'tokens', limitValue: 1000, at: NOW,
    })

    assert.equal(listQuotas(store, { workspaceId: WS }).length, 3)
    assert.equal(listQuotas(store, { workspaceId: WS, scope: 'workspace', scopeId: WS }).length, 2)

    reserve(store, { quotaId: tokens.id, runId: 'run_1', workspaceId: WS, amount: 100, at: NOW })
    assert.equal(findExhaustedWorkspaceQuota(store, WS, NOW)!.id, tokens.id)
    // 过了重置点：视作新周期，不拦。
    assert.equal(findExhaustedWorkspaceQuota(store, WS, Date.UTC(2026, 10, 5, 0, 0, 0)), null)
  })
})
