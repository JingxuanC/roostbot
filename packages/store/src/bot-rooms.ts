// Bot 建群（docs/build/m4-addendum.md §B、docs/design/rooms.md §6、docs/design/bots.md §6）。
//
// 流程有意分成两步：
//   1. requestBotRoom：只校验 + 写一条 pending approval，**不建房**（一次人工确认）；
//   2. approveBotRoom：读回 payload，真正 createRoomExt，再把审批标 approved。
//
// 为什么用审批而不是直接建房：Bot 不能自己扩权。人批准之前，房间里不该出现任何东西。
//
// 配额：每个 Bot 每天最多建 BOT_ROOM_DAILY_LIMIT 个房间，按
// `rooms.created_by_kind='bot' AND created_by=<bot> AND created_at >= 今天 00:00`（本地时区）
// 数。配额在 request 时检查（文档口径是「已建房间数」）。
//
// 错误码：沿用 StoreError 现有枚举，域错误码以 `CODE: detail` 写在 message 开头
// （见 approvals.ts 的 taggedStoreMessage / storeErrorTag），API 层据此映射 HTTP 状态。

import { ROOM_LIMITS } from '../../contract/src/index.ts'
import {
  APPROVAL_ERROR_CODES,
  createApproval,
  decideApproval,
  getApproval,
  taggedStoreMessage,
} from './approvals.ts'
import type { Approval } from './approvals.ts'
import { StoreError } from './errors.ts'
import { asInteger, asRecord, assertOpen, errorMessage } from './internal.ts'
import { createRoomExt, getRoomDetail } from './rooms-ext.ts'
import type { RoomDetail } from './rooms-ext.ts'
import type { Store } from './types.ts'

/** 与 rooms.md §6 一致：每 Bot 每日 3 个房间。 */
export const BOT_ROOM_DAILY_LIMIT = 3
/** 审批类型：Bot 建群。 */
export const BOT_ROOM_APPROVAL_KIND = 'create_room'

/**
 * 审批到落地的 payload 形状。approve 之后会追加 roomId（幂等重放用），
 * 所以读的时候 roomId 可有可无。
 */
export interface BotRoomPayload {
  workspaceId: string
  botId: string
  name: string | null
  purpose: string | null
  memberBotIds: string[]
  /** 只在 approved 之后出现：这次审批建出来的房间。 */
  roomId?: string
}

export interface RequestBotRoomInput {
  workspaceId: string
  botId: string
  /** 省略时由 createRoomExt 按成员名生成。 */
  name?: string
  purpose?: string
  /** 必须包含机器人自己：创建的 Bot 是 host（bots.md §6）。 */
  memberBotIds: string[]
  at?: number
}

export interface ApproveBotRoomInput {
  approvalId: string
  by: string
  at?: number
}

export interface RejectBotRoomInput {
  approvalId: string
  by: string
  at?: number
}

export interface ApproveBotRoomResult {
  room: RoomDetail
  approval: Approval
}

