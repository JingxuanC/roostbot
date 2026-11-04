// cron 与简化形态的解析（不碰时区）。
// 由 cron.ts 调用；对外只通过 cron.ts 的 export * 暴露。

export class CronError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CronError'
  }
}

export interface FieldSet {
  values: number[]
  /** 原字段不是星号（含星号斜杠步长）即受限；日/周的并集规则依赖它。 */
  restricted: boolean
}

export interface CronLikeSpec {
  kind: 'cron'
  minutes: FieldSet
  hours: FieldSet
  daysOfMonth: FieldSet
  months: FieldSet
  daysOfWeek: FieldSet
}

export interface EverySpec {
  kind: 'every'
  seconds: number
}

export type ParsedSpec = CronLikeSpec | EverySpec

const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

export function range(start: number, end: number): number[] {
  const values: number[] = []
  for (let value = start; value <= end; value += 1) values.push(value)
  return values
}

function parseNumber(text: string, label: string): number {
  if (!/^\d+$/.test(text)) throw new CronError(`${label} must be a number, got "${text}"`)
  return Number(text)
}

function parseField(
  text: string,
  min: number,
  max: number,
  label: string,
  normalize?: (value: number) => number,
): FieldSet {
  if (text.trim() === '') throw new CronError(`${label} field is empty`)
  const restricted = text !== '*'
  const values = new Set<number>()
  for (const item of text.split(',')) {
    if (item === '') throw new CronError(`${label} has an empty list item`)
    const slash = item.indexOf('/')
    const rangeText = slash === -1 ? item : item.slice(0, slash)
    let step = 1
    if (slash !== -1) {
      const stepText = item.slice(slash + 1)
      if (!/^\d+$/.test(stepText)) throw new CronError(`${label} step must be a number, got "${stepText}"`)
      step = Number(stepText)
      if (step < 1) throw new CronError(`${label} step must be >= 1`)
    }

    let start: number
    let end: number
    if (rangeText === '*') {
      start = min
      end = max
    } else if (rangeText.includes('-')) {
      const [a, b, ...rest] = rangeText.split('-')
      if (rest.length > 0 || a === '' || b === '') {
        throw new CronError(`${label} has a malformed range "${rangeText}"`)
      }
      start = parseNumber(a!, label)
      end = parseNumber(b!, label)
      if (start > end) throw new CronError(`${label} range start must be <= end in "${rangeText}"`)
    } else {
      start = parseNumber(rangeText, label)
      // `a/n` 约定为 a..max，与标准 cron 一致。
      end = slash === -1 ? start : max
    }
    if (start < min || end > max) {
      throw new CronError(`${label} value out of range ${min}-${max}: "${item}"`)
    }
    for (let value = start; value <= end; value += step) {
      values.add(normalize === undefined ? value : normalize(value))
    }
  }
  if (values.size === 0) throw new CronError(`${label} does not select any value`)
  return { values: [...values].sort((a, b) => a - b), restricted }
}

function parseClock(text: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (match === null) throw new CronError(`time must look like HH:MM, got "${text}"`)
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) throw new CronError(`time out of range: "${text}"`)
  return { hour, minute }
}

function parseWeekday(text: string): number {
  const lowered = text.toLowerCase()
  if (/^\d+$/.test(lowered)) {
    const value = Number(lowered)
    if (value > 7) throw new CronError(`weekday out of range 0-7: "${text}"`)
    return value === 7 ? 0 : value
  }
  const named = WEEKDAY_NAMES[lowered]
  if (named === undefined) throw new CronError(`unknown weekday "${text}"`)
  return named
}

export function parseSpec(expression: string): ParsedSpec {
  const text = expression.trim().toLowerCase()
  if (text === '') throw new CronError('schedule expression is empty')

  if (text === 'every' || text.startsWith('every ')) {
    const value = text.slice('every'.length).trim()
    if (!/^\d+$/.test(value)) {
      throw new CronError(`every needs a positive integer number of seconds, got "${value}"`)
    }
    const seconds = Number(value)
    if (seconds < 1) throw new CronError('every seconds must be >= 1')
    return { kind: 'every', seconds }
  }

  const daily = /^daily\s+(\S+)$/.exec(text)
  if (daily !== null) {
    const clock = parseClock(daily[1]!)
    return {
      kind: 'cron',
      minutes: { values: [clock.minute], restricted: false },
      hours: { values: [clock.hour], restricted: false },
      daysOfMonth: { values: range(1, 31), restricted: false },
      months: { values: range(1, 12), restricted: false },
      daysOfWeek: { values: range(0, 6), restricted: false },
    }
  }

  const weekly = /^weekly\s+(\S+)\s+(\S+)$/.exec(text)
  if (weekly !== null) {
    const clock = parseClock(weekly[2]!)
    const days = new Set<number>()
    for (const name of weekly[1]!.split(',')) {
      if (name === '') throw new CronError('weekly has an empty day')
      days.add(parseWeekday(name))
    }
    return {
      kind: 'cron',
      minutes: { values: [clock.minute], restricted: false },
      hours: { values: [clock.hour], restricted: false },
      daysOfMonth: { values: range(1, 31), restricted: false },
      months: { values: range(1, 12), restricted: false },
      daysOfWeek: { values: [...days].sort((a, b) => a - b), restricted: true },
    }
  }

  const fields = text.split(/\s+/)
  if (fields.length !== 5) {
    throw new CronError(
      'schedule expression must be 5 cron fields or one of "daily HH:MM", "weekly mon,wed HH:MM", "every <seconds>"',
    )
  }
  return {
    kind: 'cron',
    minutes: parseField(fields[0]!, 0, 59, 'minute'),
    hours: parseField(fields[1]!, 0, 23, 'hour'),
    daysOfMonth: parseField(fields[2]!, 1, 31, 'day-of-month'),
    months: parseField(fields[3]!, 1, 12, 'month'),
    daysOfWeek: parseField(fields[4]!, 0, 7, 'day-of-week', (value) => (value === 7 ? 0 : value)),
  }
}

/** 日/周同时受限时取并集，否则取交集（标准 cron 语义）。 */
export function matchesDay(spec: CronLikeSpec, year: number, month: number, day: number): boolean {
  if (!spec.months.values.includes(month)) return false
  const domOk = spec.daysOfMonth.values.includes(day)
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const dowOk = spec.daysOfWeek.values.includes(weekday)
  if (spec.daysOfMonth.restricted && spec.daysOfWeek.restricted) return domOk || dowOk
  if (spec.daysOfMonth.restricted) return domOk
  if (spec.daysOfWeek.restricted) return dowOk
  return true
}
