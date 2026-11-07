import assert from 'node:assert/strict'
import test from 'node:test'

import { createCliAdapter } from '../../agent-adapters/cli-adapter.mjs'
import { createFakeSpawn } from './fake-child.mjs'

const spec = {
  sessionId: 'room-rm_test-bot_bot1',
  roomId: 'rm_test',
  botId: 'bot_1',
  workspaceId: 'ws_test',
  workdir: '/workspace/agents/bot1',
  env: {},
}

async function collect(iterable: AsyncIterable<Record<string, unknown>>): Promise<any[]> {
  const events: any[] = []
  for await (const event of iterable) events.push(event)
  return events
}

function adapterWith(lines: unknown[], options: Record<string, unknown> = {}) {
  const children: any[] = []
  const spawn = createFakeSpawn(children)
  const adapter = createCliAdapter({
    kind: 'claude-code',
    spawn,
    command: 'fake-claude',
    args: ['--headless'],
    promptWriter: () => '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
    parser: (line: string) => [JSON.parse(line)],
    ...options,
  })
  return { adapter, children, lines }
}

test('CLI adapter maps NDJSON, keeps stderr diagnostic and ends once', async () => {
  const { adapter, children } = adapterWith([])
  const session = await adapter.openSession(spec)
  const iterable = session.send({
    turnId: 'turn-1',
    input: 'hi',
    context: {} as any,
    signal: new AbortController().signal,
  })
  const consumer = collect(iterable as any)
  const child = children[0]
  assert.equal(child.frames().length, 1)
  child.writeStderr('warning: not an event')
  child.writeStdout({ type: 'text.delta', text: '你' })
  child.writeStdout({ type: 'text.delta', text: '好' })
  child.writeStdout({ type: 'turn.ended', reason: 'stop' })
  const events = await consumer
  assert.deepEqual(events.filter((event) => event.type === 'text.delta').map((event) => event.text), ['你', '好'])
  assert.equal(events.find((event) => event.type === 'text.final')?.text, '你好')
  assert.equal(events.filter((event) => event.type === 'turn.ended').length, 1)
  assert.equal(events.at(-1)?.reason, 'stop')
  assert.equal(events.some((event) => typeof event.text === 'string' && event.text.includes('warning')), false)
  await session.close()
})

test('CLI crash before terminal becomes error + turn.ended(error)', async () => {
  const { adapter, children } = adapterWith([])
  const session = await adapter.openSession(spec)
  const iterable = session.send({
    turnId: 'turn-crash',
    input: 'hi',
    context: {} as any,
    signal: new AbortController().signal,
  })
  const consumer = collect(iterable as any)
  children[0].emitExit(1, null)
  const events = await consumer
  assert.ok(events.some((event) => event.type === 'error'))
  assert.equal(events.filter((event) => event.type === 'turn.ended').length, 1)
  assert.equal(events.at(-1)?.reason, 'error')
  await session.close()
})

test('CLI cancel sends SIGINT and ends cancelled without late deltas', async () => {
  const { adapter, children } = adapterWith([])
  const session = await adapter.openSession(spec)
  const iterable = session.send({
    turnId: 'turn-cancel',
    input: 'hi',
    context: {} as any,
    signal: new AbortController().signal,
  })
  const consumer = collect(iterable as any)
  await new Promise((resolve) => setTimeout(resolve, 10))
  await session.cancel('turn-cancel', 'user')
  children[0].writeStdout({ type: 'text.delta', text: 'late' })
  const events = await consumer
  assert.ok(children[0].kills.includes('SIGINT'))
  assert.equal(events.filter((event) => event.type === 'turn.ended').length, 1)
  assert.equal(events.at(-1)?.reason, 'cancelled')
  assert.equal(events.some((event) => event.type === 'text.delta' && event.text === 'late'), false)
  await session.close()
})
