import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AgentRuntimeError,
  createAdapterRegistry,
  defaultCapabilities,
  guardAgentEvents,
  isAgentRuntimeKind,
} from '../src/index.ts'
import type { AgentAdapter, AgentEvent } from '../src/index.ts'

function adapter(kind: AgentAdapter['kind']): AgentAdapter {
  return {
    kind,
    async probe() {
      return { ok: true, auth: 'ok', problems: [] }
    },
    capabilities() {
      return defaultCapabilities(kind)
    },
    async openSession() {
      throw new Error('not used')
    },
  }
}

async function collect(events: AgentEvent[]): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const event of guardAgentEvents('t1', (async function* () {
    for (const item of events) yield item
  })())) out.push(event)
  return out
}

test('runtime kind accepts known values and rejects unknown ones', () => {
  assert.equal(isAgentRuntimeKind('grok-build'), true)
  assert.equal(isAgentRuntimeKind('nope'), false)
  assert.equal(isAgentRuntimeKind(undefined), false)
})

test('default capabilities describe each runtime', () => {
  assert.equal(defaultCapabilities('grok-build').streaming, true)
  assert.equal(defaultCapabilities('hermes').resume, false)
})

test('registry rejects duplicate adapters and reports unsupported runtimes', () => {
  const registry = createAdapterRegistry([adapter('dsh')])
  assert.equal(registry.require('dsh').kind, 'dsh')
  assert.throws(() => registry.register(adapter('dsh')), AgentRuntimeError)
  assert.throws(() => registry.require('codex'), AgentRuntimeError)
})

test('guard accepts a well-formed turn', async () => {
  const events: AgentEvent[] = [
    { type: 'turn.started', turnId: 't1', at: 1 },
    { type: 'text.delta', turnId: 't1', seq: 1, text: 'hi' },
    { type: 'text.final', turnId: 't1', text: 'hi' },
    { type: 'turn.ended', turnId: 't1', reason: 'stop' },
  ]
  assert.equal((await collect(events)).length, 4)
})

test('guard rejects missing terminal, duplicate final and events after end', async () => {
  await assert.rejects(
    collect([{ type: 'turn.started', turnId: 't1', at: 1 }]),
    /ended without turn\.ended/,
  )
  await assert.rejects(
    collect([
      { type: 'text.final', turnId: 't1', text: 'a' },
      { type: 'text.final', turnId: 't1', text: 'b' },
      { type: 'turn.ended', turnId: 't1', reason: 'stop' },
    ]),
    /duplicate text\.final/,
  )
  await assert.rejects(
    collect([
      { type: 'turn.ended', turnId: 't1', reason: 'stop' },
      { type: 'text.delta', turnId: 't1', seq: 1, text: 'x' },
    ]),
    /event after turn\.ended/,
  )
})
