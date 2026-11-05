// 房间与消息 API：鉴权、建房间、发消息、增量读、SSE 推送。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createMemoryStore } from '../src/memory-store.ts'
import { startServer } from '../src/server.ts'
import type { StorePort } from '../src/port.ts'

interface Ctx {
  base: string
  store: StorePort
  close: () => Promise<void>
}

async function withApi(fn: (ctx: Ctx) => Promise<void>, options: { streamPollMs?: number } = {}): Promise<void> {
  const store = createMemoryStore()
  const { url, close } = await startServer({
    store,
    port: 0,
    host: '127.0.0.1',
    streamPollMs: options.streamPollMs ?? 40
  })
  try {
    await fn({ base: url, store, close })
  } finally {
    await close()
  }
}

async function pair(base: string, accountId = 'acc_rooms'): Promise<{ token: string; workspaceId: string }> {
  const codeRes = await fetch(`${base}/api/pairing/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId })
  })
  const { code } = (await codeRes.json()) as { code: string }
  const claimRes = await fetch(`${base}/api/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code })
  })
  const { sessionToken } = (await claimRes.json()) as { sessionToken: string }
  const wsRes = await fetch(`${base}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ name: '量化研究组' })
  })
  const { workspace } = (await wsRes.json()) as { workspace: { id: string } }
  return { token: sessionToken, workspaceId: workspace.id }
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

test('房间接口都要鉴权', async () => {
  await withApi(async ({ base }) => {
    for (const [method, path] of [
      ['GET', '/api/rooms'],
      ['POST', '/api/rooms'],
      ['GET', '/api/rooms/rm_x/messages'],
      ['POST', '/api/rooms/rm_x/messages']
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {})
      })
      assert.equal(res.status, 401, `${method} ${path} should be 401`)
    }
  })
})

test('建房间 → 发消息 → 增量读回', async () => {
  await withApi(async ({ base }) => {
    const { token, workspaceId } = await pair(base)

    const created = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(token) },
      body: JSON.stringify({ workspaceId, name: '量化研究组' })
    })
    assert.equal(created.status, 201)
    const { room } = (await created.json()) as { room: { id: string; name: string; replyMode: string } }
    assert.equal(room.name, '量化研究组')
    assert.equal(room.replyMode, 'admin')

    const listed = await fetch(`${base}/api/rooms`, { headers: auth(token) })
    assert.deepEqual(((await listed.json()) as { rooms: Array<{ id: string }> }).rooms.map((r) => r.id), [room.id])

    const posted = await fetch(`${base}/api/rooms/${room.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(token) },
      body: JSON.stringify({ text: '盘前看一下异动' })
    })
    assert.equal(posted.status, 201)
    const { message } = (await posted.json()) as { message: { seq: number; text: string } }
    assert.equal(message.text, '盘前看一下异动')

    const read = await fetch(`${base}/api/rooms/${room.id}/messages`, { headers: auth(token) })
    const body = (await read.json()) as { messages: Array<{ seq: number; text: string; actor: { kind: string } }> }
    assert.equal(body.messages.length, 1)
    assert.equal(body.messages[0]!.actor.kind, 'user')

    const after = await fetch(`${base}/api/rooms/${room.id}/messages?after=${message.seq}`, {
      headers: auth(token)
    })
    assert.deepEqual(((await after.json()) as { messages: unknown[] }).messages, [])
  })
})

test('空消息与超长消息被拒；错 id 的房间 404', async () => {
  await withApi(async ({ base }) => {
    const { token, workspaceId } = await pair(base)
    const { room } = (await (
      await fetch(`${base}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(token) },
        body: JSON.stringify({ workspaceId, name: '房间' })
      })
    ).json()) as { room: { id: string } }

    for (const text of ['', '   ', 'x'.repeat(8001)]) {
      const res = await fetch(`${base}/api/rooms/${room.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(token) },
        body: JSON.stringify({ text })
      })
      assert.equal(res.status, 400)
    }

    const missing = await fetch(`${base}/api/rooms/rm_missing/messages`, { headers: auth(token) })
    assert.equal(missing.status, 404)
  })
})

test('SSE：账号 cookie 会话也能订阅，不要求 access_token 查询参数', async () => {
  await withApi(async ({ base }) => {
    const { token, workspaceId } = await pair(base)
    const { room } = (await (
      await fetch(`${base}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(token) },
        body: JSON.stringify({ workspaceId, name: 'cookie 房间' })
      })
    ).json()) as { room: { id: string } }

    const controller = new AbortController()
    const response = await fetch(`${base}/api/rooms/${room.id}/stream`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream', cookie: `roost_session=${token}` }
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    controller.abort()
  })
})

test('SSE：订阅后能收到新消息（event: message + cursor）', async () => {
  await withApi(
    async ({ base }) => {
      const { token, workspaceId } = await pair(base)
      const { room } = (await (
        await fetch(`${base}/api/rooms`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth(token) },
          body: JSON.stringify({ workspaceId, name: '房间' })
        })
      ).json()) as { room: { id: string } }

      const controller = new AbortController()
      const response = await fetch(`${base}/api/rooms/${room.id}/stream?access_token=${token}`, {
        signal: controller.signal,
        headers: { accept: 'text/event-stream' }
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
      assert.ok(response.body)

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      setTimeout(() => {
        void fetch(`${base}/api/rooms/${room.id}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth(token) },
          body: JSON.stringify({ text: 'SSE 测试消息' })
        })
      }, 30)

      const deadline = Date.now() + 3000
      while (Date.now() < deadline && !buffer.includes('SSE 测试消息')) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
      }
      assert.match(buffer, /event: message/)
      assert.match(buffer, /SSE 测试消息/)
      assert.match(buffer, /event: cursor/)

      controller.abort()
      await reader.cancel().catch(() => {})
    },
    { streamPollMs: 20 }
  )
})
