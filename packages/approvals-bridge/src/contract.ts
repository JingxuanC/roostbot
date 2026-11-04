// 审批桥的契约（docs/build/wave3.md §A）。
//
// 这一层只有词汇、校验和到 DSH 结果词的映射，不含任何状态与时序：
// 状态机在 bridge.ts，DSH 侧适配在 dsh.ts。
//
// 为什么需要它：控制面的审批（packages/store/src/approvals.ts）状态只有
// pending → approved | rejected，而"人没在时限内回答"是一个必须显式表达的
// 现实。桥在自己的账上补齐 timeout，并且**始终失败关闭**：超时不是放行。

/** 桥自己账上的状态；`timeout` 是控制面没有的第四种终态。 */
export const BRIDGE_STATES = ['pending', 'approved', 'rejected', 'timeout'] as const
export type BridgeState = (typeof BRIDGE_STATES)[number]

/** 能落定一个请求的决定；与 BRIDGE_STATES 的差集就是 `pending`。 */
export const BRIDGE_DECISIONS = ['approved', 'rejected', 'timeout'] as const
export type BridgeDecision = (typeof BRIDGE_DECISIONS)[number]

/**
 * DSH 的封闭结果词（`@deepseek-ai/dsh-user-approval/lib/types/types.d.ts:26`）。
 * 刻意复制成字面量而不 import DSH 包：这个包要能在没有 DSH 的环境里跑测试。
 */
export const DSH_APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const
export type DshApprovalOutcome = (typeof DSH_APPROVAL_OUTCOMES)[number]

/**
 * 桥侧故障（不是用户的决定）。区分它很重要：DSH 把 `unavailable`
 * 解释成"没有审批通道"，把 `rejected` 解释成"用户拒绝了这个工具调用"
 * （`@deepseek-ai/dsh-tools/lib/index.js:3559-3585`）。控制面 502 不该被
 * 说成用户拒绝。
 */
export const BRIDGE_FAILURES = ['request_failed', 'disposed'] as const
export type BridgeFailure = (typeof BRIDGE_FAILURES)[number]

/** 谁落定的：人、超时、还是桥自己（建单失败 / 被 dispose）。 */
export const DECISION_ACTORS = ['user', 'timeout', 'bridge'] as const
export type DecisionActor = (typeof DECISION_ACTORS)[number]

/** 一次工具审批请求。字段与 wave3 §A 的契约一致。 */
export interface ApprovalRequest {
  /** 桥侧 id，见 dsh.ts 的 requestId 约定。 */
  id: string
  workspaceId: string
  botId: string
  tool: string
  /** 参数摘要（不是完整参数）：控制面只做展示与审计。 */
  argsSummary: string
  /** 后果说明（卡片上"会发生什么"）。 */
  consequence: string
  /** epoch 毫秒。 */
  requestedAt: number
}

/** 桥对外的只读快照；每次返回都是新对象，外部改不动内部账。 */
export interface BridgeOutcome {
  id: string
  request: ApprovalRequest
  state: BridgeState
  /** pending 时为 null。 */
  decision: BridgeDecision | null
  /**
   * 默认映射下的 DSH 结果词；pending 时为 null。
   * `request_failed` 时调用方（dsh.ts）应自行降级成 `unavailable`。
   */
  dshOutcome: DshApprovalOutcome | null
  failure: BridgeFailure | null
  /** 控制面审批 id（`apr_…`）；未建单或建单失败时为 null。 */
  approvalId: string | null
  requestedAt: number
  /** requestedAt + timeoutMs；没有超时约定时为 null。 */
  deadlineAt: number | null
  decidedAt: number | null
  decidedBy: DecisionActor | null
  /** 人类可读的补充说明（失败原因、超时说明、dispose 说明）。 */
  note: string | null
}

export type BridgeErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_DECISION'
  | 'UNKNOWN_REQUEST'
  | 'ALREADY_DISPOSED'

/** 桥的输入错误；`detail` 带着逐字段校验结果，方便 API 层直出 400。 */
export class BridgeError extends Error {
  code: BridgeErrorCode
  detail: readonly RequestFieldError[]

  constructor(code: BridgeErrorCode, message: string, detail: readonly RequestFieldError[] = []) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.detail = detail
  }
}

