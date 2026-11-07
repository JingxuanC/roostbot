import assert from 'node:assert/strict'
import test from 'node:test'

import { guardAgentEvents } from '../../../../packages/agent-runtime/src/index.ts'
import { ACP_ASSUMPTIONS, createAcpAdapter } from '../../agent-adapters/acp-adapter.mjs'
import { createFakeAcpTransport } from './fake-acp-transport.mjs'

const spec = {
  sessionId: 'room-rm_test-bot_bot1',
  roomId: 'rm_test',
  botId: 'bot_1',
  workspaceId: 'ws_test',
  workdir: '/workspace/agents/bot1',
  env: {},
}

async function collect(iterable: AsyncIterable<{ turnId?: string }>, turnId = 'turn-1'): Promise<any[]> {
  const events: any[] = []
  for await (const event of guardAgentEvents(turnId, iterable as any)) events.push(event)
  return events
}

test('ACP adapter streams text, tools, permission and ends exactly once', async () => {
  const transport = createFakeAcpTransport({
    sessionId: 'acp-session-1',
    prompt: async (_params: unknown, ctx: any) => {
      ctx.emitNotification('session/update', {
        sessionId: 'acp-session-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你' } },
      })
      ctx.emitNotification('session/update', {
        sessionId: 'acp-session-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } },
      })
      ctx.emitNotification('session/update', {
        sessionId: 'acp-session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'read_file',
          rawInput: { path: 'a.txt' },
        },
      })
      ctx.emitNotification('session/update', {
        sessionId: 'acp-session-1',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', rawOutput: 'ok' },
      })
      await ctx.emitRequest('session/request_permission', {
        sessionId: 'acp-session-1',
        toolCall: { title: 'write_file', rawInput: { path: 'b.txt' } },
        options: [
          { optionId: 'allow-1', kind: 'allow_once' },
          { optionId: 'reject-1', kind: 'reject_once' },
        ],
      })
      return { stopReason: 'end_turn' }
    },
  })
  const adapter = createAcpAdapter({
    kind: 'grok-build',
    createTransport: () => transport,
    permissionPolicy: 'allow',
  })
  assert.equal(adapter.capabilities().streaming, true)
  const session = await adapter.openSession(spec)
  const iterable = session.send({ turnId: 'turn-1', input: 'hi', context: {} as any, signal: new AbortController().signal })
  const events = await collect(iterable as any)
  const types = events.map((event) => event.type)
  assert.ok(types.includes('turn.started'))
  assert.deepEqual(events.filter((event) => event.type === 'text.delta').map((event) => event.text), ['你', '好'])
  assert.equal(events.filter((event) => event.type === 'text.final').length, 1)
  assert.equal(events.find((event) => event.type === 'text.final')?.text, '你好')
  assert.equal(events.filter((event) => event.type === 'tool.call').length, 1)
  assert.equal(events.filter((event) => event.type === 'tool.result').length, 1)
  assert.equal(events.filter((event) => event.type === 'permission.request').length, 1)
  assert.equal(events.filter((event) => event.type === 'permission.resolved')[0]?.decision, 'allow')
  assert.equal(events.filter((event) => event.type === 'turn.ended').length, 1)
  assert.equal(events.at(-1)?.reason, 'stop')
  await session.close()
})

test('ACP cancel ends the turn once and sends session/cancel', async () => {
  const transport = createFakeAcpTransport({
    sessionId: 'acp-session-2',
    prompt: () => new Promise(() => {}),
  })
  const adapter = createAcpAdapter({ kind: 'codex', createTransport: () => transport })
  const session = await adapter.openSession({ ...spec, sessionId: 'room-rm_test-bot_bot2' })
  const iterable = session.send({ turnId: 'turn-cancel', input: 'long', context: {} as any, signal: new AbortController().signal })
  const consumer = (async () => {
    const events: any[] = []
    for await (const event of iterable as any) events.push(event)
    return events
  })()
  await new Promise((resolve) => setTimeout(resolve, 10))
  await session.cancel('turn-cancel', 'user')
  const events = await consumer
  assert.equal(events.filter((event) => event.type === 'turn.ended').length, 1)
  assert.equal(events.at(-1)?.reason, 'cancelled')
  assert.ok(transport.sentNotifications.some((item: any) => item.method === 'session/cancel'))
  await session.close()
})

