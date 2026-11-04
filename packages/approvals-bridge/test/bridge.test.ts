// 状态机：pending → approved | rejected | timeout，幂等、并发、超时、失败关闭。
// 全部用注入的时钟 / 定时器 / fetch 替身，测试里不 sleep（一个实时超时用例除外）。

import assert from 'node:assert/strict'
import test from 'node:test'

import { BridgeError, createApprovalBridge } from '../src/index.ts'
import type { ApprovalBridge, ApprovalBridgeOptions, ApprovalRequest, BridgeDecision } from '../src/index.ts'

const T0 = 1_700_000_000_000

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'dsh:s1:call_1',
    workspaceId: 'ws_1',
    botId: 'bot_1',
    tool: 'bash',
    argsSummary: 'bash (call call_1) — npm test',
    consequence: 'runs a shell command',
    requestedAt: T0,
    ...overrides,
  }
}

/** 固定时钟 + 手动定时器：让超时用例完全确定。 */
function harness(options: Partial<ApprovalBridgeOptions> = {}) {
  let clock = T0
  const timers: Array<{ callback: () => void; ms: number }> = []
  const bridge = createApprovalBridge({
    now: () => clock,
    setTimer: (callback, ms) => {
      const timer = { callback, ms }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as { callback: () => void; ms: number })
      if (index >= 0) timers.splice(index, 1)
    },
    ...options,
  })
  return {
    bridge,
    advance(ms: number): void {
      clock += ms
      for (const timer of [...timers]) {
        if (timer.ms <= ms) {
          const index = timers.indexOf(timer)
          if (index >= 0) timers.splice(index, 1)
          timer.callback()
        }
      }
    },
    get clock(): number {
      return clock
    },
    get timers(): number {
      return timers.length
    },
  }
}

test('提交后是 pending：拿到控制面 id、截止时间，没有决定', async () => {
  const calls: ApprovalRequest[] = []
  const { bridge } = harness({
    timeoutMs: 1000,
    request: async (input) => {
      calls.push(input)
      return { approvalId: 'apr_1' }
    },
  })
  const outcome = await bridge.submit(request())
  assert.equal(outcome.state, 'pending')
  assert.equal(outcome.decision, null)
  assert.equal(outcome.dshOutcome, null)
  assert.equal(outcome.approvalId, 'apr_1')
  assert.equal(outcome.deadlineAt, T0 + 1000)
  assert.equal(outcome.decidedAt, null)
  assert.equal(outcome.failure, null)
  assert.equal(calls.length, 1)
  assert.equal(bridge.size, 1)
})

test('批准：approved → allowed-once，记时间与决定人', async () => {
  const { bridge, clock } = harness({ request: async () => ({ approvalId: 'apr_1' }) })
  await bridge.submit(request())
  const outcome = bridge.settle('dsh:s1:call_1', 'approved')
  assert.equal(outcome.state, 'approved')
  assert.equal(outcome.decision, 'approved')
  assert.equal(outcome.dshOutcome, 'allowed-once')
  assert.equal(outcome.decidedAt, clock)
  assert.equal(outcome.decidedBy, 'user')
})

test('拒绝：rejected → rejected', async () => {
  const { bridge } = harness()
  await bridge.submit(request())
  const outcome = bridge.settle('dsh:s1:call_1', 'rejected', { by: 'user', note: 'seen in UI' })
  assert.equal(outcome.state, 'rejected')
  assert.equal(outcome.dshOutcome, 'rejected')
  assert.equal(outcome.note, 'seen in UI')
})

test('幂等：同一个决定再来一次不改账，onSettled 只响一次', async () => {
  const settled: string[] = []
  const { bridge } = harness({ onSettled: (outcome) => settled.push(outcome.state) })
  await bridge.submit(request())
  const first = bridge.settle('dsh:s1:call_1', 'approved')
  const second = bridge.settle('dsh:s1:call_1', 'approved', { at: T0 + 500 })
  assert.equal(second.decidedAt, first.decidedAt)
  assert.deepEqual(second, first)
  assert.deepEqual(settled, ['approved'])
  assert.equal(bridge.size, 1)
})

test('不翻案：先批准后拒绝，仍是 approved', async () => {
  const { bridge } = harness()
  await bridge.submit(request())
  bridge.settle('dsh:s1:call_1', 'approved')
  const after = bridge.settle('dsh:s1:call_1', 'rejected')
  assert.equal(after.state, 'approved')
  assert.equal(after.dshOutcome, 'allowed-once')
})

test('未知 id：settle / waitFor 都抛 UNKNOWN_REQUEST', async () => {
  const { bridge } = harness()
  assert.throws(() => bridge.settle('nope', 'approved'), (err: unknown) => {
    assert.ok(err instanceof BridgeError)
    assert.equal(err.code, 'UNKNOWN_REQUEST')
    return true
  })
  await assert.rejects(bridge.waitFor('nope'), (err: unknown) => {
    assert.ok(err instanceof BridgeError)
    assert.equal(err.code, 'UNKNOWN_REQUEST')
    return true
  })
  assert.equal(bridge.get('nope'), null)
})

