// 房间与消息（docs/design/messaging.md）。
//
// 消息不单独建表：一条消息就是一个 chat.message 事件，seq 是它的身份。
// 这里只做「房间」与「按房间读消息」两件事，避免存两份真相。
//
// 日志裁剪（rooms.md §3「保留 60 条，最近 12 条首次全给」）是读模型投影：
// readRoomLogPage 只决定 API 给出哪一段，events 表本身一条不动。

import { ROUND_LIMITS } from '../../contract/src/index.ts'
import { StoreError } from './errors.ts'
import { asInteger, asNonEmptyString, asOptionalString, asRecord, assertOpen, errorMessage, toNumber } from './internal.ts'
import { newRoostId } from './ids.ts'
import { appendEvent, readEvents } from './events.ts'
import type { Actor, MessagePart, SendMessageInput, Store, Room, RoomMessage } from './types.ts'

export const REPLY_MODES = ['admin', 'everyone', 'mentions'] as const

interface RoomRow {
  id: string
  workspace_id: string
  name: string
  notice: string | null
  reply_mode: string
  created_at: number | bigint
}

export function createRoom(
  store: Store,
  input: { workspaceId: string; name: string; notice?: string; replyMode?: string; createdAt?: number },
): Room {
  assertOpen(store)
  const req = asRecord(input, 'room', 'INVALID_ROOM')
  const workspaceId = asNonEmptyString(req.workspaceId, 'room.workspaceId', 'INVALID_ROOM')
  const name = asNonEmptyString(req.name, 'room.name', 'INVALID_ROOM')
  const notice = asOptionalString(req.notice, 'room.notice', 'INVALID_ROOM')
  const replyMode = asReplyMode(req.replyMode)
  const createdAt =
    req.createdAt === undefined || req.createdAt === null
      ? Date.now()
      : asInteger(req.createdAt, 'room.createdAt', 0, 'INVALID_ROOM')

  // workspace 必须存在：房间不能挂在空气上。
  const workspace = store.db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId)
  if (workspace === undefined) {
    throw new StoreError('WORKSPACE_NOT_FOUND', `unknown workspace ${workspaceId}`)
  }

  const id = newRoostId('rm')
  try {
    store.db
      .prepare('INSERT INTO rooms (id, workspace_id, name, notice, reply_mode, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, workspaceId, name, notice, replyMode, createdAt)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new StoreError('ROOM_WRITE_FAILED', `failed to create room: ${message}`, { cause: err })
  }
  return { id, workspaceId, name, notice, replyMode, createdAt }
}

export function listRooms(store: Store, filter: { workspaceId: string }): Room[] {
  assertOpen(store)
  const workspaceId = asNonEmptyString(filter.workspaceId, 'room.workspaceId', 'INVALID_ROOM')
  const rows = store.db
    .prepare(
      'SELECT id, workspace_id, name, notice, reply_mode, created_at FROM rooms WHERE workspace_id = ? ORDER BY created_at, id',
    )
    .all(workspaceId)
  return rows.map((row) => rowToRoom(row))
}

export function getRoom(store: Store, id: string): Room | null {
  assertOpen(store)
  const roomId = asNonEmptyString(id, 'room.id', 'INVALID_ROOM')
  const row = store.db
    .prepare('SELECT id, workspace_id, name, notice, reply_mode, created_at FROM rooms WHERE id = ?')
    .get(roomId)
  return row === undefined || row === null ? null : rowToRoom(row)
}

/** 写一条消息：本质是 append 一个 chat.message 事件，并返回它的 seq。 */
export function sendMessage(store: Store, input: SendMessageInput): RoomMessage {
  assertOpen(store)
  const req = asRecord(input, 'message', 'INVALID_MESSAGE')
  const roomId = asNonEmptyString(req.roomId, 'message.roomId', 'INVALID_MESSAGE')
  if (req.text !== undefined && req.text !== null && typeof req.text !== 'string') {
    throw new StoreError('INVALID_MESSAGE', 'message.text must be a string')
  }
  const text = typeof req.text === 'string' ? req.text : ''
  const parts = normalizeParts(req.parts)
  if (text.trim() === '' && parts.length === 0) {
    throw new StoreError('INVALID_MESSAGE', 'message text is empty')
  }
  if (text.length > 8000) throw new StoreError('INVALID_MESSAGE', 'message.text is too long')
  const actor = asActor(req.actor)
  const at =
    req.at === undefined || req.at === null ? Date.now() : asInteger(req.at, 'message.at', 0, 'INVALID_MESSAGE')

  const room = getRoom(store, roomId)
  if (room === null) throw new StoreError('ROOM_NOT_FOUND', `unknown room ${roomId}`)

  const event = appendEvent(store, {
    domain: 'chat',
    kind: 'chat.message',
    actor,
    subject: { kind: 'room', id: roomId },
    audience: `room:${roomId}`,
    idem: asOptionalString(req.idem, 'message.idem', 'INVALID_MESSAGE'),
    // events.at 是 ISO 字符串（events.md §3）；调用方传毫秒。
    at: new Date(at).toISOString(),
    payload: {
      roomId,
      text,
      role: actor.kind === 'user' ? 'user' : 'bot',
      ...(parts.length === 0 ? {} : { parts }),
      ...(req.routine === undefined ? {} : { routine: req.routine }),
    },
  })

  return {
    seq: event.seq,
    at: event.at,
    actor,
    roomId,
    text,
    ...(parts.length === 0 ? {} : { parts }),
    ...(req.routine === undefined ? {} : { routine: req.routine }),
  }
}

