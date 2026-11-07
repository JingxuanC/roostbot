import assert from 'node:assert/strict'
import test from 'node:test'

import { guardAgentEvents } from '../../../../packages/agent-runtime/src/index.ts'
import { createAcpAdapter } from '../../agent-adapters/acp-adapter.mjs'
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
