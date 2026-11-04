// 把 packages/store（同步 + 抛 StoreError）适配成控制面 API 的 StorePort（异步 + 结果对象）。
//
// 契约见 apps/api/src/port.ts 文件头五条；这里逐条兑现：
//   1. 配对码冲突 → PairingCodeCollisionError（不覆盖活着的码）
//   2. claim 的读改写在 store 内部的 savepoint 里完成（原子）
//   3. 会话只按 hash 查，明文 token 不经过这一层
//   4. now / expiresAt 都由调用方传入，适配器不读时钟
//   5. 返回值都是新对象（store 已经这么做，这里再拷贝一次角色字段）

import { randomUUID } from 'node:crypto'

import {
  StoreError,
  addRoomMembers as addRoomMembersInStore,
  claimPairingCode as claimInStore,
  createBot as createBotInStore,
  createRoom as createRoomInStore,
  createRoomExt as createRoomExtInStore,
  createPairingCode as createPairingInStore,
  createSession as createSessionInStore,
  createWorkspace as createWorkspaceInStore,
  deleteBot as deleteBotInStore,
  deleteRoom as deleteRoomInStore,
  findSessionByTokenHash,
  getBot as getBotInStore,
  getRoom as getRoomInStore,
  getRoomDetail as getRoomDetailInStore,
  listBots as listBotsInStore,
  latestRound as latestRoundInStore,
  listRooms as listRoomsInStore,
  listWorkspaces as listWorkspacesInStore,
  readMessages as readMessagesInStore,
  readRoomLogPage as readRoomLogPageInStore,
  removeRoomMember as removeRoomMemberInStore,
  restoreBot as restoreBotInStore,
  sendMessage as sendMessageInStore,
  touchSession,
  updateBot as updateBotInStore,
  updateRoomExtras as updateRoomExtrasInStore,
} from '../../../packages/store/src/index.ts'
import type { RoomDetail, Store } from '../../../packages/store/src/index.ts'
import type { Bot } from '../../../packages/contract/src/index.ts'
import {
  PairingCodeCollisionError,
  type ClaimPairingCodeInput,
  type ClaimPairingCodeResult,
  type CreateBotPortInput,
  type CreatePairingCodeInput,
  type CreateRoomExtPortInput,
  type CreateSessionInput,
  type CreateWorkspaceInput,
  type DeleteBotPortInput,
  type DeleteRoomPortInput,
  type ListBotsInput,
  type PairingRecord,
  type ReadRoomLogPortInput,
  type RemoveRoomMemberPortInput,
  type RestoreBotPortInput,
  type RoomLogPageRecord,
  type RoomMemberMutationInput,
  type RoomMessageRecord,
  type RoomRecord,
  type SessionRecord,
  type StorePort,
  type UpdateBotPortInput,
  type UpdateRoomPortInput,
  type WorkspaceRecord,
  type WorkspaceRole,
} from './port.ts'

const DEFAULT_PROFILE_VERSION = 'dev'

