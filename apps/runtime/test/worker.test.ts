// Room worker 的端到端测试：真 HTTP、真 SSE 之外的另一条路——轮询内部接口。
// 链路：人发消息 → worker 发现 → 调 /say 以 Bot 身份写 → 公开接口/SSE 能看到。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createMemoryStore } from '../../api/src/memory-store.ts'
import { startServer } from '../../api/src/server.ts'
import { placeholderReply, startRoomWorker } from '../worker.ts'

const RUNTIME_TOKEN = 'rt_worker_test_0123456789abcdef'

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for condition')
}

test('worker 会把人的消息变成 Bot 回复（占位模板）', async () => {
  const store = createMemoryStore()
  const { url, close } = await startServer({ store, port: 0, host: '127.0.0.1', runtimeToken: RUNTIME_TOKEN })
  let worker: Awaited<ReturnType<typeof startRoomWorker>> | undefined
  try {
    // 人：配对 → 建 workspace → 建房间
    const code = ((await (await fetch(`${url}/api/pairing/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'acc_worker' })
    })).json()) as { code: string }).code
    const token = ((await (await fetch(`${url}/api/pairing/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code })
    })).json()) as { sessionToken: string }).sessionToken
    const workspace = ((await (await fetch(`${url}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: '量化研究组' })
    })).json()) as { workspace: { id: string } }).workspace
    const room = ((await (await fetch(`${url}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspaceId: workspace.id, name: '量化研究组' })
    })).json()) as { room: { id: string } }).room

    worker = await startRoomWorker({ apiBase: url, runtimeToken: RUNTIME_TOKEN, pollMs: 20, replyDelayMs: 10, log: () => {} })

    await fetch(`${url}/api/rooms/${room.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: '盘前看一下异动' })
    })

    const messages = await until(async () => {
      const res = await fetch(`${url}/api/rooms/${room.id}/messages`, { headers: { authorization: `Bearer ${token}` } })
      const body = (await res.json()) as { messages: Array<{ seq: number; text: string; actor: { kind: string; id: string } }> }
      return body.messages.some((m) => m.actor.kind === 'bot') ? body.messages : undefined
    })

    assert.equal(messages.length, 2)
    assert.equal(messages[0]!.actor.kind, 'user')
    assert.equal(messages[1]!.actor.kind, 'bot')
    assert.equal(messages[1]!.actor.id, 'selector')
    assert.match(messages[1]!.text, /收到：「盘前看一下异动」/)
    assert.ok(worker.replies >= 1)
  } finally {
    worker?.stop()
    await close()
  }
})

test('worker 不会回复 Bot 自己的消息（不会自激）', async () => {
  const store = createMemoryStore()
  const { url, close } = await startServer({ store, port: 0, host: '127.0.0.1', runtimeToken: RUNTIME_TOKEN })
  let worker: Awaited<ReturnType<typeof startRoomWorker>> | undefined
  try {
    const code = ((await (await fetch(`${url}/api/pairing/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'acc_worker2' })
    })).json()) as { code: string }).code
    const token = ((await (await fetch(`${url}/api/pairing/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code })
    })).json()) as { sessionToken: string }).sessionToken
    const workspace = ((await (await fetch(`${url}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'w2' })
    })).json()) as { workspace: { id: string } }).workspace
    const room = ((await (await fetch(`${url}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspaceId: workspace.id, name: 'r2' })
    })).json()) as { room: { id: string } }).room

    worker = await startRoomWorker({ apiBase: url, runtimeToken: RUNTIME_TOKEN, pollMs: 20, replyDelayMs: 5, log: () => {} })
    await fetch(`${url}/api/rooms/${room.id}/say`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-runtime-token': RUNTIME_TOKEN },
      body: JSON.stringify({ botId: 'selector', text: 'Bot 自己说的' })
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(worker.replies, 0)

    const res = await fetch(`${url}/api/rooms/${room.id}/messages`, { headers: { authorization: `Bearer ${token}` } })
    const body = (await res.json()) as { messages: unknown[] }
    assert.equal(body.messages.length, 1)
  } finally {
    worker?.stop()
    await close()
  }
})

test('占位回复不伪造模型输出', () => {
  const text = placeholderReply('x'.repeat(200))
  assert.match(text, /v0 的占位回复/)
  assert.ok(text.length < 400)
})
