// 审批桥的纯状态机（docs/build/wave3.md §A）。
//
//   pending ──settle('approved')──▶ approved   → DSH allowed-once
//      │    ──settle('rejected')──▶ rejected   → DSH rejected
//      │    ──expire(deadline) ───▶ timeout    → DSH rejected（失败关闭）
//      └────dispose() ───────────▶ rejected（failure='disposed'）
//
// 三条不变量：
//   1. 幂等：同一个 id 再来一次 submit 返回既有账目，不再打控制面；终态的
//      settle 原样返回，**相反的决定不翻案**（与 packages/store/src/approvals.ts
//      的 decideApproval 同一条哲学：审批一旦落定就是事实）。
//   2. 失败关闭：建单失败、被 dispose、超时都不放行。
//   3. 副作用只在两个注入点上：`request`（落控制面）与 `wait`（等人）。
//      状态机本身不碰时钟、网络、定时器 API 的具体实现。

import type { ApprovalRequest, BridgeDecision, BridgeFailure, BridgeOutcome, BridgeState, DecisionActor } from './contract.ts'
import { BridgeError, isBridgeDecision, isTerminal, readApprovalRequest, toDshOutcome } from './contract.ts'

/** 交给 `wait` 的上下文：够它轮询控制面，也够它在桥被关掉时停下。 */
export interface WaitInput {
  request: ApprovalRequest
  approvalId: string | null
  deadlineAt: number | null
  /** 桥落定 / dispose 时 abort：轮询循环据此停手。 */
  signal: AbortSignal
}

/** 落控制面。返回控制面审批 id（`apr_…`），没有就返回 void。 */
export type CreateRemoteApproval = (
  request: ApprovalRequest,
) => Promise<{ approvalId?: string | null } | string | null | void>

/** 等一个决定。返回 null/undefined 表示"这一轮没等到"，请求保持 pending。 */
export type WaitRemoteDecision = (
  input: WaitInput,
) => Promise<BridgeDecision | null | undefined | void>

export interface ApprovalBridgeOptions {
  /** 建单；省略 = 纯外部驱动（由调用方自己 settle）。 */
  request?: CreateRemoteApproval
  /** 等决定；省略 = 纯外部驱动。 */
  wait?: WaitRemoteDecision
  /** 超过这个毫秒数没决定就落 timeout。省略 = 不超时。 */
  timeoutMs?: number
  now?: () => number
  /** 测试注入点：默认 setTimeout / clearTimeout。 */
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** 每次落定回调一次（审计/事件用）。抛异常不回滚状态。 */
  onSettled?: (outcome: BridgeOutcome) => void
}

export interface SettleOptions {
  at?: number
  by?: DecisionActor
  note?: string
  failure?: BridgeFailure | null
}

export interface ApprovalBridge {
  /** 提交一次审批；返回提交后的快照（可能已经是终态）。 */
  submit(input: unknown): Promise<BridgeOutcome>
  /** 落定。未终态才写；终态原样返回（幂等，不翻案）。 */
  settle(id: string, decision: BridgeDecision, options?: SettleOptions): BridgeOutcome
  /** 把到期的 pending 落成 timeout；返回本次真正落定的那些。 */
  expire(at?: number): BridgeOutcome[]
  /** 等到终态；已终态则立即返回。 */
  waitFor(id: string): Promise<BridgeOutcome>
  get(id: string): BridgeOutcome | null
  list(): BridgeOutcome[]
  pending(): BridgeOutcome[]
  /** 账目总数（含终态）。 */
  readonly size: number
  /** 关桥：pending 全部按 rejected 失败关闭，之后的 submit 抛 ALREADY_DISPOSED。 */
  dispose(): void
}

interface Deferred {
  promise: Promise<BridgeOutcome>
  resolve: (outcome: BridgeOutcome) => void
}

interface Entry {
  request: ApprovalRequest
  state: BridgeState
  decision: BridgeDecision | null
  failure: BridgeFailure | null
  approvalId: string | null
  deadlineAt: number | null
  decidedAt: number | null
  decidedBy: DecisionActor | null
  note: string | null
  deferred: Deferred | null
  controller: AbortController
  timer: unknown
}

