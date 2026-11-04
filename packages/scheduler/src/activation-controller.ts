// 激活判定：把 clock / event / repair / missed 收敛成一个纯函数。
// 设计见 docs/design/scheduling.md §2（统一原语）、§7（幂等）、§8（错过与追赶）。
//
// 这个文件不读 DB、不推进 next_run_at、不创建 activation：
//   * 输入是一次 tick 看到的 routine 快照；输出是「该做什么 + 为什么 + 幂等键」；
//   * 落库与推进仍由 store/src/schedules.ts 负责（本批不改它），Lead 在 tick 循环里调用。
//
// 判定顺序（先到先得，组合输入时按这个顺序）：
//   1. enabled === false            → skip(disabled)
//   2. lastRunAt 有值且无终态标记     → repair(interrupted)
//   3. clock 已晚于 catchUpMs        → missed
//   4. signals 非空                  → run(event)
//   5. clock 到点且未超窗口           → run(clock)
//   6. 其余                          → skip(not_due / not_scheduled)
//
// repair 先于 missed：上一轮没留下终态就跑新的一轮，会把「中断」永久掩盖。
// missed 先于 event：错过本身要留收据；事件靠 event idem 去重，下一 tick 仍可处理。

import { clockIdem } from './activation.ts'
import { CATCH_UP_MS } from './constants.ts'
import { isTerminal } from './types.ts'
import type { RunStatus } from './types.ts'

/** 一次判定给出的动作；与 Run 的状态转换一一对应。 */
export type ActivationAction = 'run' | 'skip' | 'repair' | 'missed'

/**
 * 机器可读的判定原因。调用方可以按它分支/记指标；
 * 人类可读的解释不要塞进这里，改 reason 会破坏既有调用方。
 */
export type ActivationReason =
  | 'routine.disabled'
  | 'routine.not_scheduled'
  | 'routine.not_due'
  | 'run.interrupted'
  | 'clock.missed'
  | 'clock.due'
  | 'event.signal'

/**
 * decideActivation 看到的 routine 快照。
 * 形状参考 types.ts 的 Run/Activation；同时兼容 store 里 Schedule 的字段名
 * （routineId / catchUpMs / nextRunAt），方便 Lead 直接传。
 */
export interface RoutineShape {
  /** routine 标识；store 的 Schedule 用 routineId，两个都接受。 */
  id?: string
  routineId?: string
  /** false 表示已停用；缺省视为启用。 */
  enabled?: boolean
  /** 下一次计划触发的 UTC 毫秒；补跑时仍应是原定时间。 */
  nextRunAt?: number
  /** 与 nextRunAt 同义的别名（有的调用方按 scheduledFor 命名）。 */
  scheduledFor?: number
  /**
   * 上一轮 Run 的终态标记之一：completed/failed/missed/skipped。
   * 缺省 = 没有终态标记，配合 lastRunAt 触发 repair。
   */
  lastRunStatus?: RunStatus | null
  /** 另一形式的终态标记：上一轮 Run 的结束时间。有值即视为已结束。 */
  lastRunFinishedAt?: number | null
  /** routine 自己的追赶窗口；参数 catchUpMs 优先，其次这里，最后用 §6 的 12 小时。 */
  catchUpMs?: number
}

/** 外部事件信号；字符串等价于 { id }。 */
export type ActivationSignalInput = string | { id: string; at?: number }

export interface ActivationSignal {
  id: string
  at?: number
}

export interface DecideActivationInput {
  routine: RoutineShape
  /** 本次 tick 的 UTC 毫秒。 */
  now: number
  /** 上一轮 Run 的开始/活动时刻；null/undefined 表示没有未结束的上一轮。 */
  lastRunAt?: number | null
  /** 错过追赶窗口；缺省依次回落到 routine.catchUpMs、CATCH_UP_MS（12h）。 */
  catchUpMs?: number
  /** 已按到达顺序排好、且调用方尚未处理的外部信号。 */
  signals?: readonly ActivationSignalInput[]
}

export interface ActivationDecision {
  action: ActivationAction
  reason: ActivationReason
  /** 落库唯一键；没有可识别的计划时刻时为 ''。 */
  idem: string
}

/** event 的幂等键：同一 routine 的同一个信号只算一次。 */
export function eventIdem(routineId: string, signalId: string): string {
  return `event:${routineId}:${signalId}`
}

/** repair 的幂等键：同一个中断现场反复 tick 也只补一次。 */
export function repairIdem(routineId: string, lastRunAt: number): string {
  return `repair:${routineId}@${new Date(lastRunAt).toISOString()}`
}

