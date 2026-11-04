// 时间计算：5 段 cron + 三种简化形态，按 IANA 时区求下一次触发的 UTC 毫秒。
// 设计见 docs/design/scheduling.md §4；不引依赖，时区换算只用 Intl.DateTimeFormat。
//
// 支持：
//   * 5 段 cron（分 时 日 月 周）：`*`、`n`、`a-b`、`*/n`、`a-b/n`、`a/n`、逗号列表；
//     周 0/7 都表示周日；日与周同时受限时按标准 cron 取并集。
//   * `daily 09:00`
//   * `weekly mon,wed 09:00`
//   * `every 3600`（秒）
//
// DST（§4）：
//   * 跳过的本地时刻不存在 → 不生成触发点（2:30 在春季跳变当天被跳过）；
//   * 重复的本地时刻只取第一次（秋季回拨的 1:30 只跑一次）。
//
// 非法表达式与未知时区抛 CronError，调用方按 INVALID_INPUT 处理。

import { CronError, matchesDay, parseSpec } from './cron-parse.ts'

export { CronError } from './cron-parse.ts'

const DAY_MS = 86_400_000
/** 最远往后找 8 年；处理 2 月 31 日这类永远不可能满足的表达式。 */
const MAX_LOOKAHEAD_DAYS = 366 * 8

const formatterCache = new Map<string, Intl.DateTimeFormat>()
const offsetCache = new Map<string, number>()

function timeZoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone)
  if (cached !== undefined) return cached
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch (err) {
    throw new CronError(
      `unknown time zone "${timeZone}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  formatterCache.set(timeZone, formatter)
  return formatter
}

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function localParts(timeZone: string, ms: number): LocalParts {
  const parts = timeZoneFormatter(timeZone).formatToParts(new Date(ms))
  const result: LocalParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 }
  for (const part of parts) {
    switch (part.type) {
      case 'year':
        result.year = Number(part.value)
        break
      case 'month':
        result.month = Number(part.value)
        break
      case 'day':
        result.day = Number(part.value)
        break
      case 'hour':
        result.hour = Number(part.value) % 24
        break
      case 'minute':
        result.minute = Number(part.value)
        break
      case 'second':
        result.second = Number(part.value)
        break
      default:
        break
    }
  }
  return result
}

/** 时区在某一 UTC 时刻的偏移（毫秒）：localAsUTC - utc。 */
function offsetAt(timeZone: string, ms: number): number {
  const key = `${timeZone}:${Math.floor(ms / 60_000)}`
  const cached = offsetCache.get(key)
  if (cached !== undefined) return cached
  const parts = localParts(timeZone, ms)
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  const offset = localAsUtc - Math.floor(ms / 1000) * 1000
  if (offsetCache.size > 2000) offsetCache.clear()
  offsetCache.set(key, offset)
  return offset
}

/**
 * 本地墙钟时间 → 可能的 UTC 时刻。
 * 返回最早一个匹配的 UTC 毫秒；不存在的本地时刻（春季跳变）返回 null。
 * 回拨时的重复时刻会得到两个候选，这里只留更早的（第一次）。
 */
function resolveLocal(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number | null {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  const offsets = new Set<number>([
    offsetAt(timeZone, guess),
    offsetAt(timeZone, guess - 26 * 3_600_000),
    offsetAt(timeZone, guess + 26 * 3_600_000),
  ])
  let best: number | null = null
  for (const offset of offsets) {
    const candidate = guess - offset
    const parts = localParts(timeZone, candidate)
    if (
      parts.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.hour === hour &&
      parts.minute === minute &&
      parts.second === 0
    ) {
      if (best === null || candidate < best) best = candidate
    }
  }
  return best
}

/**
 * 求 afterMs 之后的下一次触发时刻（UTC 毫秒，严格大于 afterMs）。
 * 非法表达式或未知时区抛 CronError。
 */
export function nextRunAt(expression: string, timeZone: string, afterMs: number): number {
  if (!Number.isFinite(afterMs)) throw new CronError('afterMs must be a finite number')
  const spec = parseSpec(expression)
  // 即使 every 不用时区，也要校验：调用方存下来的 timezone 必须可解析。
  timeZoneFormatter(timeZone)

  if (spec.kind === 'every') return afterMs + spec.seconds * 1000

  const start = localParts(timeZone, afterMs)
  const startDay = Date.UTC(start.year, start.month - 1, start.day)
  for (let offset = 0; offset <= MAX_LOOKAHEAD_DAYS; offset += 1) {
    const date = new Date(startDay + offset * DAY_MS)
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1
    const day = date.getUTCDate()
    if (!matchesDay(spec, year, month, day)) continue
    for (const hour of spec.hours.values) {
      for (const minute of spec.minutes.values) {
        const instant = resolveLocal(timeZone, year, month, day, hour, minute)
        if (instant !== null && instant > afterMs) return instant
      }
    }
  }
  throw new CronError(
    `schedule "${expression}" has no matching time within ${MAX_LOOKAHEAD_DAYS} days from ${new Date(afterMs).toISOString()}`,
  )
}

/** 校验表达式与时区，返回 nextRunAt；API 建/改 schedule 前用。 */
export function validateSchedule(expression: string, timeZone: string, afterMs: number): number {
  return nextRunAt(expression, timeZone, afterMs)
}