const TIMEOUT_DISABLED = 0
/** setTimeout 的上限是 2^31-1 毫秒（≈24.8 天）；更长的截止时间分段等。 */
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * 造一台审批桥。
 *
 * ```ts
 * const bridge = createApprovalBridge({
 *   timeoutMs: 5 * 60_000,
 *   request: (req) => postInternalApproval(req),      // → { approvalId }
 *   wait: ({ approvalId, signal }) => pollApproval(approvalId, signal),
 * })
 * ```
 */
export function createApprovalBridge(options: ApprovalBridgeOptions = {}): ApprovalBridge {
  const timeoutMs = readTimeout(options.timeoutMs)
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const onSettled = options.onSettled
  const requestRemote = options.request
  const waitRemote = options.wait

  const entries = new Map<string, Entry>()
  let disposed = false

  function currentTime(): number {
    return now()
  }

  function snapshot(entry: Entry): BridgeOutcome {
    return Object.freeze({
      id: entry.request.id,
      request: Object.freeze({ ...entry.request }),
      state: entry.state,
      decision: entry.decision,
      dshOutcome: toDshOutcome(entry.decision),
      failure: entry.failure,
      approvalId: entry.approvalId,
      requestedAt: entry.request.requestedAt,
      deadlineAt: entry.deadlineAt,
      decidedAt: entry.decidedAt,
      decidedBy: entry.decidedBy,
      note: entry.note,
    })
  }

  function apply(entry: Entry, patch: Partial<Entry>): BridgeOutcome {
    Object.assign(entry, patch)
    if (entry.timer !== null && entry.timer !== undefined) {
      clearTimer(entry.timer)
      entry.timer = null
    }
    // 落定即让还在轮询的 wait 停手：一个请求只问一次。
    if (!entry.controller.signal.aborted) entry.controller.abort()

    const outcome = snapshot(entry)
    const deferred = entry.deferred
    entry.deferred = null
    if (deferred !== null) deferred.resolve(outcome)
    if (onSettled !== undefined) {
      try {
        onSettled(outcome)
      } catch {
        // 审计钩子不能改状态，也不能让调用方看到"没落定"。
      }
    }
    return outcome
  }

  function settle(id: string, decision: BridgeDecision, settleOptions: SettleOptions = {}): BridgeOutcome {
    if (!isBridgeDecision(decision)) {
      throw new BridgeError('INVALID_DECISION', `approval decision must be one of approved|rejected|timeout, got ${String(decision)}`)
    }
    const entry = entries.get(id)
    if (entry === undefined) throw new BridgeError('UNKNOWN_REQUEST', `unknown approval request ${id}`)
    // 终态是事实：同决定幂等，相反决定不翻案。
    if (isTerminal(entry.state)) return snapshot(entry)

    const by = settleOptions.by ?? (decision === 'timeout' ? 'timeout' : 'user')
    return apply(entry, {
      state: decision,
      decision,
      failure: settleOptions.failure ?? null,
      decidedAt: settleOptions.at ?? currentTime(),
      decidedBy: by,
      note: settleOptions.note ?? null,
    })
  }

  /**
   * 装定时器。分段而不是一次 setTimeout(deadline)：超过 2^31-1 毫秒会溢出成
   * 立刻触发（Node 会警告），而时钟跳变后也需要重新核对"到点了没有"。
   */
  function arm(entry: Entry): void {
    if (entry.deadlineAt === null) return
    const remaining = entry.deadlineAt - currentTime()
    if (remaining <= 0) {
      expire()
      return
    }
    entry.timer = setTimer(() => {
      entry.timer = null
      arm(entry)
    }, Math.min(remaining, MAX_TIMER_MS))
  }

  function expire(at: number = currentTime()): BridgeOutcome[] {
    const settled: BridgeOutcome[] = []
    for (const entry of entries.values()) {
      if (entry.state !== 'pending') continue
      if (entry.deadlineAt === null || entry.deadlineAt > at) continue
      // decidedAt 取 deadline（而不是"现在"）：同样的输入必须得到同样的账目。
      settled.push(
        settle(entry.request.id, 'timeout', {
          at: entry.deadlineAt,
          by: 'timeout',
          note: `no decision within ${timeoutMs}ms`,
        }),
      )
    }
    return settled
  }

  function submit(input: unknown): Promise<BridgeOutcome> {
    if (disposed) {
      return Promise.reject(new BridgeError('ALREADY_DISPOSED', 'approval bridge is disposed'))
    }
    const read = readApprovalRequest(input, currentTime())
    if (!read.ok) {
      const detail = read.errors.map((error) => `${error.field} ${error.message}`).join('; ')
      return Promise.reject(new BridgeError('INVALID_REQUEST', `invalid approval request: ${detail}`, read.errors))
    }
    const request = Object.freeze(read.request)

    const existing = entries.get(request.id)
    if (existing !== undefined) return Promise.resolve(snapshot(existing))

    const entry: Entry = {
      request,
      state: 'pending',
      decision: null,
      failure: null,
      approvalId: null,
      deadlineAt: timeoutMs > 0 ? request.requestedAt + timeoutMs : null,
      decidedAt: null,
      decidedBy: null,
      note: null,
      deferred: null,
      controller: new AbortController(),
      timer: null,
    }
    entries.set(request.id, entry)
    if (entry.deadlineAt !== null) arm(entry)

    return drive(entry)
  }

  async function drive(entry: Entry): Promise<BridgeOutcome> {
    if (requestRemote !== undefined) {
      try {
        const created = await requestRemote(entry.request)
        entry.approvalId = readApprovalId(created)
      } catch (err) {
        // 建单失败 = 通道坏了：失败关闭，但记成 failure 而不是"用户拒绝"。
        if (entry.state === 'pending') {
          apply(entry, {
            state: 'rejected',
            decision: 'rejected',
            failure: 'request_failed',
            decidedAt: currentTime(),
            decidedBy: 'bridge',
            note: `control-plane request failed: ${errorMessage(err)}`,
          })
        }
        return snapshot(entry)
      }
    }

    if (waitRemote !== undefined && entry.state === 'pending') {
      // 后台等：submit 立刻返回 pending，让调用方拿 id 去做展示。
      void waitThenSettle(entry)
    }
    return snapshot(entry)
  }

  async function waitThenSettle(entry: Entry): Promise<void> {
    try {
      const decision = await waitRemote!({
        request: entry.request,
        approvalId: entry.approvalId,
        deadlineAt: entry.deadlineAt,
        signal: entry.controller.signal,
      })
      if (decision === undefined || decision === null) {
        if (entry.state === 'pending') entry.note = 'wait returned no decision'
        return
      }
      if (!isBridgeDecision(decision)) {
        if (entry.state === 'pending') entry.note = `wait returned an unknown decision: ${String(decision)}`
        return
      }
      settle(entry.request.id, decision, { at: currentTime() })
    } catch (err) {
      // 轮询抖一下不该替用户回答：保持 pending，等下一轮或超时。
      if (entry.state === 'pending') entry.note = `wait failed: ${errorMessage(err)}`
    }
  }

  function waitFor(id: string): Promise<BridgeOutcome> {
    const entry = entries.get(id)
    if (entry === undefined) {
      return Promise.reject(new BridgeError('UNKNOWN_REQUEST', `unknown approval request ${id}`))
    }
    if (isTerminal(entry.state)) return Promise.resolve(snapshot(entry))
    if (entry.deferred === null) {
      let resolve: (outcome: BridgeOutcome) => void = () => {}
      const promise = new Promise<BridgeOutcome>((done) => {
        resolve = done
      })
      entry.deferred = { promise, resolve }
    }
    return entry.deferred.promise
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    for (const entry of entries.values()) {
      if (entry.state === 'pending') {
        settle(entry.request.id, 'rejected', {
          by: 'bridge',
          failure: 'disposed',
          note: 'approval bridge disposed',
        })
      }
    }
  }

  const bridge: ApprovalBridge = {
    submit,
    settle,
    expire,
    waitFor,
    get(id: string): BridgeOutcome | null {
      const entry = entries.get(id)
      return entry === undefined ? null : snapshot(entry)
    },
    list(): BridgeOutcome[] {
      return Array.from(entries.values(), snapshot)
    },
    pending(): BridgeOutcome[] {
      return Array.from(entries.values(), snapshot).filter((outcome) => outcome.state === 'pending')
    },
    get size(): number {
      return entries.size
    },
    dispose,
  }
  return Object.freeze(bridge)
}

function readTimeout(value: number | undefined): number {
  if (value === undefined) return TIMEOUT_DISABLED
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError('timeoutMs must be a positive finite number of milliseconds')
  }
  return Math.trunc(value)
}

function readApprovalId(created: { approvalId?: string | null } | string | null | void): string | null {
  if (typeof created === 'string') return created === '' ? null : created
  if (created === undefined || created === null) return null
  const id = created.approvalId
  return typeof id === 'string' && id !== '' ? id : null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
