// 控制面调度（docs/design/scheduling.md §4–§10）：幂等、追赶、重叠、推进、人工与停止。

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createSchedule,
  deleteSchedule,
  getRun,
  getSchedule,
  listRuns,
  listSchedules,
  manualActivation,
  stopRun,
  tick,
  updateSchedule,
} from '../src/index.ts'
import type { Store } from '../src/index.ts'
import { withStore } from './helpers.ts'

const WS = 'ws_sched'
const T0 = Date.UTC(2026, 10, 4, 8, 0, 0) // 2026-11-04T08:00:00Z

function count(store: Store, sql: string, ...params: unknown[]): number {
  const row = store.db.prepare(sql).get(...params) as { n: number | bigint }
  return Number(row.n)
}

function makeSchedule(store: Store, routineId: string, overrides: Record<string, unknown> = {}) {
  return createSchedule(store, {
    workspaceId: WS,
    routineId,
    botId: 'bot_1',
    cron: '0 9 * * *',
    timezone: 'UTC',
    at: T0,
    ...overrides,
  })
}

test('create：计算 nextRunAt，重复 routine 抛 SCHEDULE_EXISTS，非法表达式/时区抛 SCHEDULE_INVALID', () => {
  return withStore((store) => {
    const schedule = makeSchedule(store, 'daily')
    assert.equal(schedule.nextRunAt, Date.UTC(2026, 10, 4, 9, 0, 0))
    assert.equal(schedule.enabled, true)
    assert.equal(schedule.overlap, 'queue')
    assert.equal(schedule.catchUpMs, 12 * 60 * 60 * 1000)

    assert.throws(
      () => makeSchedule(store, 'daily'),
      (err: unknown) => err instanceof Error && err.message.includes('SCHEDULE_EXISTS'),
    )
    assert.throws(
      () => makeSchedule(store, 'bad-cron', { cron: 'not a cron' }),
      (err: unknown) => err instanceof Error && err.message.includes('SCHEDULE_INVALID'),
    )
    assert.throws(
      () => makeSchedule(store, 'bad-tz', { timezone: 'Mars/Olympus' }),
      (err: unknown) => err instanceof Error && err.message.includes('SCHEDULE_INVALID'),
    )
  })
})

test('update：改 cron/timezone 重算 next_run_at，未改则保留', () => {
  return withStore((store) => {
    const schedule = makeSchedule(store, 'daily')
    const same = updateSchedule(store, { id: schedule.id, enabled: false, at: T0 + 60_000 })
    assert.equal(same.nextRunAt, schedule.nextRunAt)
    assert.equal(same.enabled, false)

    const later = updateSchedule(store, {
      id: schedule.id,
      cron: '0 10 * * *',
      at: Date.UTC(2026, 10, 5, 8, 0, 0),
    })
    assert.equal(later.nextRunAt, Date.UTC(2026, 10, 5, 10, 0, 0))

    deleteSchedule(store, schedule.id)
    assert.equal(getSchedule(store, schedule.id), null)
    assert.throws(
      () => deleteSchedule(store, schedule.id),
      (err: unknown) => err instanceof Error && err.message.includes('SCHEDULE_NOT_FOUND'),
    )
  })
})

test('幂等：同一 scheduledFor tick 两次只建一条 activation/run', () => {
  return withStore((store) => {
    const schedule = makeSchedule(store, 'daily')
    const due = Date.UTC(2026, 10, 4, 9, 0, 0)

    const first = tick(store, { now: due })
    assert.deepEqual(first, { created: 1, missed: 0, skipped: 0 })
    assert.equal(count(store, 'SELECT COUNT(*) AS n FROM activations'), 1)
    assert.equal(count(store, 'SELECT COUNT(*) AS n FROM runs'), 1)
    assert.equal(count(store, 'SELECT COUNT(*) AS n FROM run_events WHERE kind = ?', 'enqueued'), 1)

    // 模拟双计时器/重放：把 next_run_at 拨回原定时刻再 tick。
    store.db.prepare('UPDATE workspace_schedules SET next_run_at = ? WHERE id = ?').run(due, schedule.id)
    const second = tick(store, { now: due })
    assert.deepEqual(second, { created: 0, missed: 0, skipped: 0 })
    assert.equal(count(store, 'SELECT COUNT(*) AS n FROM activations'), 1)
    assert.equal(count(store, 'SELECT COUNT(*) AS n FROM runs'), 1)
    // next_run_at 仍然推进到下一次。
    assert.equal(getSchedule(store, schedule.id)!.nextRunAt, Date.UTC(2026, 10, 5, 9, 0, 0))
  })
})