/**
 * 判定一次 routine 该做什么。纯函数：同样输入永远得到同样输出（含 idem）。
 * 非法输入抛 TypeError，而不是猜一个动作。
 */
export function decideActivation(input: DecideActivationInput): ActivationDecision {
  if (input === null || typeof input !== 'object') throw new TypeError('decideActivation input must be an object')

  const { routine } = input
  if (routine === null || typeof routine !== 'object') throw new TypeError('routine must be an object')

  const now = input.now
  assertFinite('now', now)

  const routineId = readRoutineId(routine)
  const scheduledFor = readScheduledFor(routine)
  const catchUpMs = readCatchUpMs(input.catchUpMs, routine.catchUpMs)
  const plannedIdem = scheduledFor === null ? '' : clockIdem(routineId, new Date(scheduledFor))

  // 1. 停用的 routine 什么都不做，但把计划时刻的键带出去，便于留收据。
  if (routine.enabled === false) {
    return { action: 'skip', reason: 'routine.disabled', idem: plannedIdem }
  }

  // 2. 上一轮 Run 没有终态标记：先修，不新开一轮。
  const lastRunAt = input.lastRunAt
  if (lastRunAt !== undefined && lastRunAt !== null) {
    assertFinite('lastRunAt', lastRunAt)
    if (!hasTerminalMarker(routine)) {
      return { action: 'repair', reason: 'run.interrupted', idem: repairIdem(routineId, lastRunAt) }
    }
  }

  // 3. clock 已晚于追赶窗口：记 missed（scheduledFor 仍是原定时间）。
  if (scheduledFor !== null && now - scheduledFor > catchUpMs) {
    return { action: 'missed', reason: 'clock.missed', idem: plannedIdem }
  }

  // 4. 外部信号：按到达顺序取第一条，调用方负责过滤已处理过的信号。
  const signal = firstSignal(input.signals)
  if (signal !== null) {
    return { action: 'run', reason: 'event.signal', idem: eventIdem(routineId, signal.id) }
  }

  // 5. clock 到点（含刚好到点）。
  if (scheduledFor === null) {
    return { action: 'skip', reason: 'routine.not_scheduled', idem: '' }
  }
  if (now < scheduledFor) {
    return { action: 'skip', reason: 'routine.not_due', idem: plannedIdem }
  }
  return { action: 'run', reason: 'clock.due', idem: plannedIdem }
}

// ---- 内部 --------------------------------------------------------------------

function assertFinite(name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`)
  }
}

function readRoutineId(routine: RoutineShape): string {
  const raw = typeof routine.id === 'string' ? routine.id : routine.routineId
  const id = typeof raw === 'string' ? raw.trim() : ''
  if (id === '') throw new TypeError('routine.id must be a non-empty string')
  return id
}

function readScheduledFor(routine: RoutineShape): number | null {
  const raw = routine.nextRunAt ?? routine.scheduledFor
  if (raw === undefined || raw === null) return null
  assertFinite('routine.nextRunAt', raw)
  return raw
}

function readCatchUpMs(explicit: number | undefined, fromRoutine: number | undefined): number {
  const raw = explicit ?? fromRoutine ?? CATCH_UP_MS
  assertFinite('catchUpMs', raw)
  if (raw < 0) throw new TypeError('catchUpMs must be >= 0')
  return raw
}

/** 有终态标记才算上一轮正常结束；status 缺失或非终态都按「没结束」处理。 */
function hasTerminalMarker(routine: RoutineShape): boolean {
  if (routine.lastRunFinishedAt !== undefined && routine.lastRunFinishedAt !== null) {
    assertFinite('routine.lastRunFinishedAt', routine.lastRunFinishedAt)
    return true
  }
  const status = routine.lastRunStatus
  return status !== undefined && status !== null && isTerminal(status)
}

function firstSignal(signals: readonly ActivationSignalInput[] | undefined): ActivationSignal | null {
  if (signals === undefined || signals === null) return null
  if (!Array.isArray(signals)) throw new TypeError('signals must be an array')
  if (signals.length === 0) return null
  return normalizeSignal(signals[0], 0)
}

function normalizeSignal(input: ActivationSignalInput, index: number): ActivationSignal {
  if (typeof input === 'string') {
    const id = input.trim()
    if (id === '') throw new TypeError(`signals[${index}] id must be a non-empty string`)
    return { id }
  }
  if (input === null || typeof input !== 'object') {
    throw new TypeError(`signals[${index}] must be a string or { id }`)
  }
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  if (id === '') throw new TypeError(`signals[${index}].id must be a non-empty string`)
  if (input.at === undefined) return { id }
  assertFinite(`signals[${index}].at`, input.at)
  return { id, at: input.at }
}
