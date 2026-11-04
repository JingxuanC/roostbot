// 房间扩展（docs/build/m4-contract.md §1/§2、docs/design/rooms.md §4/§7）。
//
// rooms 在 0003 只有 name/notice/reply_mode；0005 补了 host_bot_id、responder_json、
// purpose、created_by_kind、created_by（以及设计文档里的 bulletin 列）。
//
// 本模块负责：
//   * createRoomExt：建房 + 成员 + host + responder + notice/purpose 一次落库（一个 savepoint）；
//   * getRoomExtras / updateRoomExtras：M4 的新字段；
//   * getRoomDetail：房间 + extras + members，给 API 层直接用。
//
// responder 的 fallback 链照抄 rooms.md §4：
//   指定成员存在？→ 用它；否则 → 成员里的第一个；没有成员 → mentions。
// 显式写入一个不存在的成员一律 ROOM_RESPONDER_INVALID（OMB checkedGroupResponder）。

import { ROOM_LIMITS } from '../../contract/src/index.ts'
import type { RoomMember, RoomResponder } from '../../contract/src/index.ts'
import { StoreError } from './errors.ts'
import { asNonEmptyString, asRecord, assertOpen, errorMessage } from './internal.ts'
import { addRoomMembers, listRoomMembers, setRoomHost } from './room-members.ts'
import { createRoom, getRoom } from './rooms.ts'
import type { Room, Store } from './types.ts'

export interface RoomExtras {
  hostBotId: string | null
  responder: RoomResponder
  notice: string | null
  purpose: string | null
  /** 设计文档里的公告列；M4 API 的 notice 仍写 rooms.notice（见交付报告）。 */
  bulletin: string | null
  createdByKind: 'user' | 'bot'
  createdBy: string | null
}

export interface RoomDetail {
  room: Room
  extras: RoomExtras
  members: RoomMember[]
}

export interface CreateRoomExtInput {
  workspaceId: string
  /** 省略时按成员名生成（"研究员、评审员"）。 */
  name?: string
  notice?: string
  purpose?: string
  memberBotIds?: string[]
  hostBotId?: string
  responder?: RoomResponder
  createdByKind?: 'user' | 'bot'
  createdBy?: string
  createdAt?: number
}

export interface UpdateRoomExtrasInput {
  roomId: string
  name?: string
  /** null / '' 清空公告。 */
  notice?: string | null
  purpose?: string | null
  hostBotId?: string | null
  responder?: RoomResponder
  createdByKind?: 'user' | 'bot'
  createdBy?: string | null
}

interface RoomExtrasRow {
  name: string
  notice: string | null
  bulletin: string | null
  purpose: string | null
  host_bot_id: string | null
  responder_json: string | null
  reply_mode: string
  created_by_kind: string | null
  created_by: string | null
}

const EXTRAS_COLUMNS =
  'name, notice, bulletin, purpose, host_bot_id, responder_json, reply_mode, created_by_kind, created_by'

export function getRoomExtras(store: Store, roomId: string): RoomExtras | null {
  assertOpen(store)
  const id = asNonEmptyString(roomId, 'room.id', 'INVALID_ROOM')
  const row = store.db.prepare(`SELECT ${EXTRAS_COLUMNS} FROM rooms WHERE id = ?`).get(id) as
    | RoomExtrasRow
    | undefined
  if (row === undefined || row === null) return null

  const members = listRoomMembers(store, id)
  const memberIds = members.map((member) => member.botId)
  const memberHost = members.find((member) => member.role === 'host')?.botId
  const hostBotId = row.host_bot_id ?? memberHost ?? members[0]?.botId ?? null
  const stored = decodeResponder(row.responder_json)
  const responder = resolveResponder(stored ?? deriveFromReplyMode(row.reply_mode, memberIds, hostBotId), memberIds, hostBotId)

  return {
    hostBotId,
    responder,
    notice: row.notice,
    purpose: row.purpose,
    bulletin: row.bulletin,
    createdByKind: row.created_by_kind === 'bot' ? 'bot' : 'user',
    createdBy: row.created_by,
  }
}

export function getRoomDetail(store: Store, roomId: string): RoomDetail | null {
  assertOpen(store)
  const id = asNonEmptyString(roomId, 'room.id', 'INVALID_ROOM')
  const room = getRoom(store, id)
  if (room === null) return null
  const extras = getRoomExtras(store, id)
  if (extras === null) return null
  return { room, extras, members: listRoomMembers(store, id) }
}