export function requestBotRoom(store: Store, input: RequestBotRoomInput): Approval {
  assertOpen(store)
  const req = asRecord(input, 'botRoom', 'INVALID_INPUT')
  const workspaceId = readRequiredId(req.workspaceId, 'botRoom.workspaceId')
  const botId = readRequiredId(req.botId, 'botRoom.botId')
  const at = readAt(req.at, 'botRoom.at')

  // 1) workspace 必须存在。
  const workspace = store.db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId)
  if (workspace === undefined || workspace === null) {
    throw new StoreError('WORKSPACE_NOT_FOUND', `unknown workspace ${workspaceId}`)
  }

  // 2) 发起 Bot 必须存在且属于同一个 workspace（不能跨租户拉群）。
  const bot = store.db.prepare('SELECT id, workspace_id FROM bots WHERE id = ? AND deleted_at IS NULL').get(botId) as
    | { id: string; workspace_id: string }
    | undefined
  if (bot === undefined || bot === null) {
    throw new StoreError(
      'BOT_NOT_FOUND',
      taggedStoreMessage('BOT_ROOM_BOT_NOT_FOUND', `unknown bot ${botId}`),
    )
  }
  if (bot.workspace_id !== workspaceId) {
    throw new StoreError(
      'FORBIDDEN',
      taggedStoreMessage(
        'BOT_ROOM_CROSS_WORKSPACE',
        `bot ${botId} belongs to ${bot.workspace_id}, not ${workspaceId}`,
      ),
    )
  }

  // 3) 成员：2..12 个、都在同 workspace、且必须包含发起 Bot（它是 host）。
  const memberBotIds = readMemberBotIds(req.memberBotIds)
  if (memberBotIds.length < 2) {
    throw new StoreError(
      'ROOM_MEMBERS_INVALID',
      taggedStoreMessage('BOT_ROOM_MEMBERS', 'a room needs at least 2 bots (rooms.md §6)'),
    )
  }
  if (memberBotIds.length > ROOM_LIMITS.membersMax) {
    throw new StoreError(
      'ROOM_MEMBERS_INVALID',
      taggedStoreMessage(
        'BOT_ROOM_MEMBERS',
        `a room holds at most ${ROOM_LIMITS.membersMax} bots (rooms.md §3)`,
      ),
    )
  }
  if (!memberBotIds.includes(botId)) {
    throw new StoreError(
      'ROOM_MEMBERS_INVALID',
      taggedStoreMessage(
        'BOT_ROOM_MEMBERS',
        `the requesting bot ${botId} must be one of memberBotIds (it becomes host)`,
      ),
    )
  }
  for (const memberId of memberBotIds) {
    const member = store.db.prepare('SELECT id, workspace_id FROM bots WHERE id = ? AND deleted_at IS NULL').get(memberId) as
      | { id: string; workspace_id: string }
      | undefined
    if (member === undefined || member === null) {
      throw new StoreError(
        'ROOM_MEMBERS_INVALID',
        taggedStoreMessage('BOT_ROOM_MEMBERS', `unknown bot ${memberId}`),
      )
    }
    if (member.workspace_id !== workspaceId) {
      throw new StoreError(
        'ROOM_MEMBERS_INVALID',
        taggedStoreMessage(
          'BOT_ROOM_MEMBERS',
          `bot ${memberId} belongs to ${member.workspace_id}, not ${workspaceId}`,
        ),
      )
    }
  }

  const name = readOptionalName(req.name)
  const purpose = readOptionalPurpose(req.purpose)

  // 4) 幂等：同一个 Bot 在同一个 workspace 已有同类 pending 请求 → 返回它（不重复排审批）。
  const existing = findPending(store, workspaceId, botId)
  if (existing !== null) return existing

  // 5) 配额：今天已经建出来的 Bot 房间数。
  const used = countBotRoomsToday(store, botId, at)
  if (used >= BOT_ROOM_DAILY_LIMIT) {
    throw new StoreError(
      'INVALID_INPUT',
      taggedStoreMessage(
        'BOT_ROOM_QUOTA',
        `bot ${botId} already created ${used} rooms today (limit ${BOT_ROOM_DAILY_LIMIT})`,
      ),
    )
  }

  // 6) 只写审批，不建房。
  const payload: BotRoomPayload = {
    workspaceId,
    botId,
    name,
    purpose,
    memberBotIds,
  }
  const approval = createApproval(store, {
    workspaceId,
    kind: BOT_ROOM_APPROVAL_KIND,
    requester: botId,
    requesterKind: 'bot',
    payload: { ...payload },
    at,
  })
  return approval
}

/**
 * 批准并建房。返回 `{room, approval}`。
 *
 * 幂等：同一个审批再批准一次返回同一个房间（roomId 记在 payload 里），不会建第二个。
 * 整段在一个 savepoint 里：建房失败则审批仍是 pending，用户可重试。
 */
