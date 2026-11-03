// 房间与消息（docs/design/messaging.md）。
//
// 消息不单独建表：一条消息就是一个 chat.message 事件，seq 是它的身份。
// 这里只做「房间」与「按房间读消息」两件事，避免存两份真相。

import { StoreError } from './errors.ts'
import { asInteger, asNonEmptyString, asOptionalString, asRecord, assertOpen, toNumber } from './internal.ts'
import { newRoostId } from './ids.ts'
import { appendEvent, readEvents } from './events.ts'
import type { Actor, SendMessageInput, Store, Room, RoomMessage } from './types.ts'

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
  const text = asNonEmptyString(req.text, 'message.text', 'INVALID_MESSAGE')
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
    payload: { roomId, text, role: actor.kind === 'user' ? 'user' : 'bot' },
  })

  return { seq: event.seq, at: event.at, actor, roomId, text }
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
  return events.map((event) => {
    const payload = event.payload as { text?: unknown }
    return {
      seq: event.seq,
      at: event.at,
      actor: event.actor,
      roomId,
      text: typeof payload.text === 'string' ? payload.text : '',
    }
  })
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
