// 控制面计量采集（budget.md §2、§6「控制面采样」）。
//
// 两个计量单位、两种聚合口径：
//   * container_seconds 是累计量：同一 workspace 同一天的多段运行相加；
//   * storage_bytes 是 gauge：同一 workspace 同一天取最大值，不求和（budget.md §10）。
//
// 纯函数：不读 DB、不看时钟；`now` 由调用方注入。幂等键
// `meter:<workspace>:<YYYY-MM-DD>:<kind>`（UTC 日，与 store 的周期口径一致），
// 同一天重复上报会被 store 的 usage idem 去重。

export const METER_KINDS = ['container_seconds', 'storage_bytes'] as const
export type MeterKind = (typeof METER_KINDS)[number]

export interface ContainerSecondsInput {
  /** 容器启动时刻（epoch ms）。 */
  startedAt: number
  /** 停止时刻；未停止时按 `now` 计。 */
  stoppedAt?: number | null
  now: number
}

export interface RuntimeSample {
  workspaceId: string
  startedAt: number
  /** 未停止 = 仍在运行，按 `now` 截断。 */
  stoppedAt?: number | null
}

export interface VolumeSample {
  workspaceId: string
  /** 卷大小（字节）；也接受 sizeBytes / storageBytes 别名。 */
  bytes?: number
  sizeBytes?: number
  storageBytes?: number
  /** 采样时刻；默认 `now`。 */
  at?: number
}

export interface PlanMeteringInput {
  runtimes?: readonly RuntimeSample[]
  volumes?: readonly VolumeSample[]
  now: number
}

export interface MeterEntry {
  kind: MeterKind
  /** container_seconds 为秒（可含小数）；storage_bytes 为整数字节。 */
  amount: number
  workspaceId: string
  idem: string
  /** 该条目所属采样时刻（epoch ms）。 */
  at: number
}

/** 最多保留三位小数，消掉浮点尾巴（1500ms → 1.5，60000ms → 60）。 */
function seconds(ms: number): number {
  return Math.round(ms) / 1000
}

/**
 * 容器秒：`(stoppedAt ?? now - startedAt) / 1000`，负数 clamp 到 0。
 * 非有限输入按 0 处理（宁少记，不写 NaN 进账）。
 */
export function containerSeconds(input: ContainerSecondsInput): number {
  const start = input.startedAt
  const end = input.stoppedAt ?? input.now
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  const delta = end - start
  return delta <= 0 ? 0 : seconds(delta)
}

/** UTC 日键，与 budget.md 的周期口径（UTC 0 点）一致。 */
export function meterDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/** `meter:<workspace>:<YYYY-MM-DD>:<kind>`。 */
export function meterIdem(workspaceId: string, kind: MeterKind, at: number): string {
  return `meter:${workspaceId}:${meterDay(at)}:${kind}`
}

interface Bucket {
  kind: MeterKind
  workspaceId: string
  day: string
  at: number
  /** container_seconds 求和；storage_bytes 取最大值。 */
  amount: number
}

function bucketKey(workspaceId: string, kind: MeterKind, day: string): string {
  return `${workspaceId}\u0000${kind}\u0000${day}`
}

function readWorkspaceId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id === '' ? null : id
}

function readEpoch(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * 把 runtime / volume 采样折成待记账条目：每个 workspace 每个 UTC 日每种 kind 一条。
 *
 * - 同一 workspace 同一天的多段运行：`container_seconds` 求和；
 * - 同一 workspace 同一天的多份卷采样：`storage_bytes` 取最大值，并四舍五入到整数；
 * - 非法 workspaceId / 非有限时刻的采样直接跳过（不写 NaN）；
 * - `at` 取该桶内最晚的采样时刻，保证幂等键的日期与 `at` 同一天。
 *
 * 输出按 workspaceId → kind → at 排序，方便测试与对账。
 */
export function planMetering(input: PlanMeteringInput): MeterEntry[] {
  const now = input.now
  const buckets = new Map<string, Bucket>()

  if (Number.isFinite(now)) {
    for (const runtime of input.runtimes ?? []) {
      const workspaceId = readWorkspaceId(runtime.workspaceId)
      if (workspaceId === null) continue
      const stoppedAt = readEpoch(runtime.stoppedAt)
      const running = runtime.stoppedAt === undefined || runtime.stoppedAt === null
      const at = running ? now : stoppedAt
      if (at === null) continue
      const day = meterDay(at)
      const key = bucketKey(workspaceId, 'container_seconds', day)
      const current = buckets.get(key)
      const amount = containerSeconds({
        startedAt: runtime.startedAt,
        stoppedAt: runtime.stoppedAt ?? null,
        now,
      })
      if (current === undefined) {
        buckets.set(key, { kind: 'container_seconds', workspaceId, day, at, amount })
      } else {
        current.amount += amount
        current.at = Math.max(current.at, at)
      }
    }

    for (const volume of input.volumes ?? []) {
      const workspaceId = readWorkspaceId(volume.workspaceId)
      if (workspaceId === null) continue
      const rawBytes = volume.bytes ?? volume.sizeBytes ?? volume.storageBytes
      if (typeof rawBytes !== 'number' || !Number.isFinite(rawBytes)) continue
      const at = readEpoch(volume.at) ?? now
      if (!Number.isFinite(at)) continue
      const day = meterDay(at)
      const key = bucketKey(workspaceId, 'storage_bytes', day)
      const bytes = Math.round(Math.max(0, rawBytes))
      const current = buckets.get(key)
      if (current === undefined) {
        buckets.set(key, { kind: 'storage_bytes', workspaceId, day, at, amount: bytes })
      } else {
        current.amount = Math.max(current.amount, bytes)
        current.at = Math.max(current.at, at)
      }
    }
  }

  return [...buckets.values()]
    .map((bucket) => ({
      kind: bucket.kind,
      // 容器秒保留小数；存储已取整，这里再兜一次底。
      amount: bucket.kind === 'container_seconds' ? bucket.amount : Math.round(bucket.amount),
      workspaceId: bucket.workspaceId,
      idem: meterIdem(bucket.workspaceId, bucket.kind, bucket.at),
      at: bucket.at,
    }))
    .sort(
      (left, right) =>
        left.workspaceId.localeCompare(right.workspaceId) ||
        left.kind.localeCompare(right.kind) ||
        left.at - right.at,
    )
}