export function approveBotRoom(store: Store, input: ApproveBotRoomInput): ApproveBotRoomResult {
  assertOpen(store)
  const req = asRecord(input, 'botRoom.approve', 'INVALID_INPUT')
  const approvalId = readRequiredId(req.approvalId, 'botRoom.approvalId')
  const by = readRequiredId(req.by, 'botRoom.by')
  const at = readAt(req.at, 'botRoom.at')

  store.db.exec('SAVEPOINT roost_approve_bot_room')
  try {
    const approval = getApproval(store, approvalId)
    if (approval === null) throw approvalNotFound(approvalId)
    assertBotRoomApproval(approval)

    // 已经批准过：返回当时的房间（不重复建房）。
    if (approval.status === 'approved') {
      const existingRoomId = typeof approval.payload.roomId === 'string' ? approval.payload.roomId : null
      const existing = existingRoomId === null ? null : getRoomDetail(store, existingRoomId)
      if (existing === null) {
        throw new StoreError(
          'INVALID_INPUT',
          taggedStoreMessage(
            APPROVAL_ERROR_CODES.conflict,
            `approval ${approvalId} is approved but its room is gone`,
          ),
        )
      }
      store.db.exec('RELEASE roost_approve_bot_room')
      return { room: existing, approval }
    }
    if (approval.status === 'rejected') {
      throw new StoreError(
        'INVALID_INPUT',
        taggedStoreMessage(APPROVAL_ERROR_CODES.conflict, `approval ${approvalId} was already rejected`),
      )
    }

    const payload = readBotRoomPayload(approval.payload, approval.workspaceId)
    const room = createRoomExt(store, {
      workspaceId: payload.workspaceId,
      ...(payload.name === null ? {} : { name: payload.name }),
      ...(payload.purpose === null ? {} : { purpose: payload.purpose }),
      memberBotIds: payload.memberBotIds,
      hostBotId: payload.botId,
      createdByKind: 'bot',
      createdBy: payload.botId,
      createdAt: at,
    })

    decideApproval(store, { id: approvalId, decision: 'approved', by, at })
    // roomId 写回 payload：重复批准时用它拿回同一个房间，而不是再建一个。
    store.db
      .prepare('UPDATE approvals SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...payload, roomId: room.room.id }), approvalId)
    const updated = getApproval(store, approvalId)
    if (updated === null) throw approvalNotFound(approvalId)

    store.db.exec('RELEASE roost_approve_bot_room')
    return { room, approval: updated }
  } catch (err) {
    rollback(store, 'roost_approve_bot_room')
    if (err instanceof StoreError) throw err
    throw new StoreError('INVALID_INPUT', `failed to approve bot room: ${errorMessage(err)}`, { cause: err })
  }
}

/** 拒绝：只落状态，不建房。重复拒绝幂等。 */
export function rejectBotRoom(store: Store, input: RejectBotRoomInput): Approval {
  assertOpen(store)
  const req = asRecord(input, 'botRoom.reject', 'INVALID_INPUT')
  const approvalId = readRequiredId(req.approvalId, 'botRoom.approvalId')
  const by = readRequiredId(req.by, 'botRoom.by')
  const at = readAt(req.at, 'botRoom.at')

  const approval = getApproval(store, approvalId)
  if (approval === null) throw approvalNotFound(approvalId)
  assertBotRoomApproval(approval)
  if (approval.status === 'approved') {
    throw new StoreError(
      'INVALID_INPUT',
      taggedStoreMessage(APPROVAL_ERROR_CODES.conflict, `approval ${approvalId} was already approved`),
    )
  }
  return decideApproval(store, { id: approvalId, decision: 'rejected', by, at })
}

/** 今天（本地时区 00:00 起）该 Bot 已经建出来的房间数；配额与测试共用。 */
export function countBotRoomsToday(store: Store, botId: string, at: number = Date.now()): number {
  assertOpen(store)
  const id = readRequiredId(botId, 'botRoom.botId')
  const now = asInteger(at, 'botRoom.at', 0, 'INVALID_INPUT')
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS n FROM rooms
        WHERE created_by_kind = 'bot' AND created_by = ? AND created_at >= ?`,
    )
    .get(id, startOfLocalDay(now)) as { n: number | bigint } | undefined
  return row === undefined || row === null ? 0 : Number(row.n)
}

/** 本地时区的当天 00:00（rooms.created_at 是 epoch 毫秒）。 */
export function startOfLocalDay(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

// ---- 内部 --------------------------------------------------------------------

function findPending(store: Store, workspaceId: string, botId: string): Approval | null {
  const row = store.db
    .prepare(
      `SELECT id FROM approvals
        WHERE workspace_id = ? AND kind = ? AND requester = ? AND requester_kind = 'bot' AND status = 'pending'
        ORDER BY created_at, id LIMIT 1`,
    )
    .get(workspaceId, BOT_ROOM_APPROVAL_KIND, botId) as { id: string } | undefined
  if (row === undefined || row === null) return null
  return getApproval(store, row.id)
}

function assertBotRoomApproval(approval: Approval): void {
  if (approval.kind !== BOT_ROOM_APPROVAL_KIND || approval.requesterKind !== 'bot') {
    throw new StoreError(
      'INVALID_INPUT',
      taggedStoreMessage(
        APPROVAL_ERROR_CODES.invalid,
        `approval ${approval.id} is ${approval.kind}/${approval.requesterKind}, not ${BOT_ROOM_APPROVAL_KIND}/bot`,
      ),
    )
  }
}

function readBotRoomPayload(payloadValue: Record<string, unknown>, approvalWorkspaceId: string): BotRoomPayload {
  const payload = asRecord(payloadValue, 'approval.payload', 'INVALID_INPUT')
  const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : ''
  const botId = typeof payload.botId === 'string' ? payload.botId : ''
  const memberBotIds = readMemberBotIds(payload.memberBotIds)
  if (workspaceId === '' || botId === '' || workspaceId !== approvalWorkspaceId) {
    throw new StoreError(
      'INVALID_INPUT',
      taggedStoreMessage(
        APPROVAL_ERROR_CODES.invalid,
        `approval payload for ${approvalWorkspaceId} is missing workspaceId/botId`,
      ),
    )
  }
  return {
    workspaceId,
    botId,
    name: readOptionalName(payload.name),
    purpose: readOptionalPurpose(payload.purpose),
    memberBotIds,
    ...(typeof payload.roomId === 'string' && payload.roomId !== '' ? { roomId: payload.roomId } : {}),
  }
}

function readMemberBotIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new StoreError(
      'ROOM_MEMBERS_INVALID',
      taggedStoreMessage('BOT_ROOM_MEMBERS', 'botRoom.memberBotIds must be an array of bot ids'),
    )
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new StoreError(
        'ROOM_MEMBERS_INVALID',
        taggedStoreMessage('BOT_ROOM_MEMBERS', 'botRoom.memberBotIds must contain non-empty strings'),
      )
    }
    const id = item.trim()
    if (!out.includes(id)) out.push(id)
  }
  return out
}

function readOptionalName(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new StoreError(
      'INVALID_ROOM',
      taggedStoreMessage('BOT_ROOM_INVALID', 'botRoom.name must be a string'),
    )
  }
  const name = value.trim()
  if (name === '') return null
  if (name.length > ROOM_LIMITS.nameMax) {
    throw new StoreError(
      'INVALID_ROOM',
      taggedStoreMessage('BOT_ROOM_INVALID', `botRoom.name must be at most ${ROOM_LIMITS.nameMax} characters`),
    )
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new StoreError(
      'INVALID_ROOM',
      taggedStoreMessage('BOT_ROOM_INVALID', 'botRoom.name must not contain control characters'),
    )
  }
  return name
}

function readOptionalPurpose(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new StoreError(
      'INVALID_ROOM',
      taggedStoreMessage('BOT_ROOM_INVALID', 'botRoom.purpose must be a string'),
    )
  }
  const purpose = value.trim()
  if (purpose === '') return null
  if (purpose.length > ROOM_LIMITS.noticeMax) {
    throw new StoreError(
      'INVALID_ROOM',
      taggedStoreMessage('BOT_ROOM_INVALID', `botRoom.purpose must be at most ${ROOM_LIMITS.noticeMax} characters`),
    )
  }
  if (/[\u0000\u007f]/.test(purpose)) {
    throw new StoreError(
      'INVALID_ROOM',
      taggedStoreMessage('BOT_ROOM_INVALID', 'botRoom.purpose contains NUL or DEL'),
    )
  }
  return purpose
}

function readRequiredId(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new StoreError('INVALID_INPUT', `${label} must be a string`)
  const id = value.trim()
  if (id === '') throw new StoreError('INVALID_INPUT', `${label} must not be empty`)
  if (id.length > 200) throw new StoreError('INVALID_INPUT', `${label} must be at most 200 characters`)
  return id
}

function readAt(value: unknown, label: string): number {
  return value === undefined || value === null
    ? Date.now()
    : asInteger(value, label, 0, 'INVALID_INPUT')
}

function approvalNotFound(approvalId: string): StoreError {
  return new StoreError(
    'INVALID_INPUT',
    taggedStoreMessage(APPROVAL_ERROR_CODES.notFound, `unknown approval ${approvalId}`),
  )
}

function rollback(store: Store, savepoint: string): void {
  try {
    store.db.exec(`ROLLBACK TO ${savepoint}`)
    store.db.exec(`RELEASE ${savepoint}`)
  } catch {
    // 外层事务可能已经把 savepoint 一起回滚；保留原始错误。
  }
}
