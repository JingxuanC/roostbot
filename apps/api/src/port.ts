// 控制面 API 依赖的存储端口。设计见 docs/design/auth.md §9 与 docs/design/workspace.md §8。
//
// 这里只有接口，没有任何实现，也不 import 真实 store：API 只认这个端口，测试和本地启动用
// memory-store.ts，Lead 之后把 packages/store 的实现包一层适配器接进来即可。
//
// 存端口时必须满足的契约（实现方负责，API 依赖它们）：
//   1. createPairingCode：同一个 code 上已有「未使用且未过期」的记录时，必须抛
//      PairingCodeCollisionError，绝不覆盖（否则会把别人的码顶掉）。
//   2. claimPairingCode：单次使用 + 尝试计数必须在同一个事务/临界区里完成（原子），
//      否则两个并发 claim 可以拿到两个会话。
//   3. findSessionByToken 只按 hash 查，永不接受明文 token；返回 null 表示查无此会话。
//   4. 所有 now / expiresAt 都是毫秒时间戳，由调用方传入，store 自己不看时钟。
//   5. 返回给调用方的对象必须是拷贝：调用方改字段不能改到 store 内部状态。

// M4 的 Bot / 房间扩展类型直接来自共享契约（packages/contract），避免第二份定义漂移。
import type {
  Bot,
  RoomMember,
  RoomResponder,
  RoomRound,
  UpdateBotInput
} from '../../../packages/contract/src/index.ts'

export type HomeMode = 'cloud' | 'local'

export type WorkspaceState = 'absent' | 'stopped' | 'starting' | 'running' | 'stopping' | 'migrating'

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer'

export type DevicePlatform = 'web' | 'desktop' | 'ios' | 'android' | 'cli'

/** 一次配对码。字段对应 auth.md §9 的 pairing_codes 表。 */
export interface PairingRecord {
  code: string
  accountId: string
  workspaceId?: string
  createdAt: number
  expiresAt: number
  usedAt?: number
  /** 针对这个码的错误次数；达到上限后锁一段时间。 */
  attempts: number
  lockedUntil?: number
}

export interface CreatePairingCodeInput {
  code: string
  accountId: string
  workspaceId?: string
  now: number
  expiresAt: number
}

export interface ClaimPairingCodeInput {
  code: string
  now: number
  /** 允许的错误次数上限；达到即锁。计数口径由 store 决定（成功是否计数也一样）。 */
  maxAttempts: number
  /**
   * 建议的锁定持续时间（毫秒）。实现可以忽略：码本身 5 分钟就过期，
   * 把锁当成永久与按 10 分钟解锁在行为上等价（auth.md §3 的 10 分钟锁没有对应列）。
   */
  lockMs: number
}

export type PairingClaimFailure = 'invalid' | 'expired' | 'used' | 'locked'

export type ClaimPairingCodeResult =
  | { ok: true; pairing: PairingRecord }
  | { ok: false; reason: PairingClaimFailure }

/** workspace 投影：控制面 DB 的权威字段 + 当前账号在其中的角色。 */
export interface WorkspaceRecord {
  id: string
  tenantId: string
  name: string
  homeMode: HomeMode
  /** 生命周期状态，见 workspace.md §7；内存实现里创建后是 stopped。 */
  state: WorkspaceState
  volumeId?: string
  profileVersion: string
  role: WorkspaceRole
  createdAt: number
}

export interface CreateWorkspaceInput {
  accountId: string
  name: string
  now: number
  homeMode?: HomeMode
  profileVersion?: string
}

/** 设备会话。字段对应 auth.md §9 的 sessions 表（明文 token 不落库）。 */
export interface SessionRecord {
  id: string
  accountId: string
  deviceId: string
  workspaceId?: string
  tokenHash: string
  createdAt: number
  expiresAt: number
  lastSeenAt?: number
  revokedAt?: number
}

export interface CreateSessionInput {
  accountId: string
  /** 由 API 计算好的 sha256(token) 十六进制；store 不碰明文。 */
  tokenHash: string
  now: number
  expiresAt: number
  workspaceId?: string
  deviceLabel?: string
  platform?: DevicePlatform
}

/**
 * 控制面存储端口。真实实现（packages/store）必须满足文件头的五条契约。
 * 所有方法都可能失败（数据库错误等），API 会把它变成 500 JSON 而不是挂起连接。
 */

// ---- 房间与消息（docs/design/messaging.md）----------------------------------
// 房间属于 workspace；只有该 workspace 的成员能读写。消息本体是 chat.message 事件，
// seq 是它的身份，所以 API 不需要自己的消息 id。

export interface RoomRecord {
  id: string
  workspaceId: string
  name: string
  notice?: string
  replyMode: 'admin' | 'everyone' | 'mentions'
  createdAt: number
  /** M4：谁回答、host、公告/目的、创建者；成员是 Bot 成员列表。 */
  responder: RoomResponder
  hostBotId?: string
  purpose?: string
  createdByKind?: 'user' | 'bot'
  createdBy?: string
  members: RoomMember[]
  /** DM（与某个 Bot 的私聊）；M4 起用于 kickoff。 */
  dm?: boolean
}

export interface RoomMessageRecord {
  seq: number
  /** ISO 8601。 */
  at: string
  actorKind: 'user' | 'bot' | 'system' | 'control-plane'
  actorId: string
  text: string
}

export interface ListRoomsInput {
  accountId: string
  workspaceId?: string
}