export function createRoomExt(store: Store, input: CreateRoomExtInput): RoomDetail {
  assertOpen(store)
  const req = asRecord(input, 'room', 'INVALID_ROOM')
  const workspaceId = asNonEmptyString(req.workspaceId, 'room.workspaceId', 'INVALID_ROOM')
  const workspace = store.db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId)
  if (workspace === undefined || workspace === null) {
    throw new StoreError('WORKSPACE_NOT_FOUND', `unknown workspace ${workspaceId}`)
  }

  const memberBotIds = readBotIdList(req.memberBotIds)
  if (memberBotIds.length > ROOM_LIMITS.membersMax) {
    throw new StoreError(
      'ROOM_MEMBERS_INVALID',
      `a room holds at most ${ROOM_LIMITS.membersMax} bots (rooms.md §3)`,
    )
  }

  const memberNames: string[] = []
  for (const botId of memberBotIds) {
    const bot = store.db.prepare('SELECT id, name, workspace_id FROM bots WHERE id = ?').get(botId) as
      | { id: string; name: string; workspace_id: string }
      | undefined
    if (bot === undefined || bot === null) throw new StoreError('ROOM_MEMBERS_INVALID', `unknown bot ${botId}`)
    if (bot.workspace_id !== workspaceId) {
      throw new StoreError(
        'ROOM_MEMBERS_INVALID',
        `bot ${botId} belongs to ${bot.workspace_id}, room is created in ${workspaceId}`,
      )
    }
    memberNames.push(bot.name)
  }

  let hostBotId: string | null = null
  if (memberBotIds.length > 0) {
    hostBotId =
      req.hostBotId === undefined || req.hostBotId === null
        ? memberBotIds[0]!
        : asNonEmptyString(req.hostBotId, 'room.hostBotId', 'INVALID_ROOM')
    if (!memberBotIds.includes(hostBotId)) {
      throw new StoreError('ROOM_MEMBERS_INVALID', `host ${hostBotId} is not in memberBotIds`)
    }
  } else if (req.hostBotId !== undefined && req.hostBotId !== null) {
    throw new StoreError('ROOM_MEMBERS_INVALID', 'a room without member bots cannot have a host bot')
  }

  const name =
    req.name === undefined || req.name === null
      ? generateRoomName(memberNames)
      : readRoomName(req.name)
  const notice = readOptionalText(req.notice, 'room.notice', ROOM_LIMITS.noticeMax)
  const purpose = readOptionalText(req.purpose, 'room.purpose', ROOM_LIMITS.noticeMax)
  const createdByKind = req.createdByKind === undefined ? 'user' : readCreatedByKind(req.createdByKind)
  const createdBy = readOptionalText(req.createdBy, 'room.createdBy', 200)

  const responder =
    req.responder === undefined || req.responder === null
      ? hostBotId === null
        ? { kind: 'mentions' as const }
        : { kind: 'member' as const, botId: hostBotId }
      : normalizeResponder(readResponder(req.responder), memberBotIds, hostBotId)

  let roomId: string
  store.db.exec('SAVEPOINT roost_create_room_ext')
  try {
    const room = createRoom(store, {
      workspaceId,
      name,
      ...(notice === null ? {} : { notice }),
      replyMode: replyModeOf(responder),
      ...(req.createdAt === undefined || req.createdAt === null ? {} : { createdAt: req.createdAt }),
    })
    roomId = room.id

    if (memberBotIds.length > 0) {
      addRoomMembers(store, { roomId, botIds: memberBotIds, role: 'member', now: room.createdAt })
      setRoomHost(store, { roomId, botId: hostBotId! })
    }

    store.db
      .prepare(
        `UPDATE rooms
            SET host_bot_id = ?, responder_json = ?, purpose = ?, created_by_kind = ?, created_by = ?
          WHERE id = ?`,
      )
      .run(hostBotId, JSON.stringify(responder), purpose, createdByKind, createdBy, roomId)

    store.db.exec('RELEASE roost_create_room_ext')
  } catch (err) {
    rollback(store, 'roost_create_room_ext')
    if (err instanceof StoreError) throw err
    throw new StoreError('ROOM_WRITE_FAILED', `failed to create room: ${errorMessage(err)}`, { cause: err })
  }

  const detail = getRoomDetail(store, roomId!)
  if (detail !== null) return detail
  throw new StoreError('ROOM_WRITE_FAILED', 'room was created but could not be read back')
}

