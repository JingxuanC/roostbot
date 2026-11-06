// H4: SSE must reject revoked sessions, re-check during the pump, and must not
// accept a long-lived session token in the query string.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import { createStorePort } from '../src/store-adapter.ts'
import { startServer } from '../src/server.ts'
import { manualClock } from './helpers.ts'

const ACCOUNT = 'acc_stream'

async function start() {
  const rawStore = openStore(':memory:')
  const store = createStorePort(rawStore)
  const clock = manualClock()
  const started = await startServer({
    store,
    rawStore,
    now: clock.now,
    port: 0,
    host: '127.0.0.1',
    streamPollMs: 30,
  })
  return {
    rawStore,
    clock,
    base: started.url,
    close: async () => {
      await started.close()
      rawStore.close()
    },
  }
}

async function pair(base: string): Promise<{ token: string; workspaceId: string }> {
  const minted = await fetch(`${base}/api/pairing/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: ACCOUNT }),
  })
  const { code } = (await minted.json()) as { code: string }
  const claimed = await fetch(`${base}/api/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  const { sessionToken } = (await claimed.json()) as { sessionToken: string }
  const created = await fetch(`${base}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ name: 'stream' }),
  })
  const { workspace } = (await created.json()) as { workspace: { id: string } }
  return { token: sessionToken, workspaceId: workspace.id }
}

async function createRoom(base: string, token: string, workspaceId: string): Promise<string> {
  const response = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ workspaceId, name: '房间' }),
  })
  const body = (await response.json()) as { room: { id: string } }
  return body.room.id
}

test('SSE rejects a long-lived session token in ?access_token=', async () => {
  const fx = await start()
  try {
    const { token, workspaceId } = await pair(fx.base)
    const roomId = await createRoom(fx.base, token, workspaceId)
    const response = await fetch(`${fx.base}/api/rooms/${roomId}/stream?access_token=${token}`, {
      headers: { accept: 'text/event-stream' },
    })
    assert.equal(response.status, 401)
    const body = (await response.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'stream_ticket_required')
  } finally {
    await fx.close()
  }
})

test('a short-lived room ticket opens the stream; a ticket for another room does not', async () => {
  const fx = await start()
  try {
    const { token, workspaceId } = await pair(fx.base)
    const roomId = await createRoom(fx.base, token, workspaceId)
    const other = await createRoom(fx.base, token, workspaceId)
    const minted = await fetch(`${fx.base}/api/rooms/${roomId}/stream-ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}',
    })
    assert.equal(minted.status, 200)
    const ticketBody = (await minted.json()) as { ticket: string; expiresAt: number }
    assert.equal(ticketBody.ticket.length, 64)
    assert.ok(ticketBody.expiresAt <= fx.clock.now() + 60_000)

    const ok = await fetch(`${fx.base}/api/rooms/${roomId}/stream?ticket=${ticketBody.ticket}`, {
      headers: { accept: 'text/event-stream' },
    })
    assert.equal(ok.status, 200)
    assert.match(ok.headers.get('content-type') ?? '', /text\/event-stream/)
    await ok.body?.cancel()

    const reused = await fetch(`${fx.base}/api/rooms/${roomId}/stream?ticket=${ticketBody.ticket}`)
    assert.equal(reused.status, 401)

    const again = await fetch(`${fx.base}/api/rooms/${roomId}/stream-ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}',
    })
    const second = (await again.json()) as { ticket: string }
    const wrongRoom = await fetch(`${fx.base}/api/rooms/${other}/stream?ticket=${second.ticket}`)
    assert.equal(wrongRoom.status, 403)
  } finally {
    await fx.close()
  }
})

test('a revoked session cannot open a stream and an open stream stops after revoke', async () => {
  const fx = await start()
  try {
    const { token, workspaceId } = await pair(fx.base)
    const roomId = await createRoom(fx.base, token, workspaceId)
    const devices = await fetch(`${fx.base}/api/devices`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const listed = (await devices.json()) as { devices: Array<{ id: string }> }
    const sessionId = listed.devices[0]?.id
    assert.ok(sessionId)

    const minted = await fetch(`${fx.base}/api/rooms/${roomId}/stream-ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}',
    })
    const { ticket } = (await minted.json()) as { ticket: string }
    const stream = await fetch(`${fx.base}/api/rooms/${roomId}/stream?ticket=${ticket}`, {
      headers: { accept: 'text/event-stream' },
    })
    assert.equal(stream.status, 200)
    const reader = stream.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const first = await reader.read()
    buffer += decoder.decode(first.value, { stream: true })
    assert.match(buffer, /connected/)

    const revoked = await fetch(`${fx.base}/api/devices/${sessionId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(revoked.status, 204)

    const deadline = Date.now() + 2000
    while (Date.now() < deadline && !buffer.includes('session_revoked')) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
    }
    assert.match(buffer, /session_revoked/)

    await fetch(`${fx.base}/api/rooms/${roomId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: 'AFTER-REVOKE' }),
    })
    const quiet = Date.now() + 200
    while (Date.now() < quiet) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: undefined }>((resolve) => setTimeout(() => resolve({ done: true }), 50)),
      ])
      if (chunk.done || chunk.value === undefined) break
      buffer += decoder.decode(chunk.value, { stream: true })
    }
    assert.equal(buffer.includes('AFTER-REVOKE'), false)

    const again = await fetch(`${fx.base}/api/rooms/${roomId}/stream`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    })
    assert.equal(again.status, 401)
    const body = (await again.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'session_revoked')
  } finally {
    await fx.close()
  }
})