test('非法决定词被拒：INVALID_DECISION，且不改状态', async () => {
  const { bridge } = harness()
  await bridge.submit(request())
  assert.throws(
    () => bridge.settle('dsh:s1:call_1', 'pending' as unknown as BridgeDecision),
    (err: unknown) => err instanceof BridgeError && err.code === 'INVALID_DECISION',
  )
  assert.equal(bridge.get('dsh:s1:call_1')?.state, 'pending')
})

test('超时：到点前不动，到点后 timeout，decidedAt 取 deadline', async () => {
  const { bridge, advance } = harness({ timeoutMs: 1000 })
  await bridge.submit(request())
  assert.deepEqual(bridge.expire(T0 + 999), [])
  assert.equal(bridge.get('dsh:s1:call_1')?.state, 'pending')

  advance(1000)
  const outcome = bridge.get('dsh:s1:call_1')
  assert.equal(outcome?.state, 'timeout')
  assert.equal(outcome?.dshOutcome, 'rejected') // 失败关闭：超时不是放行
  assert.equal(outcome?.decidedAt, T0 + 1000)
  assert.equal(outcome?.decidedBy, 'timeout')
  assert.match(outcome?.note ?? '', /no decision within 1000ms/)
})

test('超时幂等：再 expire 不会再落定一次', async () => {
  const { bridge, advance } = harness({ timeoutMs: 100 })
  await bridge.submit(request())
  advance(100)
  assert.equal(bridge.get('dsh:s1:call_1')?.state, 'timeout')
  assert.deepEqual(bridge.expire(T0 + 1000), [])
})

test('没有 timeoutMs = 不超时，expire 永远不落定', async () => {
  const { bridge } = harness()
  await bridge.submit(request())
  assert.equal(bridge.get('dsh:s1:call_1')?.deadlineAt, null)
  assert.deepEqual(bridge.expire(T0 + 86_400_000), [])
  assert.equal(bridge.get('dsh:s1:call_1')?.state, 'pending')
})

test('实时定时器：不用手动 expire，waitFor 自己等到 timeout', async () => {
  const bridge = createApprovalBridge({ timeoutMs: 5 })
  await bridge.submit(request())
  const outcome = await bridge.waitFor('dsh:s1:call_1')
  assert.equal(outcome.state, 'timeout')
  assert.equal(outcome.dshOutcome, 'rejected')
})

test('并发：三个请求互不干扰，落定中间那个不动其他两个', async () => {
  let seq = 0
  const { bridge } = harness({
    timeoutMs: 10_000,
    request: async () => ({ approvalId: `apr_${++seq}` }),
  })
  const ids = ['a', 'b', 'c']
  for (const id of ids) await bridge.submit(request({ id }))

  assert.equal(bridge.pending().length, 3)
  assert.deepEqual(bridge.pending().map((outcome) => outcome.id), ids)

  bridge.settle('b', 'approved')
  assert.deepEqual(bridge.pending().map((outcome) => outcome.id), ['a', 'c'])
  assert.equal(bridge.get('a')?.approvalId, 'apr_1')
  assert.equal(bridge.get('b')?.approvalId, 'apr_2')
  assert.equal(bridge.get('c')?.approvalId, 'apr_3')

  const waitingA = bridge.waitFor('a')
  bridge.settle('c', 'rejected')
  assert.equal(bridge.get('a')?.state, 'pending') // 别人落定不牵连它
  bridge.settle('a', 'timeout')
  assert.equal((await waitingA).state, 'timeout')
})

test('同一 id 再提交：不重复打控制面，返回既有账目', async () => {
  let calls = 0
  const { bridge } = harness({
    request: async () => {
      calls += 1
      return { approvalId: 'apr_1' }
    },
  })
  await bridge.submit(request())
  bridge.settle('dsh:s1:call_1', 'approved')
  const second = await bridge.submit(request({ consequence: '改了文案也不新建' }))
  assert.equal(calls, 1)
  assert.equal(second.state, 'approved')
  assert.equal(second.request.consequence, 'runs a shell command')
})

test('非法提交：reject 成 INVALID_REQUEST，带逐字段 detail', async () => {
  const { bridge } = harness()
  await assert.rejects(bridge.submit({ id: 'x' }), (err: unknown) => {
    assert.ok(err instanceof BridgeError)
    assert.equal(err.code, 'INVALID_REQUEST')
    const fields = err.detail.map((entry) => entry.field)
    assert.deepEqual(fields, ['workspaceId', 'botId', 'tool'])
    return true
  })
  assert.equal(bridge.size, 0)
})

