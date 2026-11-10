// M4 共享契约（docs/build/m4-contract.md）。所有实现都 import 这里，避免各自定义漂移。

import type { AgentCapabilities, AgentRuntimeKind } from '../../agent-runtime/src/index.ts'

export type { AgentCapabilities, AgentRuntimeKind }

export type RuntimeConfig = Record<string, unknown>

export interface ApiError {
  ok: false
  error: { code: string; message: string }
}

export type BotStatus = 'active' | 'paused'

export interface Bot {
  id: string
  workspaceId: string
  name: string
  role: string
  persona: string
  provider: string
  model: string
  avatar?: { shape?: string; color?: string; image?: string }
  skills: string[]
  toolsAllow: string[]
  toolsDeny: string[]
  approval: 'ask' | 'edits' | 'auto' | 'full'
  memoryScopes: string[]
  status: BotStatus
  createdBy: string
  createdAt: number
  /** 软删时刻（epoch 毫秒）；未删除时缺省。只在 includeDeleted 的读取里出现。 */
  deletedAt?: number
  /** Agent Runtime：dsh / grok-build / claude-code / codex / hermes。旧数据默认 dsh。 */
  runtimeKind?: AgentRuntimeKind
  /** Runtime 专属配置（JSON-safe）；不存明文凭据。 */
  runtimeConfig?: RuntimeConfig
  /** 指向 secret provider 的引用，不是密钥本身；API 只暴露引用。 */
  credentialRef?: string
  /** 最近一次 probe/协商缓存的能力；UI 按它渲染。 */
  capabilities?: AgentCapabilities
}

export interface CreateBotInput {
  workspaceId: string
  name: string
  role?: string
  model?: string
  provider?: string
  avatar?: Bot['avatar']
  persona?: string
  /** 缺省 dsh；必须是 packages/agent-runtime 的 AgentRuntimeKind。 */
  runtimeKind?: AgentRuntimeKind
  runtimeConfig?: RuntimeConfig
  credentialRef?: string
  capabilities?: AgentCapabilities
}

export interface UpdateBotInput {
  name?: string
  role?: string
  persona?: string
  avatar?: Bot['avatar']
  skills?: string[]
  toolsAllow?: string[]
  toolsDeny?: string[]
  approval?: Bot['approval']
  memoryScopes?: string[]
  model?: string
  status?: BotStatus
  runtimeKind?: AgentRuntimeKind
  runtimeConfig?: RuntimeConfig
  credentialRef?: string
  capabilities?: AgentCapabilities
}

export type RoomResponderKind = 'member' | 'everyone' | 'mentions' | 'auto'

export interface RoomResponder {
  kind: RoomResponderKind
  /** kind=member 时的成员 */
  botId?: string
  /** kind=auto 的兜底成员 */
  fallbackBotId?: string
}

export interface RoomMember {
  botId: string
  role: 'host' | 'member'
  name?: string
}

export interface Room {
  id: string
  workspaceId: string
  name: string
  notice?: string
  replyMode: 'admin' | 'everyone' | 'mentions'
  responder: RoomResponder
  hostBotId?: string
  purpose?: string
  createdByKind: 'user' | 'bot'
  createdBy: string
  createdAt: number
  members: RoomMember[]
}

export interface CreateRoomInput {
  workspaceId: string
  name?: string
  notice?: string
  memberBotIds: string[]
  hostBotId?: string
  responder?: RoomResponder
  purpose?: string
}

export type SlotStatus =
  | 'waiting'
  | 'speaking'
  | 'posted'
  | 'passed'
  | 'failed'
  | 'missed'
  | 'working'
  | 'left'
  | 'waiting-approval'
  | 'needs_input'

export interface RoundSlot {
  botId: string
  name?: string
  status: SlotStatus
  note?: string
  /** 被哪个成员 @ 调用进来的 */
  by?: string
  /** 这张卡没人答之前，轮次停在这里。答案事件把它放回 waiting。 */
  awaiting?: { kind: 'choice' | 'approval'; id: string }
}

export interface RoomRound {
  id: string
  roomId: string
  startSeq: number
  state: 'running' | 'done' | 'stopped'
  slots: RoundSlot[]
  turns: number
  speaking?: string
  startedAt: number
  endedAt?: number
}

/** 控制面 → 沙箱（room-agent）的派发指令：这一轮、这个成员、投什么。 */
export interface RoundAssignment {
  roundId: string
  roomId: string
  botId: string
  sessionId: string
  prompt: string
  /** 该 slot 是本轮第几个 */
  index: number
  total: number
}

export type SlotResult =
  | { kind: 'posted'; text: string }
  | { kind: 'passed' }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'working' }
  | { kind: 'approval' }
  | { kind: 'missed' }

/** 内部接口请求/响应形状（apps/api 与 apps/runtime 共用）。 */
export interface InternalRoomsResponse {
  rooms: Array<{
    id: string
    name: string
    responder: RoomResponder
    members: Array<{ botId: string; role: 'host' | 'member' }>
    hostBotId?: string
  }>
}

export interface RoundAdvanceInput {
  slotIndex: number
  result: SlotResult
}

export const BOT_LIMITS = {
  nameMax: 40,
  roleMax: 24,
  personaMax: 20_000
} as const

export const ROOM_LIMITS = {
  nameMax: 60,
  noticeMax: 2_000,
  membersMax: 12
} as const

export const ROUND_LIMITS = {
  replyTimeoutMs: 240_000,
  workGraceMs: 15_000,
  perMemberTurns: 2,
  hostTurns: 4,
  extraTurns: 4,
  hostExtraTurns: 4,
  lateRounds: 10,
  logMax: 60,
  firstLook: 12,
  deltaMax: 24,
  earlierMax: 8
} as const
