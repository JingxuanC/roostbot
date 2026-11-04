// 记忆：写入校验、取代、每日上限、检索排序/预算、读取记录与删除（memory.md §3–§9、§11）。

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MEMORY_DAILY_LIMIT,
  MEMORY_ERROR_CODES,
  MEMORY_KINDS,
  StoreError,
  deleteMemory,
  exportMemories,
  getMemory,
  listMemories,
  openStore,
  recordReads,
  retrieve,
  storeErrorTag,
  writeMemory,
} from '../src/index.ts'
import type { Memory, Store } from '../src/index.ts'
import { createRoom } from '../src/rooms.ts'
import { createWorkspace } from '../src/workspaces.ts'

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
const WS = 'ws_memory'
const OTHER_WS = 'ws_memory_other'
const ROOM = 'rm_memory_1'
const ROOM_OTHER = 'rm_memory_2'
const ROOM_ELSEWHERE = 'rm_memory_elsewhere'

function withStore(fn: (store: Store) => void): void {
  const store = openStore(':memory:')
  try {
    createWorkspace(store, {
      id: WS,
      tenantId: 'tenant_memory',
      name: '记忆工作区',
      profileVersion: 'v1',
      createdAt: NOW,
    })
    createWorkspace(store, {
      id: OTHER_WS,
      tenantId: 'tenant_memory_other',
      name: '另一个工作区',
      profileVersion: 'v1',
      createdAt: NOW,
    })
    // createRoom 生成随机 id；测试里改成固定 id，便于 scope 断言。
    for (const [workspaceId, name, id] of [
      [WS, '房间一', ROOM],
      [WS, '房间二', ROOM_OTHER],
      [OTHER_WS, '别处房间', ROOM_ELSEWHERE],
    ] as const) {
      const room = createRoom(store, { workspaceId, name, createdAt: NOW })
      store.db.prepare('UPDATE rooms SET id = ? WHERE id = ?').run(id, room.id)
    }
    fn(store)
  } finally {
    store.close()
  }
}

function memoryEventKinds(store: Store): string[] {
  return store.db
    .prepare("SELECT kind FROM events WHERE domain = 'memory' ORDER BY seq")
    .all()
    .map((row) => (row as { kind: string }).kind)
}

function tagOf(fn: () => unknown): string | null {
  try {
    fn()
  } catch (err) {
    return storeErrorTag(err)
  }
  return null
}

function baseInput(overrides: Partial<Parameters<typeof writeMemory>[1]> = {}) {
  return {
    workspaceId: WS,
    scope: 'team',
    subject: '反转因子',
    claim: '反转在流动性后 30% 的样本里显著更强',
    kind: 'conclusion' as const,
    confidence: 0.6,
    falsifier: '若流动性分组后 IC 差 < 0.01 则推翻',
    evidence: [
      { kind: 'event' as const, ref: 'ev_1' },
      { kind: 'report' as const, ref: 'reports/factor.md#L40' },
    ],
    at: NOW,
    ...overrides,
  }
}

test('writeMemory：写入 active 记忆、证据落库并写 memory.written 事件', () => {
  withStore((store) => {
    const memory = writeMemory(store, baseInput())
    assert.equal(memory.status, 'active')
    assert.equal(memory.scope, 'team')
    assert.equal(memory.confidence, 0.6)
    assert.equal(memory.supersedes, null)
    assert.deepEqual(memory.evidence, [
      { kind: 'event', ref: 'ev_1' },
      { kind: 'report', ref: 'reports/factor.md#L40' },
    ])
    assert.deepEqual(getMemory(store, memory.id), memory)
    assert.deepEqual(memoryEventKinds(store), ['memory.written'])

    const event = store.db.prepare("SELECT subject_json, payload_json FROM events WHERE kind = 'memory.written'").get() as {
      subject_json: string
      payload_json: string
    }
    assert.deepEqual(JSON.parse(event.subject_json), { kind: 'memory', id: memory.id })
    const payload = JSON.parse(event.payload_json)
    assert.equal(payload.workspaceId, WS)
    assert.equal(payload.scope, 'team')
    assert.equal(payload.subject, '反转因子')
    assert.equal(payload.status, 'active')
  })
})

