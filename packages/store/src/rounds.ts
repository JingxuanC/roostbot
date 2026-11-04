// 轮次持久化（docs/design/rooms.md §7）。
//
// room_rounds 只存“这一轮跑到哪”：slots 是 JSON，日志本体仍在 events 里，不存两份内容。
// room_seen 是每成员已读游标；bot_sessions 是 (room,bot) 到 DSH 会话的映射。

import type { RoomRound, RoundSlot } from '../../contract/src/index.ts'
import { StoreError } from './errors.ts'
import { assertOpen, asNonEmptyString, asRecord, toNumber } from './internal.ts'
import type { Store } from './types.ts'

interface RoundRow {
  id: string
  room_id: string
  start_seq: number | bigint
  state: string
  slots_json: string
  turns: number | bigint
  started_at: number | bigint
  ended_at: number | bigint | null
}

function parseSlots(json: string, roundId: string): RoundSlot[] {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    throw new StoreError('EVENT_CORRUPT', `round ${roundId} has unreadable slots`, { cause: error })
  }
  if (!Array.isArray(value)) {
    throw new StoreError('EVENT_CORRUPT', `round ${roundId} slots is not an array`)
  }
  return value as RoundSlot[]
}

function rowToRound(row: RoundRow): RoomRound {
  const state = row.state === 'done' || row.state === 'stopped' ? row.state : 'running'
  const endedAt = row.ended_at === null || row.ended_at === undefined ? undefined : toNumber(row.ended_at)
  return {
    id: row.id,
    roomId: row.room_id,
    startSeq: toNumber(row.start_seq),
    state,
    slots: parseSlots(row.slots_json, row.id),
    turns: toNumber(row.turns),
    startedAt: toNumber(row.started_at),
    ...(endedAt === undefined ? {} : { endedAt })
  }
}

/** 插入或更新一轮（同 id 覆盖状态与 slots）。 */
export function saveRound(store: Store, round: RoomRound): void {
  assertOpen(store)
  const req = asRecord(round, 'round', 'INVALID_INPUT')
  const id = asNonEmptyString(req.id, 'round.id', 'INVALID_INPUT')
  store.db
    .prepare(
      `INSERT INTO room_rounds (id, room_id, start_seq, state, slots_json, turns, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         slots_json = excluded.slots_json,
         turns = excluded.turns,
         ended_at = excluded.ended_at`
    )
    .run(
      id,
      asNonEmptyString(req.roomId, 'round.roomId', 'INVALID_INPUT'),
      toNumber(req.startSeq),
      asNonEmptyString(req.state, 'round.state', 'INVALID_INPUT'),
      JSON.stringify(req.slots ?? []),
      toNumber(req.turns ?? 0),
      toNumber(req.startedAt ?? Date.now()),
      req.endedAt === undefined || req.endedAt === null ? null : toNumber(req.endedAt)
    )
}

export function getRound(store: Store, id: string): RoomRound | null {
  assertOpen(store)
  const row = store.db.prepare('SELECT * FROM room_rounds WHERE id = ?').get(asNonEmptyString(id, 'round.id', 'INVALID_INPUT')) as
    | RoundRow
    | undefined
  return row === undefined || row === null ? null : rowToRound(row)
}

/** 房间当前进行中的一轮（同一时刻最多一轮）。 */
export function activeRound(store: Store, roomId: string): RoomRound | null {
  assertOpen(store)
  const row = store.db
    .prepare('SELECT * FROM room_rounds WHERE room_id = ? AND state = ? ORDER BY started_at DESC LIMIT 1')
    .get(asNonEmptyString(roomId, 'round.roomId', 'INVALID_INPUT'), 'running') as RoundRow | undefined
  return row === undefined || row === null ? null : rowToRound(row)
}

/** 房间最近一轮（不论状态）：轮次结束后 GET 仍能看到 done/stopped。 */
export function latestRound(store: Store, roomId: string): RoomRound | null {
  assertOpen(store)
  const row = store.db
    .prepare('SELECT * FROM room_rounds WHERE room_id = ? ORDER BY started_at DESC LIMIT 1')
    .get(asNonEmptyString(roomId, 'round.roomId', 'INVALID_INPUT')) as RoundRow | undefined
  return row === undefined || row === null ? null : rowToRound(row)
}

export function listRounds(store: Store, roomId: string, limit = 20): RoomRound[] {
  assertOpen(store)
  const rows = store.db
    .prepare('SELECT * FROM room_rounds WHERE room_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(asNonEmptyString(roomId, 'round.roomId', 'INVALID_INPUT'), Math.max(1, Math.min(200, limit))) as RoundRow[]
  return rows.map(rowToRound)
}

/** 推进已读游标（只增不减）。 */
export function markSeen(store: Store, roomId: string, botId: string, seq: number): void {
  assertOpen(store)
  store.db
    .prepare(
      `INSERT INTO room_seen (room_id, bot_id, seq) VALUES (?, ?, ?)
       ON CONFLICT(room_id, bot_id) DO UPDATE SET seq = MAX(room_seen.seq, excluded.seq)`
    )
    .run(asNonEmptyString(roomId, 'seen.roomId', 'INVALID_INPUT'), asNonEmptyString(botId, 'seen.botId', 'INVALID_INPUT'), toNumber(seq))
}

export function seenSeq(store: Store, roomId: string, botId: string): number {
  assertOpen(store)
  const row = store.db
    .prepare('SELECT seq FROM room_seen WHERE room_id = ? AND bot_id = ?')
    .get(asNonEmptyString(roomId, 'seen.roomId', 'INVALID_INPUT'), asNonEmptyString(botId, 'seen.botId', 'INVALID_INPUT')) as
    | { seq: number | bigint }
    | undefined
  return row === undefined || row === null ? 0 : toNumber(row.seq)
}

export function setBotSession(store: Store, roomId: string, botId: string, sessionId: string): void {
  assertOpen(store)
  store.db
    .prepare(
      `INSERT INTO bot_sessions (room_id, bot_id, session_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(room_id, bot_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`
    )
    .run(
      asNonEmptyString(roomId, 'session.roomId', 'INVALID_INPUT'),
      asNonEmptyString(botId, 'session.botId', 'INVALID_INPUT'),
      asNonEmptyString(sessionId, 'session.sessionId', 'INVALID_INPUT'),
      Date.now()
    )
}

export function botSession(store: Store, roomId: string, botId: string): string | null {
  assertOpen(store)
  const row = store.db
    .prepare('SELECT session_id FROM bot_sessions WHERE room_id = ? AND bot_id = ?')
    .get(asNonEmptyString(roomId, 'session.roomId', 'INVALID_INPUT'), asNonEmptyString(botId, 'session.botId', 'INVALID_INPUT')) as
    | { session_id: string }
    | undefined
  return row === undefined || row === null ? null : row.session_id
}