export function updateRoomExtras(store: Store, input: UpdateRoomExtrasInput): RoomDetail {
  assertOpen(store)
  const req = asRecord(input, 'room.update', 'INVALID_ROOM')
  const roomId = asNonEmptyString(req.roomId, 'room.id', 'INVALID_ROOM')
  const row = store.db.prepare(`SELECT ${EXTRAS_COLUMNS} FROM rooms WHERE id = ?`).get(roomId) as
    | RoomExtrasRow
    | undefined
  if (row === undefined || row === null) throw new StoreError('ROOM_NOT_FOUND', `unknown room ${roomId}`)

  const members = listRoomMembers(store, roomId)
  const memberIds = members.map((member) => member.botId)

  const name = req.name === undefined ? row.name : readRoomName(req.name)
  const notice = req.notice === undefined ? row.notice : readOptionalText(req.notice, 'room.notice', ROOM_LIMITS.noticeMax)
  const purpose =
    req.purpose === undefined ? row.purpose : readOptionalText(req.purpose, 'room.purpose', ROOM_LIMITS.noticeMax)
  const createdByKind = req.createdByKind === undefined ? (row.created_by_kind === 'bot' ? 'bot' : 'user') : readCreatedByKind(req.createdByKind)
  const createdBy =
    req.createdBy === undefined ? row.created_by : readOptionalText(req.createdBy, 'room.createdBy', 200)

  let hostBotId = row.host_bot_id ?? members.find((member) => member.role === 'host')?.botId ?? null
  if (req.hostBotId !== undefined) {
    if (req.hostBotId === null) {
      if (memberIds.length > 0) {
        throw new StoreError('ROOM_MEMBERS_INVALID', 'cannot clear the host while the room still has members')
      }
      hostBotId = null
    } else {
      const nextHost = asNonEmptyString(req.hostBotId, 'room.hostBotId', 'INVALID_ROOM_MEMBER')
      if (!memberIds.includes(nextHost)) {
        throw new StoreError('ROOM_MEMBERS_INVALID', `host ${nextHost} is not a member of ${roomId}`)
      }
      hostBotId = nextHost
    }
  }

  const stored = decodeResponder(row.responder_json) ?? deriveFromReplyMode(row.reply_mode, memberIds, hostBotId)
  const responder =
    req.responder === undefined
      ? resolveResponder(stored, memberIds, hostBotId)
      : normalizeResponder(readResponder(req.responder), memberIds, hostBotId)

  store.db.exec('SAVEPOINT roost_update_room_extras')
  try {
    if (req.hostBotId !== undefined && hostBotId !== null) {
      setRoomHost(store, { roomId, botId: hostBotId })
    }
    store.db
      .prepare(
        `UPDATE rooms
            SET name = ?, notice = ?, purpose = ?, responder_json = ?, reply_mode = ?,
                host_bot_id = ?, created_by_kind = ?, created_by = ?
          WHERE id = ?`,
      )
      .run(
        name,
        notice,
        purpose,
        JSON.stringify(responder),
        replyModeOf(responder),
        hostBotId,
        createdByKind,
        createdBy,
        roomId,
      )

    store.db.exec('RELEASE roost_update_room_extras')
  } catch (err) {
    rollback(store, 'roost_update_room_extras')
    if (err instanceof StoreError) throw err
    throw new StoreError('ROOM_WRITE_FAILED', `failed to update room ${roomId}: ${errorMessage(err)}`, {
      cause: err,
    })
  }

  const detail = getRoomDetail(store, roomId)
  if (detail === null) throw new StoreError('ROOM_NOT_FOUND', `unknown room ${roomId}`)
  return detail
}

// ---- responder / 文本校验 ----------------------------------------------------

function readResponder(value: unknown): RoomResponder {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StoreError('ROOM_RESPONDER_INVALID', 'room.responder must be an object')
  }
  const record = value as Record<string, unknown>
  const kind = record.kind
  if (kind !== 'member' && kind !== 'everyone' && kind !== 'mentions' && kind !== 'auto') {
    throw new StoreError('ROOM_RESPONDER_INVALID', 'room.responder.kind must be member|everyone|mentions|auto')
  }
  const responder: RoomResponder = { kind }
  if (record.botId !== undefined && record.botId !== null) {
    if (typeof record.botId !== 'string' || record.botId.trim() === '') {
      throw new StoreError('ROOM_RESPONDER_INVALID', 'room.responder.botId must be a non-empty string')
    }
    responder.botId = record.botId.trim()
  }
  if (record.fallbackBotId !== undefined && record.fallbackBotId !== null) {
    if (typeof record.fallbackBotId !== 'string' || record.fallbackBotId.trim() === '') {
      throw new StoreError('ROOM_RESPONDER_INVALID', 'room.responder.fallbackBotId must be a non-empty string')
    }
    responder.fallbackBotId = record.fallbackBotId.trim()
  }
  return responder
}

