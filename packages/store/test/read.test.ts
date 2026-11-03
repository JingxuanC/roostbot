import assert from 'node:assert/strict'
import test from 'node:test'

import { appendEvent, latestSeq, readEvents } from '../src/index.ts'
import { assertStoreError, withStore } from './helpers.ts'

test('afterSeq 只返回更晚的事件（断线续传）', async () => {
  await withStore((store) => {
    for (let i = 0; i < 3; i += 1) {
      appendEvent(store, { domain: 'chat', kind: 'chat.message' })
    }

    assert.deepEqual(readEvents(store, { afterSeq: 0 }).map((e) => e.seq), [1, 2, 3])
    assert.deepEqual(readEvents(store, { afterSeq: 2 }).map((e) => e.seq), [3])
    assert.deepEqual(readEvents(store, { afterSeq: 3 }), [])
    assert.deepEqual(readEvents(store, { afterSeq: 99 }), [])
  })
})

test('按 domain 过滤', async () => {
  await withStore((store) => {
    appendEvent(store, { domain: 'chat', kind: 'chat.message' })
    appendEvent(store, { domain: 'turn', kind: 'turn.started' })
    appendEvent(store, { domain: 'chat', kind: 'chat.message' })
    appendEvent(store, { domain: 'tool', kind: 'tool.result' })

    const chat = readEvents(store, { domain: 'chat' })
    assert.deepEqual(chat.map((e) => e.seq), [1, 3])
    assert.ok(chat.every((e) => e.domain === 'chat'))

    assert.deepEqual(readEvents(store, { domain: 'schedule' }), [])
  })
})

test('按 audience 过滤', async () => {
  await withStore((store) => {
    appendEvent(store, { domain: 'chat', kind: 'chat.message', audience: 'team' })
    appendEvent(store, { domain: 'chat', kind: 'chat.message', audience: 'room:r_quant' })
    appendEvent(store, { domain: 'chat', kind: 'chat.message', audience: 'member:m_1' })
    appendEvent(store, { domain: 'chat', kind: 'chat.message', audience: 'room:r_quant' })

    assert.deepEqual(readEvents(store, { audience: 'room:r_quant' }).map((e) => e.seq), [2, 4])
    assert.deepEqual(readEvents(store, { audience: 'team' }).map((e) => e.seq), [1])
  })
})

test('domain + audience + afterSeq + limit 组合', async () => {
  await withStore((store) => {
    for (let i = 0; i < 6; i += 1) {
      appendEvent(store, {
        domain: i % 2 === 0 ? 'chat' : 'tool',
        kind: i % 2 === 0 ? 'chat.message' : 'tool.call',
        audience: i < 3 ? 'team' : 'room:r_1',
      })
    }

    const result = readEvents(store, { domain: 'chat', audience: 'room:r_1', afterSeq: 1, limit: 1 })
    assert.deepEqual(result.map((e) => e.seq), [5])
  })
})

test('始终按 seq 升序，不按 at 排序（时钟会漂）', async () => {
  await withStore((store) => {
    appendEvent(store, { domain: 'chat', kind: 'chat.message', at: '2030-01-01T00:00:00.000Z' })
    appendEvent(store, { domain: 'chat', kind: 'chat.message', at: '2000-01-01T00:00:00.000Z' })
    appendEvent(store, { domain: 'chat', kind: 'chat.message', at: '2026-06-01T00:00:00.000Z' })

    assert.deepEqual(readEvents(store).map((e) => e.seq), [1, 2, 3])
  })
})

test('非法查询参数直接报错', async () => {
  await withStore((store) => {
    appendEvent(store, { domain: 'chat', kind: 'chat.message' })

    assertStoreError(() => readEvents(store, { afterSeq: -1 }), 'INVALID_INPUT')
    assertStoreError(() => readEvents(store, { limit: 0 }), 'INVALID_INPUT')
    assertStoreError(() => readEvents(store, { domain: '' }), 'INVALID_INPUT')
    assertStoreError(() => readEvents(store, { afterSeq: 1.5 }), 'INVALID_INPUT')
  })
})

test('latestSeq 在空库上是 0', async () => {
  await withStore((store) => {
    assert.equal(latestSeq(store), 0)
    appendEvent(store, { domain: 'chat', kind: 'chat.message' })
    assert.equal(latestSeq(store), 1)
  })
})
