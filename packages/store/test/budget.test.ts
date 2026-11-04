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
  StoreError,
  settle,
  storeErrorTag,
  sumUsage,
} from '../src/index.ts'
import type { Quota, Store } from '../src/index.ts'
import { usageDaily } from '../src/budget.ts'
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
      containerSeconds: 0,
      storageBytes: 0,
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

function quotaFor(
  store: Store,
  scope: Quota['scope'],
  scopeId: string,
  limitValue: number,
  metric: 'tokens' | 'runs' = 'tokens',
): Quota {
  return ensureQuota(store, { scope, scopeId, period: 'day', metric, limitValue, at: NOW })
}

test('多层 reserve：workspace + run + turn 同时检查并各自记账', () => {
  withStore((store) => {
    const ws = dayQuota(store, 1000)
    const run = quotaFor(store, 'run', 'run_1', 500)
    const turn = quotaFor(store, 'turn', 'turn_1', 200)

    const result = reserve(store, {
      workspaceId: WS,
      runId: 'run_1',
      turnId: 'turn_1',
      period: 'day',
      metric: 'tokens',
      amount: 150,
      at: NOW,
    })

    assert.deepEqual(result.layers.map((layer) => layer.scope), ['workspace', 'run', 'turn'])
    assert.deepEqual(result.reservations.map((row) => row.quotaId), [ws.id, run.id, turn.id])
    assert.equal(result.reservations.length, 3)
    // 每层都各自 reserved += amount。
    assert.equal(getQuota(store, ws.id)!.reserved, 150)
    assert.equal(getQuota(store, run.id)!.reserved, 150)
    assert.equal(getQuota(store, turn.id)!.reserved, 150)
    // remaining 取最紧的一层：turn = 200 - 150。
    assert.equal(result.remaining, 50)
    assert.deepEqual(result.layers.map((layer) => layer.remaining), [850, 350, 50])
    assert.equal(eventKinds(store).filter((kind) => kind === 'billing.reserve').length, 3)

    // 显式 scope 只命中一层。
    const single = reserve(store, {
      scope: 'run',
      runId: 'run_1',
      workspaceId: WS,
      period: 'day',
      metric: 'tokens',
      amount: 10,
      at: NOW,
    })
    assert.equal(single.layers.length, 1)
    assert.equal(single.layers[0]!.scope, 'run')
    assert.equal(getQuota(store, ws.id)!.reserved, 150)
    assert.equal(getQuota(store, run.id)!.reserved, 160)
  })
})

test('多层 reserve：run/turn 不足 429 语义，错误里带 layer 且全部回滚', () => {
  withStore((store) => {
    const ws = dayQuota(store, 1000)
    const run = quotaFor(store, 'run', 'run_1', 100)
    const turn = quotaFor(store, 'turn', 'turn_1', 300)

    // run 层不足：workspace 也不应被扣。
    const runError = (() => {
      try {
        reserve(store, {
          workspaceId: WS, runId: 'run_1', turnId: 'turn_1', period: 'day', metric: 'tokens', amount: 101, at: NOW,
        })
      } catch (err) {
        return err as Error
      }
      return null
    })()
    assert.ok(runError !== null)
    assert.equal(storeErrorTag(runError), BUDGET_ERROR_CODES.quotaExhausted)
    assert.match(runError!.message, /layer=run/)
    assert.equal(getQuota(store, ws.id)!.reserved, 0)
    assert.equal(getQuota(store, run.id)!.reserved, 0)
    assert.equal(getQuota(store, turn.id)!.reserved, 0)

    // turn 层不足。
    const turnError = (() => {
      try {
        reserve(store, {
          workspaceId: WS, runId: 'run_1', turnId: 'turn_1', period: 'day', metric: 'tokens', amount: 301, at: NOW,
        })
      } catch (err) {
        return err as Error
      }
      return null
    })()
    assert.ok(turnError !== null)
    assert.match(turnError!.message, /layer=run/) // run 层 301 > 100 先失败
    assert.equal(getQuota(store, ws.id)!.reserved, 0)

    // run 够、turn 不够时命中 turn。
    ensureQuota(store, { scope: 'run', scopeId: 'run_2', period: 'day', metric: 'tokens', limitValue: 1000, at: NOW })
    const onlyTurn = (() => {
      try {
        reserve(store, {
          workspaceId: WS, runId: 'run_2', turnId: 'turn_1', period: 'day', metric: 'tokens', amount: 301, at: NOW,
        })
      } catch (err) {
        return err as Error
      }
      return null
    })()
    assert.ok(onlyTurn !== null)
    assert.match(onlyTurn!.message, /layer=turn/)
    assert.equal(getQuota(store, ws.id)!.reserved, 0)
    assert.equal(getQuota(store, turn.id)!.reserved, 0)
  })
})

