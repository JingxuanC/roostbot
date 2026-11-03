// 内部接口：runtime token 鉴权、以 Bot 身份说话、按 seq 增量读。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createMemoryStore } from '../src/memory-store.ts'
import { startServer } from '../src/server.ts'

const RUNTIME_TOKEN = 'rt_test_0123456789abcdef'

async function withApi(fn: (base: string) => Promise<void>, runtimeToken: string | undefined = RUNTIME_TOKEN): Promise<void> {
  const store = createMemoryStore()
  const { url, close } = await startServer({
    store,
    port: 0,
    host: '127.0.0.1',
    runtimeToken,
    streamPollMs: 40
  })
  try {
    await fn(url)
  } finally {
    await close()
  }
}

async function seedRoom(base: string): Promise<{ token: string; roomId: string }> {
  const code = ((await (await fetch(`${base}/api/pairing/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: 'acc_internal' })
  })).json()) as { code: string }).code
  const token = ((await (await fetch(`${base}/api/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code })
  })).json()) as { sessionToken: string }).sessionToken
  const workspace = ((await (await fetch(`${base}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: '量化研究组' })
  })).json()) as { workspace: { id: string } }).workspace
  const room = ((await (await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ workspaceId: workspace.id, name: '量化研究组' })
  })).json()) as { room: { id: string } }).room
  return { token, roomId: room.id }
}

test('没配置 runtime token：内部接口 404（不暴露存在性）', async () => {
  await withApi(async (base) => {
    const res = await fetch(`${base}/api/internal/rooms`, { headers: { 'x-runtime-token': RUNTIME_TOKEN } })
    assert.equal(res.status, 404)
  }, '')
})

test('错 token 401；对 token 200', async () => {
  await withApi(async (base) => {
    const wrong = await fetch(`${base}/api/internal/rooms`, { headers: { 'x-runtime-token': 'nope' } })
    assert.equal(wrong.status, 401)

    const ok = await fetch(`${base}/api/internal/rooms`, {
      headers: { authorization: `Runtime ${RUNTIME_TOKEN}` }
    })
    assert.equal(ok.status, 200)
    assert.deepEqual(((await ok.json()) as { rooms: unknown[] }).rooms, [])
  })
})

test('以 Bot 身份说话：房间消息的 actor.kind=bot，且公开接口能读到', async () => {
  await withApi(async (base) => {
    const { token, roomId } = await seedRoom(base)

    const said = await fetch(`${base}/api/rooms/${roomId}/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-runtime-token': RUNTIME_TOKEN },
      body: JSON.stringify({ botId: 'selector', text: '我先拉一遍涨跌幅。' })
    })
    assert.equal(said.status, 201)
    const saidBody = (await said.json()) as { message: { seq: number; actor: { kind: string; id: string } } }
    assert.equal(saidBody.message.actor.kind, 'bot')
    assert.equal(saidBody.message.actor.id, 'selector')

    const read = await fetch(`${base}/api/rooms/${roomId}/messages`, { headers: { authorization: `Bearer ${token}` } })
    const body = (await read.json()) as { messages: Array<{ text: string; actor: { kind: string } }> }
    assert.deepEqual(body.messages.map((m) => [m.text, m.actor.kind]), [['我先拉一遍涨跌幅。', 'bot']])

    // 内部读：同样的消息，带 after 增量。
    const internal = await fetch(`${base}/api/internal/rooms/${roomId}/messages?after=${saidBody.message.seq}`, {
      headers: { 'x-runtime-token': RUNTIME_TOKEN }
    })
    assert.equal(internal.status, 200)
    assert.deepEqual(((await internal.json()) as { messages: unknown[] }).messages, [])
  })
})

test('say 参数校验：缺 botId / 空文本 → 400', async () => {
  await withApi(async (base) => {
    const { roomId } = await seedRoom(base)
    for (const body of [{ text: 'x' }, { botId: 'selector', text: '   ' }, { botId: 'selector' }]) {
      const res = await fetch(`${base}/api/rooms/${roomId}/say`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-runtime-token': RUNTIME_TOKEN },
        body: JSON.stringify(body)
      })
      assert.equal(res.status, 400, JSON.stringify(body))
    }
  })
})
