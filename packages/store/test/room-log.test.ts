import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createRoom, createWorkspace, openStore } from '../src/index.ts'
import { appendRoomSignal, readRoomEvents } from '../src/room-log.ts'
import { readWorkspaceRoomEvents } from '../src/events.ts'

function setup() {
  const store = openStore(':memory:')
  const workspace = createWorkspace(store, {
    tenantId: 'tenant_a',
    name: '甲',
    profileVersion: 'dev',
  })
  const other = createWorkspace(store, {
    tenantId: 'tenant_b',
    name: '乙',
    profileVersion: 'dev',
  })
  const room = createRoom(store, { workspaceId: workspace.id, name: '研究' })
  const elsewhere = createRoom(store, { workspaceId: other.id, name: '别的' })
  return { store, workspace, other, room, elsewhere }
}

test('房间信号按 seq 追加，同 idem 不产生新行', () => {
  const { store, room } = setup()
  try {
    const first = appendRoomSignal(store, {
      roomId: room.id,
      domain: 'turn',
      kind: 'turn.round.started',
      idem: 'round:r1:started',
      payload: { roundId: 'rnd_1' },
    })
    const again = appendRoomSignal(store, {
      roomId: room.id,
      domain: 'turn',
      kind: 'turn.round.started',
      idem: 'round:r1:started',
      payload: { roundId: 'rnd_1' },
    })
    assert.equal(again.seq, first.seq)
    const speaking = appendRoomSignal(store, {
      roomId: room.id,
      domain: 'turn',
      kind: 'turn.speaking',
      parent: first.seq,
      payload: { botId: 'bot_1' },
    })
    const events = readRoomEvents(store, { roomId: room.id, afterSeq: 0 })
    assert.deepEqual(events.map((event) => event.kind), ['turn.round.started', 'turn.speaking'])
    assert.equal(speaking.parent, first.seq)
    assert.equal(events[0]?.payload.roomId, room.id)
    assert.deepEqual(readRoomEvents(store, { roomId: room.id, afterSeq: first.seq }).map((event) => event.seq), [
      speaking.seq,
    ])
  } finally {
    store.close()
  }
})

test('workspace 读只看见自己房间的日志', () => {
  const { store, workspace, other, room, elsewhere } = setup()
  try {
    appendRoomSignal(store, { roomId: room.id, domain: 'chat', kind: 'chat.message.delta', payload: { delta: '甲' } })
    appendRoomSignal(store, {
      roomId: elsewhere.id,
      domain: 'chat',
      kind: 'chat.message.delta',
      payload: { delta: '乙' },
    })
    const own = readWorkspaceRoomEvents(store, { workspaceId: workspace.id, afterSeq: 0 })
    assert.equal(own.length, 1)
    assert.equal(own[0]?.payload.delta, '甲')
    const theirs = readWorkspaceRoomEvents(store, { workspaceId: other.id, afterSeq: 0 })
    assert.equal(theirs.length, 1)
    assert.equal(theirs[0]?.payload.delta, '乙')
    const all = readWorkspaceRoomEvents(store, { afterSeq: 0 })
    assert.equal(all.length, 2)
  } finally {
    store.close()
  }
})
