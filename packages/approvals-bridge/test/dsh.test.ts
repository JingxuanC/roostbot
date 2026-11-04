// DSH 适配器：注册形态、请求翻译、结果词映射、撤回与失败关闭。
// 不 import 任何 DSH 包 —— 适配器是鸭子类型的，所以测试用假 ctx 就够。

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BridgeError,
  DSH_APPROVAL_VERSION,
  createApprovalBridge,
  defaultRequestId,
  describeDshApprovalSurface,
  describeDshRequest,
  installApprovalBridge,
} from '../src/index.ts'
import type {
  ApprovalBridgeOptions,
  ApprovalRequest,
  DshAnswerer,
  DshApprovalOutcome,
  DshApprovalRequestEvent,
} from '../src/index.ts'

const T0 = 1_700_000_000_000
const SCOPE = { workspaceId: 'ws_1', botId: 'bot_1' }

function fakeContext() {
  const registered: Array<{ event: string; listener: DshAnswerer }> = []
  let disposals = 0
  return {
    ctx: {
      on(event: string, listener: DshAnswerer) {
        registered.push({ event, listener })
        return () => {
          disposals += 1
        }
      },
    },
    registered,
    disposals: () => disposals,
  }
}

function event(overrides: Partial<DshApprovalRequestEvent> = {}): DshApprovalRequestEvent {
  return {
    agent: { session: { id: 'sess_1' } },
    toolName: 'bash',
    callId: 'call_1',
    reason: 'needs network',
    ...overrides,
  }
}

function never(): Promise<never> {
  return new Promise<never>(() => {})
}

function bridgeWith(options: Partial<ApprovalBridgeOptions> = {}) {
  const submitted: ApprovalRequest[] = []
  const bridge = createApprovalBridge({
    timeoutMs: 20,
    request: async (input) => {
      submitted.push(input)
      return { approvalId: 'apr_1' }
    },
    ...options,
  })
  return { bridge, submitted }
}

test('describeDshApprovalSurface：DSH 有公开钩子，supported=true 且给出证据行号', () => {
  const surface = describeDshApprovalSurface()
  assert.equal(surface.supported, true)
  assert.equal(surface.reason, null)
  assert.equal(surface.version, DSH_APPROVAL_VERSION)
  assert.equal(surface.seam.event, 'approval/request')
  assert.equal(surface.seam.mode, 'waterfall')
  assert.equal(surface.seam.service, 'ctx.approval (ApprovalService)')
  assert.deepEqual([...surface.seam.outcomes], ['allowed-once', 'rejected', 'cancelled', 'unavailable'])
  assert.ok(surface.findings.length >= 12)
  for (const finding of surface.findings) {
    assert.ok(finding.file.includes('@deepseek-ai/'), finding.file)
    assert.ok(Number.isInteger(finding.line) && finding.line > 0, finding.file)
    assert.equal(typeof finding.fact, 'string')
    assert.ok(finding.fact.length > 10)
  }
})

test('describeDshApprovalSurface：引用的是真实的声明与派发位置', () => {
  const surface = describeDshApprovalSurface()
  const has = (file: string, line: number): boolean =>
    surface.findings.some((finding) => finding.file.endsWith(file) && finding.line === line)

  // waterfall 声明 / 结果词 / ctx.approval 注入 / 派发与失败关闭
  assert.ok(has('dsh-user-approval/lib/types/types.d.ts', 81))
  assert.ok(has('dsh-user-approval/lib/types/types.d.ts', 26))
  assert.ok(has('dsh-user-approval/lib/types/index.d.ts', 21))
  assert.ok(has('dsh-user-approval/lib/index.js', 176))
  // host 侧 answerer 先例
  assert.ok(has('dsh-acp/lib/index.js', 1158))
  // 进程外 SDK 没有审批方法
  assert.ok(has('dsh-sdk-jsonrpc-server/lib/index.js', 275))
  // 返回同一份冻结事实，避免调用方改坏
  assert.equal(describeDshApprovalSurface(), surface)
  assert.ok(Object.isFrozen(surface))
  assert.ok(Object.isFrozen(surface.findings))
})

test('describeDshApprovalSurface：剩下的缺口写清楚，不假装完备', () => {
  const gaps = describeDshApprovalSurface().gaps.join('\n')
  assert.match(gaps, /不带工具参数/)
  assert.match(gaps, /没有 allow-always/)
  assert.match(gaps, /turn/)
  assert.match(gaps, /没有撤销接口/)
  assert.match(gaps, /JSON-RPC/)
})

