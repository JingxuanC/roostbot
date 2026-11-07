// Supervisor tests: adapter selection, one session per (room, bot), guarded
// event streams, capability cache, cancel and close. Fake adapters only.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AgentRuntimeError } from '../../../../packages/agent-runtime/src/index.ts'
import {
  createAgentSupervisor,
  defaultSessionId,
} from '../../agent-supervisor.mjs'
import {
  createFakeAdapter,
  duplicateFinalTurn,
  missingTerminalTurn,
  wellFormedTurn,
  wrongTurnIdTurn,
} from './fake-agent-adapter.mjs'

function turn(overrides = {}) {
  return {
    turnId: 't1',
    input: 'hello',
    context: { roomName: 'room', members: [], recentMessages: [], artifacts: [], tokenBudget: 1000 },
    signal: new AbortController().signal,
    ...overrides,
  }
}

function request(overrides = {}) {
  return {
    roomId: 'rm_1',
    botId: 'bot_1',
    workspaceId: 'ws_1',
    workdir: '/workspace/agents/bot_1',
    runtimeKind: 'grok-build',
    turn: turn(),
    ...overrides,
  }
}

async function collect(iterable) {
  const events = []
  for await (const event of iterable) events.push(event)
  return events
}

async function expectRuntimeError(iterable, code) {
  await assert.rejects(async () => collect(iterable), (error) => {
    assert.ok(error instanceof AgentRuntimeError, `expected AgentRuntimeError, got ${error}`)
    assert.equal(error.code, code)
    return true
  })
}

test('selection maps runtimeKind to the registered adapter', async () => {
  const grok = createFakeAdapter('grok-build')
  const claude = createFakeAdapter('claude-code')
  const supervisor = createAgentSupervisor({ adapters: [grok.adapter, claude.adapter] })

  const grokEntry = await supervisor.ensureSession(request({ runtimeKind: 'grok-build' }))
  assert.equal(grokEntry.kind, 'grok-build')
  assert.equal(grok.opened.length, 1)

  const claudeEntry = await supervisor.ensureSession(request({ botId: 'bot_2', runtimeKind: 'claude-code' }))
  assert.equal(claudeEntry.kind, 'claude-code')
  assert.equal(claude.opened.length, 1)
  assert.equal(supervisor.stats().sessions, 2)
})

test('the factory receives the kind and its per-kind config', async () => {
  const calls = []
  const supervisor = createAgentSupervisor({
    adapterConfigs: { codex: { command: 'codex-acp' } },
    createAdapter(kind, config) {
      calls.push({ kind, config })
      return createFakeAdapter(kind).adapter
    },
  })
  await supervisor.ensureSession(request({ runtimeKind: 'codex' }))
  assert.deepEqual(calls, [{ kind: 'codex', config: { command: 'codex-acp' } }])

  const mismatched = createAgentSupervisor({
    createAdapter: () => createFakeAdapter('claude-code').adapter,
  })
  await assert.rejects(
    () => mismatched.ensureSession(request({ runtimeKind: 'grok-build' })),
    (error) => error.code === 'supervisor.adapter_mismatch',
  )
})

test('one session per (room, bot): sends reuse it and different bots stay separate', async () => {
  const grok = createFakeAdapter('grok-build')
  const supervisor = createAgentSupervisor({ adapters: [grok.adapter] })

  const first = await collect(supervisor.send(request()))
  const second = await collect(supervisor.send(request({ turn: turn({ turnId: 't2' }) })))
  assert.equal(first.at(-1).reason, 'stop')
  assert.equal(second.at(-1).reason, 'stop')
  assert.equal(grok.opened.length, 1, 'the same (room, bot) reuses its session')
  assert.equal(grok.opened[0].calls.send.length, 2)

  await collect(supervisor.send(request({ botId: 'bot_2', turn: turn({ turnId: 't3' }) })))
  assert.equal(grok.opened.length, 2)

  const entry = supervisor.getSession('rm_1', 'bot_1')
  assert.equal(entry.sessionId, defaultSessionId('rm_1', 'bot_1'))
  assert.equal(entry.turns, 2)
  assert.equal(supervisor.listSessions().length, 2)
})

test('session spec defaults are deterministic and carry the control-plane fields', async () => {
  const grok = createFakeAdapter('grok-build')
  const supervisor = createAgentSupervisor({ adapters: [grok.adapter] })
  await supervisor.ensureSession(request({ env: { REGION: 'cn' } }))
  const spec = grok.opened[0].spec
  assert.equal(spec.sessionId, 'room-rm_1-bot_1')
  assert.equal(spec.roomId, 'rm_1')
  assert.equal(spec.botId, 'bot_1')
  assert.equal(spec.workspaceId, 'ws_1')
  assert.equal(spec.workdir, '/workspace/agents/bot_1')
  assert.deepEqual(spec.env, { REGION: 'cn' })
})

test('a runtimeKind change for the same bot is rejected instead of swapping mid-room', async () => {
  const supervisor = createAgentSupervisor({
    adapters: [createFakeAdapter('grok-build').adapter, createFakeAdapter('codex').adapter],
  })
  await supervisor.ensureSession(request({ runtimeKind: 'grok-build' }))
  await assert.rejects(
    () => supervisor.ensureSession(request({ runtimeKind: 'codex' })),
    (error) => error.code === 'supervisor.runtime_mismatch',
  )
})