export interface CreateRoomInput {
  accountId: string
  workspaceId: string
  name: string
  now: number
}

export interface ReadMessagesInput {
  accountId: string
  roomId: string
  afterSeq?: number
  limit?: number
}

export interface PostMessageInput {
  accountId: string
  roomId: string
  text: string
  idem?: string
}

export interface ListBotsInput {
  accountId: string
  /** 省略时列出该账号所有 workspace 的 Bot（按 createdAt 升序）。 */
  workspaceId?: string
}

export interface CreateBotPortInput {
  accountId: string
  workspaceId: string
  name: string
  role?: string
  persona?: string
  provider?: string
  model?: string
  avatar?: Bot['avatar']
  now: number
}

export interface UpdateBotPortInput {
  accountId: string
  botId: string
  patch: UpdateBotInput
}

export interface DeleteBotPortInput {
  accountId: string
  botId: string
}

export interface CreateRoomExtPortInput {
  accountId: string
  workspaceId: string
  name?: string
  notice?: string
  purpose?: string
  memberBotIds: string[]
  hostBotId?: string
  responder?: RoomResponder
  now: number
}

export interface UpdateRoomPortInput {
  accountId: string
  roomId: string
  name?: string
  notice?: string | null
  responder?: RoomResponder
  /** 简写：等价于 responder={kind:'member',botId:responderBot}。 */
  responderBot?: string
}

export interface RoomMemberMutationInput {
  accountId: string
  roomId: string
  botIds: string[]
}

export interface RemoveRoomMemberPortInput {
  accountId: string
  roomId: string
  botId: string
}

export interface StorePort {
  createPairingCode(input: CreatePairingCodeInput): Promise<PairingRecord>
  claimPairingCode(input: ClaimPairingCodeInput): Promise<ClaimPairingCodeResult>
  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRecord>
  /** 按 createdAt 升序返回当前账号是成员的 workspace。 */
  listWorkspaces(input: { accountId: string }): Promise<WorkspaceRecord[]>
  createSession(input: CreateSessionInput): Promise<SessionRecord>
  findSessionByToken(tokenHash: string): Promise<SessionRecord | null>

  /** 列出该账号可见的房间；给了 workspaceId 就只列那一个。 */
  listRooms(input: ListRoomsInput): Promise<RoomRecord[]>
  createRoom(input: CreateRoomInput): Promise<RoomRecord>
  /** 读消息按 seq 升序；afterSeq 用于 SSE 断线补拉。 */
  readMessages(input: ReadMessagesInput): Promise<RoomMessageRecord[]>
  /** 写一条消息，返回它的 seq（幂等由 idem 保证）。 */
  postMessage(input: PostMessageInput): Promise<RoomMessageRecord>

  // ---- 服务端内部（runtime worker 用；只由持有 runtime token 的进程调用）----
  /** 所有房间（worker 启动时发现要盯哪些房间）。 */
  listAllRooms(): Promise<RoomRecord[]>
  /** 以 Bot 身份写一条消息。 */
  postBotMessage(input: { roomId: string; botId: string; text: string; idem?: string }): Promise<RoomMessageRecord>
  /** 内部读：不走成员校验，调用方已经用 runtime token 证明过身份。 */
  readMessagesInternal(input: { roomId: string; afterSeq?: number; limit?: number }): Promise<RoomMessageRecord[]>

  // ---- M4：Bot 域 -------------------------------------------------------------
  /** 只列该账号是成员的 workspace 里的 Bot；workspaceId 必须属于该账号。 */
  listBots(input: ListBotsInput): Promise<Bot[]>
  /** 找不到、或该账号不是 Bot 所在 workspace 的成员，都返回 null（不泄露存在性）。 */
  getBot(input: { accountId: string; botId: string }): Promise<Bot | null>
  createBot(input: CreateBotPortInput): Promise<Bot>
  updateBot(input: UpdateBotPortInput): Promise<Bot>
  /** DELETE /api/bots/:id：软/硬删由适配器决定（当前实现是硬删，见 packages/store/src/bots.ts）。 */
  deleteBot(input: DeleteBotPortInput): Promise<void>

  // ---- M4：房间扩展 -----------------------------------------------------------
  /** 单房间详情（含成员）；该账号必须是房间所在 workspace 的成员。 */
  getRoom(input: { accountId: string; roomId: string }): Promise<RoomRecord | null>
  /** 建房 + 成员 + host + responder + notice/purpose，一次事务。 */
  createRoomExt(input: CreateRoomExtPortInput): Promise<RoomRecord>
  /** 改 name/notice/responder；responder 必须指向当前成员，否则适配器抛 ROOM_RESPONDER_INVALID。 */
  updateRoom(input: UpdateRoomPortInput): Promise<RoomRecord>
  addRoomMembers(input: RoomMemberMutationInput): Promise<RoomRecord>
  removeRoomMember(input: RemoveRoomMemberPortInput): Promise<RoomRecord>
  /** 房间最近一轮（running 或已结束）；没有轮次时 null。 */
  getRoomRound(roomId: string): Promise<RoomRound | null>
}

/** 6 位码空间很小：签发时必须能发现「同一个码还活着」，由 API 换一个重试。 */
export class PairingCodeCollisionError extends Error {
  code: string

  constructor(code: string) {
    super(`pairing code ${code} is already active`)
    this.name = 'PairingCodeCollisionError'
    this.code = code
  }
}
