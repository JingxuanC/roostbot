// 事件日志（events.md）。只追加：本模块没有 update/delete。
//
// 关键规则（events.md §3）：
//   1. seq 是唯一排序依据，时间戳不参与排序；
//   2. idem 唯一，重复写入返回已有事件，不报错、不写第二条；
//   3. kind 是 domain.action，前缀必须是 domain。

import { StoreError } from './errors.ts'
import {
  asInteger,
  asNonEmptyString,
  asOptionalInteger,
  asOptionalString,
  asRecord,
  assertOpen,
  errorMessage,
  toNumber,
} from './internal.ts'
import { newEventId } from './ids.ts'
import type { Actor, Event, NewEvent, ReadEventsQuery, Store, Subject } from './types.ts'

interface EventRow {
  seq: number | bigint
  id: string
  at: string
  domain: string
  kind: string
  actor_json: string | null
  subject_json: string | null
  audience: string | null
  parent: number | bigint | null
  idem: string | null
  trace_json: string | null
  payload_json: string
  v: number | bigint
}

const COLUMNS =
  'seq, id, at, domain, kind, actor_json, subject_json, audience, parent, idem, trace_json, payload_json, v'

let eventSink: ((event: Event) => void) | null = null

/** 注册一个只读事件出口（指标/审计）；传 null 关闭。写库成功后才回调，异常被吞掉。 */
export function setEventSink(sink: ((event: Event) => void) | null): void {
  eventSink = sink
}