test('追赶：12 小时内补跑为 queued，超过窗口记 missed', () => {
  return withStore((store) => {
    const within = makeSchedule(store, 'within')

    // within：09:00 的触发在 20:00 处理，晚 11 小时。
    const a = tick(store, { now: Date.UTC(2026, 10, 4, 20, 0, 0) })
    assert.deepEqual(a, { created: 1, missed: 0, skipped: 0 })
    const runA = listRuns(store, { workspaceId: WS })[0]!
    assert.equal(runA.status, 'queued')

    // late 单独创建，次日 00:00 才处理，晚 15 小时 → missed。
    const late = makeSchedule(store, 'late', { workspaceId: 'ws_sched_2' })
    const b = tick(store, { now: Date.UTC(2026, 10, 5, 0, 0, 0) })
    assert.deepEqual(b, { created: 0, missed: 1, skipped: 0 })
    const runB = listRuns(store, { workspaceId: 'ws_sched_2' })[0]!
    assert.equal(runB.status, 'missed')
    assert.equal(runB.outcome, 'missed')
    assert.equal(count(store, 'SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND kind = ?', runB.id, 'missed'), 1)
    assert.ok(getSchedule(store, late.id)!.nextRunAt > Date.UTC(2026, 10, 5, 0, 0, 0))
    assert.equal(getSchedule(store, within.id)!.nextRunAt, Date.UTC(2026, 10, 5, 9, 0, 0))
  })
})

test('重叠：skip 留 skipped(duplicate) 收据，queue 两条都排队', () => {
  return withStore((store) => {
    const skip = makeSchedule(store, 'skip', { cron: 'every 3600', overlap: 'skip' })
    const queue = createSchedule(store, {
      workspaceId: WS,
      routineId: 'queue',
      botId: 'bot_1',
      cron: 'every 3600',
      timezone: 'UTC',
      overlap: 'queue',
      at: T0,
    })

    const result = tick(store, { now: Date.UTC(2026, 10, 4, 10, 0, 0) })
    // 每个 schedule 两次触发：第一次 queued；第二次 skip 被丢弃，queue 继续排队。
    assert.deepEqual(result, { created: 3, missed: 0, skipped: 1 })

    const skipRuns = listRuns(store, { workspaceId: WS }).filter((run) => run.routineId === 'skip')
    assert.deepEqual(skipRuns.map((run) => run.status).sort(), ['queued', 'skipped'])
    const skippedRun = skipRuns.find((run) => run.status === 'skipped')!
    assert.equal(skippedRun.outcome, 'duplicate')
    assert.equal(count(store, 'SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?', skippedRun.id), 1)

    const queueRuns = listRuns(store, { workspaceId: WS }).filter((run) => run.routineId === 'queue')
    assert.deepEqual(queueRuns.map((run) => run.status).sort(), ['queued', 'queued'])

    assert.equal(getSchedule(store, skip.id)!.nextRunAt, Date.UTC(2026, 10, 4, 11, 0, 0))
    assert.equal(getSchedule(store, queue.id)!.nextRunAt, Date.UTC(2026, 10, 4, 11, 0, 0))
  })
})