test('waitFor：落定时解析；已终态则立即解析', async () => {
  const { bridge } = harness()
  await bridge.submit(request())
  const waiting = bridge.waitFor('dsh:s1:call_1')
  bridge.settle('dsh:s1:call_1', 'approved')
  assert.equal((await waiting).state, 'approved')
  assert.equal((await bridge.waitFor('dsh:s1:call_1')).state, 'approved')
})

test('wait 自动作答：后台等到 approved 后自己落定', async () => {
  const seen: Array<string | null> = []
  const { bridge } = harness({
    request: async () => ({ approvalId: 'apr_9' }),
    wait: async (input) => {
      seen.push(input.approvalId)
      return 'approved'
    },
  })
  await bridge.submit(request())
  const outcome = await bridge.waitFor('dsh:s1:call_1')
  assert.deepEqual(seen, ['apr_9'])
  assert.equal(outcome.state, 'approved')
})

test('wait 这一轮没结果：保持 pending，只记 note', async () => {
  const { bridge } = harness({ wait: async () => null })
  await bridge.submit(request())
  await new Promise((resolve) => setTimeout(resolve, 0))
  const outcome = bridge.get('dsh:s1:call_1')
  assert.equal(outcome?.state, 'pending')
  assert.equal(outcome?.note, 'wait returned no decision')
})

test('wait 抛错：不替用户回答，保持 pending 等超时', async () => {
  const { bridge } = harness({
    wait: async () => {
      throw new Error('control plane 502')
    },
  })
  await bridge.submit(request())
  await new Promise((resolve) => setTimeout(resolve, 0))
  const outcome = bridge.get('dsh:s1:call_1')
  assert.equal(outcome?.state, 'pending')
  assert.match(outcome?.note ?? '', /control plane 502/)
})

test('建单失败：失败关闭，标 failure=request_failed 而不是"用户拒绝"', async () => {
  const { bridge } = harness({
    request: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  const outcome = await bridge.submit(request())
  assert.equal(outcome.state, 'rejected')
  assert.equal(outcome.failure, 'request_failed')
  assert.equal(outcome.approvalId, null)
  assert.equal(outcome.decidedBy, 'bridge')
  assert.match(outcome.note ?? '', /ECONNREFUSED/)
  assert.equal(bridge.pending().length, 0)
})

test('dispose：pending 全部按 rejected 关闭，再提交被拒', async () => {
  const { bridge } = harness()
  await bridge.submit(request({ id: 'a' }))
  await bridge.submit(request({ id: 'b' }))
  const waiting = bridge.waitFor('a')

  bridge.dispose()
  assert.equal((await waiting).state, 'rejected')
  assert.equal(bridge.get('a')?.failure, 'disposed')
  assert.equal(bridge.pending().length, 0)
  bridge.dispose() // 幂等
  await assert.rejects(bridge.submit(request({ id: 'c' })), (err: unknown) => {
    assert.ok(err instanceof BridgeError)
    assert.equal(err.code, 'ALREADY_DISPOSED')
    return true
  })
})

test('返回的快照不可变：外部改不动内部账', async () => {
  const { bridge } = harness()
  await bridge.submit(request())
  const outcome = bridge.get('dsh:s1:call_1')
  assert.ok(outcome !== null)
  assert.ok(Object.isFrozen(outcome))
  assert.ok(Object.isFrozen(outcome.request))
  assert.throws(() => {
    ;(outcome as unknown as { state: string }).state = 'approved'
  }, TypeError)
  assert.equal(bridge.get('dsh:s1:call_1')?.state, 'pending')
})

test('timeoutMs 非法：造桥时直接报错，不静默降级', () => {
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createApprovalBridge({ timeoutMs }), TypeError)
  }
  assert.doesNotThrow(() => createApprovalBridge({ timeoutMs: 1 }))
})

test('onSettled 抛错不影响账目', async () => {
  const { bridge } = harness({
    onSettled: () => {
      throw new Error('audit down')
    },
  })
  await bridge.submit(request())
  const outcome = bridge.settle('dsh:s1:call_1', 'approved')
  assert.equal(outcome.state, 'approved')
  assert.equal(bridge.get('dsh:s1:call_1')?.state, 'approved')
})

test('桥对象自身冻结，size 跟随账目', async () => {
  const { bridge } = harness()
  assert.ok(Object.isFrozen(bridge))
  assert.equal(bridge.size, 0)
  await bridge.submit(request())
  assert.equal(bridge.size, 1)
  assert.equal(bridge.list().length, 1)
})

test('类型层面：ApprovalBridge 是 createApprovalBridge 的返回类型', () => {
  const bridge: ApprovalBridge = createApprovalBridge()
  assert.equal(typeof bridge.submit, 'function')
  assert.equal(typeof bridge.waitFor, 'function')
})
