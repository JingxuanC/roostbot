// 超时/宽限判定：与 packages/rooms/src/round.ts 的 classifyGrace 同边界。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_REPLY_TIMEOUT_MS, DEFAULT_WORK_GRACE_MS, graceLimitsFromEnv, graceVerdict } from '../turn-grace.mjs'

test('未到超时：继续等', () => {
  assert.equal(graceVerdict({ elapsedMs: 0, working: true }), 'continue')
  assert.equal(graceVerdict({ elapsedMs: DEFAULT_REPLY_TIMEOUT_MS - 1, working: false }), 'continue')
})

test('到点不在工作：timeout', () => {
  assert.equal(graceVerdict({ elapsedMs: DEFAULT_REPLY_TIMEOUT_MS, working: false }), 'timeout')
})

test('到点仍在工作：宽限窗口内继续等，用完记 working', () => {
  assert.equal(graceVerdict({ elapsedMs: DEFAULT_REPLY_TIMEOUT_MS, working: true }), 'continue')
  assert.equal(
    graceVerdict({ elapsedMs: DEFAULT_REPLY_TIMEOUT_MS + DEFAULT_WORK_GRACE_MS - 1, working: true }),
    'continue'
  )
  assert.equal(graceVerdict({ elapsedMs: DEFAULT_REPLY_TIMEOUT_MS + DEFAULT_WORK_GRACE_MS, working: true }), 'working')
})

test('自定义 limits 与非法值回退', () => {
  assert.equal(graceVerdict({ elapsedMs: 100, working: true, replyTimeoutMs: 50, workGraceMs: 0 }), 'working')
  assert.equal(graceVerdict({ elapsedMs: -5, working: true }), 'continue')
  assert.equal(graceVerdict({ elapsedMs: Number.NaN, working: true }), 'continue')
})

test('env 解析：只接受正整数/非负整数', () => {
  assert.deepEqual(graceLimitsFromEnv({ ROOST_REPLY_TIMEOUT_MS: '5000', ROOST_WORK_GRACE_MS: '0' }), {
    replyTimeoutMs: 5000,
    workGraceMs: 0
  })
  assert.deepEqual(graceLimitsFromEnv({ ROOST_REPLY_TIMEOUT_MS: '-1', ROOST_WORK_GRACE_MS: 'x' }), {})
})
