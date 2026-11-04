// 房间成员（docs/design/rooms.md §2/§6、docs/build/m4-contract.md §1）。
//
// 不变量：
//   1. 一个房间最多 ROOM_LIMITS.membersMax 个 Bot 成员；
//   2. 只要房间里有 Bot 成员，就有且只有一个 host（room_members.role='host' 且
//      rooms.host_bot_id 同步）；DB 里还有部分唯一索引兜底；
//   3. 成员必须是同 workspace 的、存在的 Bot；
//   4. 移除成员时同时清理它的已读游标/会话，并在 responder 指向它时回退到新 host，
//      这样房间不会指向幽灵成员。
//
// room_members 是 0003 建的表：(room_id, bot_id, user_id, role)。role 已存在，这里不 ALTER。

import { ROOM_LIMITS } from '../../contract/src/index.ts'
import type { RoomMember } from '../../contract/src/index.ts'
import { StoreError } from './errors.ts'
import { asNonEmptyString, asRecord, assertOpen, errorMessage } from './internal.ts'
import { getRoom } from './rooms.ts'
import type { Store } from './types.ts'

export interface AddRoomMembersInput {
  roomId: string
  botIds: string[]
  /** 默认 member。role='host' 时必须是唯一一个 bot，并替换原 host。 */
  role?: 'host' | 'member'
  now?: number
}

export interface RemoveRoomMemberInput {
  roomId: string
  botId: string
}

interface MemberRow {
  bot_id: string
  role: string
  created_at: number | bigint
  name: string | null
}

const MEMBER_SELECT = `
  SELECT m.bot_id AS bot_id, m.role AS role, m.created_at AS created_at, b.name AS name
    FROM room_members m
    LEFT JOIN bots b ON b.id = m.bot_id
   WHERE m.room_id = ? AND m.bot_id IS NOT NULL
   ORDER BY CASE m.role WHEN 'host' THEN 0 ELSE 1 END, m.created_at, m.bot_id`

export function listRoomMembers(store: Store, roomId: string): RoomMember[] {
  assertOpen(store)
  const id = asNonEmptyString(roomId, 'room.id', 'INVALID_ROOM_MEMBER')
  if (getRoom(store, id) === null) throw new StoreError('ROOM_NOT_FOUND', `unknown room ${id}`)
  const rows = store.db.prepare(MEMBER_SELECT).all(id) as MemberRow[]
  return rows.map((row) => {
    const member: RoomMember = {
      botId: row.bot_id,
      role: row.role === 'host' ? 'host' : 'member',
    }
    if (row.name !== null) member.name = row.name
    return member
  })
}

