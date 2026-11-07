// ROOST_MULTI_RUNTIME wiring tests (docs/design/agent-runtimes.md §6–§7).
//
// A local fake control plane provides rooms/messages/assignments/advance/bots/
// deltas/say; the runtime adapter side is an injected fake supervisor, so no
// vendor binary, network or DSH adapter process is involved.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { startRoomAgent } from '../room-agent.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const GROK_BOTS = [{ id: 'bot_grok', runtimeKind: 'grok-build', capabilities: { streaming: true } }]
const DSH_BOTS = [{ id: 'bot_dsh', runtimeKind: 'dsh' }]

function turnStream(finalText, { reason = 'stop', deltas = ['答', '案'] } = {}) {
  return async function* stream(turn) {
    yield { type: 'turn.started', turnId: turn.turnId, at: Date.now() }
    for (const [index, text] of deltas.entries()) {
      yield { type: 'text.delta', turnId: turn.turnId, seq: index + 1, text }
    }
    yield { type: 'text.final', turnId: turn.turnId, text: finalText }
    yield { type: 'turn.ended', turnId: turn.turnId, reason }
  }
}

function fakeSupervisor(stream, options = {}) {
  const sent = []
  const closed = []
  const instance = {
    send(request) {
      sent.push(request)
      return stream(request)
    },
    async cancel(roomId, botId, turnId, reason) {
      sent.push({ cancel: { roomId, botId, turnId, reason } })
      return true
    },
    async closeSession() {
      return true
    },
    async closeAll() {
      closed.push(Date.now())
      return 1
    },
    capabilities() {
      return { streaming: true }
    }
  }
  return { instance, sent, closed, ...options }
}

/** Local fake control plane with the endpoints room-agent polls. */
async function fakeControlPlane(options = {}) {
  const state = {
    rooms: options.rooms ?? [{ id: 'rm_test', members: [{ botId: 'bot_grok' }] }],
    messages: options.messages ?? [{ seq: 1, actor: { kind: 'user', id: 'acc_1' }, text: '你好' }],
    assignments: options.assignments,
    bots: options.bots ?? GROK_BOTS,
    said: [],
    deltas: [],
    advances: [],
    botsRequests: 0,
    botsPaths: [],
    requests: []
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local')
    const path = url.pathname
    state.requests.push({ method: req.method, path })
    const json = (status, payload) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(payload))
    }
    const readBody = (done) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => done(body))
    }

    if (req.method === 'GET' && path === '/api/internal/events') {
      json(404, { ok: false, error: { code: 'not_found' } })
      return
    }
    if (req.method === 'GET' && path === '/api/internal/bots') {
      state.botsRequests += 1
      state.botsPaths.push(path)
      if (typeof state.bots === 'number') {
        json(state.bots, { ok: false, error: { code: 'binding_error' } })
        return
      }
      json(200, { bots: state.bots })
      return
    }
    if (req.method === 'GET' && path === '/api/internal/rooms') {
      json(200, { rooms: state.rooms })
      return
    }
    const messagesMatch = /^\/api\/internal\/rooms\/([^/]+)\/messages$/.exec(path)
    if (req.method === 'GET' && messagesMatch !== null) {
      const after = Number(url.searchParams.get('after') ?? '0')
      json(200, { messages: state.messages.filter((message) => message.seq > after) })
      return
    }
    const assignmentsMatch = /^\/api\/internal\/rooms\/([^/]+)\/assignments$/.exec(path)
    if (req.method === 'GET' && assignmentsMatch !== null) {
      if (state.assignments === undefined) {
        json(404, { ok: false, error: { code: 'not_found' } })
        return
      }
      json(200, { assignments: state.assignments })
      return
    }
    const advanceMatch = /^\/api\/internal\/rounds\/([^/]+)\/advance$/.exec(path)
    if (req.method === 'POST' && advanceMatch !== null) {
      readBody((body) => {
        state.advances.push({ roundId: decodeURIComponent(advanceMatch[1]), ...JSON.parse(body || '{}') })
        json(200, { ok: true })
      })
      return
    }
    const roundMatch = /^\/api\/internal\/rooms\/([^/]+)\/round$/.exec(path)
    if (req.method === 'GET' && roundMatch !== null) {
      json(404, { ok: false, error: { code: 'not_found' } })
      return
    }
    const deltasMatch = /^\/api\/internal\/rooms\/([^/]+)\/deltas$/.exec(path)
    if (req.method === 'POST' && deltasMatch !== null) {
      readBody((body) => {
        state.deltas.push(JSON.parse(body || '{}'))
        json(200, { ok: true })
      })
      return
    }
    const sayMatch = /^\/api\/rooms\/([^/]+)\/say$/.exec(path)
    if (req.method === 'POST' && sayMatch !== null) {
      readBody((body) => {
        state.said.push({ roomId: decodeURIComponent(sayMatch[1]), ...JSON.parse(body || '{}') })
        json(200, { ok: true })
      })
      return
    }
    json(404, { ok: false, error: { code: 'not_found', path } })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

