// Registry tests: runtime-kind selection, the delegated DSH adapter, the DSH
// JSON-RPC mapping and explicit unsupported kinds. No vendor binary.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AgentRuntimeError, guardAgentEvents } from '../../../../packages/agent-runtime/src/index.ts'
import { REGISTRY_KINDS, createDshAdapter, createRuntimeAdapter } from '../../agent-adapters/registry.mjs'
import { createFakeAcpTransport } from './fake-acp-transport.mjs'
import { createFakeSpawn } from './fake-child.mjs'

const spec = {
  sessionId: 'room-rm_1-bot_1',
  roomId: 'rm_1',
  botId: 'bot_1',
  workspaceId: 'ws_1',
  workdir: '/workspace/agents/bot_1',
  env: {},
}

const turn = {
  turnId: 't1',
  input: '你好',
  context: { roomName: 'room', members: [], recentMessages: [], artifacts: [], tokenBudget: 1000 },
  signal: new AbortController().signal,
}

async function collect(iterable) {
  const events = []
  for await (const event of iterable) events.push(event)
  return events
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Minimal JsonRpcProcessClient-compatible fake for the DSH adapter. */
function createFakeDshClient() {
  const handlers = new Map()
  const requests = []
  let closed = false
  return {
    requests,
    handlers,
    get closed() {
      return closed
    },
    on(method, handler) {
      handlers.set(method, handler)
    },
    async request(method, params) {
      requests.push({ method, params })
      if (method === 'session/prompt') return { messageId: 'm1' }
      if (method === 'session/cancel') return {}
      if (method === 'session/resume') return {}
      throw new Error(`unexpected DSH method: ${method}`)
    },
    emit(method, params) {
      handlers.get(method)?.(params)
    },
    close() {
      closed = true
    },
  }
}

test('the registry selects ACP for grok-build and codex', async () => {
  assert.ok(REGISTRY_KINDS.includes('grok-build'))
  const transport = createFakeAcpTransport({ sessionId: 'acp-1' })
  const grok = createRuntimeAdapter('grok-build', { command: 'fake-grok', createTransport: () => transport })
  assert.equal(grok.kind, 'grok-build')
  assert.equal(grok.capabilities().permissions, 'native')
  const session = await grok.openSession(spec)
  assert.equal(session.acpSessionId, 'acp-1')

  const codexTransport = createFakeAcpTransport({ sessionId: 'acp-2' })
  const codex = createRuntimeAdapter('codex', { command: 'fake-codex', createTransport: () => codexTransport })
  assert.equal(codex.kind, 'codex')
  assert.equal(codex.capabilities().permissions, 'bridge')
  assert.equal((await codex.openSession({ ...spec, botId: 'bot_2' })).acpSessionId, 'acp-2')
})

test('the registry selects the NDJSON CLI for claude-code', async () => {
  const children = []
  const adapter = createRuntimeAdapter('claude-code', {
    command: 'fake-claude',
    spawn: createFakeSpawn(children),
  })
  assert.equal(adapter.kind, 'claude-code')
  assert.equal(adapter.capabilities().permissions, 'none')
  const session = await adapter.openSession(spec)
  assert.equal(session.id, spec.sessionId)
  assert.equal(children.length, 1)
  assert.equal(children[0].command, 'fake-claude')
})

test('hermes and unknown kinds are explicit errors, not silent fallbacks', () => {
  assert.throws(() => createRuntimeAdapter('hermes'), (error) => {
    assert.ok(error instanceof AgentRuntimeError)
    assert.equal(error.code, 'runtime.unsupported')
    assert.match(error.message, /hermes/)
    return true
  })
  assert.throws(() => createRuntimeAdapter('mystery'), (error) => error.code === 'runtime.unsupported')
})

test('dsh delegates openSession to the current room-agent session', async () => {
  const delegateSession = {
    id: 'delegated',
    send() { return (async function* empty() {})() },
    async cancel() {},
    async close() {},
  }
  let seenSpec = null
  const adapter = createRuntimeAdapter('dsh', {
    delegate: {
      async probe() {
        return { ok: true, version: 'dsh-1', auth: 'ok', problems: [] }
      },
      async openSession(value) {
        seenSpec = value
        return delegateSession
      },
    },
  })
  assert.equal(adapter.kind, 'dsh')
  assert.equal(adapter.capabilities().permissions, 'bridge')
  assert.equal((await adapter.probe()).version, 'dsh-1')
  assert.equal(await adapter.openSession(spec), delegateSession)
  assert.equal(seenSpec.sessionId, spec.sessionId)
})

test('dsh without a delegate or client is a configuration error', async () => {
  const adapter = createDshAdapter({})
  const probe = await adapter.probe()
  assert.equal(probe.ok, false)
  assert.match(probe.problems[0], /delegate or a JsonRpcProcessClient/)
  await assert.rejects(() => adapter.openSession(spec), (error) => error.code === 'runtime.misconfigured')
})

test('dsh maps assistant live chunks, final message and idle status to one turn', async () => {
  const client = createFakeDshClient()
  const adapter = createRuntimeAdapter('dsh', { client })
  const session = await adapter.openSession(spec)

  const eventsPromise = collect(guardAgentEvents('t1', session.send(turn)))
  await tick()
  assert.equal(client.requests[0].method, 'session/resume')
  client.emit('session.event', { sessionId: spec.sessionId, event: { type: 'assistant/live-chunk', data: { chunk: { type: 'text-delta', text: '你' } } } })
  client.emit('session.event', { sessionId: spec.sessionId, event: { type: 'assistant/live-chunk', data: { chunk: { type: 'text-delta', text: '好' } } } })
  client.emit('session.event', { sessionId: spec.sessionId, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '你好' }] } } } })
  client.emit('session.status', { sessionId: spec.sessionId, status: 'idle' })
  const events = await eventsPromise

  assert.deepEqual(events.map((event) => event.type), [
    'turn.started',
    'text.delta',
    'text.delta',
    'text.final',
    'usage',
    'turn.ended',
  ])
  assert.deepEqual(events.filter((event) => event.type === 'text.delta').map((event) => event.text), ['你', '好'])
  assert.equal(events.find((event) => event.type === 'text.final').text, '你好')
  assert.equal(events.find((event) => event.type === 'usage').estimated, true)
  assert.equal(events.at(-1).reason, 'stop')
  assert.equal(client.requests.find((request) => request.method === 'session/prompt').params.contentBlocks[0].text, '你好')
  await session.close()
})

