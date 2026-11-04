// 私聊（DM）房间（docs/build/m4-addendum.md §A、docs/design/bots.md §2）。
//
// DM 不是另一张表：它就是一条 rooms 行 + dm=1，成员是 room_members 里唯一的 bot
// （role='host'），notice 为空、reply_mode='admin'。这样轮次、事件日志、已读游标、
// 会话映射全部复用既有实现，不需要给私聊单开一套。
//
// 唯一性：每个 (workspace, bot) 恰好一个 DM。bot 归属在 room_members 里，SQLite 的
// 跨表唯一索引表达不了 (workspace_id, bot_id)，所以这里用「建前查 + savepoint 内复查」
// 保证；同一个 store 上的调用是同步串行的，不会插进两个。已有 DM 时直接返回它（幂等）。
//
// 不走 createRoomExt：它要求 ≥2 个成员（群聊语义），DM 只有一个 bot。这里用
// createRoom + addRoomMembers，并自己补 host_bot_id / responder_json / created_by。

import type { Room, Store } from './types.ts'
import { StoreError } from './errors.ts'
import { asInteger, asNonEmptyString, asRecord, assertOpen, errorMessage } from './internal.ts'
import { addRoomMembers } from './room-members.ts'
import { createRoom } from './rooms.ts'

/** createDmRoom 的入参。at 同时作为房间 createdAt 和成员 created_at。 */
export interface CreateDmRoomInput {
  workspaceId: string
  botId: string
  /** 创建者（用户 id；写进 rooms.created_by，created_by_kind='user'）。 */
  createdBy: string
  /** epoch 毫秒；默认 Date.now()。 */
  at?: number
}

/** 带 dm 标记的房间；结构上仍是 Room，调用方不需要另一套读法。 */
export interface DmRoom extends Room {
  dm: true
}

interface DmRow {
  id: string
  workspace_id: string
  name: string
  notice: string | null
  reply_mode: string
  created_at: number | bigint
}

const DM_SELECT = `
  SELECT r.id AS id, r.workspace_id AS workspace_id, r.name AS name,
         r.notice AS notice, r.reply_mode AS reply_mode, r.created_at AS created_at
    FROM rooms r
    JOIN room_members m ON m.room_id = r.id
   WHERE r.workspace_id = ? AND r.dm = 1 AND m.bot_id = ?
   ORDER BY r.created_at, r.id
   LIMIT 1`

/** 该 (workspace, bot) 的 DM；没有返回 null。 */
export function findDmRoom(store: Store, workspaceId: string, botId: string): DmRoom | null {
  assertOpen(store)
  const wsId = asNonEmptyString(workspaceId, 'dm.workspaceId', 'INVALID_ROOM')
  const bot = asNonEmptyString(botId, 'dm.botId', 'INVALID_ROOM')
  const row = store.db.prepare(DM_SELECT).get(wsId, bot) as DmRow | undefined
  if (row === undefined || row === null) return null
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    notice: row.notice,
    replyMode: row.reply_mode,
    createdAt: typeof row.created_at === 'bigint' ? Number(row.created_at) : row.created_at,
    dm: true,
  }
}

/**
 * 取或建该 (workspace, bot) 的 DM。
 *
 * - Bot 必须存在且属于同一个 workspace；否则 ROOM_MEMBERS_INVALID。
 * - 已有 DM 直接返回同一个房间（幂等），不重建、不改名。
 * - 新建时 one savepoint 落 rooms + room_members；失败整体回滚。
 */
export function createDmRoom(store: Store, input: CreateDmRoomInput): DmRoom {
  assertOpen(store)
  const req = asRecord(input, 'dm', 'INVALID_ROOM')
  const workspaceId = asNonEmptyString(req.workspaceId, 'dm.workspaceId', 'INVALID_ROOM')
  const botId = asNonEmptyString(req.botId, 'dm.botId', 'INVALID_ROOM')
  const createdBy = asNonEmptyString(req.createdBy, 'dm.createdBy', 'INVALID_ROOM')
  const at =
    req.at === undefined || req.at === null ? Date.now() : asInteger(req.at, 'dm.at', 0, 'INVALID_ROOM')

  // 已软删的 Bot（deleted_at 非空）不能建 DM（bots.md §5）。
  const bot = store.db.prepare('SELECT id, workspace_id, name FROM bots WHERE id = ? AND deleted_at IS NULL').get(botId) as
    | { id: string; workspace_id: string; name: string }
    | undefined
  if (bot === undefined || bot === null) {
    throw new StoreError('ROOM_MEMBERS_INVALID', `unknown bot ${botId}`)
  }
  if (bot.workspace_id !== workspaceId) {
    throw new StoreError(
      'ROOM_MEMBERS_INVALID',
      `bot ${botId} belongs to ${bot.workspace_id}, dm is created in ${workspaceId}`,
    )
  }

  const existing = findDmRoom(store, workspaceId, botId)
  if (existing !== null) return existing

  store.db.exec('SAVEPOINT roost_create_dm')
  try {
    // 复查放在 savepoint 内：即使将来有并发调用，也只会有一个 INSERT 活下来。
    const raced = findDmRoom(store, workspaceId, botId)
    if (raced !== null) {
      store.db.exec('RELEASE roost_create_dm')
      return raced
    }

    const room = createRoom(store, {
      workspaceId,
      name: bot.name,
      replyMode: 'admin',
      createdAt: at,
    })

    store.db
      .prepare(
        `UPDATE rooms
            SET dm = 1, host_bot_id = ?, responder_json = ?, created_by_kind = 'user', created_by = ?
          WHERE id = ?`,
      )
      .run(botId, JSON.stringify({ kind: 'member', botId }), createdBy, room.id)

    // 只有一个成员，且直接是 host：不走 createRoomExt 的 ≥2 校验。
    addRoomMembers(store, { roomId: room.id, botIds: [botId], role: 'host', now: at })

    store.db.exec('RELEASE roost_create_dm')

    const created = findDmRoom(store, workspaceId, botId)
    if (created === null) {
      throw new StoreError('ROOM_WRITE_FAILED', `dm for ${botId} was created but could not be read back`)
    }
    return created
  } catch (err) {
    rollback(store, 'roost_create_dm')
    if (err instanceof StoreError) throw err
    throw new StoreError('ROOM_WRITE_FAILED', `failed to create dm for ${botId}: ${errorMessage(err)}`, {
      cause: err,
    })
  }
}

function rollback(store: Store, savepoint: string): void {
  try {
    store.db.exec(`ROLLBACK TO ${savepoint}`)
    store.db.exec(`RELEASE ${savepoint}`)
  } catch {
    // 外层事务可能已经把 savepoint 一起回滚；保留原始错误。
  }
}