test('concurrent session creation opens exactly one session', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const grok = createFakeAdapter('grok-build', {
    async openSession(spec) {
      await gate
      return {
        id: spec.sessionId,
        send: (value) => wellFormedTurn(value),
        async cancel() {},
        async close() {},
      }
    },
  })
  const supervisor = createAgentSupervisor({ adapters: [grok.adapter] })
  const a = supervisor.ensureSession(request())
  const b = supervisor.ensureSession(request())
  release()
  const [first, second] = await Promise.all([a, b])
  assert.equal(first, second)
  assert.equal(grok.opened.length, 0, 'the custom openSession bypasses the recorder')
  assert.equal(supervisor.stats().sessions, 1)
})

test('events are guarded: well-formed passes, broken adapters fail at the boundary', async () => {
  const supervisor = createAgentSupervisor({
    adapters: [
      createFakeAdapter('grok-build', { send: (value) => wellFormedTurn(value) }).adapter,
      createFakeAdapter('codex', { send: (value) => missingTerminalTurn(value) }).adapter,
      createFakeAdapter('claude-code', { send: (value) => duplicateFinalTurn(value) }).adapter,
      createFakeAdapter('dsh', { send: (value) => wrongTurnIdTurn(value) }).adapter,
    ],
  })
  const good = await collect(supervisor.send(request({ runtimeKind: 'grok-build' })))
  assert.equal(good.at(-1).type, 'turn.ended')

  await expectRuntimeError(supervisor.send(request({ botId: 'b2', runtimeKind: 'codex' })), 'runtime.missing_end')
  await expectRuntimeError(supervisor.send(request({ botId: 'b3', runtimeKind: 'claude-code' })), 'runtime.duplicate_final')
  await expectRuntimeError(supervisor.send(request({ botId: 'b4', runtimeKind: 'dsh' })), 'runtime.turn_mismatch')
})

test('capabilities are cached per runtime kind and refreshable', async () => {
  const grok = createFakeAdapter('grok-build')
  const supervisor = createAgentSupervisor({ adapters: [grok.adapter] })
  await supervisor.ensureSession(request())
  await supervisor.send(request({ turn: turn({ turnId: 't2' }) }))
  assert.equal(supervisor.capabilities('grok-build').streaming, true)
  assert.equal(grok.capabilitiesCalls, 1, 'capabilities() called once and cached')
  supervisor.refreshCapabilities('grok-build')
  assert.equal(grok.capabilitiesCalls, 2)
  assert.equal(typeof supervisor.probe('grok-build'), 'object')
  assert.equal(grok.probeCalls, 1)
})

test('cancel delegates to the session and reports whether a session existed', async () => {
  const grok = createFakeAdapter('grok-build', {
    send: () => (async function* pending() { await new Promise(() => {}) })() ,
  })
  const supervisor = createAgentSupervisor({ adapters: [grok.adapter] })
  // Start consuming so the session exists, but the fake's pending generator is
  // intentionally never awaited: this test is about the cancel call reaching it.
  const iterable = supervisor.send(request())
  const consumer = (async () => { for await (const event of iterable) void event })().catch(() => [])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(await supervisor.cancel('rm_1', 'bot_1', 't1', 'user'), true)
  assert.deepEqual(grok.opened[0].calls.cancel, [{ turnId: 't1', reason: 'user' }])

  await supervisor.closeSession('rm_1', 'bot_1')
  assert.equal(await supervisor.cancel('rm_1', 'missing', 't1'), false)
  void consumer
})

test('closeSession and closeAll close sessions once and clear the map', async () => {
  const grok = createFakeAdapter('grok-build')
  const claude = createFakeAdapter('claude-code')
  const supervisor = createAgentSupervisor({ adapters: [grok.adapter, claude.adapter] })
  await supervisor.ensureSession(request({ runtimeKind: 'grok-build' }))
  await supervisor.ensureSession(request({ botId: 'bot_2', runtimeKind: 'claude-code' }))

  assert.equal(await supervisor.closeSession('rm_1', 'bot_1'), true)
  assert.equal(grok.opened[0].calls.close, 1)
  assert.equal(supervisor.getSession('rm_1', 'bot_1'), undefined)
  assert.equal(await supervisor.closeSession('rm_1', 'bot_1'), false, 'idempotent')

  assert.equal(await supervisor.closeAll(), 1)
  assert.equal(claude.opened[0].calls.close, 1)
  assert.equal(supervisor.stats().sessions, 0)
  assert.equal(await supervisor.closeAll(), 0)
})

test('the supervisor contains no direct persistence or SSE writes', async () => {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const source = await readFile(join(import.meta.dirname, '../../agent-supervisor.mjs'), 'utf8')
  for (const forbidden of ['fetch(', 'INSERT INTO', 'UPDATE ', 'res.write', 'EventSource', 'text/event-stream']) {
    assert.equal(source.includes(forbidden), false, `supervisor must not contain ${forbidden}`)
  }
})