async function runAgent(controlPlane, options = {}) {
  const agent = await startRoomAgent({
    apiBase: controlPlane.base,
    runtimeToken: 'rt',
    botId: options.botId ?? 'bot_grok',
    dshBin: join(HERE, 'fake-dsh.mjs'),
    pollMs: 20,
    stopPollMs: 0,
    log: () => {},
    workspaceId: 'ws_test',
    ...options
  })
  return agent
}

test('a non-dsh assignment streams deltas and advances the classified result', async () => {
  const cp = await fakeControlPlane({
    assignments: [{ roundId: 'rd_1', roomId: 'rm_test', botId: 'bot_grok', index: 0, total: 1, prompt: '请用 grok 回答' }]
  })
  const supervisor = fakeSupervisor(turnStream('答案'))
  const agent = await runAgent(cp, { multiRuntime: true, supervisor: supervisor.instance, botId: 'bot_grok' })
  try {
    assert.equal(await waitFor(() => cp.state.advances.length === 1), true, 'slot advanced')
    const advance = cp.state.advances[0]
    assert.equal(advance.roundId, 'rd_1')
    assert.equal(advance.slotIndex, 0)
    assert.deepEqual(advance.result, { kind: 'posted', text: '答案' })
    assert.equal(cp.state.said.length, 0, 'advance owns the message; no duplicate /say')

    assert.equal(supervisor.sent.length, 1)
    const request = supervisor.sent[0]
    assert.equal(request.roomId, 'rm_test')
    assert.equal(request.botId, 'bot_grok')
    assert.equal(request.runtimeKind, 'grok-build')
    assert.equal(request.sessionSpec.sessionId, 'room-rm_test-bot_grok')
    assert.equal(request.sessionSpec.workdir, '/workspace/agents/bot_grok')
    assert.equal(request.sessionSpec.workspaceId, 'ws_test')
    assert.equal(request.turn.input, '请用 grok 回答')
    assert.equal(request.turn.context.roomName, 'rm_test')
    assert.equal(request.turn.context.members[0].botId, 'bot_grok')
    assert.equal(typeof request.turn.signal.aborted, 'boolean')

    assert.equal(await waitFor(() => cp.state.deltas.length > 0), true, 'deltas posted')
    assert.ok(cp.state.deltas.map((delta) => delta.delta).join('').includes('答案'.replace('案', '案')))
    assert.equal(cp.state.botsRequests, 1)
  } finally {
    await agent.stop()
    await cp.close()
  }
})

test('dsh bots keep using the existing DSH session path', async () => {
  const cp = await fakeControlPlane({
    rooms: [{ id: 'rm_test', members: [{ botId: 'bot_dsh' }] }],
    bots: DSH_BOTS,
    assignments: [{ roundId: 'rd_dsh', roomId: 'rm_test', botId: 'bot_dsh', index: 0, total: 1, prompt: '' }]
  })
  const supervisor = fakeSupervisor(turnStream('supervisor must not run'))
  const agent = await runAgent(cp, {
    multiRuntime: true,
    supervisor: supervisor.instance,
    botId: 'bot_dsh',
    dshEnv: { FAKE_DSH_ANSWER: 'dsh answer' }
  })
  try {
    assert.equal(await waitFor(() => cp.state.advances.length === 1), true)
    assert.deepEqual(cp.state.advances[0].result, { kind: 'posted', text: 'dsh answer' })
    assert.equal(supervisor.sent.length, 0, 'dsh bots never reach the supervisor')
  } finally {
    await agent.stop()
    await cp.close()
  }
})

test('a failed runtime lookup falls back to dsh for every bot', async () => {
  const cp = await fakeControlPlane({
    rooms: [{ id: 'rm_test', members: [{ botId: 'bot_unknown' }] }],
    bots: 500,
    assignments: [{ roundId: 'rd_fallback', roomId: 'rm_test', botId: 'bot_unknown', index: 0, total: 1, prompt: '' }]
  })
  const supervisor = fakeSupervisor(turnStream('supervisor must not run'))
  const agent = await runAgent(cp, {
    multiRuntime: true,
    supervisor: supervisor.instance,
    botId: 'bot_unknown',
    dshEnv: { FAKE_DSH_ANSWER: 'fallback dsh answer' }
  })
  try {
    assert.equal(await waitFor(() => cp.state.advances.length === 1), true)
    assert.deepEqual(cp.state.advances[0].result, { kind: 'posted', text: 'fallback dsh answer' })
    assert.equal(supervisor.sent.length, 0, 'lookup failure means dsh')
    assert.ok(cp.state.botsRequests >= 1)
  } finally {
    await agent.stop()
    await cp.close()
  }
})

