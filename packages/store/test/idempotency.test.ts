import assert from 'node:assert/strict'
import test from 'node:test'

import { appendEvent, createRoom, createWorkspace, latestSeq, readEvents, readMessages, sendMessage } from '../src/index.ts'
import { assertStoreError, withStore } from './helpers.ts'

test('同一个 idem 只写一条，第二次返回已有事件', async () => {
  await withStore((store) => {
    const first = appendEvent(store, {
      domain: 'assignment',
      kind: 'assignment.settled',
      idem: 'as_7f:settled',
      payload: { outcome: 'done' },
    })
    const second = appendEvent(store, {
      domain: 'assignment',
      kind: 'assignment.settled',
      idem: 'as_7f:settled',
      payload: { outcome: 'done' },
    })

    assert.deepEqual(second, first)
    assert.equal(latestSeq(store), 1)
    assert.equal(readEvents(store).length, 1)
  })
})

test('重放同 idem 时即使 payload 不同也返回首条（events.md §3 规则 2）', async () => {
  await withStore((store) => {
    const first = appendEvent(store, {
      domain: 'chat',
      kind: 'chat.message',
      idem: 'msg_1',
      payload: { text: '第一次' },
    })
    const second = appendEvent(store, {
      domain: 'chat',
      kind: 'chat.message',
      idem: 'msg_1',
      payload: { text: '第二次' },
    })

    assert.equal(second.seq, first.seq)
    assert.deepEqual(second.payload, { text: '第一次' })
    assert.equal(readEvents(store).length, 1)
  })
})

test('不同 idem 各写一条', async () => {
  await withStore((store) => {
    const a = appendEvent(store, { domain: 'chat', kind: 'chat.message', idem: 'a' })
    const b = appendEvent(store, { domain: 'chat', kind: 'chat.message', idem: 'b' })

    assert.deepEqual([a.seq, b.seq], [1, 2])
    assert.equal(readEvents(store).length, 2)
  })
})

test('没有 idem 的事件不被去重', async () => {
  await withStore((store) => {
    const a = appendEvent(store, { domain: 'chat', kind: 'chat.message' })
    const b = appendEvent(store, { domain: 'chat', kind: 'chat.message' })

    assert.deepEqual([a.seq, b.seq], [1, 2])
    assert.notEqual(a.id, b.id)
  })
})

test('同一个 idem 在不同房间各写一条，不会吞掉后写的消息', async () => {
  await withStore((store) => {
    const workspace = createWorkspace(store, {
      tenantId: 'acc_victim',
      name: 'victim',
      profileVersion: 'dev',
      createdAt: 1_760_000_000_000,
    })
    const victim = createRoom(store, { workspaceId: workspace.id, name: 'victim-room', createdAt: 1_760_000_000_000 })
    const eve = createRoom(store, { workspaceId: workspace.id, name: 'eve-room', createdAt: 1_760_000_000_001 })
    const first = sendMessage(store, {
      roomId: victim.id,
      text: 'VICTIM-SECRET',
      actor: { kind: 'user', id: 'victim' },
      idem: 'dup-1',
    })
    const second = sendMessage(store, {
      roomId: eve.id,
      text: 'eve-note',
      actor: { kind: 'user', id: 'eve' },
      idem: 'dup-1',
    })
    assert.notEqual(second.seq, first.seq)
    assert.equal(second.text, 'eve-note')
    assert.equal(readMessages(store, { roomId: victim.id })[0]?.text, 'VICTIM-SECRET')
    assert.equal(readMessages(store, { roomId: eve.id })[0]?.text, 'eve-note')
  })
})

test('同一房间同一 actor 的 idem 重放回读库里的原文', async () => {
  await withStore((store) => {
    const workspace = createWorkspace(store, {
      tenantId: 'acc_1',
      name: 'ws',
      profileVersion: 'dev',
      createdAt: 1_760_000_000_000,
    })
    const room = createRoom(store, { workspaceId: workspace.id, name: 'room', createdAt: 1_760_000_000_000 })
    const first = sendMessage(store, {
      roomId: room.id,
      text: '第一次',
      actor: { kind: 'user', id: 'acc_1' },
      idem: 'dup-1',
    })
    const second = sendMessage(store, {
      roomId: room.id,
      text: '第二次',
      actor: { kind: 'user', id: 'acc_1' },
      idem: 'dup-1',
    })
    assert.equal(second.seq, first.seq)
    assert.equal(second.text, '第一次')
    assert.equal(readMessages(store, { roomId: room.id }).length, 1)
  })
})

test('同一作用域下 idem 被用到不同 kind 时返回 IDEM_CONFLICT', async () => {
  await withStore((store) => {
    appendEvent(store, {
      domain: 'chat',
      kind: 'chat.message',
      actor: { kind: 'user', id: 'acc_1' },
      audience: 'room:rm_1',
      idem: 'dup-1',
    })
    assertStoreError(
      () =>
        appendEvent(store, {
          domain: 'chat',
          kind: 'chat.deleted',
          actor: { kind: 'user', id: 'acc_1' },
          audience: 'room:rm_1',
          idem: 'dup-1',
        }),
      'IDEM_CONFLICT',
    )
  })
})

test('同 id 不同 idem 是错误，不静默覆盖', async () => {
  await withStore((store) => {
    appendEvent(store, { domain: 'chat', kind: 'chat.message', id: 'ev_fixed' })
    assertStoreError(
      () => appendEvent(store, { domain: 'chat', kind: 'chat.message', id: 'ev_fixed' }),
      'EVENT_ID_CONFLICT',
    )
    assert.equal(readEvents(store).length, 1)
  })
})