test('tick 每次最多补 100 次', () => {
  return withStore((store) => {
    makeSchedule(store, 'flood', { cron: 'every 1' })
    const result = tick(store, { now: T0 + 500_000 })
    assert.equal(result.created, 100)
    assert.equal(count(store, 'SELECT COUNT(*) AS n FROM runs'), 100)
    // 下一次 tick 继续补，next_run_at 单调前进。
    const next = tick(store, { now: T0 + 500_000 })
    assert.equal(next.created, 100)
  })
})

test('manualActivation：建 manual activation + queued run，idem 重放返回同一条', () => {
  return withStore((store) => {
    const first = manualActivation(store, {
      workspaceId: WS,
      botId: 'bot_1',
      routineId: 'daily',
      at: T0,
      idem: 'manual:once',
    })
    assert.equal(first.run.status, 'queued')
    assert.equal(first.run.kind, 'manual')
    assert.equal(first.run.routineId, 'daily')

    const replay = manualActivation(store, {
      workspaceId: WS,
      botId: 'bot_1',
      routineId: 'daily',
      at: T0 + 1000,
      idem: 'manual:once',
    })
    assert.equal(replay.activationId, first.activationId)
    assert.equal(replay.run.id, first.run.id)
    assert.equal(count(store, 'SELECT COUNT(*) AS n FROM activations'), 1)

    const second = manualActivation(store, { workspaceId: WS, botId: 'bot_1', routineId: 'daily', at: T0 + 2000 })
    assert.notEqual(second.activationId, first.activationId)
  })
})

test('stopRun：completed/stopped + settled 事件，重复停止幂等', () => {
  return withStore((store) => {
    const { run } = manualActivation(store, { workspaceId: WS, botId: 'bot_1', routineId: 'daily', at: T0 })
    const stopped = stopRun(store, { runId: run.id, by: 'acc_owner', at: T0 + 1000 })
    assert.equal(stopped.status, 'completed')
    assert.equal(stopped.outcome, 'stopped')
    assert.equal(stopped.finishedAt, T0 + 1000)
    assert.equal(count(store, 'SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND kind = ?', run.id, 'settled'), 1)

    const again = stopRun(store, { runId: run.id, by: 'acc_owner', at: T0 + 2000 })
    assert.equal(again.status, 'completed')
    assert.equal(count(store, 'SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND kind = ?', run.id, 'settled'), 1)

    assert.throws(
      () => stopRun(store, { runId: 'run_missing', by: 'acc_owner', at: T0 }),
      (err: unknown) => err instanceof Error && err.message.includes('RUN_NOT_FOUND'),
    )
  })
})

test('listRuns：按 workspace 过滤、按 status 过滤、limit 生效', () => {
  return withStore((store) => {
    manualActivation(store, { workspaceId: WS, botId: 'bot_1', routineId: 'a', at: T0 })
    const stopped = manualActivation(store, { workspaceId: WS, botId: 'bot_1', routineId: 'b', at: T0 + 1 })
    stopRun(store, { runId: stopped.run.id, by: 'acc_owner', at: T0 + 2 })

    assert.equal(listRuns(store, { workspaceId: WS }).length, 2)
    assert.equal(listRuns(store, { workspaceId: WS, status: 'queued' }).length, 1)
    assert.equal(listRuns(store, { workspaceId: WS, status: 'completed' }).length, 1)
    assert.equal(listRuns(store, { workspaceId: WS, limit: 1 }).length, 1)
    assert.equal(listRuns(store, { workspaceId: 'ws_other' }).length, 0)
    assert.equal(getRun(store, stopped.run.id)!.status, 'completed')
  })
})

test('listSchedules：按 workspace 与 enabled 过滤', () => {
  return withStore((store) => {
    makeSchedule(store, 'a')
    makeSchedule(store, 'b', { workspaceId: 'ws_2' })
    updateSchedule(store, { id: makeSchedule(store, 'c').id, enabled: false, at: T0 })
    assert.equal(listSchedules(store, { workspaceId: WS }).length, 2)
    assert.equal(listSchedules(store, { workspaceId: WS, enabled: true }).length, 1)
    assert.equal(listSchedules(store, {}).length, 3)
  })
})
