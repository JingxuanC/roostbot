// 输入校验与行读取的小工具。只在本包内部使用，不从 index.ts 导出。

import { StoreError } from './errors.ts'
import type { StoreErrorCode } from './errors.ts'
import type { Store } from './types.ts'

export function assertOpen(store: Store): void {
  if (!store || typeof store !== 'object') {
    throw new StoreError('INVALID_INPUT', 'store is required')
  }
  if (store.closed) {
    throw new StoreError('STORE_CLOSED', 'store is closed')
  }
}

export function asRecord(
  value: unknown,
  label: string,
  code: StoreErrorCode = 'INVALID_INPUT',
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StoreError(code, `${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

export function asNonEmptyString(
  value: unknown,
  label: string,
  code: StoreErrorCode = 'INVALID_INPUT',
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StoreError(code, `${label} must be a non-empty string`)
  }
  return value
}

export function asOptionalString(
  value: unknown,
  label: string,
  code: StoreErrorCode = 'INVALID_INPUT',
): string | null {
  if (value === undefined || value === null) return null
  return asNonEmptyString(value, label, code)
}

export function asInteger(
  value: unknown,
  label: string,
  min: number,
  code: StoreErrorCode = 'INVALID_INPUT',
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new StoreError(code, `${label} must be an integer >= ${min}`)
  }
  return value
}

export function asOptionalInteger(
  value: unknown,
  label: string,
  min: number,
  code: StoreErrorCode = 'INVALID_INPUT',
): number | null {
  if (value === undefined || value === null) return null
  return asInteger(value, label, min, code)
}

/** sqlite 在超大整数上会返回 bigint；这里统一成 number。 */
export function toNumber(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return value
  throw new StoreError('INVALID_INPUT', `expected a number from sqlite, got ${typeof value}`)
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