test('dsh ignores events for other sessions and duplicate final text', async () => {
  const client = createFakeDshClient()
  const adapter = createRuntimeAdapter('dsh', { client })
  const session = await adapter.openSession(spec)
  const eventsPromise = collect(guardAgentEvents('t1', session.send(turn)))
  await tick()
  client.emit('session.event', { sessionId: 'someone-else', event: { type: 'assistant/live-chunk', data: { chunk: { type: 'text-delta', text: 'wrong' } } } })
  const message = { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答案' }] } } }
  client.emit('session.event', { sessionId: spec.sessionId, event: message })
  client.emit('session.event', { sessionId: spec.sessionId, event: message })
  client.emit('session.status', { sessionId: spec.sessionId, status: 'idle' })
  const events = await eventsPromise
  assert.equal(events.some((event) => event.type === 'text.delta'), false)
  assert.equal(events.filter((event) => event.type === 'text.final').length, 1)
  assert.equal(events.at(-1).reason, 'stop')
})

test('dsh turn timeout and cancel end exactly once', async () => {
  const client = createFakeDshClient()
  const adapter = createRuntimeAdapter('dsh', { client, turnTimeoutMs: 20 })
  const session = await adapter.openSession(spec)
  const events = await collect(guardAgentEvents('t1', session.send(turn)))
  assert.equal(events.filter((event) => event.type === 'turn.ended').length, 1)
  assert.equal(events.at(-1).reason, 'timeout')

  const second = await adapter.openSession({ ...spec, sessionId: 'room-rm_1-bot_2' })
  const pending = collect(guardAgentEvents('t2', second.send({ ...turn, turnId: 't2' })))
  await tick()
  await second.cancel('t2', 'user')
  const cancelled = await pending
  assert.equal(cancelled.at(-1).reason, 'cancelled')
  assert.ok(client.requests.some((request) => request.method === 'session/cancel'))
})

test('dsh rejects a second concurrent turn', async () => {
  const client = createFakeDshClient()
  const adapter = createRuntimeAdapter('dsh', { client, turnTimeoutMs: 0 })
  const session = await adapter.openSession(spec)
  const first = session.send(turn)
  const consumer = collect(first)
  await assert.rejects(async () => session.send({ ...turn, turnId: 't2' }), /one turn at a time/)
  await session.cancel('t1', 'user')
  await consumer
})
