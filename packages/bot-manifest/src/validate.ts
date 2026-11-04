// 纯校验：不引依赖、不抛异常。错误信息路径固定为 `$` / `$.field`，便于测试与 CLI 展示。

import {
  APPROVAL_KINDS,
  MANIFEST_SCHEMA,
  MEMORY_SCOPES,
  MODEL_TIERS,
  type BotManifest,
} from './types.ts'

export type ManifestValidation =
  | { ok: true; manifest: BotManifest }
  | { ok: false; errors: string[] }

const MANIFEST_FIELDS = new Set([
  'schema',
  'id',
  'name',
  'role',
  'description',
  'instructions',
  'color',
  'model',
  'tools',
  'skills',
  'panels',
  'approvals',
  'memory',
  'schedule',
])

const MODEL_FIELDS = ['tier', 'providerRef'] as const
const TOOLS_FIELDS = ['allow', 'deny'] as const
const MEMORY_FIELDS = ['enabled', 'scopes', 'retentionDays'] as const
const SCHEDULE_FIELDS = ['cron', 'timezone', 'checks'] as const
const PANEL_FIELDS = new Set(['name', 'title', 'slot', 'path'])

const BOT_ID = /^[a-z][a-z0-9-]{1,40}$/
const COLOR = /^[a-z]+$/

interface StringRule {
  required?: boolean
  min?: number
  max?: number
  pattern?: RegExp
  patternText?: string
}

/**
 * 校验 bot manifest v1。
 *
 * 必填：schema、id、name、role、instructions。
 * 其余字段可选；未知字段直接报错（schema 的 additionalProperties=false）。
 */
export function validateManifest(value: unknown): ManifestValidation {
  if (!isPlainObject(value)) return { ok: false, errors: ['$: expected an object'] }

  const errors: string[] = []

  for (const key of Object.keys(value)) {
    if (!MANIFEST_FIELDS.has(key)) errors.push(`$: unknown field "${key}"`)
  }

  const schema = checkString(value.schema, '$.schema', errors, { required: true })
  if (schema !== null && schema !== MANIFEST_SCHEMA) {
    errors.push(`$.schema: expected "${MANIFEST_SCHEMA}"`)
  }

  checkString(value.id, '$.id', errors, {
    required: true,
    pattern: BOT_ID,
    patternText: BOT_ID.toString(),
  })
  checkString(value.name, '$.name', errors, { required: true, min: 1, max: 40 })
  checkString(value.role, '$.role', errors, { required: true, min: 1, max: 20 })
  checkString(value.description, '$.description', errors, { max: 400 })
  checkString(value.instructions, '$.instructions', errors, { required: true, min: 1 })
  checkString(value.color, '$.color', errors, { pattern: COLOR, patternText: COLOR.toString() })

  const model = checkObject(value.model, '$.model', errors, MODEL_FIELDS)
  if (model !== null) {
    checkEnum(model.tier, '$.model.tier', errors, MODEL_TIERS)
    checkString(model.providerRef, '$.model.providerRef', errors, { min: 1 })
  }

  const tools = checkObject(value.tools, '$.tools', errors, TOOLS_FIELDS)
  if (tools !== null) {
    checkStringArray(tools.allow, '$.tools.allow', errors)
    checkStringArray(tools.deny, '$.tools.deny', errors)
  }

  checkStringArray(value.skills, '$.skills', errors, { maxItems: 60 })
  checkPanels(value.panels, errors)
  checkEnumArray(value.approvals, '$.approvals', errors, APPROVAL_KINDS)

  const memory = checkObject(value.memory, '$.memory', errors, MEMORY_FIELDS)
  if (memory !== null) {
    if (memory.enabled !== undefined && typeof memory.enabled !== 'boolean') {
      errors.push('$.memory.enabled: expected a boolean')
    }
    checkEnumArray(memory.scopes, '$.memory.scopes', errors, MEMORY_SCOPES)
    if (memory.retentionDays !== undefined) checkInteger(memory.retentionDays, '$.memory.retentionDays', errors, 1, 3650)
  }

  const schedule = checkObject(value.schedule, '$.schedule', errors, SCHEDULE_FIELDS)
  if (schedule !== null) {
    checkString(schedule.cron, '$.schedule.cron', errors, { min: 1 })
    checkString(schedule.timezone, '$.schedule.timezone', errors, { min: 1 })
    checkStringArray(schedule.checks, '$.schedule.checks', errors)
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, manifest: value as unknown as BotManifest }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function checkString(
  value: unknown,
  path: string,
  errors: string[],
  rule: StringRule = {},
): string | null {
  if (value === undefined) {
    if (rule.required === true) errors.push(`${path}: required`)
    return null
  }
  if (typeof value !== 'string') {
    errors.push(`${path}: expected a string`)
    return null
  }
  const text = value.trim()
  if (rule.min !== undefined && text.length < rule.min) {
    errors.push(`${path}: expected length >= ${rule.min}`)
    return null
  }
  if (rule.max !== undefined && text.length > rule.max) {
    errors.push(`${path}: expected length <= ${rule.max}`)
    return null
  }
  if (rule.pattern !== undefined && !rule.pattern.test(value)) {
    errors.push(`${path}: expected ${rule.patternText ?? rule.pattern.toString()}`)
    return null
  }
  return text
}

function checkObject(
  value: unknown,
  path: string,
  errors: string[],
  allowed: readonly string[],
): Record<string, unknown> | null {
  if (value === undefined) return null
  if (!isPlainObject(value)) {
    errors.push(`${path}: expected an object`)
    return null
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}: unknown field "${key}"`)
  }
  return value
}

function checkStringArray(
  value: unknown,
  path: string,
  errors: string[],
  options: { maxItems?: number } = {},
): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected an array`)
    return
  }
  if (options.maxItems !== undefined && value.length > options.maxItems) {
    errors.push(`${path}: expected at most ${options.maxItems} items`)
  }
  value.forEach((item, index) => {
    if (!isNonEmptyString(item)) errors.push(`${path}[${index}]: expected a non-empty string`)
  })
}

function checkEnum(
  value: unknown,
  path: string,
  errors: string[],
  allowed: readonly string[],
): void {
  if (value === undefined) return
  if (typeof value !== 'string' || !allowed.includes(value)) {
    errors.push(`${path}: expected one of ${allowed.join(', ')}`)
  }
}

function checkEnumArray(
  value: unknown,
  path: string,
  errors: string[],
  allowed: readonly string[],
): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected an array`)
    return
  }
  value.forEach((item, index) => checkEnum(item, `${path}[${index}]`, errors, allowed))
}

function checkInteger(
  value: unknown,
  path: string,
  errors: string[],
  min: number,
  max: number,
): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    errors.push(`${path}: expected an integer between ${min} and ${max}`)
  }
}

function checkPanels(value: unknown, errors: string[]): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push('$.panels: expected an array')
    return
  }
  value.forEach((item, index) => {
    const path = `$.panels[${index}]`
    if (!isPlainObject(item)) {
      errors.push(`${path}: expected an object`)
      return
    }
    for (const key of Object.keys(item)) {
      if (!PANEL_FIELDS.has(key)) errors.push(`${path}: unknown field "${key}"`)
    }
    checkString(item.name, `${path}.name`, errors, { required: true, min: 1, max: 128 })
    checkString(item.title, `${path}.title`, errors, { min: 1, max: 200 })
    checkString(item.slot, `${path}.slot`, errors, { min: 1, max: 64 })
    checkString(item.path, `${path}.path`, errors, { min: 1, max: 512 })
  })
}
