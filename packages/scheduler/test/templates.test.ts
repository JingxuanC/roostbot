// 每日复盘模板：形状、默认值、幂等键（同一天同键、跨天不同）、时区与非法输入。

import assert from 'node:assert/strict'
import test from 'node:test'

import { CronError } from '../src/cron.ts'
import {
  REVIEW_ROUTINE_TEMPLATE,
  TemplateError,
  localDateIn,
  reviewRoutineId,
  reviewRoutineInput,
  reviewScheduledFor,
} from '../src/templates.ts'

const AT = Date.UTC(2026, 10, 4, 1, 0, 0) // 2026-11-04 09:00 Asia/Shanghai
const SAME_DAY_LATE = Date.UTC(2026, 10, 4, 14, 0, 0) // 2026-11-04 22:00 Asia/Shanghai
const NEXT_DAY = Date.UTC(2026, 10, 5, 1, 0, 0) // 2026-11-05 09:00 Asia/Shanghai

test('模板形状：每日 20:00、Asia/Shanghai、三步、清理参数与完成条件', () => {
  assert.equal(REVIEW_ROUTINE_TEMPLATE.id, 'daily-review')
  assert.equal(REVIEW_ROUTINE_TEMPLATE.source, 'routine:daily-review')
  assert.equal(REVIEW_ROUTINE_TEMPLATE.cron, 'daily 20:00')
  assert.equal(REVIEW_ROUTINE_TEMPLATE.timezone, 'Asia/Shanghai')
  assert.equal(REVIEW_ROUTINE_TEMPLATE.overlap, 'skip')
  assert.deepEqual(
    REVIEW_ROUTINE_TEMPLATE.steps.map((step) => step.key),
    ['review', 'cleanup', 'lessons'],
  )
  for (const step of REVIEW_ROUTINE_TEMPLATE.steps) {
    assert.ok(step.title.length > 0)
    assert.ok(step.instruction.length >= 10)
  }
  assert.equal(REVIEW_ROUTINE_TEMPLATE.cleanup.falsifiedOlderThanMs, 30 * 86_400_000)
  assert.equal(REVIEW_ROUTINE_TEMPLATE.cleanup.keepRecent, 20)
  assert.ok(REVIEW_ROUTINE_TEMPLATE.doneWhen.length > 0)
  assert.ok((REVIEW_ROUTINE_TEMPLATE.budget.tokens ?? 0) > 0)
  assert.ok(REVIEW_ROUTINE_TEMPLATE.lessonCandidates > 0)
})

test('reviewRoutineInput：日期、scheduledFor、routineId、source 都按本地日算', () => {
  const input = reviewRoutineInput({ workspaceId: 'ws_1', at: AT })
  assert.equal(input.kind, 'clock')
  assert.equal(input.workspaceId, 'ws_1')
  assert.equal(input.date, '2026-11-04')
  assert.equal(input.timezone, 'Asia/Shanghai')
  assert.equal(input.scheduledForMs, Date.UTC(2026, 10, 4, 12, 0, 0))
  assert.equal(input.scheduledFor, '2026-11-04T12:00:00.000Z')
  assert.equal(input.routineId, 'routine-ws_1-2026-11-04')
  assert.equal(input.source, 'routine:routine-ws_1-2026-11-04')
  assert.equal(input.at, AT)
  assert.equal(input.payload.inputs.length, REVIEW_ROUTINE_TEMPLATE.steps.length)
  assert.deepEqual(input.budget, REVIEW_ROUTINE_TEMPLATE.budget)
  assert.equal(input.doneWhen, REVIEW_ROUTINE_TEMPLATE.doneWhen)
  assert.deepEqual(input.cleanup, REVIEW_ROUTINE_TEMPLATE.cleanup)
})

test('幂等键用 clockIdem：`routine-<workspace>-<YYYY-MM-DD>@<计划时刻>`', () => {
  const input = reviewRoutineInput({ workspaceId: 'ws_1', at: AT })
  assert.equal(input.idem, 'routine-ws_1-2026-11-04@2026-11-04T12:00:00.000Z')
  assert.equal(reviewRoutineId('ws_1', input.date), input.routineId)
})

test('同一天不同时刻 → 同 routineId / scheduledFor / idem', () => {
  const early = reviewRoutineInput({ workspaceId: 'ws_1', at: AT })
  const late = reviewRoutineInput({ workspaceId: 'ws_1', at: SAME_DAY_LATE })
  assert.equal(late.date, early.date)
  assert.equal(late.scheduledFor, early.scheduledFor)
  assert.equal(late.idem, early.idem)
  // 凌晨调用也落到当天 20:00。
  const midnight = reviewRoutineInput({ workspaceId: 'ws_1', at: Date.UTC(2026, 10, 3, 16, 10, 0) })
  assert.equal(midnight.date, '2026-11-04')
  assert.equal(midnight.idem, early.idem)
})

