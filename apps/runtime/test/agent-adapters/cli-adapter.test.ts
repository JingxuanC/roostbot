import assert from 'node:assert/strict'
import test from 'node:test'

import { CLI_ASSUMPTIONS, createClaudeCodeParser, createCliAdapter, createCodexParser } from '../../agent-adapters/cli-adapter.mjs'
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

test('CLI duplicate terminal lines produce one text.final and one turn.ended', async () => {
  const { adapter, children } = adapterWith([])
  const session = await adapter.openSession(spec)
  const consumer = collect(session.send({
    turnId: 'turn-dup', input: 'hi', context: {} as any, signal: new AbortController().signal,
  }) as any)
  const child = children[0]
  child.writeStdout({ type: 'text.delta', text: '答' })
  child.writeStdout({ type: 'text.final', text: '答' })
  child.writeStdout({ type: 'text.final', text: '重复' })
  child.writeStdout({ type: 'turn.ended', reason: 'stop' })
  const events = await consumer
  assert.equal(events.filter((event) => event.type === 'text.final').length, 1)
  assert.equal(events.find((event) => event.type === 'text.final')?.text, '答')
  assert.equal(events.filter((event) => event.type === 'turn.ended').length, 1)
  await session.close()
})

test('default Claude Code parser maps assistant/tool/result lines', () => {
  const parse = createClaudeCodeParser()
  assert.deepEqual(parse(JSON.stringify({ type: 'system', subtype: 'init' })), [])
  const assistant = parse(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '想法' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a' } }] },
  }))
  assert.deepEqual(assistant.map((event: any) => event.type), ['text.delta', 'tool.call'])
  assert.equal(assistant[1].callId, 't1')
  const toolResult = parse(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] },
  }))
  assert.deepEqual(toolResult, [{ type: 'tool.result', callId: 't1', ok: true, output: 'ok' }])
  const result = parse(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: '最终答案',
    usage: { input_tokens: 10, output_tokens: 5 },
  }))
  assert.deepEqual(result.map((event: any) => event.type), ['usage', 'text.final', 'turn.ended'])
  assert.equal(result[2].reason, 'stop')
  const failed = parse(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'too many turns' }))
  assert.equal(failed.find((event: any) => event.type === 'error').code, 'cli.result_error')
  assert.equal(failed.at(-1).reason, 'error')
})

test('default Codex parser maps items and turn.completed', () => {
  const parse = createCodexParser()
  assert.deepEqual(parse(JSON.stringify({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls' } })), [
    { type: 'tool.call', callId: 'c1', name: 'shell', input: 'ls' },
  ])
  assert.deepEqual(parse(JSON.stringify({
    type: 'item.completed', item: { id: 'c1', type: 'command_execution', status: 'completed', exit_code: 0, output: 'ok' },
  })), [{ type: 'tool.result', callId: 'c1', ok: true, output: 'ok' }])
  assert.deepEqual(parse(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '你好' } })), [
    { type: 'text.delta', text: '你好' },
  ])
  const completed = parse(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }))
  assert.deepEqual(completed.map((event: any) => event.type), ['usage', 'turn.ended'])
})

test('CLI probe reports --version and caches the result', async () => {
  const children: any[] = []
  const adapter = createCliAdapter({ kind: 'claude-code', spawn: createFakeSpawn(children), command: 'fake-claude' })
  const probePromise = adapter.probe()
  const child = children[0]
  child.writeStdout('1.2.3 (Claude Code)')
  child.emitExit(0, null)
  const probe = await probePromise
  assert.equal(probe.ok, true)
  assert.match(probe.version ?? '', /1\.2\.3/)
  assert.equal(probe.binary, 'fake-claude')
  assert.equal((await adapter.probe()).ok, true)
  assert.equal(children.length, 1, 'probe is cached')

  const broken = createCliAdapter({ kind: 'codex', spawn: () => { throw new Error('spawn ENOENT') }, command: 'missing' })
  const failed = await broken.probe()
  assert.equal(failed.ok, false)
  assert.match(failed.problems[0], /ENOENT/)
})

test('CLI assumptions are documented for real wrapper verification', () => {
  assert.match(CLI_ASSUMPTIONS.claudeCode.command, /stream-json/)
  assert.match(CLI_ASSUMPTIONS.codex.command, /codex exec --json/)
  assert.ok(CLI_ASSUMPTIONS.unverified.length > 0)
})
