// 事件信封 v1 的类型与运行时常量。事实源：docs/design/events.md §3–§4。
// 只用可擦除 TS 语法；相对导入必须带 .ts 扩展名。

export const EVENT_DOMAINS = [
  'chat',
  'turn',
  'tool',
  'approval',
  'assignment',
  'schedule',
  'sandbox',
  'memory',
  'workspace',
  'auth',
  'billing',
] as const

export type EventDomain = (typeof EVENT_DOMAINS)[number]

/**
 * 每个 domain 允许的 kind。events.md §4 是基线；
 * architecture-v2.md 只追加 kind（message.delta、round、speaking），不改旧语义。
 */
export const EVENT_KINDS_BY_DOMAIN = {
  chat: ['chat.message', 'chat.message.edited', 'chat.unread', 'chat.message.delta'],
  turn: [
    'turn.started',
    'turn.step',
    'turn.completed',
    'turn.failed',
    'turn.interrupted',
    'turn.round.started',
    'turn.round.ended',
    'turn.speaking',
  ],
  tool: ['tool.call', 'tool.result', 'tool.denied'],
  approval: ['approval.requested', 'approval.decided'],
  assignment: [
    'assignment.enqueued',
    'assignment.started',
    'assignment.parked',
    'assignment.answered',
    'assignment.settled',
    'assignment.cancelled',
  ],
  schedule: [
    'schedule.activation',
    'schedule.run.started',
    'schedule.run.settled',
    'schedule.run.missed',
  ],
  sandbox: ['sandbox.ready', 'sandbox.denied', 'sandbox.frozen', 'sandbox.stopped'],
  memory: ['memory.written', 'memory.superseded', 'memory.deleted'],
  workspace: ['workspace.created', 'workspace.started', 'workspace.stopped', 'workspace.migrated'],
  auth: ['auth.paired', 'auth.session.revoked', 'auth.token.refreshed'],
  billing: ['billing.usage', 'billing.reserve', 'billing.settle', 'billing.cap'],
} as const satisfies Record<EventDomain, readonly string[]>

export type EventKind = (typeof EVENT_KINDS_BY_DOMAIN)[EventDomain][number]

/** 扁平化后的全部 kind，便于 CLI/文档展示。 */
export const EVENT_KINDS: readonly EventKind[] = EVENT_DOMAINS.flatMap((domain) => [
  ...EVENT_KINDS_BY_DOMAIN[domain],
])

export function isEventDomain(value: unknown): value is EventDomain {
  return typeof value === 'string' && (EVENT_DOMAINS as readonly string[]).includes(value)
}

export function isEventKind(value: unknown): value is EventKind {
  return typeof value === 'string' && (EVENT_KINDS as readonly string[]).includes(value)
}

export function eventKindsFor(domain: EventDomain): readonly EventKind[] {
  return EVENT_KINDS_BY_DOMAIN[domain]
}

/**
 * event.schema.json（旧扁平信封）到 events.md 新 kind 的兼容映射。
 * 只用于读旧日志；validateEvent 不接收旧 kind，新写入必须用 domain.kind。
 * `error` 没有对应的新 kind，旧数据按原样保留、不再新增。
 */
export const LEGACY_KIND_MAP = {
  'user.message': 'chat.message',
  'bot.message': 'chat.message',
  'tool.call': 'tool.call',
  'tool.result': 'tool.result',
  'approval.request': 'approval.requested',
  'approval.decision': 'approval.decided',
  'run.started': 'schedule.run.started',
  'run.settled': 'schedule.run.settled',
  'memory.written': 'memory.written',
} as const

/** events.md §3：team | room:<id> | member:<id>。 */
export type EventAudience = 'team' | `room:${string}` | `member:${string}`

export interface EventActor {
  kind: string
  id: string
}

export type EventSubject = EventActor

export interface EventTrace {
  run?: string
  turn?: string
  assignment?: string
  [key: string]: unknown
}

/** 事件信封。worker/控制面写日志、客户端续读都用这一份形状。 */
export interface EventEnvelope<P = Record<string, unknown>> {
  id: string
  /** workspace 内单调递增，唯一排序依据。 */
  seq: number
  /** 写入时刻（ISO date-time）。 */
  at: string
  domain: EventDomain
  kind: EventKind
  actor?: EventActor | null
  subject?: EventSubject | null
  audience?: EventAudience | null
  /** 回答哪条事件（seq）。 */
  parent?: number | null
  /** 幂等键：同 key 只写一次。 */
  idem?: string | null
  trace?: EventTrace | null
  /** 域自定义；大对象写附件，只留引用和摘要。 */
  payload: P
  v: 1
}

export type Event = EventEnvelope
