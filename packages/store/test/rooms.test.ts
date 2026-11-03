// 房间与消息：房间挂在 workspace 上，消息是 chat.message 事件（seq 即身份）。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createRoom, createWorkspace, getRoom, listRooms, readMessages, sendMessage } from '../src/index.ts'
import { assertStoreError, withStore } from './helpers.ts'

const BASE = 1_760_000_000_000

function seedWorkspace(store: Parameters<typeof createWorkspace>[0]) {
  return createWorkspace(store, {
    tenantId: 'acc_1',
    name: '量化研究组',
    profileVersion: 'dev',
    createdAt: BASE,
  })
}

test('房间必须挂在真实 workspace 上', async () => {
  await withStore((store) => {
    assertStoreError(() => createRoom(store, { workspaceId: 'ws_missing', name: '房间' }), 'WORKSPACE_NOT_FOUND')
  })
})

test('创建后能列出与读回，replyMode 默认 admin', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const room = createRoom(store, { workspaceId: workspace.id, name: '量化研究组', createdAt: BASE })
    assert.equal(room.replyMode, 'admin')
    assert.equal(room.notice, null)

    assert.deepEqual(listRooms(store, { workspaceId: workspace.id }).map((r) => r.id), [room.id])
    assert.equal(getRoom(store, room.id)?.name, '量化研究组')
    assert.equal(getRoom(store, 'rm_missing'), null)
  })
})

test('消息写入 events 表，seq 单调，读回按 seq 升序', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const room = createRoom(store, { workspaceId: workspace.id, name: '房间', createdAt: BASE })

    const first = sendMessage(store, { roomId: room.id, text: '盘前看一下', actor: { kind: 'user', id: 'acc_1' }, at: BASE })
    const second = sendMessage(store, {
      roomId: room.id,
      text: '我先拉数据',
      actor: { kind: 'bot', id: 'selector' },
      at: BASE + 1000,
    })
    assert.ok(second.seq > first.seq)

    const messages = readMessages(store, { roomId: room.id })
    assert.deepEqual(messages.map((m) => m.text), ['盘前看一下', '我先拉数据'])
    assert.equal(messages[1]!.actor.kind, 'bot')

    // 增量：只要 afterSeq 之后的。
    const later = readMessages(store, { roomId: room.id, afterSeq: first.seq })
    assert.deepEqual(later.map((m) => m.text), ['我先拉数据'])

    // 库里确实是一条 chat.message 事件，而不是另存一份消息。
    const event = store.db.prepare("SELECT domain, kind, audience FROM events WHERE seq = ?").get(first.seq) as {
      domain: string
      kind: string
      audience: string
    }
    assert.equal(event.domain, 'chat')
    assert.equal(event.kind, 'chat.message')
    assert.equal(event.audience, `room:${room.id}`)
  })
})

test('同 idem 的消息不会写两条（重发去重）', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const room = createRoom(store, { workspaceId: workspace.id, name: '房间', createdAt: BASE })
    const input = {
      roomId: room.id,
      text: '重发一次',
      actor: { kind: 'user', id: 'acc_1' },
      idem: 'msg-test-1',
      at: BASE,
    }
    const a = sendMessage(store, input)
    const b = sendMessage(store, input)
    assert.equal(a.seq, b.seq)
    assert.equal(readMessages(store, { roomId: room.id }).length, 1)
  })
})

test('不存在的房间写消息要报错，而不是静默丢弃', async () => {
  await withStore((store) => {
    assertStoreError(
      () => sendMessage(store, { roomId: 'rm_missing', text: 'x', actor: { kind: 'user', id: 'acc_1' } }),
      'ROOM_NOT_FOUND',
    )
  })
})

test('房间之间互相隔离：读 A 不会读到 B 的消息', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const a = createRoom(store, { workspaceId: workspace.id, name: 'A', createdAt: BASE })
    const b = createRoom(store, { workspaceId: workspace.id, name: 'B', createdAt: BASE })
    sendMessage(store, { roomId: a.id, text: '给 A', actor: { kind: 'user', id: 'acc_1' }, at: BASE })
    sendMessage(store, { roomId: b.id, text: '给 B', actor: { kind: 'user', id: 'acc_1' }, at: BASE })

    assert.deepEqual(readMessages(store, { roomId: a.id }).map((m) => m.text), ['给 A'])
    assert.deepEqual(readMessages(store, { roomId: b.id }).map((m) => m.text), ['给 B'])
  })
})
