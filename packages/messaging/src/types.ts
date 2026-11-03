// 设计见 docs/design/messaging.md。只有类型与纯函数。

export type SenderKind = 'bot' | 'user' | 'system'

export interface MessageParty {
  kind: SenderKind
  id: string
  /** 目标侧的目的线程；缺省用该 Bot 自己的主线程。 */
  thread?: string
}

/** 消息在目标上下文里的角色；决定注入时的发送者框（见 design §2）。 */
export type MessageRole =
  | 'request'
  | 'reply'
  | 'report'
  | 'room'
  | 'question'
  | 'resume'
  | 'stopped'
  | 'notice'

/** 有 assignment 才有状态机与回执义务；没有就是纯消息。 */
export type DeliveryMode = 'now' | 'queue'

export type ReplyPolicy = 'resume' | 'poll' | 'none'

export type Audience = 'team' | 'room' | 'member'

export interface MessageEnvelope {
  id: string
  /** 幂等键：同一 (assignment, 序号) 只会产生一条。 */
  idem: string
  from: MessageParty
  to: MessageParty
  role: MessageRole
  /** 关联的任务单；为空表示纯消息，不产生回执。 */
  assignment?: string
  mode?: DeliveryMode
  reply?: ReplyPolicy
  audience?: Audience
  body: string
  attachments?: string[]
  deadline?: string
  at: string
}

/** 发送者框的词汇表；注入时放在正文第一块。 */
export const FRAMING: Record<MessageRole, (name: string, room?: string) => string> = {
  request: (name) => `[Message from ${name}]`,
  reply: (name) => `[Reply from ${name}]`,
  report: (name) => `[Report from ${name}]`,
  room: (_name, room) => `[Group chat "${room ?? 'room'}" · new message]`,
  question: (name) => `[Question from ${name}]`,
  resume: (name) => `[Message from ${name} · the harness restarted while you were working]`,
  stopped: (name) => `[Stopped by ${name}]`,
  notice: (name) => `[Notice from ${name}]`,
}

/** 上限：对齐设计文档 §8。64KB 不是性能参数，是这条消息最多能吃多少 token。 */
export const MAX_MESSAGE_BYTES = 65_536
export const INLINE_HEAD_CHARS = 1_000
export const MAX_BRIEF_CHARS = 12_000

/** 需要保序的边界：同一 sender→target 的连续消息，在目标 inbox 内保序。 */
export function orderingKey(message: Pick<MessageEnvelope, 'from' | 'to'>): string {
  return `${message.from.kind}:${message.from.id}->${message.to.kind}:${message.to.id}`
}

/** 纯消息不产生回执义务；带 assignment 的由状态机负责。 */
export function expectsReply(message: Pick<MessageEnvelope, 'assignment' | 'reply'>): boolean {
  if (message.assignment === undefined) return false
  return (message.reply ?? 'resume') !== 'none'
}