test('flag unset never fetches bot runtimes or constructs a supervisor', async () => {
  const previous = process.env.ROOST_MULTI_RUNTIME
  delete process.env.ROOST_MULTI_RUNTIME
  const cp = await fakeControlPlane({
    assignments: [{ roundId: 'rd_legacy', roomId: 'rm_test', botId: 'bot_grok', index: 0, total: 1, prompt: '' }]
  })
  let constructed = 0
  const supervisor = fakeSupervisor(turnStream('supervisor must not run'))
  const agent = await runAgent(cp, {
    botId: 'bot_grok',
    supervisor: supervisor.instance,
    createSupervisor: () => {
      constructed += 1
      return supervisor.instance
    },
    dshEnv: { FAKE_DSH_ANSWER: 'legacy dsh answer' }
  })
  try {
    assert.equal(await waitFor(() => cp.state.advances.length === 1), true)
    assert.deepEqual(cp.state.advances[0].result, { kind: 'posted', text: 'legacy dsh answer' })
    assert.equal(constructed, 0)
    assert.equal(supervisor.sent.length, 0)
    assert.equal(cp.state.botsRequests, 0, 'the bots endpoint is never called when the flag is off')
    assert.equal(cp.state.requests.some((request) => request.path.startsWith('/api/internal/bots')), false)
  } finally {
    await agent.stop()
    await cp.close()
    if (previous === undefined) delete process.env.ROOST_MULTI_RUNTIME
    else process.env.ROOST_MULTI_RUNTIME = previous
  }
})

test('ROOST_MULTI_RUNTIME=1 creates the supervisor lazily with env-derived adapter configs', async () => {
  const previous = process.env.ROOST_MULTI_RUNTIME
  const previousGrok = process.env.ROOST_GROK_BIN
  process.env.ROOST_MULTI_RUNTIME = '1'
  process.env.ROOST_GROK_BIN = '/opt/agents/grok-build/bin/grok'
  const cp = await fakeControlPlane({
    assignments: [{ roundId: 'rd_env', roomId: 'rm_test', botId: 'bot_grok', index: 0, total: 1, prompt: 'env 路径' }]
  })
  const supervisor = fakeSupervisor(turnStream('env answer'))
  const configs = []
  const agent = await runAgent(cp, {
    botId: 'bot_grok',
    createSupervisor: (config) => {
      configs.push(config)
      return supervisor.instance
    }
  })
  try {
    assert.equal(await waitFor(() => cp.state.advances.length === 1), true)
    assert.deepEqual(cp.state.advances[0].result, { kind: 'posted', text: 'env answer' })
    assert.equal(configs.length, 1, 'supervisor created once, lazily')
    assert.equal(configs[0].adapterConfigs['grok-build'].command, '/opt/agents/grok-build/bin/grok')
    assert.equal(configs[0].adapterConfigs['claude-code'].command, 'claude')
    assert.equal(configs[0].adapterConfigs.codex.command, 'codex')
    assert.equal(typeof configs[0].logger, 'function')
    assert.equal(supervisor.sent[0].runtimeKind, 'grok-build')
  } finally {
    await agent.stop()
    await cp.close()
    if (previous === undefined) delete process.env.ROOST_MULTI_RUNTIME
    else process.env.ROOST_MULTI_RUNTIME = previous
    if (previousGrok === undefined) delete process.env.ROOST_GROK_BIN
    else process.env.ROOST_GROK_BIN = previousGrok
  }
})

test('fallbackSay (no assignments API) posts the non-dsh final text through /say', async () => {
  const cp = await fakeControlPlane({
    rooms: [{ id: 'rm_test', members: [{ botId: 'bot_grok' }] }],
    bots: GROK_BOTS,
    assignments: undefined
  })
  const supervisor = fakeSupervisor(turnStream('fallback answer', { deltas: ['fallback ', 'answer'] }))
  const agent = await runAgent(cp, { multiRuntime: true, supervisor: supervisor.instance, botId: 'bot_grok' })
  try {
    assert.equal(await waitFor(() => cp.state.said.length === 1), true)
    assert.equal(cp.state.said[0].botId, 'bot_grok')
    assert.equal(cp.state.said[0].text, 'fallback answer')
    assert.equal(cp.state.said[0].idem, 'reply-rm_test-1-bot_grok')
    assert.equal(cp.state.advances.length, 0)
    assert.equal(supervisor.sent[0].turn.input, '房间里有人说：你好')
    assert.equal(await waitFor(() => cp.state.deltas.length > 0), true)
  } finally {
    await agent.stop()
    await cp.close()
  }
})

test('runtime-kind lookups are cached across messages', async () => {
  const cp = await fakeControlPlane({
    rooms: [{ id: 'rm_test', members: [{ botId: 'bot_grok' }] }],
    bots: GROK_BOTS,
    messages: [
      { seq: 1, actor: { kind: 'user', id: 'acc_1' }, text: '第一句' },
      { seq: 2, actor: { kind: 'user', id: 'acc_1' }, text: '第二句' }
    ],
    assignments: [{ roundId: 'rd_cache', roomId: 'rm_test', botId: 'bot_grok', index: 0, total: 1, prompt: '缓存' }]
  })
  const supervisor = fakeSupervisor(turnStream('缓存答案'))
  const agent = await runAgent(cp, { multiRuntime: true, supervisor: supervisor.instance, botId: 'bot_grok' })
  try {
    assert.equal(await waitFor(() => cp.state.advances.length === 2), true)
    assert.equal(cp.state.botsRequests, 1, 'one lookup serves both user messages')
    assert.equal(supervisor.sent.length, 2)
  } finally {
    await agent.stop()
    await cp.close()
  }
})