export function createStorePort(store: Store): StorePort {
  return {
    async createPairingCode(input: CreatePairingCodeInput): Promise<PairingRecord> {
      try {
        const created = createPairingInStore(store, {
          code: input.code,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          now: input.now,
          expiresAt: input.expiresAt,
        })
        return toPairingRecord(created)
      } catch (err) {
        if (err instanceof StoreError && err.code === 'PAIRING_CODE_CONFLICT') {
          throw new PairingCodeCollisionError(`pairing code ${input.code} is still live`)
        }
        throw err
      }
    },

    async claimPairingCode(input: ClaimPairingCodeInput): Promise<ClaimPairingCodeResult> {
      try {
        const claim = claimInStore(store, {
          code: input.code,
          now: input.now,
          maxAttempts: input.maxAttempts,
        })
        // claim 成功后回读一次：端口要 createdAt/expiresAt，而 PairingClaim 只带部分字段。
        const row = store.db
          .prepare('SELECT created_at, expires_at, used_at, attempts FROM pairing_codes WHERE code = ?')
          .get(input.code) as
          | { created_at: number | bigint; expires_at: number | bigint; used_at: number | bigint | null; attempts: number | bigint }
          | undefined
        return {
          ok: true,
          pairing: {
            code: claim.code,
            accountId: claim.accountId,
            ...(claim.workspaceId === null ? {} : { workspaceId: claim.workspaceId }),
            createdAt: row === undefined ? claim.createdAt : Number(row.created_at),
            expiresAt: row === undefined ? input.now : Number(row.expires_at),
            usedAt: row === undefined ? claim.usedAt : (row.used_at === null ? undefined : Number(row.used_at)),
            attempts: row === undefined ? claim.attempts : Number(row.attempts),
          },
        }
      } catch (err) {
        if (err instanceof StoreError) {
          const reason = claimReason(err.code)
          if (reason !== null) return { ok: false, reason }
        }
        throw err
      }
    },

    async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
      const workspace = createWorkspaceInStore(store, {
        tenantId: input.accountId,
        name: input.name,
        homeMode: input.homeMode ?? 'cloud',
        state: 'stopped',
        volumeId: null,
        profileVersion: input.profileVersion ?? DEFAULT_PROFILE_VERSION,
        createdAt: input.now,
      })
      // 创建者即 owner（port 契约：createWorkspace 要写成员并返回 role）。
      store.db
        .prepare(
          'INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, NULL, ?)',
        )
        .run(workspace.id, input.accountId, 'owner', input.now)
      return {
        id: workspace.id,
        tenantId: workspace.tenantId,
        name: workspace.name,
        homeMode: workspace.homeMode,
        state: workspace.state,
        ...(workspace.volumeId === null ? {} : { volumeId: workspace.volumeId }),
        profileVersion: workspace.profileVersion,
        role: 'owner',
        createdAt: workspace.createdAt,
      }
    },

    async listWorkspaces(input: { accountId: string }): Promise<WorkspaceRecord[]> {
      // 账号能看到两类 workspace：自己创建的租户（tenant_id）和被邀请成为成员的（workspace_members）。
      // 只按 tenant_id 查会让 OIDC/邮箱登录的成员看不到被邀请的工作区。
      const rows = store.db
        .prepare(
          `SELECT w.id, w.tenant_id, w.name, w.home_mode, w.state, w.volume_id, w.profile_ver, w.created_at,
                  COALESCE(m.role, CASE WHEN w.tenant_id = ? THEN 'owner' ELSE 'viewer' END) AS role
             FROM workspaces w
             LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?
            WHERE w.tenant_id = ? OR m.user_id = ?
            ORDER BY w.created_at ASC, w.id ASC`,
        )
        .all(input.accountId, input.accountId, input.accountId, input.accountId) as Array<{
          id: string
          tenant_id: string
          name: string
          home_mode: string
          state: string
          volume_id: string | null
          profile_ver: string
          created_at: number | bigint
          role: WorkspaceRole
        }>
      return rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        name: row.name,
        homeMode: row.home_mode as WorkspaceRecord['homeMode'],
        state: row.state as WorkspaceRecord['state'],
        ...(row.volume_id === null ? {} : { volumeId: row.volume_id }),
        profileVersion: row.profile_ver,
        role: row.role,
        createdAt: Number(row.created_at),
      }))
    },

    async createSession(input: CreateSessionInput): Promise<SessionRecord> {
      // 端口只给 deviceLabel/platform：设备由适配器建，会话绑定到它。
      const deviceId = `dev_${randomUUID().replaceAll('-', '')}`
      store.db
        .prepare(
          'INSERT INTO devices (id, account_id, label, platform, last_seen_at, revoked_at, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)',
        )
        .run(deviceId, input.accountId, input.deviceLabel ?? null, input.platform ?? null, input.now)
      const session = createSessionInStore(store, {
        id: `ses_${randomUUID().replaceAll('-', '')}`,
        accountId: input.accountId,
        deviceId,
        tokenHash: input.tokenHash,
        createdAt: input.now,
        expiresAt: input.expiresAt,
      })
      return {
        id: session.id,
        accountId: session.accountId,
        deviceId: session.deviceId,
        tokenHash: session.tokenHash,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
      }
    },

    async listRooms(input): Promise<RoomRecord[]> {
      const rows = store.db
        .prepare(
          `SELECT r.id, r.workspace_id, r.name, r.notice, r.reply_mode, r.created_at
             FROM rooms r JOIN workspace_members m ON m.workspace_id = r.workspace_id
            WHERE m.user_id = ?${input.workspaceId === undefined ? '' : ' AND r.workspace_id = ?'}
            ORDER BY r.created_at, r.id`,
        )
        .all(...(input.workspaceId === undefined ? [input.accountId] : [input.accountId, input.workspaceId])) as RoomRow[]
      return rows.map((row) => toRoomRecord(store, row))
    },

    async createRoom(input): Promise<RoomRecord> {
      requireMembership(store, input.workspaceId, input.accountId)
      const room = createRoomInStore(store, {
        workspaceId: input.workspaceId,
        name: input.name,
        createdAt: input.now,
      })
      // v0 建房路径没有 created_by 列；M4 契约的 Room.createdBy 必填，这里补上。
      store.db
        .prepare('UPDATE rooms SET created_by_kind = ?, created_by = ? WHERE id = ?')
        .run('user', input.accountId, room.id)
      return toRoomRecord(store, {
        id: room.id,
        workspace_id: room.workspaceId,
        name: room.name,
        notice: room.notice,
        reply_mode: room.replyMode,
        created_at: room.createdAt,
      })
    },

    async readMessages(input): Promise<RoomMessageRecord[]> {
      requireRoomMembership(store, input.roomId, input.accountId)
      return readMessagesInStore(store, {
        roomId: input.roomId,
        ...(input.afterSeq === undefined ? {} : { afterSeq: input.afterSeq }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }).map(toMessageRecord)
    },

    async postMessage(input): Promise<RoomMessageRecord> {
      requireRoomMembership(store, input.roomId, input.accountId)
      const message = sendMessageInStore(store, {
        roomId: input.roomId,
        text: input.text,
        actor: { kind: 'user', id: input.accountId },
        ...(input.idem === undefined ? {} : { idem: input.idem }),
      })
      return toMessageRecord(message)
    },

    async listAllRooms(): Promise<RoomRecord[]> {
      const rows = store.db
        .prepare('SELECT id, workspace_id, name, notice, reply_mode, created_at FROM rooms ORDER BY created_at, id')
        .all() as RoomRow[]
      return rows.map((row) => toRoomRecord(store, row))
    },

    async getRoomWorkspace(roomId: string): Promise<string | null> {
      const row = store.db.prepare('SELECT workspace_id FROM rooms WHERE id = ?').get(roomId) as
        | { workspace_id: string }
        | undefined
      return row === undefined || row === null ? null : row.workspace_id
    },

    async postBotMessage(input: { roomId: string; botId: string; text: string; idem?: string }): Promise<RoomMessageRecord> {
      const message = sendMessageInStore(store, {
        roomId: input.roomId,
        text: input.text,
        actor: { kind: 'bot', id: input.botId },
        ...(input.idem === undefined ? {} : { idem: input.idem }),
      })
      return toMessageRecord(message)
    },

    async readMessagesInternal(input): Promise<RoomMessageRecord[]> {
      return readMessagesInStore(store, {
        roomId: input.roomId,
        ...(input.afterSeq === undefined ? {} : { afterSeq: input.afterSeq }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }).map(toMessageRecord)
    },

    async findSessionByToken(tokenHash: string): Promise<SessionRecord | null> {
      const session = findSessionByTokenHash(store, tokenHash)
      if (session === null) return null
      // 每次成功鉴权都记一次活跃（会话续期由调用方决定，这里不动 expiresAt）。
      const touched = touchSession(store, session.id, { lastSeenAt: Date.now() })
      return {
        id: touched.id,
        accountId: touched.accountId,
        deviceId: touched.deviceId,
        tokenHash: touched.tokenHash,
        createdAt: touched.createdAt,
        expiresAt: touched.expiresAt,
        lastSeenAt: touched.lastSeenAt ?? undefined,
        ...(touched.revokedAt === null ? {} : { revokedAt: touched.revokedAt }),
      }
    },

    // ---- M4：Bot 域 ---------------------------------------------------------

    async listBots(input: ListBotsInput): Promise<Bot[]> {
      if (input.workspaceId !== undefined) {
        requireMembership(store, input.workspaceId, input.accountId)
        return listBotsInStore(store, input.workspaceId).map(copyBot)
      }
      // 没有指定 workspace：把该账号可见的每个 workspace 的 Bot 合起来（与 listRooms 一致）。
      const workspaces = listWorkspacesInStore(store, { tenantId: input.accountId })
      const bots: Bot[] = []
      for (const workspace of workspaces) {
        if (!isWorkspaceMember(store, workspace.id, input.accountId)) continue
        bots.push(...listBotsInStore(store, workspace.id))
      }
      bots.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      return bots.map(copyBot)
    },

    async getBot(input: { accountId: string; botId: string }): Promise<Bot | null> {
      const bot = getBotInStore(store, input.botId)
      if (bot === null) return null
      // 不是该 workspace 的成员就当作不存在，避免跨租户探测。
      if (!isWorkspaceMember(store, bot.workspaceId, input.accountId)) return null
      return copyBot(bot)
    },

    async createBot(input: CreateBotPortInput): Promise<Bot> {
      requireMembership(store, input.workspaceId, input.accountId)
      return copyBot(
        createBotInStore(store, {
          workspaceId: input.workspaceId,
          name: input.name,
          ...(input.role === undefined ? {} : { role: input.role }),
          ...(input.persona === undefined ? {} : { persona: input.persona }),
          ...(input.provider === undefined ? {} : { provider: input.provider }),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
          createdBy: input.accountId,
          createdAt: input.now,
        }),
      )
    },

    async updateBot(input: UpdateBotPortInput): Promise<Bot> {
      const bot = getBotInStore(store, input.botId)
      if (bot === null) throw new StoreError('BOT_NOT_FOUND', `unknown bot ${input.botId}`)
      requireMembership(store, bot.workspaceId, input.accountId)
      return copyBot(updateBotInStore(store, { botId: input.botId, actor: input.accountId, patch: input.patch }))
    },

    async deleteBot(input: DeleteBotPortInput): Promise<void> {
      const bot = getBotInStore(store, input.botId)
      if (bot === null) throw new StoreError('BOT_NOT_FOUND', `unknown bot ${input.botId}`)
      requireMembership(store, bot.workspaceId, input.accountId)
      deleteBotInStore(store, input.botId, { actor: input.accountId, now: input.now })
    },

    async restoreBot(input: RestoreBotPortInput): Promise<Bot> {
      // 软删的 Bot 对 getBot 不可见，这里要带 tombstone 读才能恢复。
      const bot = getBotInStore(store, input.botId, { includeDeleted: true })
      if (bot === null) throw new StoreError('BOT_NOT_FOUND', `unknown bot ${input.botId}`)
      requireMembership(store, bot.workspaceId, input.accountId)
      return copyBot(restoreBotInStore(store, input.botId, { actor: input.accountId, now: input.now }))
    },

    // ---- M4：房间扩展 -------------------------------------------------------

    async getRoomRound(roomId: string) {
      return latestRoundInStore(store, roomId)
    },

    async getRoom(input: { accountId: string; roomId: string }): Promise<RoomRecord | null> {
      const detail = getRoomDetailInStore(store, input.roomId)
      if (detail === null) return null
      if (!isWorkspaceMember(store, detail.room.workspaceId, input.accountId)) return null
      return detailToRecord(detail, roomIsDm(store, detail.room.id))
    },

    async createRoomExt(input: CreateRoomExtPortInput): Promise<RoomRecord> {
      requireMembership(store, input.workspaceId, input.accountId)
      const detail = createRoomExtInStore(store, {
        workspaceId: input.workspaceId,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.notice === undefined ? {} : { notice: input.notice }),
        ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
        memberBotIds: input.memberBotIds,
        ...(input.hostBotId === undefined ? {} : { hostBotId: input.hostBotId }),
        ...(input.responder === undefined ? {} : { responder: input.responder }),
        createdBy: input.accountId,
        createdByKind: 'user',
        createdAt: input.now,
      })
      return detailToRecord(detail, roomIsDm(store, detail.room.id))
    },

    async updateRoom(input: UpdateRoomPortInput): Promise<RoomRecord> {
      const detail = getRoomDetailInStore(store, input.roomId)
      if (detail === null) throw new StoreError('ROOM_NOT_FOUND', `unknown room ${input.roomId}`)
      requireMembership(store, detail.room.workspaceId, input.accountId)
      const responder =
        input.responder ??
        (input.responderBot === undefined ? undefined : { kind: 'member' as const, botId: input.responderBot })
      const updated = updateRoomExtrasInStore(store, {
        roomId: input.roomId,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.notice === undefined ? {} : { notice: input.notice }),
        ...(responder === undefined ? {} : { responder }),
      })
      return detailToRecord(updated, roomIsDm(store, updated.room.id))
    },

    async addRoomMembers(input: RoomMemberMutationInput): Promise<RoomRecord> {
      const detail = getRoomDetailInStore(store, input.roomId)
      if (detail === null) throw new StoreError('ROOM_NOT_FOUND', `unknown room ${input.roomId}`)
      requireMembership(store, detail.room.workspaceId, input.accountId)
      addRoomMembersInStore(store, { roomId: input.roomId, botIds: input.botIds })
      const updated = getRoomDetailInStore(store, input.roomId)
      if (updated === null) throw new StoreError('ROOM_NOT_FOUND', `unknown room ${input.roomId}`)
      return detailToRecord(updated, roomIsDm(store, updated.room.id))
    },

    async removeRoomMember(input: RemoveRoomMemberPortInput): Promise<RoomRecord> {
      const detail = getRoomDetailInStore(store, input.roomId)
      if (detail === null) throw new StoreError('ROOM_NOT_FOUND', `unknown room ${input.roomId}`)
      requireMembership(store, detail.room.workspaceId, input.accountId)
      removeRoomMemberInStore(store, { roomId: input.roomId, botId: input.botId })
      const updated = getRoomDetailInStore(store, input.roomId)
      if (updated === null) throw new StoreError('ROOM_NOT_FOUND', `unknown room ${input.roomId}`)
      return detailToRecord(updated, roomIsDm(store, updated.room.id))
    },

    async deleteRoom(input: DeleteRoomPortInput): Promise<void> {
      const room = getRoomInStore(store, input.roomId)
      if (room === null) throw new StoreError('ROOM_NOT_FOUND', `unknown room ${input.roomId}`)
      requireMembership(store, room.workspaceId, input.accountId)
      deleteRoomInStore(store, input.roomId, input.now)
    },

    async readRoomLog(input: ReadRoomLogPortInput & { accountId: string }): Promise<RoomLogPageRecord> {
      requireRoomMembership(store, input.roomId, input.accountId)
      return toRoomLogPage(readRoomLogPageInStore(store, input))
    },

    async readRoomLogInternal(input: ReadRoomLogPortInput): Promise<RoomLogPageRecord> {
      return toRoomLogPage(readRoomLogPageInStore(store, input))
    },
  }
}