test('跨天 → idem 必然不同', () => {
  const today = reviewRoutineInput({ workspaceId: 'ws_1', at: AT })
  const tomorrow = reviewRoutineInput({ workspaceId: 'ws_1', at: NEXT_DAY })
  assert.notEqual(tomorrow.routineId, today.routineId)
  assert.notEqual(tomorrow.idem, today.idem)
  assert.equal(tomorrow.scheduledFor, '2026-11-05T12:00:00.000Z')
})

test('不同 workspace 同一天 → 不同 idem（不跨 workspace 撞键）', () => {
  const a = reviewRoutineInput({ workspaceId: 'ws_a', at: AT })
  const b = reviewRoutineInput({ workspaceId: 'ws_b', at: AT })
  assert.notEqual(a.idem, b.idem)
})

test('默认时区 Asia/Shanghai：UTC 16:30 已算次日凌晨', () => {
  const input = reviewRoutineInput({ workspaceId: 'ws_1', at: Date.UTC(2026, 10, 4, 16, 30, 0) })
  assert.equal(input.date, '2026-11-05')
  assert.equal(input.timezone, 'Asia/Shanghai')
})

test('显式时区生效（UTC）', () => {
  const input = reviewRoutineInput({
    workspaceId: 'ws_1',
    at: Date.UTC(2026, 10, 4, 16, 30, 0),
    timezone: 'UTC',
  })
  assert.equal(input.date, '2026-11-04')
  assert.equal(input.scheduledFor, '2026-11-04T20:00:00.000Z')
  assert.equal(localDateIn('UTC', Date.UTC(2026, 10, 4, 16, 30, 0)), '2026-11-04')
})

test('reviewScheduledFor：取当天模板 cron 的那次触发（at 前后都可）', () => {
  assert.equal(reviewScheduledFor(AT), Date.UTC(2026, 10, 4, 12, 0, 0))
  assert.equal(reviewScheduledFor(SAME_DAY_LATE), Date.UTC(2026, 10, 4, 12, 0, 0))
  assert.equal(reviewScheduledFor(NEXT_DAY), Date.UTC(2026, 10, 5, 12, 0, 0))
})

test('brief 含日期、workspace、三步与清理参数；inputs 是步骤副本', () => {
  const input = reviewRoutineInput({ workspaceId: 'ws_1', at: AT })
  const brief = input.payload.brief
  assert.match(brief, /每日复盘：2026-11-04/u)
  assert.match(brief, /workspace ws_1/u)
  assert.match(brief, /1\. 复核/u)
  assert.match(brief, /2\. 清理/u)
  assert.match(brief, /3\. 写 lesson 候选/u)
  assert.match(brief, /falsifiedOlderThanMs=2592000000/u)
  assert.match(brief, /keepRecent=20/u)
  assert.match(brief, /完成条件/u)
  assert.notEqual(input.payload.inputs, REVIEW_ROUTINE_TEMPLATE.steps)
  for (const step of input.payload.inputs) assert.ok(step.instruction.length > 0)
})

test('非法 workspaceId / at 抛 TemplateError；未知时区抛 CronError', () => {
  assert.throws(() => reviewRoutineInput(null as never), TemplateError)
  assert.throws(() => reviewRoutineInput({ workspaceId: '' }), TemplateError)
  assert.throws(() => reviewRoutineInput({ workspaceId: 'x'.repeat(201) }), TemplateError)
  assert.throws(() => reviewRoutineInput({ workspaceId: 'ws_1', at: 1.5 }), TemplateError)
  assert.throws(() => reviewRoutineInput({ workspaceId: 'ws_1', at: -1 }), TemplateError)
  assert.throws(
    () => reviewRoutineInput({ workspaceId: 'ws_1', at: AT, timezone: 'Mars/Olympus' }),
    CronError,
  )
})

test('at 默认取当前时间，仍产出可用的键', () => {
  const before = Date.now()
  const input = reviewRoutineInput({ workspaceId: 'ws_1' })
  const after = Date.now()
  assert.ok(input.at >= before && input.at <= after)
  assert.match(input.idem, /^routine-ws_1-\d{4}-\d{2}-\d{2}@.+Z$/u)
  assert.match(input.source, /^routine:routine-ws_1-\d{4}-\d{2}-\d{2}$/u)
})