export function addRoomMembers(store: Store, input: AddRoomMembersInput): RoomMember[] {
  assertOpen(store)
  const req = asRecord(input, 'room.members', 'INVALID_ROOM_MEMBER')
  const roomId = asNonEmptyString(req.roomId, 'room.members.roomId', 'INVALID_ROOM_MEMBER')
  const room = getRoom(store, roomId)
  if (room === null) throw new StoreError('ROOM_NOT_FOUND', `unknown room ${roomId}`)

  const botIds = readBotIds(req.botIds)
  const role = readRole(req.role)
  if (role === 'host' && botIds.length !== 1) {
    throw new StoreError('ROOM_HOST_CONFLICT', 'adding a host requires exactly one botId')
  }
  const now =
    req.now === undefined || req.now === null ? Date.now() : Number(req.now)
  if (!Number.isInteger(now) || now < 0) {
    throw new StoreError('INVALID_ROOM_MEMBER', 'room.members.now must be a non-negative integer')
  }

  // 成员必须存在且属于同一个 workspace；这里逐个查，错的时候能说清楚是哪个 Bot。
  for (const botId of botIds) {
    const bot = store.db.prepare('SELECT id, workspace_id, name FROM bots WHERE id = ?').get(botId) as
      | { id: string; workspace_id: string; name: string }
      | undefined
    if (bot === undefined || bot === null) {
      throw new StoreError('ROOM_MEMBERS_INVALID', `unknown bot ${botId}`)
    }
    if (bot.workspace_id !== room.workspaceId) {
      throw new StoreError(
        'ROOM_MEMBERS_INVALID',
        `bot ${botId} belongs to ${bot.workspace_id}, room ${roomId} is in ${room.workspaceId}`,
      )
    }
  }

  const existingRows = store.db
    .prepare('SELECT bot_id FROM room_members WHERE room_id = ? AND bot_id IS NOT NULL')
    .all(roomId) as Array<{ bot_id: string }>
  const existing = new Set(existingRows.map((row) => row.bot_id))
  const toAdd = botIds.filter((botId) => !existing.has(botId))
  if (existing.size + toAdd.length > ROOM_LIMITS.membersMax) {
    throw new StoreError(
      'ROOM_MEMBERS_INVALID',
      `a room holds at most ${ROOM_LIMITS.membersMax} bots (rooms.md §3)`,
    )
  }

  store.db.exec('SAVEPOINT roost_add_room_members')
  try {
    if (role === 'host') {
      const botId = botIds[0]!
      store.db
        .prepare("UPDATE room_members SET role = 'member' WHERE room_id = ? AND role = 'host' AND bot_id IS NOT NULL")
        .run(roomId)
      if (existing.has(botId)) {
        store.db.prepare("UPDATE room_members SET role = 'host' WHERE room_id = ? AND bot_id = ?").run(roomId, botId)
      } else {
        store.db
          .prepare("INSERT INTO room_members (room_id, bot_id, user_id, role, created_at) VALUES (?, ?, NULL, 'host', ?)")
          .run(roomId, botId, now)
      }
      store.db.prepare('UPDATE rooms SET host_bot_id = ? WHERE id = ?').run(botId, roomId)
    } else {
      for (const botId of toAdd) {
        store.db
          .prepare("INSERT INTO room_members (room_id, bot_id, user_id, role, created_at) VALUES (?, ?, NULL, 'member', ?)")
          .run(roomId, botId, now)
      }
      // 老房间可能一个 host 都没有：把这次加进来的第一个成员提成 host
      // （不按 bot_id 排序，保持「首个勾选默认 host」的语义）。
      const host = store.db
        .prepare("SELECT bot_id FROM room_members WHERE room_id = ? AND role = 'host' AND bot_id IS NOT NULL LIMIT 1")
        .get(roomId) as { bot_id: string } | undefined
      if (host === undefined || host === null) {
        const preferred = toAdd[0]
        if (preferred === undefined) {
          ensureHost(store, roomId)
        } else {
          store.db
            .prepare("UPDATE room_members SET role = 'host' WHERE room_id = ? AND bot_id = ?")
            .run(roomId, preferred)
          store.db.prepare('UPDATE rooms SET host_bot_id = ? WHERE id = ?').run(preferred, roomId)
        }
      } else {
        store.db.prepare('UPDATE rooms SET host_bot_id = ? WHERE id = ?').run(host.bot_id, roomId)
      }
    }
    store.db.exec('RELEASE roost_add_room_members')
  } catch (err) {
    rollback(store, 'roost_add_room_members')
    if (err instanceof StoreError) throw err
    const message = errorMessage(err)
    if (message.includes('UNIQUE')) {
      throw new StoreError('ROOM_HOST_CONFLICT', `room ${roomId} already has a host`, { cause: err })
    }
    throw new StoreError('ROOM_WRITE_FAILED', `failed to add room members: ${message}`, { cause: err })
  }

  return listRoomMembers(store, roomId)
}