interface RoomRow {
  id: string
  workspace_id: string
  name: string
  notice: string | null
  reply_mode: string
  created_at: number | bigint
}

function toRoomRecord(store: Store, row: RoomRow): RoomRecord {
  // 详情把 M4 的扩展列和成员一起带出来；读不到就退回 0003 的基础形状。
  const detail = getRoomDetailInStore(store, row.id)
  if (detail !== null) return detailToRecord(detail, roomIsDm(store, detail.room.id))
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    ...(row.notice === null ? {} : { notice: row.notice }),
    replyMode: row.reply_mode as RoomRecord['replyMode'],
    createdAt: Number(row.created_at),
    responder: { kind: 'mentions' },
    members: [],
  }
}

function roomIsDm(store: Store, roomId: string): boolean {
  const row = store.db.prepare('SELECT dm FROM rooms WHERE id = ?').get(roomId) as { dm?: number | bigint } | undefined
  return row !== undefined && row !== null && Number(row.dm ?? 0) === 1
}

function detailToRecord(detail: RoomDetail, dm = false): RoomRecord {
  const notice = detail.extras.notice ?? detail.room.notice
  return {
    id: detail.room.id,
    workspaceId: detail.room.workspaceId,
    name: detail.room.name,
    ...(notice === null ? {} : { notice }),
    replyMode: detail.room.replyMode as RoomRecord['replyMode'],
    createdAt: detail.room.createdAt,
    responder: { ...detail.extras.responder },
    ...(detail.extras.hostBotId === null ? {} : { hostBotId: detail.extras.hostBotId }),
    ...(detail.extras.purpose === null ? {} : { purpose: detail.extras.purpose }),
    createdByKind: detail.extras.createdByKind,
    ...(detail.extras.createdBy === null ? {} : { createdBy: detail.extras.createdBy }),
    members: detail.members.map((member) => ({ ...member })),
    ...(dm ? { dm: true } : {}),
  }
}

