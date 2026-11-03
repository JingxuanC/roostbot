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