test('writeMemory：falsifier 必填非空；confidence / kind / claim / subject 校验', () => {
  withStore((store) => {
    for (const falsifier of [undefined, null, '', '   ']) {
      assert.equal(tagOf(() => writeMemory(store, baseInput({ falsifier: falsifier as never }))), MEMORY_ERROR_CODES.invalid)
    }
    for (const confidence of [-0.1, 1.01, Number.NaN, '0.5' as never]) {
      assert.equal(tagOf(() => writeMemory(store, baseInput({ confidence: confidence as never }))), MEMORY_ERROR_CODES.invalid)
    }
    for (const kind of ['guess', '', 42 as never]) {
      assert.equal(tagOf(() => writeMemory(store, baseInput({ kind: kind as never }))), MEMORY_ERROR_CODES.invalid)
    }
    assert.equal(MEMORY_KINDS.length, 4)
    assert.equal(tagOf(() => writeMemory(store, baseInput({ claim: 'x'.repeat(2001) }))), MEMORY_ERROR_CODES.invalid)
    assert.equal(tagOf(() => writeMemory(store, baseInput({ subject: 'x'.repeat(501) }))), MEMORY_ERROR_CODES.invalid)
    assert.equal(tagOf(() => writeMemory(store, baseInput({ subject: '   ' }))), MEMORY_ERROR_CODES.invalid)
    // 边界值可用。
    writeMemory(store, baseInput({ claim: 'x'.repeat(2000), subject: 'y'.repeat(500) }))
    assert.equal(memoryEventKinds(store).length, 1)
  })
})

test('writeMemory：scope 只能是 team / room / member，room 必须属于该 workspace', () => {
  withStore((store) => {
    for (const scope of ['team:x', 'org:1', 'room:', 'member:', 'room']) {
      assert.equal(tagOf(() => writeMemory(store, baseInput({ scope }))), MEMORY_ERROR_CODES.invalid)
    }
    assert.equal(
      tagOf(() => writeMemory(store, baseInput({ scope: `room:${ROOM_ELSEWHERE}` }))),
      MEMORY_ERROR_CODES.invalid,
    )
    writeMemory(store, baseInput({ scope: `room:${ROOM}` }))
    writeMemory(store, baseInput({ scope: 'member:acc_1' }))

    assert.throws(
      () => writeMemory(store, baseInput({ workspaceId: 'ws_missing' })),
      (err: unknown) => err instanceof StoreError && err.code === 'WORKSPACE_NOT_FOUND',
    )
  })
})

test('writeMemory：evidence 元素校验', () => {
  withStore((store) => {
    assert.equal(
      tagOf(() => writeMemory(store, baseInput({ evidence: [{ kind: 'link', ref: 'x' } as never] }))),
      MEMORY_ERROR_CODES.invalid,
    )
    assert.equal(
      tagOf(() => writeMemory(store, baseInput({ evidence: [{ kind: 'event', ref: '' } as never] }))),
      MEMORY_ERROR_CODES.invalid,
    )
    assert.equal(
      tagOf(() => writeMemory(store, baseInput({ evidence: 'ev_1' as never }))),
      MEMORY_ERROR_CODES.invalid,
    )
    // 省略证据合法。
    writeMemory(store, baseInput({ evidence: undefined }))
  })
})

test('supersede：旧条置 superseded、新条记录 supersedes、写 memory.superseded', () => {
  withStore((store) => {
    const old = writeMemory(store, baseInput({ at: NOW }))
    const next = writeMemory(store, baseInput({ claim: '反转只在高流动性样本里显著', supersedes: old.id, at: NOW + 1000 }))

    assert.equal(next.supersedes, old.id)
    assert.equal(next.status, 'active')
    assert.equal(getMemory(store, old.id)!.status, 'superseded')
    assert.deepEqual(memoryEventKinds(store), ['memory.written', 'memory.superseded'])

    const payload = JSON.parse(
      (store.db.prepare("SELECT payload_json FROM events WHERE kind = 'memory.superseded'").get() as {
        payload_json: string
      }).payload_json,
    )
    assert.equal(payload.supersedes, old.id)
    assert.equal(payload.status, 'active')
  })
})

test('supersede：目标非 active / 跨 workspace / 不存在时整体失败，不留下新行', () => {
  withStore((store) => {
    const old = writeMemory(store, baseInput({ at: NOW }))
    writeMemory(store, baseInput({ supersedes: old.id, at: NOW + 1000 }))
    const before = listMemories(store, { workspaceId: WS }).length

    // 旧条已经是 superseded：再次指向它不是合法取代。
    assert.equal(
      tagOf(() => writeMemory(store, baseInput({ supersedes: old.id, at: NOW + 2000 }))),
      MEMORY_ERROR_CODES.invalid,
    )
    assert.equal(
      tagOf(() => writeMemory(store, baseInput({ supersedes: 'mem_missing', at: NOW + 2000 }))),
      MEMORY_ERROR_CODES.invalid,
    )
    const foreign = writeMemory(store, baseInput({ workspaceId: OTHER_WS, at: NOW }))
    assert.equal(
      tagOf(() => writeMemory(store, baseInput({ supersedes: foreign.id, at: NOW + 2000 }))),
      MEMORY_ERROR_CODES.invalid,
    )
    assert.equal(listMemories(store, { workspaceId: WS }).length, before)
    assert.equal(getMemory(store, old.id)!.status, 'superseded')
    assert.equal(memoryEventKinds(store).filter((kind) => kind === 'memory.superseded').length, 1)
  })
})