/** 读房间消息，按 seq 升序；afterSeq 用于增量补拉（SSE 断线重连）。 */
export function readMessages(
  store: Store,
  input: { roomId: string; afterSeq?: number; limit?: number },
): RoomMessage[] {
  assertOpen(store)
  const roomId = asNonEmptyString(input.roomId, 'message.roomId', 'INVALID_MESSAGE')
  const afterSeq =
    input.afterSeq === undefined || input.afterSeq === null
      ? 0
      : asInteger(input.afterSeq, 'message.afterSeq', 0, 'INVALID_MESSAGE')
  const limit =
    input.limit === undefined || input.limit === null
      ? 200
      : Math.min(1000, asInteger(input.limit, 'message.limit', 1, 'INVALID_MESSAGE'))

  const events = readEvents(store, {
    afterSeq,
    domain: 'chat',
    audience: `room:${roomId}`,
    limit,
  })
  return events.map((event) => messageFromPayload(event.seq, event.at, event.actor, roomId, event.payload))
}

export interface RoomLogPage {
  /** 按 seq 升序。 */
  messages: RoomMessage[]
  /** 保留窗口内还有更早的消息（用 before=oldestSeq 继续向前翻）。 */
  hasMore: boolean
  /** 本页最旧一条的 seq；空页为 null。 */
  oldestSeq: number | null
  /** 裁剪窗口下界（含）：比它旧的消息不再通过房间日志读出来（events 里仍在）。 */
  floorSeq: number
}

interface LogRow {
  seq: number | bigint
  at: string
  actor_json: string | null
  payload_json: string
}

/**
 * 房间日志的裁剪投影（rooms.md §3：日志保留 60 条、首看 12 条）。
 * 省略 beforeSeq = 最新一页；给 beforeSeq = 只取 seq 比它小的上一页。
 * limit 默认 ROUND_LIMITS.firstLook，上限 ROUND_LIMITS.logMax。
 * 增量（afterSeq）读取不走这里，用 readMessages。
 */
export function readRoomLogPage(
  store: Store,
  input: { roomId: string; beforeSeq?: number; limit?: number },
): RoomLogPage {
  assertOpen(store)
  const roomId = asNonEmptyString(input.roomId, 'message.roomId', 'INVALID_MESSAGE')
  const beforeSeq =
    input.beforeSeq === undefined || input.beforeSeq === null
      ? null
      : asInteger(input.beforeSeq, 'message.beforeSeq', 1, 'INVALID_MESSAGE')
  const limit =
    input.limit === undefined || input.limit === null
      ? ROUND_LIMITS.firstLook
      : Math.min(ROUND_LIMITS.logMax, asInteger(input.limit, 'message.limit', 1, 'INVALID_MESSAGE'))

  const audience = `room:${roomId}`
  // 窗口下界 = 第 logMax 新的一条的 seq；不足 logMax 条时从头（seq 1）起。
  const floorRow = store.db
    .prepare(
      `SELECT seq FROM events WHERE domain = 'chat' AND audience = ? ORDER BY seq DESC LIMIT 1 OFFSET ?`,
    )
    .get(audience, ROUND_LIMITS.logMax - 1) as { seq: number | bigint } | undefined
  const floorSeq = floorRow === undefined || floorRow === null ? 1 : toNumber(floorRow.seq)

  const clauses = [`domain = 'chat'`, 'audience = ?', 'seq >= ?']
  const params: unknown[] = [audience, floorSeq]
  if (beforeSeq !== null) {
    clauses.push('seq < ?')
    params.push(beforeSeq)
  }
  const rows = store.db
    .prepare(
      `SELECT seq, at, actor_json, payload_json FROM events WHERE ${clauses.join(' AND ')} ORDER BY seq DESC LIMIT ?`,
    )
    .all(...params, limit) as LogRow[]

  const messages = rows.reverse().map((row) => {
    const actor = parseLogActor(row.actor_json, toNumber(row.seq))
    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>
    } catch (err) {
      throw new StoreError('EVENT_CORRUPT', `event seq=${row.seq}: payload_json is not valid JSON`, {
        cause: err,
      })
    }
    return messageFromPayload(toNumber(row.seq), row.at, actor, roomId, payload)
  })
  const oldestSeq = messages.length === 0 ? null : messages[0]!.seq
  return { messages, hasMore: oldestSeq !== null && oldestSeq > floorSeq, oldestSeq, floorSeq }
}

