// 空闲睡/醒：planIdleAction 的边界与 startIdleSleeper 的状态机（fake backend）。
// 全部用注入的 now，不依赖真实定时器。

import assert from 'node:assert/strict'
import test from 'node:test'

import { planIdleAction, startIdleSleeper } from '../idle-sleeper.mjs'

const IDLE = 30 * 60_000

interface FakeBackend {
  calls: string[]
  backend: {
    stop: (sandbox: unknown) => Promise<void> | void
    start: (sandbox: unknown) => Promise<void> | void
  }
}

function fakeBackend(options: { failStop?: boolean; failStart?: boolean } = {}): FakeBackend {
  const calls: string[] = []
  return {
    calls,
    backend: {
      stop: async () => {
        calls.push('stop')
        if (options.failStop) throw new Error('stop exploded')
      },
      start: async () => {
        calls.push('start')
        if (options.failStart) throw new Error('start exploded')
      },
    },
  }
}

test('planIdleAction：ready 刚好 idleMs 才 stop，早 1ms 不动', () => {
  assert.equal(
    planIdleAction({ lastActivityAt: 0, now: IDLE - 1, idleMs: IDLE, phase: 'ready' }),
    'none',
  )
  assert.equal(planIdleAction({ lastActivityAt: 0, now: IDLE, idleMs: IDLE, phase: 'ready' }), 'stop')
  assert.equal(planIdleAction({ lastActivityAt: 0, now: 10 * IDLE, idleMs: IDLE, phase: 'ready' }), 'stop')
})

test('planIdleAction：stopped 后没有新活动 → none；touch 过（idleMs 内）→ wake', () => {
  // 停睡时 lastActivityAt 至少已经 idleMs 老，不会立刻醒。
  assert.equal(
    planIdleAction({ lastActivityAt: 0, now: IDLE + 1, idleMs: IDLE, phase: 'stopped' }),
    'none',
  )
  // 刚好 idleMs：不算新活动，避免 stop/wake 抖动。
  assert.equal(
    planIdleAction({ lastActivityAt: 1_000, now: 1_000 + IDLE, idleMs: IDLE, phase: 'stopped' }),
    'none',
  )
  assert.equal(
    planIdleAction({ lastActivityAt: 1_000, now: 1_000 + IDLE - 1, idleMs: IDLE, phase: 'stopped' }),
    'wake',
  )
})

test('planIdleAction：error / unknown 不自动自愈', () => {
  for (const phase of ['error', 'unknown', undefined, 'weird']) {
    assert.equal(planIdleAction({ lastActivityAt: 0, now: 0, idleMs: IDLE, phase }), 'none')
  }
})

test('planIdleAction：非法输入抛 TypeError', () => {
  assert.throws(() => planIdleAction({ lastActivityAt: 0, now: Number.NaN, idleMs: IDLE, phase: 'ready' }), /now/)
  assert.throws(() => planIdleAction({ lastActivityAt: 0, now: 0, idleMs: 0, phase: 'ready' }), /idleMs/)
  assert.throws(() => planIdleAction(null), /object/)
})

test('sleeper：闲置到点 stop 一次；重复 tick 不再重复 stop', async () => {
  const fake = fakeBackend()
  let nowMs = 0
  const sleeper = startIdleSleeper({
    backend: fake.backend,
    sandbox: { name: 'user-abc12345', phase: 'ready' },
    idleMs: IDLE,
    pollMs: 3_600_000,
    now: () => nowMs,
    log: () => {},
  })
  try {
    assert.deepEqual(fake.calls, [], '构造时不动作，只由 tick 驱动')

    nowMs = IDLE
    assert.equal(await sleeper.tick(), 'stop')
    assert.deepEqual(fake.calls, ['stop'])
    assert.equal(sleeper.state().phase, 'stopped')

    nowMs = IDLE + 1
    assert.equal(await sleeper.tick(), 'none')
    assert.equal(await sleeper.tick(), 'none')
    assert.deepEqual(fake.calls, ['stop'], '睡着后重复 tick 不再 stop')
  } finally {
    sleeper.stop()
  }

  // 停止状态机后 tick 不动作（也不 throw）。
  assert.equal(await sleeper.tick(), 'none')
  assert.deepEqual(fake.calls, ['stop'])
})