export function appendEvent(store: Store, event: NewEvent): Event {
  assertOpen(store)
  const input = asRecord(event, 'event', 'INVALID_EVENT')

  const domain = asNonEmptyString(input.domain, 'event.domain', 'INVALID_EVENT')
  const kind = asNonEmptyString(input.kind, 'event.kind', 'INVALID_EVENT')
  if (!kind.startsWith(`${domain}.`)) {
    throw new StoreError(
      'INVALID_EVENT',
      `event.kind "${kind}" must start with "${domain}." (events.md §3)`,
    )
  }

  const id =
    input.id === undefined || input.id === null
      ? newEventId()
      : asNonEmptyString(input.id, 'event.id', 'INVALID_EVENT')

  let at: string
  if (input.at === undefined || input.at === null) {
    at = new Date().toISOString()
  } else {
    at = asNonEmptyString(input.at, 'event.at', 'INVALID_EVENT')
    if (Number.isNaN(Date.parse(at))) {
      throw new StoreError('INVALID_EVENT', `event.at is not a parseable date: ${at}`)
    }
  }

  const actor = asActor(input.actor, 'event.actor')
  const subject = asActor(input.subject, 'event.subject')
  const audience = asOptionalString(input.audience, 'event.audience', 'INVALID_EVENT')
  const parent = asOptionalInteger(input.parent, 'event.parent', 1, 'INVALID_EVENT')
  const idem = asOptionalString(input.idem, 'event.idem', 'INVALID_EVENT')
  const v = input.v === undefined || input.v === null ? 1 : asInteger(input.v, 'event.v', 1, 'INVALID_EVENT')
  const traceJson = encodeObject(input.trace, 'event.trace')
  const payloadJson = encodeObject(input.payload, 'event.payload') ?? '{}'

  // 幂等：先读一次；写冲突时（并发同 idem）再读一次并返回已有事件。
  if (idem !== null) {
    const existing = eventByIdem(store, idem)
    if (existing !== null) return existing
  }

  if (parent !== null && !eventExists(store, parent)) {
    throw new StoreError('PARENT_NOT_FOUND', `event.parent ${parent} does not exist in this log`)
  }

  try {
    store.db
      .prepare(
        `INSERT INTO events (id, at, domain, kind, actor_json, subject_json, audience, parent, idem, trace_json, payload_json, v)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        at,
        domain,
        kind,
        actor === null ? null : JSON.stringify(actor),
        subject === null ? null : JSON.stringify(subject),
        audience,
        parent,
        idem,
        traceJson,
        payloadJson,
        v,
      )
  } catch (err) {
    const message = errorMessage(err)
    if (idem !== null && message.includes('events.idem')) {
      const existing = eventByIdem(store, idem)
      if (existing !== null) return existing
    }
    if (message.includes('events.id')) {
      throw new StoreError('EVENT_ID_CONFLICT', `event id already exists: ${id}`, { cause: err })
    }
    if (message.includes('FOREIGN KEY')) {
      throw new StoreError('PARENT_NOT_FOUND', `event.parent ${parent} does not exist in this log`, {
        cause: err,
      })
    }
    throw new StoreError('EVENT_WRITE_FAILED', `failed to append event ${id}: ${message}`, {
      cause: err,
    })
  }

  const row = store.db.prepare(`SELECT ${COLUMNS} FROM events WHERE id = ?`).get(id)
  if (row === undefined || row === null) {
    throw new StoreError('EVENT_WRITE_FAILED', `event ${id} was inserted but cannot be read back`)
  }
  const appended = rowToEvent(row)
  if (eventSink !== null) {
    try {
      eventSink(appended)
    } catch {
      // 指标/审计出口失败不能影响事件写入。
    }
  }
  return appended
}

/** 按 seq 升序读；afterSeq 用于断线续传（workspace.md §4「断线重连从事件 seq 续」）。 */
export function readEvents(store: Store, query: ReadEventsQuery = {}): Event[] {
  assertOpen(store)
  const input = asRecord(query, 'query')

  const clauses: string[] = []
  const params: unknown[] = []

  if (input.afterSeq !== undefined && input.afterSeq !== null) {
    const afterSeq = asInteger(input.afterSeq, 'query.afterSeq', 0)
    clauses.push('seq > ?')
    params.push(afterSeq)
  }
  if (input.domain !== undefined && input.domain !== null) {
    clauses.push('domain = ?')
    params.push(asNonEmptyString(input.domain, 'query.domain'))
  }
  if (input.audience !== undefined && input.audience !== null) {
    clauses.push('audience = ?')
    params.push(asNonEmptyString(input.audience, 'query.audience'))
  }

  let limit: number | null = null
  if (input.limit !== undefined && input.limit !== null) {
    limit = asInteger(input.limit, 'query.limit', 1)
  }

  let sql = `SELECT ${COLUMNS} FROM events`
  if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`
  sql += ' ORDER BY seq ASC'
  if (limit !== null) {
    sql += ' LIMIT ?'
    params.push(limit)
  }

  const rows = store.db.prepare(sql).all(...params)
  return rows.map(rowToEvent)
}

export function latestSeq(store: Store): number {
  assertOpen(store)
  const row = store.db.prepare('SELECT MAX(seq) AS seq FROM events').get() as
    | { seq: number | bigint | null }
    | undefined
  if (row === undefined || row === null || row.seq === null || row.seq === undefined) return 0
  return toNumber(row.seq)
}

function eventByIdem(store: Store, idem: string): Event | null {
  const row = store.db.prepare(`SELECT ${COLUMNS} FROM events WHERE idem = ?`).get(idem)
  if (row === undefined || row === null) return null
  return rowToEvent(row)
}

function eventExists(store: Store, seq: number): boolean {
  return store.db.prepare('SELECT 1 AS ok FROM events WHERE seq = ?').get(seq) !== undefined
}

function asActor(value: unknown, label: string): Actor | Subject | null {
  if (value === undefined || value === null) return null
  const record = asRecord(value, label, 'INVALID_EVENT')
  return {
    kind: asNonEmptyString(record.kind, `${label}.kind`, 'INVALID_EVENT'),
    id: asNonEmptyString(record.id, `${label}.id`, 'INVALID_EVENT'),
  }
}

function encodeObject(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreError('INVALID_EVENT', `${label} must be a plain object`)
  }
  try {
    return JSON.stringify(value)
  } catch (err) {
    throw new StoreError('INVALID_EVENT', `${label} is not JSON-serializable: ${errorMessage(err)}`, {
      cause: err,
    })
  }
}

function decodeObject(text: string | null, label: string, seq: number): Record<string, unknown> | null {
  if (text === null || text === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new StoreError('EVENT_CORRUPT', `event seq=${seq}: ${label} is not valid JSON`, { cause: err })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StoreError('EVENT_CORRUPT', `event seq=${seq}: ${label} is not a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function rowToEvent(row: unknown): Event {
  const r = row as EventRow
  const seq = toNumber(r.seq)
  const actor = decodeObject(r.actor_json, 'actor_json', seq)
  const subject = decodeObject(r.subject_json, 'subject_json', seq)
  if (actor !== null && (typeof actor.kind !== 'string' || typeof actor.id !== 'string')) {
    throw new StoreError('EVENT_CORRUPT', `event seq=${seq}: actor is missing kind/id`)
  }
  if (subject !== null && (typeof subject.kind !== 'string' || typeof subject.id !== 'string')) {
    throw new StoreError('EVENT_CORRUPT', `event seq=${seq}: subject is missing kind/id`)
  }

  return {
    id: r.id,
    seq,
    at: r.at,
    domain: r.domain,
    kind: r.kind,
    actor: actor as unknown as Actor | null,
    subject: subject as unknown as Subject | null,
    audience: r.audience,
    parent: r.parent === null || r.parent === undefined ? null : toNumber(r.parent),
    idem: r.idem,
    trace: decodeObject(r.trace_json, 'trace_json', seq),
    v: toNumber(r.v),
    payload: decodeObject(r.payload_json, 'payload_json', seq) ?? {},
  }
}