/** 换 host：目标必须已经是成员；原 host 降为 member，rooms.host_bot_id 同步。 */
export function setRoomHost(store: Store, input: { roomId: string; botId: string }): RoomMember[] {
  assertOpen(store)
  const req = asRecord(input, 'room.host', 'INVALID_ROOM_MEMBER')
  const roomId = asNonEmptyString(req.roomId, 'room.host.roomId', 'INVALID_ROOM_MEMBER')
  const botId = asNonEmptyString(req.botId, 'room.host.botId', 'INVALID_ROOM_MEMBER')
  if (getRoom(store, roomId) === null) throw new StoreError('ROOM_NOT_FOUND', `unknown room ${roomId}`)

  const member = store.db
    .prepare('SELECT role FROM room_members WHERE room_id = ? AND bot_id = ?')
    .get(roomId, botId)
  if (member === undefined || member === null) {
    throw new StoreError('ROOM_MEMBER_NOT_FOUND', `bot ${botId} is not a member of ${roomId}`)
  }

  store.db.exec('SAVEPOINT roost_set_room_host')
  try {
    store.db
      .prepare("UPDATE room_members SET role = 'member' WHERE room_id = ? AND role = 'host' AND bot_id IS NOT NULL")
      .run(roomId)
    store.db.prepare("UPDATE room_members SET role = 'host' WHERE room_id = ? AND bot_id = ?").run(roomId, botId)
    store.db.prepare('UPDATE rooms SET host_bot_id = ? WHERE id = ?').run(botId, roomId)
    store.db.exec('RELEASE roost_set_room_host')
  } catch (err) {
    rollback(store, 'roost_set_room_host')
    throw new StoreError('ROOM_WRITE_FAILED', `failed to set host for ${roomId}: ${errorMessage(err)}`, {
      cause: err,
    })
  }

  return listRoomMembers(store, roomId)
}

export function removeRoomMember(store: Store, input: RemoveRoomMemberInput): RoomMember[] {
  assertOpen(store)
  const req = asRecord(input, 'room.member.remove', 'INVALID_ROOM_MEMBER')
  const roomId = asNonEmptyString(req.roomId, 'room.member.roomId', 'INVALID_ROOM_MEMBER')
  const botId = asNonEmptyString(req.botId, 'room.member.botId', 'INVALID_ROOM_MEMBER')
  if (getRoom(store, roomId) === null) throw new StoreError('ROOM_NOT_FOUND', `unknown room ${roomId}`)

  const member = store.db.prepare('SELECT role FROM room_members WHERE room_id = ? AND bot_id = ?').get(roomId, botId)
  if (member === undefined || member === null) {
    throw new StoreError('ROOM_MEMBER_NOT_FOUND', `bot ${botId} is not a member of ${roomId}`)
  }

  store.db.exec('SAVEPOINT roost_remove_room_member')
  try {
    detachMember(store, roomId, botId)
    store.db.exec('RELEASE roost_remove_room_member')
  } catch (err) {
    rollback(store, 'roost_remove_room_member')
    throw new StoreError('ROOM_WRITE_FAILED', `failed to remove ${botId} from ${roomId}: ${errorMessage(err)}`, {
      cause: err,
    })
  }

  return listRoomMembers(store, roomId)
}

/** Bot 被删除时调用：退出它所在的每个房间。调用方负责事务。 */
export function detachBotFromRooms(store: Store, botId: string): void {
  assertOpen(store)
  const rows = store.db
    .prepare('SELECT room_id FROM room_members WHERE bot_id = ? AND bot_id IS NOT NULL')
    .all(botId) as Array<{ room_id: string }>
  for (const row of rows) detachMember(store, row.room_id, botId)
  store.db.prepare('DELETE FROM room_seen WHERE bot_id = ?').run(botId)
  store.db.prepare('DELETE FROM bot_sessions WHERE bot_id = ?').run(botId)
}

// ---- 内部 --------------------------------------------------------------------

function detachMember(store: Store, roomId: string, botId: string): void {
  const member = store.db.prepare('SELECT role FROM room_members WHERE room_id = ? AND bot_id = ?').get(roomId, botId) as
    | { role: string }
    | undefined
  if (member === undefined || member === null) return

  store.db.prepare('DELETE FROM room_members WHERE room_id = ? AND bot_id = ?').run(roomId, botId)
  store.db.prepare('DELETE FROM room_seen WHERE room_id = ? AND bot_id = ?').run(roomId, botId)
  store.db.prepare('DELETE FROM bot_sessions WHERE room_id = ? AND bot_id = ?').run(roomId, botId)

  if (member.role === 'host') {
    const hostBotId = promoteFirstMember(store, roomId)
    cleanupResponder(store, roomId, botId, hostBotId)
  } else {
    const host = store.db
      .prepare("SELECT bot_id FROM room_members WHERE room_id = ? AND role = 'host' AND bot_id IS NOT NULL LIMIT 1")
      .get(roomId) as { bot_id: string } | undefined
    cleanupResponder(store, roomId, botId, host === undefined || host === null ? null : host.bot_id)
  }
}

