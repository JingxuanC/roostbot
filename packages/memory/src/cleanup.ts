// 记忆清理计划（docs/design/memory.md §7–§9、§14；docs/build/wave2.md §A）。
//
// 复盘 routine 每天问一次：哪些 claim 已经被 falsifier 否证、又过了保留期，可以删？
// 本模块只算计划，不删数据：返回 { remove, keep } 的 id 列表，调用方按 remove 物理删除。
//
// 规则：
//   * 只清「被否证（falsifiedAt 存在）且 now − falsifiedAt > falsifiedOlderThanMs」的；
//   * status='retracted' 的一律 keep（用户/隐私撤回的条目不能被后台批量删除）；
//   * 最近 keepRecent 条（按 createdAt 降序，缺 createdAt 时按输入顺序靠后算更新）一律 keep；
//   * 其余（active / superseded / expired / 未否证 / 未过期）全部 keep。
//
// 纯函数：不读 DB、不看当前时间，now 由调用方传入。

import { ClaimError } from './claims.ts'

export type CleanupStatus = 'active' | 'superseded' | 'retracted' | 'expired'

export interface CleanupClaim {
  id: string
  status?: CleanupStatus
  /** 被复盘判定为违反 falsifier 的时刻（epoch ms）；null/缺省 = 没被否证。 */
  falsifiedAt?: number | null
  /** 用于「最近 N 条」判断；缺省按 0 处理（等价于按输入顺序）。 */
  createdAt?: number | null
}

export interface PlanCleanupInput {
  claims: readonly CleanupClaim[]
  /** epoch 毫秒。 */
  now: number
  /** 否证后的保留期；超过才清。默认 30 天。 */
  falsifiedOlderThanMs?: number
  /** 最近 N 条不动。默认 20。 */
  keepRecent?: number
}

export interface CleanupPlan {
  /** 可删除的 id，保持输入顺序，已去重。 */
  remove: string[]
  /** 保留的 id，保持输入顺序，已去重。 */
  keep: string[]
}

/** 否证后的默认保留期：30 天，与 memory.md §6 的新鲜度半衰期同量级。 */
export const DEFAULT_FALSIFIED_RETENTION_MS = 30 * 86_400_000
/** 默认至少给最近 20 条留保护带，防一次复盘把刚写的结论清掉。 */
export const DEFAULT_CLEANUP_KEEP_RECENT = 20

/** 计算清理计划；remove 与 keep 无交集，且覆盖每个合法输入 id 恰好一次。纯函数。 */
export function planCleanup(input: PlanCleanupInput): CleanupPlan {
  if (input === null || typeof input !== 'object') {
    throw new ClaimError('cleanup input must be an object')
  }
  if (!Array.isArray(input.claims)) {
    throw new ClaimError('cleanup.claims must be an array')
  }
  const now = readAt(input.now, 'cleanup.now')
  const retention = readCount(
    input.falsifiedOlderThanMs,
    'cleanup.falsifiedOlderThanMs',
    DEFAULT_FALSIFIED_RETENTION_MS,
  )
  const keepRecent = readCount(input.keepRecent, 'cleanup.keepRecent', DEFAULT_CLEANUP_KEEP_RECENT)

  // 同一个 id 以第一次出现为准（后面重复的行不参与“最近 N 条”的判断）。
  const entries: CleanupEntry[] = []
  const seen = new Set<string>()
  for (let index = 0; index < input.claims.length; index += 1) {
    const entry = readClaim(input.claims[index], index)
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }

  // 最近 keepRecent 条：按 createdAt 降序，同一时刻按输入下标降序（靠后的视为更新）。
  const protectedIndexes = new Set<number>(
    entries
      .map((entry, index) => ({ index, createdAt: entry.createdAt }))
      .sort((a, b) => b.createdAt - a.createdAt || b.index - a.index)
      .slice(0, keepRecent)
      .map((entry) => entry.index),
  )

  const remove: string[] = []
  const keep: string[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const expired =
      entry.falsifiedAt !== null && now - entry.falsifiedAt > retention && entry.status !== 'retracted'
    const removable = expired && !protectedIndexes.has(index)
    if (removable) remove.push(entry.id)
    else keep.push(entry.id)
  }

  return { remove, keep }
}

interface CleanupEntry {
  id: string
  status: CleanupStatus
  falsifiedAt: number | null
  createdAt: number
}

function readClaim(value: unknown, index: number): CleanupEntry {
  const label = `cleanup.claims[${index}]`
  if (value === null || typeof value !== 'object') {
    throw new ClaimError(`${label} must be an object`)
  }
  const record = value as Record<string, unknown>
  const id = record.id
  if (typeof id !== 'string' || id.trim() === '') {
    throw new ClaimError(`${label}.id must be a non-empty string`)
  }
  const status = record.status
  if (status !== undefined && status !== null && typeof status !== 'string') {
    throw new ClaimError(`${label}.status must be a string`)
  }
  return {
    id: id.trim(),
    status: (status === undefined || status === null ? 'active' : status) as CleanupStatus,
    falsifiedAt: optionalAt(record.falsifiedAt, `${label}.falsifiedAt`),
    createdAt: optionalAt(record.createdAt, `${label}.createdAt`) ?? 0,
  }
}

function optionalAt(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ClaimError(`${label} must be an integer >= 0 or null`)
  }
  return value
}

function readAt(value: unknown, label: string): number {
  if (value === undefined || value === null) {
    throw new ClaimError(`${label} is required`)
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ClaimError(`${label} must be an integer >= 0`)
  }
  return value
}

function readCount(value: unknown, label: string, fallback: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ClaimError(`${label} must be an integer >= 0`)
  }
  return value
}
