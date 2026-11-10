// Transport tests: JSON-RPC correlation, notifications, server->client
// requests, timeouts, framing boundaries, diagnostics, shutdown.
// A fake child process stands in for the ACP runtime.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TransportError, createAcpTransport, createLineFraming } from '../../agent-adapters/acp-transport.mjs'
import { createFakeChild, createFakeSpawn } from './fake-child.mjs'

function harness(options = {}) {
  const children = []
  const transport = createAcpTransport({
    spawn: createFakeSpawn(children),
    command: 'fake-acp-agent',
    args: ['--acp'],
    closeGraceMs: 5,
    ...options,
  })
  return { transport, child: children[0], children }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

test('sendRequest correlates ids and resolves from a JSON-RPC result', async () => {
  const { transport, child } = harness()
  const pending = transport.sendRequest('initialize', { protocolVersion: 1 })

  const frames = child.frames()
  assert.equal(frames.length, 1)
  assert.equal(frames[0].jsonrpc, '2.0')
  assert.equal(frames[0].method, 'initialize')
  assert.deepEqual(frames[0].params, { protocolVersion: 1 })
  assert.equal(typeof frames[0].id, 'number')

  child.writeStdout({ jsonrpc: '2.0', id: frames[0].id, result: { protocolVersion: 1, agentInfo: { version: '9.1' } } })
  assert.deepEqual(await pending, { protocolVersion: 1, agentInfo: { version: '9.1' } })

  // A second request gets its own id and cannot be resolved by the first reply.
  const second = transport.sendRequest('session/new', { cwd: '/tmp/w' })
  const secondId = child.frames()[1].id
  assert.notEqual(secondId, frames[0].id)
  child.writeStdout({ jsonrpc: '2.0', id: secondId, result: { sessionId: 's1' } })
  assert.deepEqual(await second, { sessionId: 's1' })
  await transport.close()
})

test('a JSON-RPC error rejects with transport.rpc_error and the raw rpc object', async () => {
  const { transport, child } = harness()
  const pending = transport.sendRequest('boom', {})
  child.writeStdout({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'agent exploded' } })
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof TransportError)
    assert.equal(error.code, 'transport.rpc_error')
    assert.equal(error.rpc.code, -32000)
    assert.match(error.message, /agent exploded/)
    return true
  })
  await transport.close()
})

test('notifications reach handlers and unsubscribe', async () => {
  const { transport, child } = harness()
  const seen = []
  const off = transport.onNotification((message) => seen.push(message))
  child.writeStdout({ jsonrpc: '2.0', method: 'session/update', params: { n: 1 } })
  await tick()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].method, 'session/update')
  assert.deepEqual(seen[0].params, { n: 1 })

  off()
  child.writeStdout({ jsonrpc: '2.0', method: 'session/update', params: { n: 2 } })
  await tick()
  assert.equal(seen.length, 1)
  await transport.close()
})

test('agent->client requests are answered by the first returning handler', async () => {
  const { transport, child } = harness()
  const requests = []
  transport.onRequest(async (request) => {
    requests.push(request)
    if (request.method === 'session/request_permission') {
      return { outcome: { outcome: 'selected', optionId: 'allow-1' } }
    }
    return undefined
  })

  child.writeStdout({ jsonrpc: '2.0', id: 'perm-1', method: 'session/request_permission', params: { sessionId: 's1' } })
  await tick()
  assert.equal(requests.length, 1)
  const response = child.frames().find((frame) => frame.id === 'perm-1')
  assert.deepEqual(response, { jsonrpc: '2.0', id: 'perm-1', result: { outcome: { outcome: 'selected', optionId: 'allow-1' } } })

  // No handler claims this one: the transport answers -32601 instead of hanging.
  child.writeStdout({ jsonrpc: '2.0', id: 'fs-1', method: 'fs/read_text_file', params: {} })
  await tick()
  const notFound = child.frames().find((frame) => frame.id === 'fs-1')
  assert.equal(notFound.error.code, -32601)
  await transport.close()
})