export interface RequestFieldError {
  field: string
  message: string
}

export type ReadApprovalRequest =
  | { ok: true; request: ApprovalRequest }
  | { ok: false; errors: RequestFieldError[] }

// 长度上限与控制面同源：action 200 / target 500 / consequence 2000
// （packages/store/src/approvals.ts:145-147），arg 摘要比 target 更宽就够用了。
export const REQUEST_ID_MAX = 200
export const REQUEST_TOOL_MAX = 200
export const REQUEST_SUMMARY_MAX = 2000
export const REQUEST_CONSEQUENCE_MAX = 2000
export const REQUEST_SCOPE_MAX = 200

/**
 * 校验并归一化一个外部请求（HTTP body / 插件对象）。
 * 不抛异常：调用方拿 `errors` 决定回 400 还是丢弃。
 * @param value - 未信任的输入。
 * @param at - `requestedAt` 缺省时用的时间戳。
 */
export function readApprovalRequest(value: unknown, at: number = Date.now()): ReadApprovalRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: [{ field: '(root)', message: 'must be a JSON object' }] }
  }
  const input = value as Record<string, unknown>
  const errors: RequestFieldError[] = []
  const id = readText(input['id'], 'id', REQUEST_ID_MAX, errors)
  const workspaceId = readText(input['workspaceId'], 'workspaceId', REQUEST_SCOPE_MAX, errors)
  const botId = readText(input['botId'], 'botId', REQUEST_SCOPE_MAX, errors)
  const tool = readText(input['tool'], 'tool', REQUEST_TOOL_MAX, errors)
  const argsSummary = readOptionalText(input['argsSummary'], 'argsSummary', REQUEST_SUMMARY_MAX, errors)
  const consequence = readOptionalText(input['consequence'], 'consequence', REQUEST_CONSEQUENCE_MAX, errors)
  const requestedAt = readTimestamp(input['requestedAt'], 'requestedAt', at, errors)

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, request: { id, workspaceId, botId, tool, argsSummary, consequence, requestedAt } }
}

/**
 * 决定 → DSH 结果词。**超时映射成 `rejected` 而不是 `unavailable`**：
 * 通道是通的（单子建出来了、人在看），只是没人回答；DSH 的 `unavailable`
 * 表示"没有可用的审批通道"，用错会让模型以为部署缺能力而不是用户没应答。
 */
export function toDshOutcome(decision: BridgeDecision | null): DshApprovalOutcome | null {
  switch (decision) {
    case null:
      return null
    case 'approved':
      return 'allowed-once'
    case 'rejected':
    case 'timeout':
      return 'rejected'
  }
}

/** 终态判定：pending 之外都是终态，终态不再变化（幂等）。 */
export function isTerminal(state: BridgeState): boolean {
  return state !== 'pending'
}

/** 是否是合法的决定词（外部输入的运行时校验）。 */
export function isBridgeDecision(value: unknown): value is BridgeDecision {
  return typeof value === 'string' && (BRIDGE_DECISIONS as readonly string[]).includes(value)
}

function readText(
  value: unknown,
  field: string,
  max: number,
  errors: RequestFieldError[],
): string {
  if (value === undefined || value === null) {
    errors.push({ field, message: 'is required (non-empty string)' })
    return ''
  }
  if (typeof value !== 'string') {
    errors.push({ field, message: 'must be a string' })
    return ''
  }
  const text = value.trim()
  if (text === '') {
    errors.push({ field, message: 'must not be empty' })
    return ''
  }
  if (text.length > max) {
    errors.push({ field, message: `must be at most ${max} characters` })
    return ''
  }
  return text
}

function readOptionalText(
  value: unknown,
  field: string,
  max: number,
  errors: RequestFieldError[],
): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    errors.push({ field, message: 'must be a string when present' })
    return ''
  }
  const text = value.trim()
  if (text.length > max) {
    errors.push({ field, message: `must be at most ${max} characters` })
    return ''
  }
  return text
}

function readTimestamp(
  value: unknown,
  field: string,
  fallback: number,
  errors: RequestFieldError[],
): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    errors.push({ field, message: 'must be a non-negative epoch-millisecond number' })
    return fallback
  }
  return Math.trunc(value)
}
