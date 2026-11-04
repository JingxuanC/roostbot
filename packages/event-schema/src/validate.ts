// 纯校验：不引依赖、不抛异常。错误信息路径固定为 `$` / `$.field`，便于测试与 CLI 展示。

import {
  EVENT_DOMAINS,
  EVENT_KINDS_BY_DOMAIN,
  isEventDomain,
  isEventKind,
  type EventDomain,
  type EventEnvelope,
} from './types.ts'

export type EventValidation =
  | { ok: true; event: EventEnvelope }
  | { ok: false; errors: string[] }

const EVENT_FIELDS = new Set([
  'id',
  'seq',
  'at',
  'domain',
  'kind',
  'actor',
  'subject',
  'audience',
  'parent',
  'idem',
  'trace',
  'payload',
  'v',
])

const TRACE_STRING_KEYS = ['run', 'turn', 'assignment'] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isIntegerAtLeast(value: unknown, minimum: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum
}

/**
 * 校验一条事件信封。
 *
 * 必填：id、seq、at、domain、kind、v。
 * 可选：actor、subject、audience、parent、idem、trace、payload（缺省归一为 {}）。
 * 未知顶层字段直接报错，避免拼错 `payload` 这类错误静默落库。
 */
export function validateEvent(value: unknown): EventValidation {
  if (!isPlainObject(value)) return { ok: false, errors: ['$: expected an object'] }

  const errors: string[] = []

  for (const key of Object.keys(value)) {
    if (!EVENT_FIELDS.has(key)) errors.push(`$: unknown field "${key}"`)
  }

  if (!isNonEmptyString(value.id)) errors.push('$.id: expected a non-empty string')
  if (!isIntegerAtLeast(value.seq, 1)) errors.push('$.seq: expected an integer >= 1')

  if (!isNonEmptyString(value.at)) {
    errors.push('$.at: expected a non-empty date-time string')
  } else if (Number.isNaN(Date.parse(value.at))) {
    errors.push('$.at: expected a parseable date-time')
  }

  const domain = value.domain
  const domainValid = isEventDomain(domain)
  if (typeof domain !== 'string') {
    errors.push('$.domain: expected a string')
  } else if (!domainValid) {
    errors.push(`$.domain: unknown domain "${domain}" (expected one of ${EVENT_DOMAINS.join(', ')})`)
  }

  const kind = value.kind
  if (typeof kind !== 'string') {
    errors.push('$.kind: expected a string')
  } else if (!isEventKind(kind)) {
    errors.push(`$.kind: unknown kind "${kind}"`)
  } else if (domainValid) {
    const allowed: readonly string[] = EVENT_KINDS_BY_DOMAIN[domain as EventDomain]
    if (!allowed.includes(kind)) {
      errors.push(`$.kind: "${kind}" does not belong to domain "${domain}"`)
    }
  }

  if (value.v !== 1) errors.push('$.v: expected 1')

  validateActor(value.actor, '$.actor', errors)
  validateActor(value.subject, '$.subject', errors)
  validateAudience(value.audience, errors)

  if (value.parent !== undefined && value.parent !== null && !isIntegerAtLeast(value.parent, 1)) {
    errors.push('$.parent: expected an integer >= 1')
  }
  if (value.idem !== undefined && value.idem !== null && !isNonEmptyString(value.idem)) {
    errors.push('$.idem: expected a non-empty string')
  }

  validateTrace(value.trace, errors)

  if (value.payload !== undefined && !isPlainObject(value.payload)) {
    errors.push('$.payload: expected an object')
  }

  if (errors.length > 0) return { ok: false, errors }

  const event: EventEnvelope = {
    ...(value as unknown as EventEnvelope),
    payload: (value.payload as Record<string, unknown> | undefined) ?? {},
  }
  return { ok: true, event }
}

function validateActor(value: unknown, path: string, errors: string[]): void {
  if (value === undefined || value === null) return
  if (!isPlainObject(value)) {
    errors.push(`${path}: expected an object`)
    return
  }
  if (!isNonEmptyString(value.kind)) errors.push(`${path}.kind: expected a non-empty string`)
  if (!isNonEmptyString(value.id)) errors.push(`${path}.id: expected a non-empty string`)
}

function validateAudience(value: unknown, errors: string[]): void {
  if (value === undefined || value === null) return
  if (typeof value === 'string' && (value === 'team' || /^(room|member):\S+$/.test(value))) return
  errors.push('$.audience: expected "team", "room:<id>" or "member:<id>"')
}

function validateTrace(value: unknown, errors: string[]): void {
  if (value === undefined || value === null) return
  if (!isPlainObject(value)) {
    errors.push('$.trace: expected an object')
    return
  }
  for (const key of TRACE_STRING_KEYS) {
    const part = value[key]
    if (part !== undefined && part !== null && !isNonEmptyString(part)) {
      errors.push(`$.trace.${key}: expected a non-empty string`)
    }
  }
}