test('a request times out with transport.timeout and a late reply is ignored', async () => {
  const { transport, child } = harness()
  await assert.rejects(
    transport.sendRequest('session/prompt', {}, { timeoutMs: 15 }),
    (error) => error instanceof TransportError && error.code === 'transport.timeout',
  )
  // The late frame must not throw or resurrect the request.
  child.writeStdout({ jsonrpc: '2.0', id: 1, result: { late: true } })
  await tick()
  assert.equal(transport.isClosed(), false)
  await transport.close()
})

test('framing survives split frames, grouped frames and reports bad JSON without stopping', async () => {
  const diagnostics = []
  const { transport, child } = harness({ onDiagnostic: (level, message) => diagnostics.push({ level, message }) })

  const first = transport.sendRequest('a', {})
  const second = transport.sendRequest('b', {})
  child.stdout.write('{"jsonrpc":"2.0","id":1,')
  child.stdout.write('"result":{"ok":1}}\n{"jsonrpc":"2.0","id":2,"result":{"ok":2}}\n')
  assert.deepEqual(await first, { ok: 1 })
  assert.deepEqual(await second, { ok: 2 })

  child.writeStdout('this is not json')
  const third = transport.sendRequest('c', {})
  const thirdId = child.frames().at(-1).id
  child.writeStdout({ jsonrpc: '2.0', id: thirdId, result: { ok: 3 } })
  assert.deepEqual(await third, { ok: 3 })
  assert.ok(diagnostics.some((entry) => entry.message.includes('transport.bad_json')))
  await transport.close()
})

test('the framing strategy is swappable (Content-Length can be a new object)', async () => {
  const framing = createLineFraming()
  assert.equal(framing.name, 'newline-delimited-json')
  assert.match(framing.encode({ a: 1 }), /\n$/)
  const decoded = []
  const errors = []
  const decoder = framing.createDecoder((message) => decoded.push(message), (error) => errors.push(error))
  decoder.push('{"a":1}\n{"b":')
  decoder.push('2}\n{"bad"\n')
  decoder.end()
  assert.deepEqual(decoded, [{ a: 1 }, { b: 2 }])
  assert.equal(errors.length, 1)

  const children = []
  let encoded = null
  const custom = {
    name: 'content-length-test',
    encode(message) {
      encoded = message
      return `<${JSON.stringify(message)}>\n`
    },
    createDecoder() {
      return { push() {}, end() {} }
    },
  }
  const transport = createAcpTransport({ spawn: createFakeSpawn(children), command: 'fake', framing: custom, closeGraceMs: 5 })
  void transport.sendRequest('x', {}).catch(() => {})
  assert.match(children[0].stdin.writes[0], /^<\{"jsonrpc"/)
  assert.equal(encoded.method, 'x')
  await transport.close()
})

test('stderr is diagnostic only and never enters the protocol stream', async () => {
  const diagnostics = []
  const messages = []
  const { transport, child } = harness({ onDiagnostic: (level, message) => diagnostics.push({ level, message }) })
  transport.onNotification((message) => messages.push(message))
  child.writeStderr('warning: rate limited')
  await tick()
  assert.equal(messages.length, 0)
  assert.ok(diagnostics.some((entry) => entry.level === 'stderr' && entry.message.includes('rate limited')))
  await transport.close()
})

test('close rejects pending requests, ends stdin and escalates signals', async () => {
  const { transport, child } = harness()
  const pending = transport.sendRequest('never', {})
  await transport.close()
  await assert.rejects(pending, (error) => error instanceof TransportError && error.code === 'transport.closed')
  assert.equal(child.stdin.writableEnded, true)
  assert.ok(child.kills.includes('SIGTERM'))
  assert.ok(child.kills.includes('SIGKILL'))
  assert.equal(transport.isClosed(), true)
  await transport.close()
})

test('a child exit rejects in-flight requests with transport.exit', async () => {
  const { transport, child } = harness()
  const pending = transport.sendRequest('never', {})
  child.emitExit(2, null)
  await assert.rejects(pending, (error) => error instanceof TransportError && error.code === 'transport.exit')
})
