// 设计见 docs/design/scheduling.md。这里只有类型，没有 IO。

/** 谁让这件事开始。 */
export type ActivationKind = 'clock' | 'event' | 'repair' | 'manual'

export interface ActivationBudget {
  tokens?: number
  wallMs?: number
  toolCalls?: number
}

export interface Activation {
  id: string
  kind: ActivationKind
  /** 例如 "routine:daily-premarket"、"github:issue#12"、"watchdog" */
  source: string
  target: { workspace: string; bot: string; room?: string }
  /**
   * 幂等键，唯一约束建在它上面。
   * clock 用 `routineId@scheduledFor`；event 用事件自身的稳定 id；repair 用巡检轮次。
   */
  idem: string
  scheduledFor?: string
  payload: { brief: string; inputs?: unknown[] }
  budget: ActivationBudget
  doneWhen?: string
  createdAt: string
}

/** Run 的可见状态。 */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'missed'
  | 'skipped'

/** 结束原因，调用方可以分支处理。 */
export type RunOutcome =
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

export const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'missed', 'skipped']

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

export interface Run {
  id: string
  activationId: string
  status: RunStatus
  outcome?: RunOutcome
  executions: number
  restarts: number
  lastActivityAt: number
  startedAt?: number
  finishedAt?: number
  result?: string
  /** harness 观测到的证据：命令数、改过的文件、工具调用、对外动作。 */
  evidence?: RunEvidence
}

export interface RunEvidence {
  commands?: number
  filesChanged?: string[]
  toolCalls?: number
  okToolCalls?: number
  errors?: string[]
  outward?: string[]
  summary?: string
}

export type RunEventKind =
  | 'enqueued'
  | 'admitted'
  | 'started'
  | 'progress'
  | 'parked'
  | 'answered'
  | 'settled'
  | 'missed'
  | 'cancelled'

export interface RunEvent {
  runId: string
  at: number
  kind: RunEventKind
  detail?: string
}