test('installApprovalBridge：注册成一个 approval/request answerer，dispose 可摘掉', () => {
  const { ctx, registered, disposals } = fakeContext()
  const { bridge } = bridgeWith()
  const handle = installApprovalBridge(ctx, bridge, { scope: SCOPE })
  assert.equal(registered.length, 1)
  assert.equal(registered[0]?.event, 'approval/request')
  assert.equal(registered[0]?.listener, handle.listener)
  assert.equal(handle.event, 'approval/request')

  handle.dispose()
  assert.equal(disposals(), 1)
  handle.dispose()
  assert.equal(disposals(), 1) // 幂等
  bridge.dispose()
})

test('installApprovalBridge：ctx 不像 Cordis 就报 TypeError', () => {
  const { bridge } = bridgeWith()
  assert.throws(() => installApprovalBridge({} as never, bridge, { scope: SCOPE }), TypeError)
  assert.throws(() => installApprovalBridge(null as never, bridge, { scope: SCOPE }), TypeError)
  bridge.dispose()
})

test('批准：answerer 返回 allowed-once，并把控制面审批 id 带回来', async () => {
  const { ctx, registered } = fakeContext()
  const { bridge, submitted } = bridgeWith({
    wait: async (input) => {
      assert.equal(input.approvalId, 'apr_1')
      return 'approved'
    },
  })
  const before = Date.now()
  const handle = installApprovalBridge(ctx, bridge, { scope: SCOPE })
  const outcome = await registered[0]!.listener(event(), async () => 'unavailable')
  const after = Date.now()
  assert.equal(outcome, 'allowed-once')
  assert.equal(submitted.length, 1)
  const sent = submitted[0]!
  assert.deepEqual(
    { ...sent, requestedAt: 0 },
    {
      id: 'dsh:sess_1:call_1',
      workspaceId: 'ws_1',
      botId: 'bot_1',
      tool: 'bash',
      argsSummary: 'bash (call call_1) — needs network',
      consequence: 'needs network',
      requestedAt: 0,
    },
  )
  assert.ok(sent.requestedAt >= before && sent.requestedAt <= after, `requestedAt=${sent.requestedAt}`)
  handle.dispose()
  bridge.dispose()
})

test('拒绝：answerer 返回 rejected', async () => {
  const { ctx, registered } = fakeContext()
  const { bridge } = bridgeWith({ wait: async () => 'rejected' })
  installApprovalBridge(ctx, bridge, { scope: SCOPE })
  assert.equal(await registered[0]!.listener(event(), async () => 'unavailable'), 'rejected')
  bridge.dispose()
})

test('超时：DSH 侧也是 rejected（失败关闭），不是 unavailable', async () => {
  const { ctx, registered } = fakeContext()
  const bridge = createApprovalBridge({ timeoutMs: 5, request: async () => ({ approvalId: 'apr_1' }), wait: never })
  installApprovalBridge(ctx, bridge, { scope: SCOPE })
  assert.equal(await registered[0]!.listener(event(), async () => 'unavailable'), 'rejected')
  bridge.dispose()
})

test('撤回：调用前已 abort 就答 cancelled，且不打扰人（不建单）', async () => {
  const { ctx, registered } = fakeContext()
  const { bridge, submitted } = bridgeWith()
  installApprovalBridge(ctx, bridge, { scope: SCOPE })
  const controller = new AbortController()
  controller.abort()
  const outcome = await registered[0]!.listener(event({ signal: controller.signal }), async () => 'unavailable')
  assert.equal(outcome, 'cancelled')
  assert.equal(submitted.length, 0)
  assert.equal(bridge.size, 0)
  bridge.dispose()
})

test('撤回：等待期间 abort，立刻答 cancelled，迟到答案被丢掉', async () => {
  const { ctx, registered } = fakeContext()
  const { bridge } = bridgeWith({ wait: never })
  installApprovalBridge(ctx, bridge, { scope: SCOPE })
  const controller = new AbortController()
  const answering = registered[0]!.listener(event({ signal: controller.signal }), async () => 'unavailable')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(bridge.pending().length, 1)
  controller.abort()
  assert.equal(await answering, 'cancelled')
  // 控制面那张单没有被撤销（没有撤销接口），桥也不假装撤销：仍是 pending。
  assert.equal(bridge.pending().length, 1)
  bridge.dispose()
})

