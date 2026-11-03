// 设计见 docs/design/workspace.md。只有类型，没有 IO。
//
// 三个概念不可混用：
//   Workspace  —— 逻辑身份（Bot 团队、房间、记忆、文件）
//   Runtime    —— 它的一个运行实例（云容器或本机进程）；一个 workspace 只有一个 home
//   Client     —— 窗口；无状态，只持有 UI 偏好与草稿
//   Node       —— 挂在 workspace 上的本地能力节点，只出站

export type HomeMode = 'cloud' | 'local'

export type WorkspaceState = 'absent' | 'stopped' | 'starting' | 'running' | 'stopping' | 'migrating'

export interface Workspace {
  id: string
  tenantId: string
  name: string
  homeMode: HomeMode
  state: WorkspaceState
  volumeId?: string
  /** 镜像里的产品版本；与客户端协议版本分开。 */
  profileVersion: string
  createdAt: number
}

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer'

export interface WorkspaceMember {
  workspaceId: string
  userId: string
  role: WorkspaceRole
  invitedBy?: string
  createdAt: number
}

export type RuntimeKind = 'home' | 'local-node'

export interface Runtime {
  id: string
  workspaceId: string
  kind: RuntimeKind
  /** 控制面内部地址，永不暴露给浏览器。 */
  baseUrl?: string
  startedAt?: number
  lastSeenAt?: number
}

export interface ClientSession {
  id: string
  userId: string
  workspaceId: string
  deviceLabel?: string
  createdAt: number
  lastSeenAt?: number
  revokedAt?: number
}

/** 节点能提供什么；云端只按白名单调用。 */
export type CapabilityKind = 'fs' | `mcp:${string}` | `model:${string}`

export interface CapabilityGrant {
  id: string
  workspaceId: string
  nodeId: string
  cap: CapabilityKind
  /** 允许的路径前缀 / 命令白名单，按 cap 解释。 */
  scope: unknown
  grantedBy: string
  expiresAt?: number
  createdAt: number
}

export interface CapabilityNodeHello {
  nodeId: string
  label: string
  provides: CapabilityKind[]
  protocol: number
}

/** 一次能力调用。断线时调用方得到 unavailable，不挂起等待。 */
export type CapabilityCall =
  | { call: { id: string; cap: CapabilityKind; args: unknown; grant: string; deadline: string } }
  | { reply: { id: string; ok: true; data: unknown } | { id: string; ok: false; code: 'denied' | 'unavailable' | 'error'; reason?: string } }

/** 客户端与 home 的协议版本；升级期间客户端显示「正在升级」而不是断线。 */
export const WORKSPACE_PROTOCOL = 1

export function isRunning(state: WorkspaceState): boolean {
  return state === 'running'
}