/** 端口契约第 5 条：返回拷贝，调用方改数组/对象不影响 store。 */
function copyBot(bot: Bot): Bot {
  return {
    ...bot,
    ...(bot.avatar === undefined ? {} : { avatar: { ...bot.avatar } }),
    skills: [...bot.skills],
    toolsAllow: [...bot.toolsAllow],
    toolsDeny: [...bot.toolsDeny],
    memoryScopes: [...bot.memoryScopes],
  }
}

function isWorkspaceMember(store: Store, workspaceId: string, accountId: string): boolean {
  const row = store.db
    .prepare('SELECT 1 AS ok FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workspaceId, accountId)
  return row !== undefined && row !== null
}

function toMessageRecord(message: {
  seq: number
  at: string
  actor: { kind: string; id: string }
  roomId: string
  text: string
}): RoomMessageRecord {
  return {
    seq: message.seq,
    at: message.at,
    actorKind: message.actor.kind as RoomMessageRecord['actorKind'],
    actorId: message.actor.id,
    text: message.text,
  }
}

function toRoomLogPage(page: {
  messages: Array<Parameters<typeof toMessageRecord>[0]>
  hasMore: boolean
  oldestSeq: number | null
  floorSeq: number
}): RoomLogPageRecord {
  return {
    messages: page.messages.map(toMessageRecord),
    hasMore: page.hasMore,
    oldestSeq: page.oldestSeq,
    floorSeq: page.floorSeq,
  }
}

function requireMembership(store: Store, workspaceId: string, accountId: string): void {
  const row = store.db
    .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workspaceId, accountId) as { role: string } | undefined
  if (row === undefined) {
    throw new StoreError('FORBIDDEN', `account ${accountId} is not a member of ${workspaceId}`)
  }
}