test('recordUsage/sumUsage：容器秒求和、存储取窗口最大值', () => {
  withStore((store) => {
    recordUsage(store, {
      workspaceId: WS, turnId: 't1', inputTokens: 10, containerSeconds: 12.5, storageBytes: 4096,
      source: 'provider_report', at: NOW,
    })
    recordUsage(store, {
      workspaceId: WS, turnId: 't2', inputTokens: 20, containerSeconds: 7.5, storageBytes: 8192,
      source: 'provider_report', at: NOW + 1,
    })
    recordUsage(store, {
      workspaceId: WS, turnId: 't3', inputTokens: 5, containerSeconds: 1, storageBytes: 2048,
      source: 'estimated', at: NOW + 2,
    })

    const summary = sumUsage(store, { workspaceId: WS, from: NOW, to: NOW + 100 })
    assert.equal(summary.totals.containerSeconds, 21)
    assert.equal(summary.totals.storageBytes, 8192)
    assert.equal(summary.totals.tokens, 35)
  })
})

test('recordUsage：无 turnId 时用调用方 idem 幂等', () => {
  withStore((store) => {
    const input = { workspaceId: WS, source: 'container_seconds', idem: 'meter:abc', containerSeconds: 3, at: NOW }
    const first = recordUsage(store, input)
    assert.equal(first.deduped, false)
    const replay = recordUsage(store, { ...input, at: NOW + 1000, containerSeconds: 999 })
    assert.equal(replay.deduped, true)
    assert.equal(replay.row.containerSeconds, 3)
    assert.equal(
      (store.db.prepare('SELECT COUNT(*) AS n FROM usage_rows').get() as { n: number | bigint }).n as number,
      1,
    )
    // 两者都没有：拒绝。
    assert.throws(
      () => recordUsage(store, { workspaceId: WS, source: 'container_seconds' }),
      (err: unknown) => err instanceof StoreError && err.code === 'INVALID_INPUT',
    )
  })
})

test('usageDaily：按 UTC 日聚合，空日补零，容器秒求和、存储取最大值', () => {
  withStore((store) => {
    const day1 = Date.UTC(2026, 10, 2, 10, 0, 0)
    const day2 = Date.UTC(2026, 10, 3, 10, 0, 0)
    const day3 = Date.UTC(2026, 10, 4, 10, 0, 0)
    recordUsage(store, { workspaceId: WS, turnId: 'd1a', inputTokens: 10, containerSeconds: 1.5, storageBytes: 100, source: 'provider_report', at: day1 })
    recordUsage(store, { workspaceId: WS, turnId: 'd1b', inputTokens: 20, containerSeconds: 2.5, storageBytes: 300, source: 'provider_report', at: day1 + 3600_000 })
    recordUsage(store, { workspaceId: WS, turnId: 'd3', inputTokens: 5, containerSeconds: 4, storageBytes: 50, source: 'provider_report', at: day3 })

    const daily = usageDaily(store, { workspaceId: WS, days: 4, at: day3 })
    assert.deepEqual(daily.map((day) => day.date), ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'])
    assert.deepEqual(daily.map((day) => day.tokens), [0, 30, 0, 5])
    assert.deepEqual(daily.map((day) => day.containerSeconds), [0, 4, 0, 4])
    assert.deepEqual(daily.map((day) => day.storageBytes), [0, 300, 0, 50])
    assert.deepEqual(daily.map((day) => day.rows), [0, 2, 0, 1])
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
