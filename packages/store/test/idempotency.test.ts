import assert from 'node:assert/strict'
import test from 'node:test'

import { appendEvent, latestSeq, readEvents } from '../src/index.ts'
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