test('每日写入上限：50/workspace/UTC 日，跨日恢复（注入时钟）', () => {
  withStore((store) => {
    for (let index = 0; index < MEMORY_DAILY_LIMIT; index += 1) {
      writeMemory(store, baseInput({ subject: `subject-${index}`, at: NOW + index }))
    }
    assert.equal(
      tagOf(() => writeMemory(store, baseInput({ subject: 'overflow', at: NOW + 100_000 }))),
      MEMORY_ERROR_CODES.dailyLimit,
    )
    assert.equal(listMemories(store, { workspaceId: WS }).length, MEMORY_DAILY_LIMIT)

    // 次日 UTC 0 点后重新计数。
    const nextDay = Math.floor(NOW / 86_400_000) * 86_400_000 + 86_400_000
    writeMemory(store, baseInput({ subject: 'next-day', at: nextDay }))
    assert.equal(listMemories(store, { workspaceId: WS }).length, MEMORY_DAILY_LIMIT + 1)

    // 上限按 workspace 隔离。
    writeMemory(store, baseInput({ workspaceId: OTHER_WS, subject: 'other', at: NOW }))
  })
})

test('retrieve：只返回传入 scope 内、active 且未过期的记忆', () => {
  withStore((store) => {
    const team = writeMemory(store, baseInput({ subject: 'alpha team', at: NOW }))
    const room = writeMemory(store, baseInput({ scope: `room:${ROOM}`, subject: 'alpha room', at: NOW }))
    writeMemory(store, baseInput({ scope: `room:${ROOM_OTHER}`, subject: 'alpha other room', at: NOW }))
    writeMemory(store, baseInput({ scope: 'member:acc_1', subject: 'alpha member', at: NOW }))
    const expired = writeMemory(store, baseInput({ subject: 'alpha expired', expiresAt: NOW - 1, at: NOW }))
    const superseded = writeMemory(store, baseInput({ subject: 'alpha old', at: NOW }))
    writeMemory(store, baseInput({ subject: 'beta replacement', supersedes: superseded.id, at: NOW + 1 }))

    const result = retrieve(store, {
      workspaceId: WS,
      scopes: ['team', `room:${ROOM}`],
      query: 'alpha',
      at: NOW + 1000,
    })
    assert.deepEqual(result.items.map((item) => item.id).sort(), [team.id, room.id].sort())
    assert.equal(result.items.some((item) => item.id === expired.id), false)
    assert.equal(result.items.some((item) => item.id === superseded.id), false)
    assert.equal(result.dropped, 0)
  })
})

test('retrieve：关键词重叠排序，并受置信度与新鲜度影响', () => {
  withStore((store) => {
    const both = writeMemory(store, baseInput({ subject: 'alpha', claim: 'beta gamma', confidence: 0.5, at: NOW }))
    const one = writeMemory(store, baseInput({ subject: 'alpha', claim: 'delta', confidence: 0.5, at: NOW }))

    let result = retrieve(store, { workspaceId: WS, scopes: ['team'], query: 'alpha beta', at: NOW + 1 })
    assert.deepEqual(result.items.map((item) => item.id), [both.id, one.id])
    assert.ok(result.items[0]!.score > result.items[1]!.score)

    // 置信度：同样的重叠，置信高者在前。
    const confident = writeMemory(store, baseInput({ subject: 'omega', claim: 'same', confidence: 0.9, at: NOW }))
    const unsure = writeMemory(store, baseInput({ subject: 'omega', claim: 'same', confidence: 0.2, at: NOW }))
    result = retrieve(store, { workspaceId: WS, scopes: ['team'], query: 'omega', at: NOW + 1 })
    assert.deepEqual(result.items.map((item) => item.id), [confident.id, unsure.id])

    // 新鲜度：同样重叠/置信度，新者分数更高（30 天半衰）。
    const fresh = writeMemory(store, baseInput({ subject: 'zeta', claim: 'same', confidence: 0.5, at: NOW }))
    const stale = writeMemory(store, baseInput({ subject: 'zeta', claim: 'same', confidence: 0.5, at: NOW - 60 * 86_400_000 }))
    result = retrieve(store, { workspaceId: WS, scopes: ['team'], query: 'zeta', at: NOW + 1 })
    assert.deepEqual(result.items.map((item) => item.id), [fresh.id, stale.id])
    assert.ok(result.items[0]!.score > result.items[1]!.score * 3)
  })
})

