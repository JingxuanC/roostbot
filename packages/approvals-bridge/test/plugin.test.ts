// Cordis 插件入口：真实 HTTP 形状（POST 建单 / GET 轮询）+ 失败关闭。
//
// 这里不碰真网络：fetch 注入一个记录请求的假实现，sleep 在退避测试里也注入。
// 超时用桥自己的定时器（timeoutMs 很小），所以用例是毫秒级，不需要 mock 时钟。

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, describeForCard } from '../src/plugin.ts'
import type { ApprovalBridgePluginConfig, ApprovalBridgePluginDeps } from '../src/plugin.ts'
import type { DshAnswerer, DshApprovalOutcome, DshApprovalRequestEvent } from '../src/dsh.ts'

const CONFIG: ApprovalBridgePluginConfig = {
  apiBase: 'http://cp.test:8792/',
  runtimeToken: 'rt_test',
  workspaceId: 'ws_1',
  botId: 'bot_1',
}

interface FetchCall {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

type Reply = Response | Error | (() => Response | Promise<Response>)

/** 按顺序消耗 reply 的假 fetch；用完后重复最后一个。 */
function fakeFetch(replies: Reply[]): { fetch: typeof fetch; calls: FetchCall[]; getCalls: () => FetchCall[] } {
  const calls: FetchCall[] = []
  let index = 0
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method: init?.method ?? 'GET', url, headers, body })
    const reply = replies[Math.min(index, replies.length - 1)]
    index += 1
    if (reply instanceof Error) throw reply
    return typeof reply === 'function' ? await reply() : reply
  }
  return { fetch: impl as typeof fetch, calls, getCalls: () => calls.filter((call) => call.method === 'GET') }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function fakeContext() {
  let listener: DshAnswerer | null = null
  return {
    ctx: {
      on(event: string, answer: DshAnswerer) {
        // The plugin also subscribes to agent/assistant-stream for token deltas.
        if (event === 'agent/assistant-stream') return () => {}
        assert.equal(event, 'approval/request')
        listener = answer
        return () => {}
      },
    },
    answer: () => {
      assert.notEqual(listener, null)
      return listener as DshAnswerer
    },
  }
}

function event(overrides: Partial<DshApprovalRequestEvent> = {}): DshApprovalRequestEvent {
  return {
    agent: { session: { id: 'sess_1' } },
    toolName: 'bash',
    callId: 'call_1',
    reason: 'needs network',
    displayReason: { en: 'Allow network access', zh: '允许访问网络' },
    ...overrides,
  }
}

async function next(): Promise<DshApprovalOutcome> {
  return 'unavailable'
}

async function run(
  replies: Reply[],
  config: Partial<ApprovalBridgePluginConfig> = {},
  deps: ApprovalBridgePluginDeps = {},
  request: DshApprovalRequestEvent = event(),
): Promise<{ outcome: DshApprovalOutcome; calls: FetchCall[]; handle: ReturnType<typeof apply> }> {
  const fake = fakeFetch(replies)
  const fakeCtx = fakeContext()
  const handle = apply(fakeCtx.ctx, { ...CONFIG, ...config }, { fetch: fake.fetch, ...deps })
  const outcome = await fakeCtx.answer()(request, next)
  return { outcome, calls: fake.calls, handle }
}

test('建单：POST 控制面，卡片字段来自 toolName / callId / displayReason', async () => {
  const { outcome, calls } = await run([json({ approval: { id: 'apr_1' } }, 201), json({ approval: { status: 'approved' } })])
  assert.equal(outcome, 'allowed-once')

  const post = calls[0]
  assert.equal(post.method, 'POST')
  assert.equal(post.url, 'http://cp.test:8792/api/internal/approvals')
  assert.equal(post.headers['x-runtime-token'], 'rt_test')
  assert.equal(post.headers['content-type'], 'application/json')
  assert.deepEqual(post.body, {
    workspaceId: 'ws_1',
    kind: 'tool.call',
    requester: 'bot_1',
    requesterKind: 'bot',
    action: '调用工具 bash',
    target: 'dsh:sess_1:call_1',
    consequence: '允许访问网络',
    payload: { tool: 'bash', callId: 'call_1' },
  })
})

test('批准：GET 轮询看到 approved 后答 allowed-once', async () => {
  const { outcome, calls } = await run([
    json({ approval: { id: 'apr_1' } }, 201),
    json({ approval: { status: 'pending' } }),
    json({ approval: { status: 'approved' } }),
  ])
  assert.equal(outcome, 'allowed-once')
  const gets = calls.filter((call) => call.method === 'GET')
  assert.equal(gets.length, 2)
  assert.equal(gets[0].url, 'http://cp.test:8792/api/internal/approvals/apr_1')
  assert.equal(gets[0].headers['x-runtime-token'], 'rt_test')
})

test('拒绝：rejected → DSH rejected（不是 unavailable）', async () => {
  const { outcome } = await run([json({ approval: { id: 'apr_1' } }, 201), json({ approval: { status: 'rejected' } })])
  assert.equal(outcome, 'rejected')
})