test('建单失败：答 unavailable（通道不可用 ≠ 用户拒绝）', async () => {
  const { ctx, registered } = fakeContext()
  const { bridge } = bridgeWith({
    request: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  installApprovalBridge(ctx, bridge, { scope: SCOPE })
  assert.equal(await registered[0]!.listener(event(), async () => 'unavailable'), 'unavailable')
  bridge.dispose()
})

test('桥自己坏了（已 dispose）：默认失败关闭，可换成交回链上', async () => {
  const { ctx, registered } = fakeContext()
  const { bridge } = bridgeWith()
  installApprovalBridge(ctx, bridge, { scope: SCOPE })
  bridge.dispose()
  const listener = registered[0]!.listener
  assert.equal(await listener(event(), async () => 'unavailable'), 'unavailable')

  const second = fakeContext()
  installApprovalBridge(second.ctx, bridge, { scope: SCOPE, now: () => T0, fallback: (_request, next) => next() })
  const outcome: DshApprovalOutcome = await second.registered[0]!.listener(event(), async () => 'rejected')
  assert.equal(outcome, 'rejected')
})

test('scope 是函数且返回 null：不归本桥管，交给链上下一个 answerer', async () => {
  const { ctx, registered } = fakeContext()
  const { bridge, submitted } = bridgeWith()
  installApprovalBridge(ctx, bridge, {
    scope: (incoming) => (incoming.toolName === 'bash' ? SCOPE : null),
  })
  let delegated = 0
  const outcome = await registered[0]!.listener(event({ toolName: 'read_file' }), async () => {
    delegated += 1
    return 'allowed-once'
  })
  assert.equal(outcome, 'allowed-once')
  assert.equal(delegated, 1)
  assert.equal(submitted.length, 0)
  bridge.dispose()
})

test('畸形请求（没有 toolName）：不认领，直接 next()', async () => {
  const { ctx, registered } = fakeContext()
  const { bridge, submitted } = bridgeWith()
  installApprovalBridge(ctx, bridge, { scope: SCOPE })
  const outcome = await registered[0]!.listener({} as DshApprovalRequestEvent, async () => 'unavailable')
  assert.equal(outcome, 'unavailable')
  assert.equal(submitted.length, 0)
  bridge.dispose()
})

test('自定义 requestId / describe：可插入 Card 文案与自定 id', async () => {
  const { ctx, registered } = fakeContext()
  const clock = T0 + 1
  const { bridge, submitted } = bridgeWith({ now: () => clock, wait: async () => 'approved' })
  installApprovalBridge(ctx, bridge, {
    scope: SCOPE,
    requestId: (incoming) => `custom:${incoming.toolName}`,
    describe: (incoming) => ({ argsSummary: `ARGS ${incoming.callId}`, consequence: 'CONSEQUENCE' }),
    now: () => clock,
  })
  assert.equal(await registered[0]!.listener(event(), async () => 'unavailable'), 'allowed-once')
  assert.equal(submitted[0]?.id, 'custom:bash')
  assert.equal(submitted[0]?.argsSummary, 'ARGS call_1')
  assert.equal(submitted[0]?.consequence, 'CONSEQUENCE')
  assert.equal(submitted[0]?.requestedAt, clock)
  bridge.dispose()
})

test('describeDshRequest：没有 reason 时也给出可展示的后果说明', () => {
  const withReason = describeDshRequest(event())
  assert.match(withReason.argsSummary, /^bash \(call call_1\) — needs network$/)
  assert.equal(withReason.consequence, 'needs network')

  const without = describeDshRequest({ toolName: 'bash' })
  assert.equal(without.argsSummary, 'bash')
  assert.match(without.consequence, /no recorded justification/)
})

test('defaultRequestId：同一次工具调用（callId）复用同一张单，没有 callId 才另开', () => {
  const next = defaultRequestId()
  assert.equal(next(event()), next(event()))
  assert.equal(next(event({ callId: 'call_2' })), next(event({ callId: 'call_2' })))
  const first = next(event({ callId: undefined }))
  const second = next(event({ callId: undefined }))
  assert.notEqual(first, second)
  assert.ok(first.startsWith('dsh:sess_1:bash:'))
})

test('同一 callId 被问两次：第二次复用已落定的结果，不重复建单', async () => {
  const { ctx, registered } = fakeContext()
  const { bridge, submitted } = bridgeWith({ wait: async () => 'rejected' })
  installApprovalBridge(ctx, bridge, { scope: SCOPE })
  assert.equal(await registered[0]!.listener(event(), async () => 'unavailable'), 'rejected')
  assert.equal(await registered[0]!.listener(event(), async () => 'unavailable'), 'rejected')
  assert.equal(submitted.length, 1)
  bridge.dispose()
})

test('BridgeError 依然是桥的唯一错误类型（适配器不吞成别的）', () => {
  const error = new BridgeError('UNKNOWN_REQUEST', 'nope')
  assert.equal(error.code, 'UNKNOWN_REQUEST')
  assert.deepEqual(error.detail, [])
})
