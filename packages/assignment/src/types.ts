// 设计见 docs/design/agent-collaboration.md。

export type AssignmentMode = 'work' | 'consult' | 'notify'
export type ReplyPolicy = 'resume' | 'poll' | 'none'

export type AssignmentStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'needs_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'refused'
  | 'interrupted'

export type AssignmentOutcome =
  | 'done'
  | 'needs_input'
  | 'budget'
  | 'stalled'
  | 'interrupted'
  | 'provider_error'
  | 'denied'
  | 'expired'
  | 'stopped'
  | 'missed'
  | 'refused'
  | 'duplicate'
  | 'cancelled'

export interface AssignmentBudget {
  tokens?: number
  wallMs?: number
  toolCalls?: number
}

export interface AssignmentEvidence {
  commands?: number
  filesChanged?: string[]
  toolCalls?: number
  okToolCalls?: number
  errors?: string[]
  outward?: string[]
}

export interface Assignment {
  id: string
  rootId: string
  parentId?: string
  /** 距离 root 的边数；超过 MAX_DEPTH 直接拒绝。 */
  depth: number
  mode: AssignmentMode
  requester: { botId: string; threadId?: string }
  assignee: { botId: string; threadId: string }
  status: AssignmentStatus
  outcome?: AssignmentOutcome
  brief: string
  doneWhen?: string
  budget: AssignmentBudget
  reply: ReplyPolicy
  level?: string
  question?: string
  answer?: string
  answeredBy?: { kind: 'bot' | 'person'; id: string }
  executions: number
  restarts: number
  lastActivityAt: number
  createdAt: number
  startedAt?: number
  finishedAt?: number
  evidence?: AssignmentEvidence
}

/** 深度上限：Bot → Bot 一层。更深就必须走房间讨论。 */
export const MAX_DEPTH = 2
/** 每 root 的请求/执行预算，取自 OpenMausBot 的实测值。 */
export const MAX_REQUESTS_PER_ROOT = 64
export const MAX_EXECUTIONS_PER_ROOT = 96
/** 单次委托的 brief 上限。 */
export const MAX_BRIEF_CHARS = 12_000
/** 无进展多久算 stalled（租约）。 */
export const STALL_MS = 10 * 60_000

const TERMINAL: readonly AssignmentStatus[] = ['completed', 'failed', 'cancelled', 'refused']
export const TERMINAL_STATUSES = TERMINAL
export function isTerminal(status: AssignmentStatus): boolean {
  return TERMINAL.includes(status)
}

/** 合法迁移表；不在表里的迁移一律拒绝，而不是静默接受。 */
const TRANSITIONS: Record<AssignmentStatus, readonly AssignmentStatus[]> = {
  queued: ['running', 'refused', 'cancelled'],
  running: ['waiting', 'needs_input', 'completed', 'failed', 'cancelled', 'interrupted'],
  waiting: ['running', 'needs_input', 'completed', 'failed'],
  needs_input: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  refused: [],
  interrupted: ['running', 'failed', 'cancelled'],
}

export function canTransition(from: AssignmentStatus, to: AssignmentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

/** 把任务派回祖先会直接成环，必须拒绝。 */
export function isAncestorViolation(parentId: string | undefined, targetId: string): boolean {
  return parentId !== undefined && parentId === targetId
}

/** 无进展超时 → 应被标为 stalled。 */
export function isStalled(lastActivityAt: number, now: number): boolean {
  return now - lastActivityAt > STALL_MS
}
