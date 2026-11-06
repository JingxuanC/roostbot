// 房间事件日志（docs/design/architecture-v2.md §5）。
//
// 不新建表：房间日志就是 events 里 audience = `room:<id>` 的那些行，seq 仍是全库单调。
// chat.message 是气泡；round / speaking / delta 是同一条日志上的信号。

import { appendEvent, readEvents } from './events.ts'
import { asInteger, asNonEmptyString, asOptionalString } from './internal.ts'
import type { Actor, Event, Store } from './types.ts'

export function roomAudience(roomId: string): `room:${string}` {
  return `room:${asNonEmptyString(roomId, 'roomId')}`
}

export function readRoomEvents(
  store: Store,
  input: { roomId: string; afterSeq?: number; limit?: number },
): Event[] {
  const roomId = asNonEmptyString(input.roomId, 'roomId')
  const afterSeq =
    input.afterSeq === undefined || input.afterSeq === null ? 0 : asInteger(input.afterSeq, 'afterSeq', 0)
  const limit =
    input.limit === undefined || input.limit === null
      ? 200
      : Math.min(1000, asInteger(input.limit, 'limit', 1))
  return readEvents(store, { audience: roomAudience(roomId), afterSeq, limit })
}

export interface AppendRoomSignalInput {
  roomId: string
  domain: string
  kind: string
  payload?: Record<string, unknown>
  actor?: Actor | null
  idem?: string | null
  parent?: number | null
  at?: string
}

/** 往房间日志追加一条非聊天信号。payload 里总会带上 roomId。 */
export function appendRoomSignal(store: Store, input: AppendRoomSignalInput): Event {
  const roomId = asNonEmptyString(input.roomId, 'signal.roomId')
  const payload = { roomId, ...(input.payload ?? {}) }
  return appendEvent(store, {
    domain: input.domain,
    kind: input.kind,
    actor: input.actor === undefined ? { kind: 'system', id: 'control-plane' } : input.actor,
    subject: { kind: 'room', id: roomId },
    audience: roomAudience(roomId),
    idem: asOptionalString(input.idem, 'signal.idem'),
    parent: input.parent ?? null,
    ...(input.at === undefined ? {} : { at: input.at }),
    payload,
  })
}