/** 把 responder 绑到真实成员上；指向非成员一律 ROOM_RESPONDER_INVALID。 */
function normalizeResponder(responder: RoomResponder, memberIds: string[], hostBotId: string | null): RoomResponder {
  const ids = new Set(memberIds)
  const fallback = hostBotId !== null && ids.has(hostBotId) ? hostBotId : (memberIds[0] ?? null)

  if (responder.kind === 'member') {
    const botId = responder.botId ?? fallback
    if (botId === null || !ids.has(botId)) {
      throw new StoreError('ROOM_RESPONDER_INVALID', `responder member ${responder.botId ?? '(none)'} is not in the room`)
    }
    return { kind: 'member', botId }
  }
  if (responder.kind === 'auto') {
    if (responder.fallbackBotId !== undefined && !ids.has(responder.fallbackBotId)) {
      throw new StoreError(
        'ROOM_RESPONDER_INVALID',
        `responder fallback ${responder.fallbackBotId} is not in the room`,
      )
    }
    const out: RoomResponder = { kind: 'auto' }
    const fallbackBotId = responder.fallbackBotId ?? fallback
    if (fallbackBotId !== null) out.fallbackBotId = fallbackBotId
    return out
  }
  return { kind: responder.kind }
}

/** 读取时用：坏 JSON / 已失效的成员自动回退，不让 GET 500。 */
function resolveResponder(responder: RoomResponder, memberIds: string[], hostBotId: string | null): RoomResponder {
  try {
    return normalizeResponder(responder, memberIds, hostBotId)
  } catch {
    return hostBotId !== null && memberIds.includes(hostBotId)
      ? { kind: 'member', botId: hostBotId }
      : memberIds.length > 0
        ? { kind: 'member', botId: memberIds[0]! }
        : { kind: 'mentions' }
  }
}

function deriveFromReplyMode(replyMode: string, memberIds: string[], hostBotId: string | null): RoomResponder {
  if (replyMode === 'everyone') return { kind: 'everyone' }
  if (replyMode === 'mentions') return { kind: 'mentions' }
  const botId = hostBotId !== null && memberIds.includes(hostBotId) ? hostBotId : (memberIds[0] ?? null)
  return botId === null ? { kind: 'mentions' } : { kind: 'member', botId }
}

function decodeResponder(raw: unknown): RoomResponder | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return readResponder(parsed)
  } catch {
    return null
  }
}

function replyModeOf(responder: RoomResponder): 'admin' | 'everyone' | 'mentions' {
  if (responder.kind === 'everyone') return 'everyone'
  if (responder.kind === 'mentions') return 'mentions'
  // member 和 auto 都落在 admin；rooms.reply_mode 的 CHECK 只允许这三种（0003）。
  return 'admin'
}

function readRoomName(value: unknown): string {
  if (typeof value !== 'string') throw new StoreError('INVALID_ROOM', 'room.name must be a string')
  const name = value.trim()
  if (name === '') throw new StoreError('INVALID_ROOM', 'room.name must not be empty')
  if (name.length > ROOM_LIMITS.nameMax) {
    throw new StoreError('INVALID_ROOM', `room.name must be at most ${ROOM_LIMITS.nameMax} characters`)
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new StoreError('INVALID_ROOM', 'room.name must not contain control characters')
  }
  return name
}

function generateRoomName(memberNames: string[]): string {
  const joined = memberNames.filter((name) => name !== '').join('、')
  if (joined === '') throw new StoreError('INVALID_ROOM', 'room.name is required when a room has no members')
  return joined.length > ROOM_LIMITS.nameMax ? joined.slice(0, ROOM_LIMITS.nameMax) : joined
}

/** null / '' / 缺省 → null；多行公告允许换行，只拒绝 NUL。 */
function readOptionalText(value: unknown, label: string, max: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new StoreError('INVALID_ROOM', `${label} must be a string`)
  const text = value.trim()
  if (text === '') return null
  if (text.length > max) throw new StoreError('INVALID_ROOM', `${label} must be at most ${max} characters`)
  if (/[\u0000\u007f]/.test(text)) throw new StoreError('INVALID_ROOM', `${label} contains NUL or DEL`)
  return text
}

function readCreatedByKind(value: unknown): 'user' | 'bot' {
  if (value === 'user' || value === 'bot') return value
  throw new StoreError('INVALID_ROOM', "room.createdByKind must be 'user' or 'bot'")
}

function readBotIdList(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new StoreError('ROOM_MEMBERS_INVALID', 'room.memberBotIds must be an array')
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new StoreError('ROOM_MEMBERS_INVALID', 'room.memberBotIds must contain non-empty strings')
    }
    const id = item.trim()
    if (!out.includes(id)) out.push(id)
  }
  return out
}

function rollback(store: Store, savepoint: string): void {
  try {
    store.db.exec(`ROLLBACK TO ${savepoint}`)
    store.db.exec(`RELEASE ${savepoint}`)
  } catch {
    // 外层事务可能已经把 savepoint 一起回滚；保留原始错误。
  }
}
