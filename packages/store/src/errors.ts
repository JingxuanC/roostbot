// 错误码集中在这里：调用方按 `err.code` 分支，不靠 message 做判断。

export const STORE_ERROR_CODES = [
  'INVALID_INPUT',
  'INVALID_PATH',
  'INVALID_EVENT',
  'INVALID_WORKSPACE',
  'INVALID_PAIRING_CODE',
  'MIGRATIONS_NOT_FOUND',
  'MIGRATION_FAILED',
  'STORE_CLOSED',
  'EVENT_WRITE_FAILED',
  'EVENT_ID_CONFLICT',
  'EVENT_CORRUPT',
  'PARENT_NOT_FOUND',
  'WORKSPACE_EXISTS',
  'WORKSPACE_WRITE_FAILED',
  'PAIRING_CODE_NOT_FOUND',
  'PAIRING_CODE_USED',
  'PAIRING_CODE_EXPIRED',
  'PAIRING_CODE_LOCKED',
  'PAIRING_CODE_CONFLICT',
  'PAIRING_WRITE_FAILED',
  'INVALID_ROOM',
] as const

export type StoreErrorCode = (typeof STORE_ERROR_CODES)[number]

export class StoreError extends Error {
  code: StoreErrorCode

  constructor(code: StoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'StoreError'
    this.code = code
  }
}

export function isStoreError(err: unknown): err is StoreError {
  return err instanceof StoreError
}
