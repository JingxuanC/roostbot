import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { appendEvent, latestSeq, openStore, readEvents } from '../src/index.ts'
import { assertStoreError, tempDir, withStore } from './helpers.ts'

test('appendEvent 填 seq，默认 at/v，payload 默认空对象', async () => {
  await withStore((store) => {
    const event = appendEvent(store, { domain: 'chat', kind: 'chat.message' })

    assert.equal(event.seq, 1)
    assert.match(event.id, /^ev_[0-9A-HJKMNP-TV-Z]{26}$/)
    assert.equal(event.v, 1)
    assert.equal(event.at, new Date(event.at).toISOString())
    assert.deepEqual(event.payload, {})
    assert.equal(event.actor, null)
    assert.equal(event.subject, null)
    assert.equal(event.audience, null)
    assert.equal(event.parent, null)
    assert.equal(event.idem, null)
    assert.equal(event.trace, null)
  })
})

test('事件信封字段完整往返（actor/subject/audience/parent/trace/payload）', async () => {
  await withStore((store) => {
    const first = appendEvent(store, {
      domain: 'chat',
      kind: 'chat.message',
      actor: { kind: 'bot', id: 'risk' },
      subject: { kind: 'room', id: 'r_quant' },
      audience: 'room:r_quant',
      at: '2026-11-03T12:00:00.123Z',
      idem: 'msg_1',
      trace: { run: 'run_9', turn: 'turn_3' },
      payload: { role: 'bot', text: '你好', framing: 'room' },
    })

    const second = appendEvent(store, {
      domain: 'assignment',
      kind: 'assignment.completed',
      actor: { kind: 'bot', id: 'risk' },
      subject: { kind: 'assignment', id: 'as_7f' },
      audience: 'team',
      parent: first.seq,
      payload: { outcome: 'done' },
    })

    const [readBack, child] = readEvents(store)
    assert.deepEqual(readBack, first)
    assert.deepEqual(child, second)
    assert.equal(readBack.at, '2026-11-03T12:00:00.123Z')
    assert.deepEqual(readBack.actor, { kind: 'bot', id: 'risk' })
    assert.deepEqual(readBack.subject, { kind: 'room', id: 'r_quant' })
    assert.equal(readBack.audience, 'room:r_quant')
    assert.deepEqual(readBack.trace, { run: 'run_9', turn: 'turn_3' })
    assert.deepEqual(readBack.payload, { role: 'bot', text: '你好', framing: 'room' })
    assert.equal(child.parent, first.seq)
  })
})

test('seq 单调递增，latestSeq 跟随', async () => {
  await withStore((store) => {
    assert.equal(latestSeq(store), 0)

    const seqs = [
      appendEvent(store, { domain: 'turn', kind: 'turn.started' }).seq,
      appendEvent(store, { domain: 'turn', kind: 'turn.completed' }).seq,
      appendEvent(store, { domain: 'tool', kind: 'tool.call' }).seq,
    ]

    assert.deepEqual(seqs, [1, 2, 3])
    assert.equal(latestSeq(store), 3)

    // 幂等重放不推高 seq。
    appendEvent(store, { domain: 'turn', kind: 'turn.started', idem: 'same' })
    appendEvent(store, { domain: 'turn', kind: 'turn.started', idem: 'same' })
    assert.equal(latestSeq(store), 4)
  })
})

test('kind 必须以 "<domain>." 开头', async () => {
  await withStore((store) => {
    assertStoreError(
      () => appendEvent(store, { domain: 'chat', kind: 'turn.started' }),
      'INVALID_EVENT',
    )
    assert.equal(latestSeq(store), 0)
  })
})

test('必填字段缺失或形状不对直接拒绝，不写半条事件', async () => {
  await withStore((store) => {
    assertStoreError(
      () => appendEvent(store, { kind: 'chat.message' } as never),
      'INVALID_EVENT',
    )
    assertStoreError(
      () => appendEvent(store, { domain: 'chat', kind: '' }),
      'INVALID_EVENT',
    )
    assertStoreError(
      () => appendEvent(store, { domain: 'chat', kind: 'chat.message', payload: [] as never }),
      'INVALID_EVENT',
    )
    assertStoreError(
      () => appendEvent(store, { domain: 'chat', kind: 'chat.message', actor: { kind: 'bot' } as never }),
      'INVALID_EVENT',
    )
    assertStoreError(
      () => appendEvent(store, {
        domain: 'chat',
        kind: 'chat.message',
        payload: { big: 1n } as never,
      }),
      'INVALID_EVENT',
    )
    assertStoreError(
      () => appendEvent(store, { domain: 'chat', kind: 'chat.message', at: 'not-a-date' }),
      'INVALID_EVENT',
    )

    assert.equal(latestSeq(store), 0)
    assert.deepEqual(readEvents(store), [])
  })
})

test('parent 必须指向本日志里已存在的 seq', async () => {
  await withStore((store) => {
    assertStoreError(
      () => appendEvent(store, { domain: 'chat', kind: 'chat.message', parent: 42 }),
      'PARENT_NOT_FOUND',
    )

    const first = appendEvent(store, { domain: 'chat', kind: 'chat.message' })
    const second = appendEvent(store, {
      domain: 'chat',
      kind: 'chat.message',
      parent: first.seq,
    })
    assert.equal(second.parent, 1)
  })
})

test('关库后再写抛 STORE_CLOSED，close 可重复调用', () => {
  const dir = tempDir()
  const store = openStore(join(dir, 'workspace.db'))
  try {
    store.close()
    store.close()
    assert.equal(store.closed, true)
    assertStoreError(
      () => appendEvent(store, { domain: 'chat', kind: 'chat.message' }),
      'STORE_CLOSED',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
