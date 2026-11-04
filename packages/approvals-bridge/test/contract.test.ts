// 契约层：请求校验、DSH 结果词映射、错误形状。
// 这一层没有状态，测试全部是纯函数。

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BRIDGE_DECISIONS,
  BRIDGE_STATES,
  BridgeError,
  DSH_APPROVAL_OUTCOMES,
  isBridgeDecision,
  isTerminal,
  readApprovalRequest,
  toDshOutcome,
} from '../src/contract.ts'

const good = {
  id: 'dsh:s1:call_1',
  workspaceId: 'ws_1',
  botId: 'bot_1',
  tool: 'bash',
  argsSummary: 'bash (call call_1) — npm test',
  consequence: 'runs a shell command',
  requestedAt: 1_700_000_000_000,
}

test('合法请求：原样通过，字符串两端空白被去掉', () => {
  const read = readApprovalRequest({ ...good, tool: '  bash  ', argsSummary: ' x ' }, 1)
  assert.equal(read.ok, true)
  assert.equal(read.ok && read.request.tool, 'bash')
  assert.equal(read.ok && read.request.argsSummary, 'x')
  assert.equal(read.ok && read.request.requestedAt, 1_700_000_000_000)
})

test('requestedAt 缺省时用传入的 at，不用全局时钟', () => {
  const read = readApprovalRequest({ ...good, requestedAt: undefined }, 42)
  assert.equal(read.ok, true)
  assert.equal(read.ok && read.request.requestedAt, 42)
})

test('argsSummary / consequence 可省略，归一化成空串', () => {
  const { argsSummary: _omitSummary, consequence: _omitConsequence, ...rest } = good
  const read = readApprovalRequest(rest)
  assert.equal(read.ok, true)
  assert.equal(read.ok && read.request.argsSummary, '')
  assert.equal(read.ok && read.request.consequence, '')
})

test('缺必填字段：逐字段报错，不抛异常', () => {
  const read = readApprovalRequest({ id: 'x' })
  assert.equal(read.ok, false)
  if (read.ok) return
  const fields = read.errors.map((error) => error.field)
  assert.deepEqual(fields, ['workspaceId', 'botId', 'tool'])
})

test('非对象输入：报 (root)', () => {
  for (const value of [null, undefined, 'bash', 42, ['a']]) {
    const read = readApprovalRequest(value)
    assert.equal(read.ok, false)
    if (read.ok) continue
    assert.equal(read.errors[0]?.field, '(root)')
  }
})

test('超长字段被拒：摘要上限 2000', () => {
  const read = readApprovalRequest({ ...good, argsSummary: 'x'.repeat(2001) })
  assert.equal(read.ok, false)
  if (read.ok) return
  assert.equal(read.errors[0]?.field, 'argsSummary')
})

test('requestedAt 非数字/负数被拒', () => {
  for (const requestedAt of ['now', -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const read = readApprovalRequest({ ...good, requestedAt })
    assert.equal(read.ok, false, `requestedAt=${String(requestedAt)} 应被拒`)
  }
})

test('决定 → DSH 结果词：超时映射成 rejected（失败关闭，不是 unavailable）', () => {
  assert.equal(toDshOutcome('approved'), 'allowed-once')
  assert.equal(toDshOutcome('rejected'), 'rejected')
  assert.equal(toDshOutcome('timeout'), 'rejected')
  assert.equal(toDshOutcome(null), null)
})

test('词汇表自洽：决定 = 状态去掉 pending，结果是 DSH 的四种', () => {
  assert.deepEqual([...BRIDGE_STATES], ['pending', ...BRIDGE_DECISIONS])
  assert.deepEqual([...DSH_APPROVAL_OUTCOMES], ['allowed-once', 'rejected', 'cancelled', 'unavailable'])
})

test('isTerminal / isBridgeDecision 的运行时校验', () => {
  assert.equal(isTerminal('pending'), false)
  for (const state of ['approved', 'rejected', 'timeout'] as const) assert.equal(isTerminal(state), true)
  assert.equal(isBridgeDecision('approved'), true)
  assert.equal(isBridgeDecision('pending'), false)
  assert.equal(isBridgeDecision('ALLOWED'), false)
  assert.equal(isBridgeDecision(undefined), false)
})

test('BridgeError 带机器可读 code 与逐字段 detail', () => {
  const read = readApprovalRequest({ id: 'x' })
  assert.equal(read.ok, false)
  if (read.ok) return
  const error = new BridgeError('INVALID_REQUEST', 'bad request', read.errors)
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'BridgeError')
  assert.equal(error.code, 'INVALID_REQUEST')
  assert.equal(error.detail.length, 3)
})
