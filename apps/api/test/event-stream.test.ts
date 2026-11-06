// 房间事件流：写完就推，不靠 700ms 轮询；沙箱用长轮询续读。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import { createBot } from '../../../packages/store/src/bots.ts'
import { createRoomExt } from '../../../packages/store/src/rooms-ext.ts'
import { createWorkspace } from '../../../packages/store/src/workspaces.ts'
import { getRoom, sendMessage } from '../../../packages/store/src/rooms.ts'
import { readRoomEvents } from '../../../packages/store/src/room-log.ts'
import { createMemoryStore } from '../src/memory-store.ts'
import { applyAdvance, openRoundForMessage } from '../src/round-orchestrator.ts'
import { armRoomWait, publishRoomWake } from '../src/room-bus.ts'
import { framesForRoomEvent } from '../src/room-stream.ts'
import { createStorePort } from '../src/store-adapter.ts'
import { startServer } from '../src/server.ts'
import type { Event } from '../../../packages/store/src/types.ts'

const RUNTIME_TOKEN = 'rt_events_0123456789abcdef'

test('总线在 arm 之后、wait 之前的写入不会被漏掉', async () => {
  const waiter = armRoomWait('rm_race')
  try {
    publishRoomWake({ roomId: 'rm_race', seq: 3, kind: 'chat.message' })
    const woke = await waiter.wait(1_000)
    assert.equal(woke, true)
    const quiet = await waiter.wait(20)
    assert.equal(quiet, false)
  } finally {
    waiter.cancel()
  }
})

test('round.started 投影成 round.started / round / status，并带 AG-UI RUN_STARTED', () => {
  const event = {
    id: 'ev_1',
    seq: 4,
    at: '2026-11-06T00:00:00.000Z',
    domain: 'turn',
    kind: 'turn.round.started',
    actor: { kind: 'system', id: 'control-plane' },
    subject: { kind: 'room', id: 'rm_1' },
    audience: 'room:rm_1',
    parent: null,
    idem: null,
    trace: null,
    v: 1,
    payload: { roomId: 'rm_1', roundId: 'rnd_1', round: { id: 'rnd_1', state: 'running' } },
  } satisfies Event
  const frames = framesForRoomEvent(event, null)
  assert.deepEqual(frames.map((frame) => frame.event), ['round.started', 'round', 'status'])
  assert.equal(frames[0]?.data.agui && (frames[0].data.agui as { type: string }).type, 'RUN_STARTED')
  assert.equal((frames[0]?.data.round as { id: string }).id, 'rnd_1')
})

test('开轮与收轮把 round / speaking 写进房间日志', () => {
  const store = openStore(':memory:')
  try {
    const workspace = createWorkspace(store, { tenantId: 'tenant_1', name: '研究', profileVersion: 'dev' })
    const host = createBot(store, {
      workspaceId: workspace.id,
      name: '研究员',
      role: '选股',
      model: 'deepseek-chat',
      createdBy: 'acc_1',
    })
    const created = createRoomExt(store, {
      workspaceId: workspace.id,
      memberBotIds: [host.id],
      hostBotId: host.id,
      responder: { kind: 'member', botId: host.id },
      createdBy: 'acc_1',
    })
    const room = getRoom(store, created.room.id)
    assert.ok(room !== null)
    const sent = sendMessage(store, { roomId: room.id, text: '今天看什么', actor: { kind: 'user', id: 'acc_1' } })
    const round = openRoundForMessage({ store, room, seq: sent.seq, text: '今天看什么' })
    assert.ok(round !== null)
    const opened = readRoomEvents(store, { roomId: room.id, afterSeq: sent.seq })
    assert.deepEqual(opened.map((event) => event.kind), ['turn.round.started', 'turn.speaking'])
    assert.equal(opened[1]?.payload.botId, host.id)

    applyAdvance({ store, roundId: round.id, slotIndex: 0, result: { kind: 'posted', text: '看成交额' } })
    const after = readRoomEvents(store, { roomId: room.id, afterSeq: sent.seq })
    assert.ok(after.some((event) => event.kind === 'turn.round.ended'))
  } finally {
    store.close()
  }
})

async function readUntil(response: Response, pattern: RegExp, timeoutMs: number): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !pattern.test(buffer)) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
  }
  await reader.cancel().catch(() => undefined)
  return buffer
}