function requireRoomMembership(store: Store, roomId: string, accountId: string): void {
  const room = getRoomInStore(store, roomId)
  if (room === null) throw new StoreError('ROOM_NOT_FOUND', `unknown room ${roomId}`)
  requireMembership(store, room.workspaceId, accountId)
}

function roleOf(store: Store, workspaceId: string, accountId: string): WorkspaceRole {
  const row = store.db
    .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workspaceId, accountId) as { role: WorkspaceRole } | undefined
  return row?.role ?? 'viewer'
}

function claimReason(code: string): 'invalid' | 'expired' | 'used' | 'locked' | null {
  switch (code) {
    case 'PAIRING_CODE_NOT_FOUND':
      return 'invalid'
    case 'PAIRING_CODE_EXPIRED':
      return 'expired'
    case 'PAIRING_CODE_USED':
      return 'used'
    case 'PAIRING_CODE_LOCKED':
      return 'locked'
    default:
      return null
  }
}

function toPairingRecord(created: {
  code: string
  accountId: string
  workspaceId: string | null
  createdAt: number
  expiresAt: number
  usedAt: number | null
  attempts: number
}): PairingRecord {
  return {
    code: created.code,
    accountId: created.accountId,
    ...(created.workspaceId === null ? {} : { workspaceId: created.workspaceId }),
    createdAt: created.createdAt,
    expiresAt: created.expiresAt,
    attempts: created.attempts,
    ...(created.usedAt === null ? {} : { usedAt: created.usedAt }),
  }
}
