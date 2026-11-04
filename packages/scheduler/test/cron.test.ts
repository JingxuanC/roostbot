// 时间计算：cron、简化形态、跨月跨年、时区与 DST。
// 只验证语义，不依赖系统时区（全部用显式 UTC / IANA 时区）。

import assert from 'node:assert/strict'
import test from 'node:test'

import { CronError, nextRunAt } from '../src/cron.ts'

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

test('普通 cron：UTC 每天 9 点', () => {
  const after = Date.UTC(2026, 10, 4, 8, 0, 0)
  assert.equal(nextRunAt('0 9 * * *', 'UTC', after), Date.UTC(2026, 10, 4, 9, 0, 0))
})

test('严格晚于 after：正好到点时取下一天', () => {
  const at = Date.UTC(2026, 10, 4, 9, 0, 0)
  assert.equal(nextRunAt('0 9 * * *', 'UTC', at), Date.UTC(2026, 10, 5, 9, 0, 0))
})

test('步长与列表', () => {
  const after = Date.UTC(2026, 10, 4, 8, 7, 0)
  assert.equal(nextRunAt('*/15 * * * *', 'UTC', after), Date.UTC(2026, 10, 4, 8, 15, 0))
  assert.equal(nextRunAt('5,10,20 * * * *', 'UTC', after), Date.UTC(2026, 10, 4, 8, 10, 0))
  assert.equal(nextRunAt('10-40/10 * * * *', 'UTC', after), Date.UTC(2026, 10, 4, 8, 10, 0))
})

test('跨月与跨年', () => {
  assert.equal(
    nextRunAt('0 0 1 * *', 'UTC', Date.UTC(2026, 11, 15, 12, 0, 0)),
    Date.UTC(2027, 0, 1, 0, 0, 0),
  )
  assert.equal(
    nextRunAt('30 23 31 12 *', 'UTC', Date.UTC(2026, 0, 1, 0, 0, 0)),
    Date.UTC(2026, 11, 31, 23, 30, 0),
  )
})

test('周日 0 与 7 等价', () => {
  // 2026-11-01 是周日。
  const after = Date.UTC(2026, 10, 1, 0, 0, 0)
  assert.equal(nextRunAt('0 12 * * 0', 'UTC', after), Date.UTC(2026, 10, 1, 12, 0, 0))
  assert.equal(nextRunAt('0 12 * * 7', 'UTC', after), Date.UTC(2026, 10, 1, 12, 0, 0))
})

test('日与周同时受限按并集', () => {
  // 2026-11-04 是周三；12 月 1 日是次月 1 号。从 11 月 5 日起，下一次要么是 12/1，要么是周日 11/8。
  const after = Date.UTC(2026, 10, 5, 0, 0, 0)
  assert.equal(nextRunAt('0 0 1 * 0', 'UTC', after), Date.UTC(2026, 10, 8, 0, 0, 0))
})

test('UTC+8 时区换算', () => {
  const after = Date.UTC(2026, 10, 4, 0, 0, 0)
  assert.equal(nextRunAt('0 9 * * *', 'Asia/Shanghai', after), Date.UTC(2026, 10, 4, 1, 0, 0))
})

test('春季跳变：不存在的 2:30 被跳过', () => {
  // 2026-03-08 美东 2:00 → 3:00，本地 2:30 不存在。
  const after = Date.UTC(2026, 2, 8, 0, 0, 0)
  const next = nextRunAt('30 2 * * *', 'America/New_York', after)
  assert.equal(iso(next), '2026-03-09T06:30:00.000Z')
})

test('秋季回拨：重复的 1:30 只取第一次', () => {
  // 2026-11-01 美东 2:00 → 1:00，本地 1:30 出现两次（05:30Z 与 06:30Z）。
  const afterFirstDay = Date.UTC(2026, 9, 31, 12, 0, 0)
  const first = nextRunAt('30 1 * * *', 'America/New_York', afterFirstDay)
  assert.equal(iso(first), '2026-11-01T05:30:00.000Z')
  // 从第一次触发点之后继续算：第二次 1:30（06:30Z）不再跑，直接到次日。
  const second = nextRunAt('30 1 * * *', 'America/New_York', first)
  assert.equal(iso(second), '2026-11-02T06:30:00.000Z')
})

test('简化形态 daily / weekly', () => {
  const after = Date.UTC(2026, 10, 1, 12, 0, 0) // 周日
  assert.equal(nextRunAt('daily 09:00', 'UTC', after), Date.UTC(2026, 10, 2, 9, 0, 0))
  assert.equal(nextRunAt('weekly mon,wed 09:00', 'UTC', after), Date.UTC(2026, 10, 2, 9, 0, 0))
  assert.equal(
    nextRunAt('weekly mon,wed 09:00', 'UTC', Date.UTC(2026, 10, 2, 10, 0, 0)),
    Date.UTC(2026, 10, 4, 9, 0, 0),
  )
})

test('简化形态 every（秒）', () => {
  const after = Date.UTC(2026, 10, 4, 8, 0, 0)
  assert.equal(nextRunAt('every 3600', 'UTC', after), after + 3_600_000)
})

test('非法表达式与未知时区抛 CronError', () => {
  assert.throws(() => nextRunAt('not a cron', 'UTC', 0), CronError)
  assert.throws(() => nextRunAt('61 * * * *', 'UTC', 0), CronError)
  assert.throws(() => nextRunAt('0 0 31 2 *', 'UTC', 0), CronError)
  assert.throws(() => nextRunAt('daily 25:00', 'UTC', 0), CronError)
  assert.throws(() => nextRunAt('weekly nope 09:00', 'UTC', 0), CronError)
  assert.throws(() => nextRunAt('every 0', 'UTC', 0), CronError)
  assert.throws(() => nextRunAt('0 9 * * *', 'Mars/Olympus', 0), CronError)
})