test('SSE 在 15s 兜底之前就把新消息推下来（内存 store 走总线）', async () => {
  const store = createMemoryStore()
  const started = await startServer({ store, port: 0, host: '127.0.0.1', streamPollMs: 15_000 })
  try {
    const code = ((await (await fetch(`${started.url}/api/pairing/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'acc_push' }),
    })).json()) as { code: string }).code
    const token = ((await (await fetch(`${started.url}/api/pairing/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })).json()) as { sessionToken: string }).sessionToken
    const workspace = ((await (await fetch(`${started.url}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: '量化' }),
    })).json()) as { workspace: { id: string } }).workspace
    const room = ((await (await fetch(`${started.url}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspaceId: workspace.id, name: '房间' }),
    })).json()) as { room: { id: string } }).room

    const controller = new AbortController()
    const response = await fetch(`${started.url}/api/rooms/${room.id}/stream?access_token=${token}`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    })
    assert.equal(response.status, 200)
    const startedAt = Date.now()
    setTimeout(() => {
      void fetch(`${started.url}/api/rooms/${room.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: '立刻推送' }),
      })
    }, 30)
    const buffer = await readUntil(response, /立刻推送/, 2_000)
    assert.match(buffer, /event: message/)
    assert.match(buffer, /立刻推送/)
    assert.ok(Date.now() - startedAt < 2_000)
    controller.abort()
  } finally {
    await started.close()
  }
})

test('内部事件长轮询、续传与 workspace 隔离；delta 进同一条日志', async () => {
  const rawStore = openStore(':memory:')
  const store = createStorePort(rawStore)
  const started = await startServer({
    store,
    rawStore,
    port: 0,
    host: '127.0.0.1',
    runtimeToken: RUNTIME_TOKEN,
    streamPollMs: 15_000,
  })
  const runtime = { 'x-runtime-token': RUNTIME_TOKEN }
  try {
    const code = ((await (await fetch(`${started.url}/api/pairing/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'acc_events' }),
    })).json()) as { code: string }).code
    const token = ((await (await fetch(`${started.url}/api/pairing/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })).json()) as { sessionToken: string }).sessionToken
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const workspaceA = ((await (await fetch(`${started.url}/api/workspaces`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: '甲' }),
    })).json()) as { workspace: { id: string } }).workspace
    const workspaceB = ((await (await fetch(`${started.url}/api/workspaces`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: '乙' }),
    })).json()) as { workspace: { id: string } }).workspace
    const roomA = ((await (await fetch(`${started.url}/api/rooms`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ workspaceId: workspaceA.id, name: '甲房' }),
    })).json()) as { room: { id: string } }).room
    const roomB = ((await (await fetch(`${started.url}/api/rooms`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ workspaceId: workspaceB.id, name: '乙房' }),
    })).json()) as { room: { id: string } }).room

    const pending = fetch(
      `${started.url}/api/internal/events?after=0&waitMs=2000&workspaceId=${encodeURIComponent(workspaceA.id)}`,
      { headers: runtime },
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    const said = await fetch(`${started.url}/api/rooms/${roomA.id}/say`, {
      method: 'POST',
      headers: { ...runtime, 'content-type': 'application/json' },
      body: JSON.stringify({ botId: 'selector', text: '盘前摘要' }),
    })
    assert.equal(said.status, 201)
    const waited = await pending
    assert.equal(waited.status, 200)
    const waitedBody = (await waited.json()) as {
      events: Array<{ kind: string; roomId: string; message?: { text: string; agui?: { type: string } }; agui?: { type: string } }>
    }
    const message = waitedBody.events.find((event) => event.kind === 'chat.message')
    assert.ok(message)
    assert.equal(message.roomId, roomA.id)
    assert.equal(message.message?.text, '盘前摘要')
    assert.equal(message.agui?.type, 'TEXT_MESSAGE_CONTENT')

    await fetch(`${started.url}/api/rooms/${roomB.id}/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: '不该出现在甲' }),
    })
    const onlyA = await fetch(
      `${started.url}/api/internal/events?after=0&workspaceId=${encodeURIComponent(workspaceA.id)}`,
      { headers: runtime },
    )
    const onlyABody = (await onlyA.json()) as { events: Array<{ roomId: string; payload?: { text?: string } }> }
    assert.ok(onlyABody.events.every((event) => event.roomId === roomA.id))
    assert.ok(!onlyABody.events.some((event) => event.payload?.text === '不该出现在甲'))

    const delta = await fetch(`${started.url}/api/internal/rooms/${roomA.id}/deltas`, {
      method: 'POST',
      headers: { ...runtime, 'content-type': 'application/json' },
      body: JSON.stringify({ botId: 'selector', delta: '还在写' }),
    })
    assert.equal(delta.status, 201)
    const deltaBody = (await delta.json()) as { event: { seq: number } }
    const resumed = await fetch(
      `${started.url}/api/internal/events?after=${deltaBody.event.seq - 1}&workspaceId=${encodeURIComponent(workspaceA.id)}`,
      { headers: runtime },
    )
    const resumedBody = (await resumed.json()) as { events: Array<{ kind: string; payload: { delta?: string } }> }
    assert.ok(resumedBody.events.some((event) => event.kind === 'chat.message.delta' && event.payload.delta === '还在写'))

    const badWait = await fetch(`${started.url}/api/internal/rooms/${roomA.id}/messages?after=0&waitMs=999999`, {
      headers: runtime,
    })
    assert.equal(badWait.status, 400)
  } finally {
    await started.close()
    rawStore.close()
  }
})