function normalizeParts(value: unknown): MessagePart[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new StoreError('INVALID_MESSAGE', 'message.parts must be an array')
  if (value.length > 12) throw new StoreError('INVALID_MESSAGE', 'message.parts is too long')
  return value.map((part, index) => {
    if (part === null || typeof part !== 'object' || Array.isArray(part)) {
      throw new StoreError('INVALID_MESSAGE', `message.parts[${index}] must be an object`)
    }
    const record = part as Record<string, unknown>
    const type = record.type
    if (type !== 'text' && type !== 'image' && type !== 'choice' && type !== 'approval' && type !== 'tool') {
      throw new StoreError('INVALID_MESSAGE', `message.parts[${index}].type is invalid`)
    }
    return record as MessagePart
  })
}

function messageFromPayload(
  seq: number,
  at: string,
  actor: Actor | null,
  roomId: string,
  payload: Record<string, unknown>,
): RoomMessage {
  const parts = Array.isArray(payload.parts) ? (payload.parts as MessagePart[]) : undefined
  const routine = payload.routine
  return {
    seq,
    at,
    actor: actor ?? { kind: 'system', id: 'unknown' },
    roomId,
    text: typeof payload.text === 'string' ? payload.text : '',
    ...(parts === undefined || parts.length === 0 ? {} : { parts }),
    ...(routine !== undefined && routine !== null && typeof routine === 'object' ? { routine: routine as RoomMessage['routine'] } : {}),
  }
}

function parseLogActor(raw: string | null, seq: number): Actor {
  if (raw === null) return { kind: 'system', id: 'unknown' }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (err) {
    throw new StoreError('EVENT_CORRUPT', `event seq=${seq}: actor_json is not valid JSON`, { cause: err })
  }
  const actor = value as { kind?: unknown; id?: unknown }
  if (typeof actor.kind !== 'string' || typeof actor.id !== 'string') {
    throw new StoreError('EVENT_CORRUPT', `event seq=${seq}: actor is missing kind/id`)
  }
  return { kind: actor.kind, id: actor.id }
}

/**
 * 删除房间投影：rooms / room_members / room_rounds / room_seen / bot_sessions。
 * events 是 append-only 事实源，一条不动（rooms.md §7「日志本体仍是 events」）。
 * 正在跑的轮次先标 stopped（§10 的 stop 语义），再清投影行；整个操作在一个 savepoint 里。
 */
export function deleteRoom(store: Store, roomId: string, now?: number): void {
  assertOpen(store)
  const id = asNonEmptyString(roomId, 'room.id', 'INVALID_ROOM')
  if (getRoom(store, id) === null) throw new StoreError('ROOM_NOT_FOUND', `unknown room ${id}`)
  const endedAt = now === undefined || now === null ? Date.now() : asInteger(now, 'room.now', 0, 'INVALID_ROOM')

  store.db.exec('SAVEPOINT roost_delete_room')
  try {
    store.db
      .prepare(`UPDATE room_rounds SET state = 'stopped', ended_at = ? WHERE room_id = ? AND state = 'running'`)
      .run(endedAt, id)
    store.db.prepare('DELETE FROM room_seen WHERE room_id = ?').run(id)
    store.db.prepare('DELETE FROM bot_sessions WHERE room_id = ?').run(id)
    store.db.prepare('DELETE FROM room_rounds WHERE room_id = ?').run(id)
    store.db.prepare('DELETE FROM room_members WHERE room_id = ?').run(id)
    store.db.prepare('DELETE FROM rooms WHERE id = ?').run(id)
    store.db.exec('RELEASE roost_delete_room')
  } catch (err) {
    try {
      store.db.exec('ROLLBACK TO roost_delete_room')
      store.db.exec('RELEASE roost_delete_room')
    } catch {
      // 外层事务可能已经把 savepoint 一起回滚；保留原始错误。
    }
    if (err instanceof StoreError) throw err
    throw new StoreError('ROOM_WRITE_FAILED', `failed to delete room ${id}: ${errorMessage(err)}`, { cause: err })
  }
}

function asActor(value: unknown): Actor {
  const actor = asRecord(value, 'message.actor', 'INVALID_MESSAGE')
  const kind = actor.kind
  if (kind !== 'user' && kind !== 'bot' && kind !== 'system' && kind !== 'control-plane') {
    throw new StoreError('INVALID_MESSAGE', 'message.actor.kind must be user|bot|system|control-plane')
  }
  return { kind, id: asNonEmptyString(actor.id, 'message.actor.id', 'INVALID_MESSAGE') }
}

function asReplyMode(value: unknown): string {
  if (value === undefined || value === null) return 'admin'
  if (value === 'admin' || value === 'everyone' || value === 'mentions') return value
  throw new StoreError('INVALID_ROOM', 'room.replyMode must be admin|everyone|mentions')
}

function rowToRoom(row: unknown): Room {
  const r = row as RoomRow
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    notice: r.notice,
    replyMode: r.reply_mode,
    createdAt: toNumber(r.created_at),
  }
}