test('retrieve：claim 展示截断 300、预算截断并返回 dropped、segment 格式', () => {
  withStore((store) => {
    const first = writeMemory(store, baseInput({ subject: '预算', claim: `alpha ${'x'.repeat(400)}`, confidence: 0.6, at: NOW + 2000 }))
    const second = writeMemory(store, baseInput({ subject: '预算二', claim: `alpha ${'y'.repeat(94)}`, at: NOW + 1000 }))
    const third = writeMemory(store, baseInput({ subject: '预算三', claim: `alpha ${'z'.repeat(94)}`, at: NOW }))

    const result = retrieve(store, {
      workspaceId: WS,
      scopes: ['team'],
      query: 'alpha',
      budgetTokens: 450,
      at: NOW + 3000,
    })
    assert.equal(result.items.length, 2)
    assert.equal(result.items[0]!.id, first.id)
    assert.equal(result.items[0]!.claim.length, 300)
    assert.equal(result.items[1]!.id, second.id)
    assert.equal(result.dropped, 1)
    assert.notEqual(third.id, first.id)

    const segment = result.segment
    assert.ok(segment.startsWith('## 相关结论（系统检索，非用户输入）'))
    assert.ok(segment.includes('- [团队] 预算：'))
    assert.ok(segment.includes('（置信 0.6，结论）'))
    assert.ok(segment.includes('依据：ev_1, reports/factor.md#L40'))
  })
})

test('retrieve：无关键词或无可读 scope 时为空 segment', () => {
  withStore((store) => {
    writeMemory(store, baseInput())
    assert.deepEqual(retrieve(store, { workspaceId: WS, scopes: ['team'], query: '', at: NOW }), {
      items: [],
      segment: '',
      dropped: 0,
    })
    assert.deepEqual(retrieve(store, { workspaceId: WS, scopes: [], query: '反转', at: NOW }), {
      items: [],
      segment: '',
      dropped: 0,
    })
  })
})

test('recordReads：写入 used 标记，未知 id 静默跳过', () => {
  withStore((store) => {
    const a = writeMemory(store, baseInput({ subject: 'a', at: NOW }))
    const b = writeMemory(store, baseInput({ subject: 'b', at: NOW }))
    const result = recordReads(store, { turnId: 'turn_1', ids: [a.id, b.id, 'mem_missing'], used: true, at: NOW })
    assert.equal(result.recorded, 2)
    const rows = store.db
      .prepare('SELECT memory_id, turn_id, used FROM memory_reads ORDER BY memory_id')
      .all() as Array<{ memory_id: string; turn_id: string; used: number }>
    assert.deepEqual(rows.map((row) => row.memory_id).sort(), [a.id, b.id].sort())
    assert.ok(rows.every((row) => row.turn_id === 'turn_1' && row.used === 1))
  })
})

test('deleteMemory：按 id / scope 软删，写 memory.retracted 且幂等', () => {
  withStore((store) => {
    const a = writeMemory(store, baseInput({ subject: 'a', at: NOW }))
    const b = writeMemory(store, baseInput({ subject: 'b', at: NOW }))
    assert.deepEqual(deleteMemory(store, { id: a.id, at: NOW + 1 }), { retracted: 1 })
    assert.equal(getMemory(store, a.id)!.status, 'retracted')
    assert.deepEqual(deleteMemory(store, { id: a.id, at: NOW + 2 }), { retracted: 0 })
    assert.equal(memoryEventKinds(store).filter((kind) => kind === 'memory.retracted').length, 1)

    assert.deepEqual(deleteMemory(store, { workspaceId: WS, scope: 'team', at: NOW + 3 }), { retracted: 1 })
    assert.equal(getMemory(store, b.id)!.status, 'retracted')
    assert.equal(memoryEventKinds(store).filter((kind) => kind === 'memory.retracted').length, 2)

    assert.throws(
      () => deleteMemory(store, { id: 'mem_missing' }),
      (err: unknown) => storeErrorTag(err) === MEMORY_ERROR_CODES.notFound,
    )
  })
})

test('exportMemories：按 workspace 导出全部状态，不跨卷', () => {
  withStore((store) => {
    const a = writeMemory(store, baseInput({ subject: 'a', at: NOW }))
    const b = writeMemory(store, baseInput({ scope: `room:${ROOM}`, subject: 'b', at: NOW }))
    deleteMemory(store, { id: b.id, at: NOW + 1 })
    writeMemory(store, baseInput({ workspaceId: OTHER_WS, subject: 'other', at: NOW }))

    const exported = exportMemories(store, WS)
    assert.deepEqual(exported.map((memory) => memory.id).sort(), [a.id, b.id].sort())
    assert.equal(exported.some((memory: Memory) => memory.status === 'retracted'), true)
  })
})