/** 没有 host / host 与 rooms.host_bot_id 不一致时修正。返回当前 host。 */
function ensureHost(store: Store, roomId: string): string | null {
  const host = store.db
    .prepare("SELECT bot_id FROM room_members WHERE room_id = ? AND role = 'host' AND bot_id IS NOT NULL LIMIT 1")
    .get(roomId) as { bot_id: string } | undefined
  if (host !== undefined && host !== null) {
    store.db.prepare('UPDATE rooms SET host_bot_id = ? WHERE id = ?').run(host.bot_id, roomId)
    return host.bot_id
  }
  return promoteFirstMember(store, roomId)
}

function promoteFirstMember(store: Store, roomId: string): string | null {
  const next = store.db
    .prepare(
      'SELECT bot_id FROM room_members WHERE room_id = ? AND bot_id IS NOT NULL ORDER BY created_at, bot_id LIMIT 1',
    )
    .get(roomId) as { bot_id: string } | undefined
  if (next === undefined || next === null) {
    store.db.prepare('UPDATE rooms SET host_bot_id = NULL WHERE id = ?').run(roomId)
    return null
  }
  store.db.prepare("UPDATE room_members SET role = 'host' WHERE room_id = ? AND bot_id = ?").run(roomId, next.bot_id)
  store.db.prepare('UPDATE rooms SET host_bot_id = ? WHERE id = ?').run(next.bot_id, roomId)
  return next.bot_id
}

/** responder 指向被移除的成员时回退到新 host（没有成员就回 mentions）。 */
function cleanupResponder(store: Store, roomId: string, removedBotId: string, hostBotId: string | null): void {
  const row = store.db.prepare('SELECT responder_json FROM rooms WHERE id = ?').get(roomId) as
    | { responder_json: string | null }
    | undefined
  if (row === undefined || row === null || row.responder_json === null) return

  let responder: unknown
  try {
    responder = JSON.parse(row.responder_json)
  } catch {
    return
  }
  if (typeof responder !== 'object' || responder === null || Array.isArray(responder)) return
  const record = responder as Record<string, unknown>
  let changed = false
  if (record.kind === 'member' && record.botId === removedBotId) {
    responder = hostBotId === null ? { kind: 'mentions' } : { kind: 'member', botId: hostBotId }
    changed = true
  } else if (record.kind === 'auto' && record.fallbackBotId === removedBotId) {
    if (hostBotId === null) {
      responder = { kind: 'auto' }
    } else {
      responder = { kind: 'auto', fallbackBotId: hostBotId }
    }
    changed = true
  }
  if (changed) {
    store.db.prepare('UPDATE rooms SET responder_json = ? WHERE id = ?').run(JSON.stringify(responder), roomId)
  }
}

function readBotIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new StoreError('INVALID_ROOM_MEMBER', 'botIds must be an array of strings')
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new StoreError('INVALID_ROOM_MEMBER', 'botIds must contain non-empty strings')
    }
    const id = item.trim()
    if (!out.includes(id)) out.push(id)
  }
  if (out.length === 0) throw new StoreError('INVALID_ROOM_MEMBER', 'botIds must not be empty')
  return out
}

function readRole(value: unknown): 'host' | 'member' {
  if (value === undefined || value === null) return 'member'
  if (value === 'host' || value === 'member') return value
  throw new StoreError('INVALID_ROOM_MEMBER', "room.members.role must be 'host' or 'member'")
}

function rollback(store: Store, savepoint: string): void {
  try {
    store.db.exec(`ROLLBACK TO ${savepoint}`)
    store.db.exec(`RELEASE ${savepoint}`)
  } catch {
    // 外层事务可能已经把 savepoint 一起回滚；保留原始错误。
  }
}
