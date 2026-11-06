import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  EVENT_DOMAINS,
  EVENT_KINDS,
  EVENT_KINDS_BY_DOMAIN,
  LEGACY_KIND_MAP,
  eventKindsFor,
  validateEvent,
} from '../src/index.ts'

const base = {
  id: 'ev_01H',
  seq: 4211,
  at: '2026-11-03T12:00:00.123Z',
  domain: 'assignment',
  kind: 'assignment.settled',
  actor: { kind: 'bot', id: 'risk' },
  subject: { kind: 'assignment', id: 'as_7f' },
  audience: 'room:r_quant',
  parent: 4210,
  idem: 'as_7f:settled',
  trace: { run: 'run_9', turn: 'turn_3', assignment: 'as_7f' },
  v: 1,
  payload: { outcome: 'done' },
}

function withBase(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...base, ...overrides }
}

test('完整事件信封合法', () => {
  const result = validateEvent(base)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.event.kind, 'assignment.settled')
  assert.equal(result.event.seq, 4211)
  assert.deepEqual(result.event.payload, { outcome: 'done' })
})

test('最小事件合法，payload 缺省归一为 {}', () => {
  const result = validateEvent({
    id: 'ev_min',
    seq: 1,
    at: '2026-11-03T12:00:00Z',
    domain: 'chat',
    kind: 'chat.message',
    v: 1,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.event.payload, {})
})

test('domain/kind 运行时表与 events.md §4 一致', () => {
  assert.deepEqual([...EVENT_DOMAINS], [
    'chat', 'turn', 'tool', 'approval', 'assignment', 'schedule',
    'sandbox', 'memory', 'workspace', 'auth', 'billing',
  ])
  assert.equal(EVENT_KINDS.length, 46)
  for (const domain of EVENT_DOMAINS) {
    for (const kind of eventKindsFor(domain)) {
      assert.ok(kind.startsWith(`${domain}.`), `${kind} 应以 ${domain}. 开头`)
    }
  }
  assert.deepEqual([...EVENT_KINDS_BY_DOMAIN.assignment], [
    'assignment.enqueued',
    'assignment.started',
    'assignment.parked',
    'assignment.answered',
    'assignment.settled',
    'assignment.cancelled',
  ])
  assert.equal(LEGACY_KIND_MAP['user.message'], 'chat.message')
  assert.equal(LEGACY_KIND_MAP['run.started'], 'schedule.run.started')
})

test('未知 kind 报错稳定', () => {
  // events.md §3 的示例写了 assignment.completed，但 §4 的权威列表只有 assignment.settled。
  const result = validateEvent(withBase({ kind: 'assignment.completed' }))
  assert.deepEqual(result, { ok: false, errors: ['$.kind: unknown kind "assignment.completed"'] })
})

test('kind 与 domain 不匹配时报错', () => {
  const result = validateEvent(withBase({ domain: 'chat', kind: 'turn.step' }))
  assert.deepEqual(result, {
    ok: false,
    errors: ['$.kind: "turn.step" does not belong to domain "chat"'],
  })
})

test('必填字段/类型/未知字段的错误按固定顺序输出', () => {
  const result = validateEvent({
    id: '',
    seq: 0,
    at: 'not-a-date',
    domain: 'chat',
    kind: 'chat.message',
    v: 2,
    payload: [],
  })
  assert.deepEqual(result, {
    ok: false,
    errors: [
      '$.id: expected a non-empty string',
      '$.seq: expected an integer >= 1',
      '$.at: expected a parseable date-time',
      '$.v: expected 1',
      '$.payload: expected an object',
    ],
  })

  const missing = validateEvent({ kind: 'chat.message', paylod: {} })
  assert.deepEqual(missing, {
    ok: false,
    errors: [
      '$: unknown field "paylod"',
      '$.id: expected a non-empty string',
      '$.seq: expected an integer >= 1',
      '$.at: expected a non-empty date-time string',
      '$.domain: expected a string',
      '$.v: expected 1',
    ],
  })
})

test('audience 只接受 team / room:<id> / member:<id>', () => {
  for (const audience of ['team', 'room:r_1', 'member:m_1']) {
    assert.equal(validateEvent(withBase({ audience })).ok, true, audience)
  }
  for (const audience of ['room', 'room:', 'member: ', 'everyone', 42]) {
    const result = validateEvent(withBase({ audience }))
    assert.equal(result.ok, false, String(audience))
    if (result.ok) continue
    assert.deepEqual(result.errors, [
      '$.audience: expected "team", "room:<id>" or "member:<id>"',
    ])
  }
})

test('actor / parent / idem / trace 的细节错误', () => {
  const result = validateEvent(withBase({
    actor: { kind: 'bot' },
    parent: 0,
    idem: '',
    trace: { run: 42, turn: 'turn_3' },
  }))
  assert.deepEqual(result, {
    ok: false,
    errors: [
      '$.actor.id: expected a non-empty string',
      '$.parent: expected an integer >= 1',
      '$.idem: expected a non-empty string',
      '$.trace.run: expected a non-empty string',
    ],
  })
})

test('非对象输入直接失败', () => {
  assert.deepEqual(validateEvent(null), { ok: false, errors: ['$: expected an object'] })
  assert.deepEqual(validateEvent([]), { ok: false, errors: ['$: expected an object'] })
  assert.deepEqual(validateEvent('x'), { ok: false, errors: ['$: expected an object'] })
})