test('超时：一直 pending → 桥记 timeout，DSH 答 rejected（失败关闭）', async () => {
  const { outcome, handle } = await run(
    [json({ approval: { id: 'apr_1' } }, 201), json({ approval: { status: 'pending' } })],
    { timeoutMs: 60 },
    { pollIntervalMs: 5, maxPollIntervalMs: 10 },
  )
  assert.equal(outcome, 'rejected')
  const ledger = handle.bridge.get('dsh:sess_1:call_1')
  assert.notEqual(ledger, null)
  assert.equal(ledger?.state, 'timeout')
  assert.equal(ledger?.decidedBy, 'timeout')
  assert.equal(ledger?.dshOutcome, 'rejected')
})

test('建单失败：502 → unavailable，账本记 request_failed（不是用户拒绝）', async () => {
  const { outcome, calls, handle } = await run([json({ error: 'boom' }, 502)])
  assert.equal(outcome, 'unavailable')
  assert.equal(calls.filter((call) => call.method === 'GET').length, 0)
  const ledger = handle.bridge.get('dsh:sess_1:call_1')
  assert.equal(ledger?.failure, 'request_failed')
  assert.equal(ledger?.state, 'rejected')
})

test('网络异常：fetch 抛错同样是 unavailable', async () => {
  const { outcome } = await run([new Error('ECONNREFUSED')])
  assert.equal(outcome, 'unavailable')
})

test('长期授权：granted:true（没有 approval id）直接放行，不轮询', async () => {
  const { outcome, calls } = await run([json({ approval: null, granted: true })])
  assert.equal(outcome, 'allowed-once')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
})

test('轮询抖动：GET 500 不替用户拒绝，等到超时仍失败关闭', async () => {
  const { outcome, handle } = await run(
    [json({ approval: { id: 'apr_1' } }, 201), json({ error: 'store down' }, 500)],
    { timeoutMs: 60 },
    { pollIntervalMs: 5, maxPollIntervalMs: 10 },
  )
  assert.equal(outcome, 'rejected')
  const ledger = handle.bridge.get('dsh:sess_1:call_1')
  assert.equal(ledger?.state, 'timeout')
  assert.match(ledger?.note ?? '', /no decision within 60ms/)
})

test('退避：500ms → 1s → 2s 封顶（按注入的 sleep 观测到的序列）', async () => {
  const sleeps: number[] = []
  const { outcome } = await run(
    [
      json({ approval: { id: 'apr_1' } }, 201),
      json({ approval: { status: 'pending' } }),
      json({ approval: { status: 'pending' } }),
      json({ approval: { status: 'approved' } }),
    ],
    { timeoutMs: 60_000 },
    {
      pollIntervalMs: 500,
      maxPollIntervalMs: 2_000,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    },
  )
  assert.equal(outcome, 'allowed-once')
  assert.deepEqual(sleeps, [500, 1_000])
})

test('DSH 撤回（signal 已 abort）：答 cancelled，既不建单也不轮询', async () => {
  const controller = new AbortController()
  controller.abort()
  const { outcome, calls } = await run(
    [json({ approval: { id: 'apr_1' } }, 201), json({ approval: { status: 'approved' } })],
    {},
    {},
    event({ signal: controller.signal }),
  )
  assert.equal(outcome, 'cancelled')
  assert.equal(calls.length, 0)
})

test('默认超时 5 分钟：submit 后 deadlineAt 就是 requestedAt + 300000', async () => {
  const fake = fakeFetch([json({ approval: { id: 'apr_1' } }, 201), json({ approval: { status: 'pending' } })])
  const fakeCtx = fakeContext()
  const handle = apply(fakeCtx.ctx, CONFIG, { fetch: fake.fetch, pollIntervalMs: 5 })
  try {
    const requestedAt = 1_700_000_000_000
    const outcome = await handle.bridge.submit({
      id: 'manual_1',
      workspaceId: 'ws_1',
      botId: 'bot_1',
      tool: 'bash',
      argsSummary: 'bash — test',
      consequence: 'test',
      requestedAt,
    })
    assert.equal(outcome.deadlineAt, requestedAt + 300_000)
  } finally {
    handle.bridge.dispose()
  }
})

test('配置校验：缺 apiBase / timeoutMs 非法 / ctx 没有 on 都立刻报错', () => {
  const fakeCtx = fakeContext()
  assert.throws(() => apply(fakeCtx.ctx, { ...CONFIG, apiBase: '' }), /apiBase/)
  assert.throws(() => apply(fakeCtx.ctx, { ...CONFIG, apiBase: 'ftp://x' }), /http/)
  assert.throws(() => apply(fakeCtx.ctx, { ...CONFIG, timeoutMs: 0 }), /timeoutMs/)
  assert.throws(
    () => apply({} as never, CONFIG),
    /Cordis-like ctx/,
  )
})

test('describeForCard：中文 displayReason 优先，没有理由时有明确兜底', () => {
  assert.deepEqual(describeForCard(event()), {
    argsSummary: 'bash (call call_1) — 允许访问网络',
    consequence: '允许访问网络',
  })
  assert.deepEqual(describeForCard(event({ callId: undefined, reason: '', displayReason: undefined })), {
    argsSummary: 'bash',
    consequence: 'tool bash will run with no recorded justification',
  })
})
