// room-agent：长活 SDK + 每房间一个 session（方案 A 的核心行为）。

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { JsonRpcProcessClient, assistantText, sessionIdFor, startRoomAgent } from '../room-agent.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

test('session id 是确定性的，且对特殊字符安全', () => {
  assert.equal(sessionIdFor('rm_1', 'selector'), 'room-rm_1-selector')
  assert.equal(sessionIdFor('rm 1/x', 'selector'), 'room-rm_1_x-selector')
  assert.equal(sessionIdFor('rm_1', 'selector'), sessionIdFor('rm_1', 'selector'))
})

test('assistantText 只取 text blocks', () => {
  assert.equal(assistantText({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }, { type: 'tool', x: 1 }, { type: 'text', text: 'b' }] } } }), 'ab')
  assert.equal(assistantText({ type: 'turn/end' }), undefined)
  assert.equal(assistantText(undefined), undefined)
})

async function fakeControlPlane(messages: Array<{ seq: number; actor: { kind: string; id: string }; text: string }>) {
  const said: Array<{ roomId: string; botId: string; text: string; idem: string }> = []
  const rooms = [{ id: 'rm_test' }]
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local')
    if (url.pathname === '/api/internal/rooms') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ rooms }))
      return
    }
    if (url.pathname === '/api/internal/rooms/rm_test/messages') {
      const after = Number(url.searchParams.get('after') ?? '0')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ messages: messages.filter((m) => m.seq > after) }))
      return
    }
    if (url.pathname === '/api/rooms/rm_test/say') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        said.push({ roomId: 'rm_test', ...JSON.parse(body) })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { base: `http://127.0.0.1:${port}`, said, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('两条消息走同一个 session，回复带 idem（多轮）', async () => {
  const cp = await fakeControlPlane([
    { seq: 1, actor: { kind: 'user', id: 'acc_1' }, text: '第一句' },
    { seq: 2, actor: { kind: 'bot', id: 'selector' }, text: '忽略' },
    { seq: 3, actor: { kind: 'user', id: 'acc_1' }, text: '第二句' }
  ])
  const agent = await startRoomAgent({
    apiBase: cp.base,
    runtimeToken: 'rt',
    botId: 'selector',
    dshBin: join(HERE, 'fake-dsh.mjs'),
    pollMs: 20,
    log: () => {}
  })
  try {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && cp.said.length < 2) await new Promise((r) => setTimeout(r, 20))
    assert.equal(cp.said.length, 2)
    // idem 带 botId：同一 seq 多个 Bot 不会互相覆盖
    assert.equal(cp.said[0].idem, 'reply-rm_test-1-selector')
    assert.equal(cp.said[1].idem, 'reply-rm_test-3-selector')
    // 第二轮由同一 session 产生（假 DSH 用轮数证明）
    assert.match(cp.said[1].text, /第 2 轮/)
  } finally {
    await agent.stop()
    await cp.close()
  }
})

test('JsonRpcProcessClient 能发请求并收通知', async () => {
  const { spawn } = await import('node:child_process')
  const child = spawn(join(HERE, 'fake-dsh.mjs'), [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const client = new JsonRpcProcessClient(child)
  try {
    const seen: string[] = []
    client.on('session.status', (params) => seen.push(params.status))
    const init = await client.request('initialize', { cwd: '/workspace', provider: 'deepseek', model: 'deepseek-chat' })
    assert.equal(init.serverInfo.name, 'fake-sdk-runtime')
    await client.request('session/prompt', { sessionId: 's1', contentBlocks: [{ type: 'text', text: 'x' }] })
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(seen, ['idle'])
  } finally {
    client.close()
  }
})
