// 激活判定：四分支、幂等键、边界（刚好到点 / 刚好超 catch-up）、非法输入。
// 纯函数，不碰 DB；时间全部显式 UTC。

import assert from 'node:assert/strict'
import test from 'node:test'

import { clockIdem } from '../src/activation.ts'
import { decideActivation, eventIdem, repairIdem } from '../src/activation-controller.ts'
import type { RoutineShape } from '../src/activation-controller.ts'

const NOW = Date.UTC(2026, 10, 4, 9, 0, 0)
const HOUR = 3_600_000
const CATCH_UP = 12 * HOUR

function routine(overrides: Partial<RoutineShape> = {}): RoutineShape {
  return { id: 'daily-premarket', nextRunAt: NOW, ...overrides }
}

test('clock 到点：run，幂等键复用 clockIdem(routine, scheduledFor)', () => {
  const decision = decideActivation({ routine: routine(), now: NOW, catchUpMs: CATCH_UP })
  assert.equal(decision.action, 'run')
  assert.equal(decision.reason, 'clock.due')
  assert.equal(decision.idem, 'daily-premarket@2026-11-04T09:00:00.000Z')
  assert.equal(decision.idem, clockIdem('daily-premarket', new Date(NOW)))
})

test('clock 未到点：skip(not_due)，仍带计划时刻的幂等键', () => {
  const decision = decideActivation({ routine: routine(), now: NOW - 1, catchUpMs: CATCH_UP })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'routine.not_due')
  assert.equal(decision.idem, clockIdem('daily-premarket', new Date(NOW)))
})

test('边界：now === scheduledFor 算到点；超 catch-up 1ms 才算 missed', () => {
  const onTime = decideActivation({ routine: routine(), now: NOW, catchUpMs: CATCH_UP })
  assert.equal(onTime.action, 'run')

  const exactlyLate = decideActivation({ routine: routine(), now: NOW + CATCH_UP, catchUpMs: CATCH_UP })
  assert.equal(exactlyLate.action, 'run')
  assert.equal(exactlyLate.reason, 'clock.due')

  const oneMsLate = decideActivation({ routine: routine(), now: NOW + CATCH_UP + 1, catchUpMs: CATCH_UP })
  assert.equal(oneMsLate.action, 'missed')
  assert.equal(oneMsLate.reason, 'clock.missed')
  assert.equal(oneMsLate.idem, clockIdem('daily-premarket', new Date(NOW)))
})

test('event 信号：run(event)，幂等键 event:<routine>:<signalId>', () => {
  const decision = decideActivation({
    routine: routine({ nextRunAt: NOW + HOUR }),
    now: NOW,
    catchUpMs: CATCH_UP,
    signals: [{ id: 'issue-42' }],
  })
  assert.equal(decision.action, 'run')
  assert.equal(decision.reason, 'event.signal')
  assert.equal(decision.idem, 'event:daily-premarket:issue-42')
  assert.equal(decision.idem, eventIdem('daily-premarket', 'issue-42'))
})

test('event 信号按到达顺序取第一条，字符串与 {id} 都接受', () => {
  const first = decideActivation({
    routine: routine({ nextRunAt: NOW + HOUR }),
    now: NOW,
    signals: ['sig-a', { id: 'sig-b', at: NOW }],
  })
  assert.equal(first.idem, 'event:daily-premarket:sig-a')

  const single = decideActivation({
    routine: routine({ nextRunAt: NOW + HOUR }),
    now: NOW,
    signals: [{ id: 'sig-b', at: NOW }],
  })
  assert.equal(single.idem, 'event:daily-premarket:sig-b')

  const empty = decideActivation({
    routine: routine({ nextRunAt: NOW + HOUR }),
    now: NOW,
    signals: [],
  })
  assert.equal(empty.action, 'skip')
  assert.equal(empty.reason, 'routine.not_due')
})

test('repair：lastRunAt 有值且无终态标记 → repair，键稳定', () => {
  const lastRunAt = NOW - 5_000
  const first = decideActivation({
    routine: routine({ nextRunAt: NOW + HOUR }),
    now: NOW,
    lastRunAt,
    catchUpMs: CATCH_UP,
  })
  assert.equal(first.action, 'repair')
  assert.equal(first.reason, 'run.interrupted')
  assert.equal(first.idem, repairIdem('daily-premarket', lastRunAt))

  const again = decideActivation({
    routine: routine({ nextRunAt: NOW + HOUR }),
    now: NOW + 1_000,
    lastRunAt,
    catchUpMs: CATCH_UP,
  })
  assert.equal(again.idem, first.idem, '同一个中断现场重复 tick 只补一次')
})