test('ACP prompt failure becomes error + turn.ended(error)', async () => {
  const transport = createFakeAcpTransport({
    sessionId: 'acp-session-3',
    prompt: async () => {
      throw Object.assign(new Error('boom'), { code: 'acp.prompt_failed' })
    },
  })
  const adapter = createAcpAdapter({ kind: 'grok-build', createTransport: () => transport })
  const session = await adapter.openSession({ ...spec, sessionId: 'room-rm_test-bot_bot3' })
  const events = await collect(session.send({
    turnId: 'turn-fail',
    input: 'x',
    context: {} as any,
    signal: new AbortController().signal,
  }) as any, 'turn-fail')
  assert.ok(events.some((event) => event.type === 'error'))
  assert.equal(events.filter((event) => event.type === 'turn.ended').length, 1)
  assert.equal(events.at(-1)?.reason, 'error')
  await session.close()
})

test('ACP probe reports the initialized agent version and failures stay data', async () => {
  const transport = createFakeAcpTransport({ sessionId: 'acp-probe' })
  const adapter = createAcpAdapter({ kind: 'codex', createTransport: () => transport })
  const probe = await adapter.probe()
  assert.equal(probe.ok, true)
  assert.equal(probe.version, '1.2.3')
  assert.equal(transport.closed, true)
  assert.equal(transport.calls.initialize, 1)

  const broken = createAcpAdapter({
    kind: 'grok-build',
    createTransport: () => { throw new Error('spawn ENOENT') },
  })
  const failed = await broken.probe()
  assert.equal(failed.ok, false)
  assert.equal(failed.auth, 'unknown')
  assert.match(failed.problems[0], /ENOENT/)
})

test('ACP missing terminal: a turn timeout ends the turn exactly once', async () => {
  const transport = createFakeAcpTransport({ sessionId: 'acp-timeout', prompt: () => new Promise(() => {}) })
  const adapter = createAcpAdapter({ kind: 'grok-build', createTransport: () => transport })
  const session = await adapter.openSession(spec)
  const events = await collect(session.send({
    turnId: 'turn-timeout',
    input: 'hangs',
    context: {} as any,
    signal: new AbortController().signal,
  }, { timeoutMs: 20 }) as any, 'turn-timeout')
  assert.equal(events.filter((event) => event.type === 'turn.ended').length, 1)
  assert.equal(events.at(-1)?.reason, 'timeout')
  assert.equal(transport.calls.cancel, 1)
  await session.close()
})

test('ACP duplicate final variants cannot produce two text.final frames', async () => {
  const transport = createFakeAcpTransport({
    sessionId: 'acp-dup',
    prompt: async (params: any, ctx: any) => {
      const update = { sessionUpdate: 'agent_message_final', content: { type: 'text', text: 'same' } }
      ctx.emitNotification('session/update', { sessionId: params.sessionId, update })
      ctx.emitNotification('session/update', { sessionId: params.sessionId, update })
      return { stopReason: 'end_turn' }
    },
  })
  const adapter = createAcpAdapter({ kind: 'grok-build', createTransport: () => transport })
  const session = await adapter.openSession(spec)
  const events = await collect(session.send({
    turnId: 'turn-dup', input: 'x', context: {} as any, signal: new AbortController().signal,
  }) as any, 'turn-dup')
  assert.equal(events.filter((event) => event.type === 'text.final').length, 1)
  assert.equal(events.filter((event) => event.type === 'turn.ended').length, 1)
  await session.close()
})

test('ACP session is single-turn and capabilities are honest', async () => {
  const transport = createFakeAcpTransport({ sessionId: 'acp-busy', prompt: () => new Promise(() => {}) })
  const adapter = createAcpAdapter({ kind: 'grok-build', createTransport: () => transport })
  assert.equal(adapter.capabilities().streaming, true)
  assert.equal(adapter.capabilities().permissions, 'native')
  assert.throws(() => createAcpAdapter({ kind: 'hermes' }), /grok-build or codex/)
  const session = await adapter.openSession(spec)
  const iterable = session.send({ turnId: 'busy-1', input: 'a', context: {} as any, signal: new AbortController().signal })
  const consumer = (async () => { const out: any[] = []; for await (const event of iterable as any) out.push(event); return out })()
  await assert.rejects(async () => session.send({ turnId: 'busy-2', input: 'b', context: {} as any, signal: new AbortController().signal }), /one turn at a time/)
  await session.cancel('busy-1', 'user')
  await consumer
  await session.close()
})

test('ACP assumptions are documented for live Grok Build verification', () => {
  assert.equal(ACP_ASSUMPTIONS.initialize.method, 'initialize')
  assert.equal(ACP_ASSUMPTIONS.newSession.method, 'session/new')
  assert.equal(ACP_ASSUMPTIONS.prompt.method, 'session/prompt')
  assert.equal(ACP_ASSUMPTIONS.cancel.kind, 'notification')
  assert.ok(ACP_ASSUMPTIONS.updateVariants.includes('agent_message_chunk'))
})
