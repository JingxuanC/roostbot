// packages/budget/src/metering.ts 的边界、聚合与幂等键。

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  containerSeconds,
  meterDay,
  meterIdem,
  planMetering,
} from '../src/metering.ts'

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0) // 2026-11-04T12:00:00Z
const DAY = 86_400_000

test('containerSeconds：已停止按 stoppedAt 计，保留小数', () => {
  assert.equal(
    containerSeconds({ startedAt: NOW - 90_000, stoppedAt: NOW, now: NOW + 999_999 }),
    90,
  )
  assert.equal(containerSeconds({ startedAt: NOW - 1_500, stoppedAt: NOW, now: NOW }), 1.5)
})

test('containerSeconds：未停止按 now 截断', () => {
  assert.equal(containerSeconds({ startedAt: NOW - 45_000, now: NOW }), 45)
  assert.equal(containerSeconds({ startedAt: NOW - 500, stoppedAt: null, now: NOW }), 0.5)
})

test('containerSeconds：负数 clamp 0，非有限输入也是 0', () => {
  assert.equal(containerSeconds({ startedAt: NOW + 10_000, stoppedAt: NOW, now: NOW }), 0)
  assert.equal(containerSeconds({ startedAt: NOW, stoppedAt: NOW, now: NOW }), 0)
  assert.equal(containerSeconds({ startedAt: Number.NaN, now: NOW }), 0)
  assert.equal(containerSeconds({ startedAt: NOW, stoppedAt: Number.NaN, now: NOW }), 0)
})

test('planMetering：同一 workspace 同一天的多段运行求和，at 取最晚停止', () => {
  const entries = planMetering({
    runtimes: [
      { workspaceId: 'ws_a', startedAt: NOW - 60_000, stoppedAt: NOW - 50_000 }, // 10s
      { workspaceId: 'ws_a', startedAt: NOW - 40_000, stoppedAt: NOW - 20_000 }, // 20s
    ],
    now: NOW,
  })

  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0], {
    kind: 'container_seconds',
    amount: 30,
    workspaceId: 'ws_a',
    idem: 'meter:ws_a:2026-11-04:container_seconds',
    at: NOW - 20_000,
  })
})

test('planMetering：运行中的容器按 now 计并在同一天聚合', () => {
  const entries = planMetering({
    runtimes: [
      { workspaceId: 'ws_a', startedAt: NOW - 10_000 },
      { workspaceId: 'ws_a', startedAt: NOW - 5_000, stoppedAt: null },
    ],
    now: NOW,
  })

  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.kind, 'container_seconds')
  assert.equal(entries[0]?.amount, 15)
  assert.equal(entries[0]?.at, NOW)
})

test('planMetering：storage_bytes 是 gauge，取最大值并四舍五入取整', () => {
  const entries = planMetering({
    volumes: [
      { workspaceId: 'ws_a', bytes: 1024.4 },
      { workspaceId: 'ws_a', bytes: 2048.6 },
      { workspaceId: 'ws_a', bytes: 512 },
    ],
    now: NOW,
  })

  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.kind, 'storage_bytes')
  assert.equal(entries[0]?.amount, 2049)
  assert.equal(entries[0]?.idem, 'meter:ws_a:2026-11-04:storage_bytes')
})

test('planMetering：跨 UTC 日的采样落成两条，幂等键按日期区分', () => {
  const yesterday = NOW - DAY
  const entries = planMetering({
    runtimes: [
      { workspaceId: 'ws_a', startedAt: yesterday - 30_000, stoppedAt: yesterday },
      { workspaceId: 'ws_a', startedAt: NOW - 10_000, stoppedAt: NOW },
    ],
    volumes: [{ workspaceId: 'ws_a', bytes: 100 }],
    now: NOW,
  })

  assert.equal(entries.length, 3)
  const idems = entries.map((entry) => entry.idem).sort()
  assert.deepEqual(idems, [
    'meter:ws_a:2026-11-03:container_seconds',
    'meter:ws_a:2026-11-04:container_seconds',
    'meter:ws_a:2026-11-04:storage_bytes',
  ])
  assert.equal(entries.find((entry) => entry.idem.endsWith('11-03:container_seconds'))?.amount, 30)
})

test('planMetering：负时长与负字节 clamp 0，零值条目仍然产生幂等行', () => {
  const entries = planMetering({
    runtimes: [{ workspaceId: 'ws_a', startedAt: NOW + 10_000, stoppedAt: NOW }],
    volumes: [{ workspaceId: 'ws_a', bytes: -5 }],
    now: NOW,
  })

  assert.deepEqual(
    entries.map((entry) => [entry.kind, entry.amount]),
    [
      ['container_seconds', 0],
      ['storage_bytes', 0],
    ],
  )
})

test('planMetering：多 workspace 时按 workspaceId → kind 排序，结果可复现', () => {
  const first = planMetering({
    runtimes: [
      { workspaceId: 'ws_b', startedAt: NOW - 2_000, stoppedAt: NOW },
      { workspaceId: 'ws_a', startedAt: NOW - 1_000, stoppedAt: NOW },
    ],
    volumes: [{ workspaceId: 'ws_b', bytes: 10 }],
    now: NOW,
  })
  const second = planMetering({
    volumes: [{ workspaceId: 'ws_b', bytes: 10 }],
    runtimes: [
      { workspaceId: 'ws_a', startedAt: NOW - 1_000, stoppedAt: NOW },
      { workspaceId: 'ws_b', startedAt: NOW - 2_000, stoppedAt: NOW },
    ],
    now: NOW,
  })

  assert.deepEqual(first, second)
  assert.deepEqual(
    first.map((entry) => `${entry.workspaceId}:${entry.kind}`),
    ['ws_a:container_seconds', 'ws_b:container_seconds', 'ws_b:storage_bytes'],
  )
})

test('planMetering：非法 workspaceId / 非有限字节被跳过；空输入返回空数组', () => {
  assert.deepEqual(planMetering({ now: NOW }), [])
  assert.deepEqual(planMetering({ runtimes: [], volumes: [], now: NOW }), [])

  const entries = planMetering({
    runtimes: [
      { workspaceId: '  ', startedAt: NOW - 1_000, stoppedAt: NOW },
      { workspaceId: 'ws_a', startedAt: NOW - 1_000, stoppedAt: NOW },
    ],
    volumes: [
      { workspaceId: 'ws_a', bytes: Number.NaN },
      { workspaceId: 'ws_a', bytes: Number.POSITIVE_INFINITY },
    ],
    now: NOW,
  })

  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.workspaceId, 'ws_a')
})

test('meterDay / meterIdem 使用 UTC 日', () => {
  assert.equal(meterDay(Date.UTC(2026, 10, 4, 23, 59, 59)), '2026-11-04')
  assert.equal(meterDay(Date.UTC(2026, 10, 5, 0, 0, 0)), '2026-11-05')
  assert.equal(
    meterIdem('ws_a', 'container_seconds', Date.UTC(2026, 10, 4, 1, 2, 3)),
    'meter:ws_a:2026-11-04:container_seconds',
  )
})