test('repair 只在缺终态标记时成立：终态 status / finishedAt 会落回 clock', () => {
  const lastRunAt = NOW - 5_000
  const done = decideActivation({
    routine: routine({ nextRunAt: NOW, lastRunStatus: 'completed' }),
    now: NOW,
    lastRunAt,
    catchUpMs: CATCH_UP,
  })
  assert.equal(done.action, 'run')
  assert.equal(done.reason, 'clock.due')

  const finished = decideActivation({
    routine: routine({ nextRunAt: NOW, lastRunFinishedAt: lastRunAt + 1 }),
    now: NOW,
    lastRunAt,
    catchUpMs: CATCH_UP,
  })
  assert.equal(finished.action, 'run')

  const running = decideActivation({
    routine: routine({ nextRunAt: NOW + HOUR, lastRunStatus: 'running' }),
    now: NOW,
    lastRunAt,
    catchUpMs: CATCH_UP,
  })
  assert.equal(running.action, 'repair')
})

test('repair 优先于 missed：中断的现场不能因为晚到就被记成 missed', () => {
  const lastRunAt = NOW - 13 * HOUR
  const decision = decideActivation({
    routine: routine(),
    now: NOW,
    lastRunAt,
    catchUpMs: CATCH_UP,
  })
  assert.equal(decision.action, 'repair')
})

test('missed 优先于 event：错过要留收据，信号下一 tick 仍可按 idem 处理', () => {
  const decision = decideActivation({
    routine: routine(),
    now: NOW + CATCH_UP + 1,
    catchUpMs: CATCH_UP,
    signals: ['sig-late'],
  })
  assert.equal(decision.action, 'missed')
})

test('disabled：任何情况下都 skip(disabled)', () => {
  const decision = decideActivation({
    routine: routine({ enabled: false, nextRunAt: NOW - HOUR }),
    now: NOW,
    catchUpMs: CATCH_UP,
    signals: ['sig'],
  })
  assert.equal(decision.action, 'skip')
  assert.equal(decision.reason, 'routine.disabled')

  const noSchedule = decideActivation({
    routine: { id: 'x', enabled: false },
    now: NOW,
    signals: ['sig'],
  })
  assert.equal(noSchedule.reason, 'routine.disabled')
  assert.equal(noSchedule.idem, '')
})

test('没有计划时刻：无信号 → skip(not_scheduled)；有信号仍可 run(event)', () => {
  const idle = decideActivation({ routine: { id: 'watchdog-ish' }, now: NOW })
  assert.equal(idle.action, 'skip')
  assert.equal(idle.reason, 'routine.not_scheduled')
  assert.equal(idle.idem, '')

  const event = decideActivation({ routine: { id: 'watchdog-ish' }, now: NOW, signals: ['boom'] })
  assert.equal(event.action, 'run')
  assert.equal(event.reason, 'event.signal')
  assert.equal(event.idem, 'event:watchdog-ish:boom')
})

test('catch-up 回落：参数 > routine.catchUpMs > 12h 默认；0 表示只在准点跑', () => {
  const fromRoutine = decideActivation({
    routine: routine({ catchUpMs: HOUR }),
    now: NOW + HOUR + 1,
  })
  assert.equal(fromRoutine.action, 'missed', 'routine.catchUpMs 生效')

  const explicit = decideActivation({
    routine: routine({ catchUpMs: HOUR }),
    now: NOW + HOUR + 1,
    catchUpMs: 2 * HOUR,
  })
  assert.equal(explicit.action, 'run', '参数优先于 routine')

  const zero = decideActivation({ routine: routine(), now: NOW + 1, catchUpMs: 0 })
  assert.equal(zero.action, 'missed')
  const zeroOnTime = decideActivation({ routine: routine(), now: NOW, catchUpMs: 0 })
  assert.equal(zeroOnTime.action, 'run')
})

test('幂等：同样输入重复判定得到同样 action/idem；scheduledFor 别名等价', () => {
  const input = { routine: routine({ scheduledFor: NOW, nextRunAt: undefined }), now: NOW }
  const a = decideActivation(input)
  const b = decideActivation(input)
  assert.deepEqual(a, b)
  assert.equal(a.action, 'run')
  assert.equal(a.idem, clockIdem('daily-premarket', new Date(NOW)))

  const withRoutineId = decideActivation({
    routine: { routineId: 'daily-premarket', nextRunAt: NOW },
    now: NOW,
  })
  assert.equal(withRoutineId.idem, a.idem, 'store 的 routineId 字段也接受')
})

test('非法输入抛 TypeError，不猜动作', () => {
  assert.throws(() => decideActivation({ routine: {}, now: NOW }), /routine\.id/)
  assert.throws(
    () => decideActivation({ routine: routine(), now: Number.NaN }),
    /now/,
  )
  assert.throws(
    () => decideActivation({ routine: routine(), now: NOW, catchUpMs: -1 }),
    /catchUpMs/,
  )
  assert.throws(
    () => decideActivation({ routine: routine({ nextRunAt: NOW + HOUR }), now: NOW, signals: [''] }),
    /signals\[0\]/,
  )
})