test('sleeper：stop 后 touch() → 下一次 tick wake；醒来后活动时间重置', async () => {
  const fake = fakeBackend()
  let nowMs = 0
  const sleeper = startIdleSleeper({
    backend: fake.backend,
    sandbox: { name: 'user-abc12345', phase: 'ready' },
    idleMs: IDLE,
    pollMs: 3_600_000,
    now: () => nowMs,
    log: () => {},
  })
  try {
    nowMs = IDLE
    assert.equal(await sleeper.tick(), 'stop')

    // 睡着期间没人用：连续 tick 不醒。
    nowMs = IDLE * 3
    assert.equal(await sleeper.tick(), 'none')
    assert.deepEqual(fake.calls, ['stop'])

    // 有活动：touch 把 lastActivityAt 推到现在，下一次 tick 叫醒。
    sleeper.touch()
    assert.equal(await sleeper.tick(), 'wake')
    assert.deepEqual(fake.calls, ['stop', 'start'])
    assert.equal(sleeper.state().phase, 'ready')
    assert.equal(sleeper.state().lastActivityAt, IDLE * 3)

    // 刚醒不算闲置，不会马上又睡。
    nowMs = IDLE * 3 + 1
    assert.equal(await sleeper.tick(), 'none')
    assert.deepEqual(fake.calls, ['stop', 'start'])
  } finally {
    sleeper.stop()
  }
})

test('sleeper：touch(at) 可显式指定活动时间', async () => {
  const fake = fakeBackend()
  let nowMs = 10 * IDLE
  const sleeper = startIdleSleeper({
    backend: fake.backend,
    sandbox: { phase: 'stopped' },
    idleMs: IDLE,
    pollMs: 3_600_000,
    now: () => nowMs,
    log: () => {},
  })
  try {
    assert.equal(await sleeper.tick(), 'none', 'stopped 且无活动不醒')
    sleeper.touch(nowMs - 1_000)
    assert.equal(await sleeper.tick(), 'wake')
    assert.deepEqual(fake.calls, ['start'])
  } finally {
    sleeper.stop()
  }
})

test('sleeper：并发 tick 合并，只停一次', async () => {
  const fake = fakeBackend()
  let nowMs = 0
  const sleeper = startIdleSleeper({
    backend: fake.backend,
    sandbox: { phase: 'ready' },
    idleMs: IDLE,
    pollMs: 3_600_000,
    now: () => nowMs,
    log: () => {},
  })
  try {
    nowMs = IDLE
    const results = await Promise.all([sleeper.tick(), sleeper.tick(), sleeper.tick()])
    assert.deepEqual(results, ['stop', 'stop', 'stop'])
    assert.deepEqual(fake.calls, ['stop'])
  } finally {
    sleeper.stop()
  }
})

test('sleeper：backend 失败进入 error，不再自动重试；touch 也不自愈', async () => {
  const fake = fakeBackend({ failStop: true })
  let nowMs = 0
  const logs: string[] = []
  const sleeper = startIdleSleeper({
    backend: fake.backend,
    sandbox: { phase: 'ready' },
    idleMs: IDLE,
    pollMs: 3_600_000,
    now: () => nowMs,
    log: (line: string) => logs.push(line),
  })
  try {
    nowMs = IDLE
    assert.equal(await sleeper.tick(), 'none')
    assert.equal(sleeper.state().phase, 'error')
    assert.equal(logs.some((line) => line.includes('stop') && line.includes('failed')), true)

    nowMs = IDLE * 2
    sleeper.touch()
    assert.equal(await sleeper.tick(), 'none')
    assert.deepEqual(fake.calls, ['stop'], 'error 后不再反复 stop')
  } finally {
    sleeper.stop()
  }
})

test('sleeper：start 失败也进入 error，不抛给调用方', async () => {
  const fake = fakeBackend({ failStart: true })
  let nowMs = 0
  const sleeper = startIdleSleeper({
    backend: fake.backend,
    sandbox: { phase: 'stopped' },
    idleMs: IDLE,
    pollMs: 3_600_000,
    now: () => nowMs,
    log: () => {},
  })
  try {
    sleeper.touch()
    assert.equal(await sleeper.tick(), 'none')
    assert.equal(sleeper.state().phase, 'error')
    assert.deepEqual(fake.calls, ['start'])
  } finally {
    sleeper.stop()
  }
})

test('sleeper：stop() 幂等；缺少 backend/sandbox 时构造失败', () => {
  const fake = fakeBackend()
  const sleeper = startIdleSleeper({
    backend: fake.backend,
    sandbox: { phase: 'ready' },
    pollMs: 3_600_000,
    now: () => 0,
    log: () => {},
  })
  sleeper.stop()
  sleeper.stop()

  assert.throws(() => startIdleSleeper({ sandbox: {} }), /backend/)
  assert.throws(() => startIdleSleeper({ backend: fake.backend }), /sandbox/)
})
