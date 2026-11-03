import type { Activation } from './types.ts'

/** 幂等键的唯一来源。clock 必须包含原定的时刻，不是“现在”。 */
export function idempotencyKey(activation: Pick<Activation, 'idem'>): string {
  return activation.idem.trim()
}

/**
 * 同一个 routine 的同一个计划时刻只算一次。
 * 补跑时 scheduledFor 仍是原定时间，所以补跑与准点跑会撞键 —— 这是故意的。
 */
export function clockIdem(routineId: string, scheduledFor: Date): string {
  return `${routineId}@${scheduledFor.toISOString()}`
}

/** 一次 Run 是否已经晚了太久，只能记 missed。 */
export function isMissed(scheduledFor: number, now: number, catchUpMs: number): boolean {
  return now - scheduledFor > catchUpMs
}
