// 配对码（auth.md §3）：6 位数字、5 分钟、单次、最多 5 次尝试。
//
// 存储层只负责「码的生死」；换会话（sessions/device_id）由控制面在 claim 成功之后做，
// 因为 claim 的入参里没有设备信息，不能在这里凭空造一个 device。

import { StoreError } from './errors.ts'
import {
  asInteger,
  asNonEmptyString,
  asOptionalString,
  asRecord,
  assertOpen,
  errorMessage,
  toNumber,
} from './internal.ts'
import type {
  ClaimPairingInput,
  CreatePairingCodeInput,
  PairingClaim,
  PairingCode,
  Store,
} from './types.ts'

/** auth.md §3：错误 5 次即锁。 */
export const PAIRING_MAX_ATTEMPTS = 5

interface PairingRow {
  code: string
  account_id: string
  workspace_id: string | null
  created_at: number | bigint
  expires_at: number | bigint
  used_at: number | bigint | null
  attempts: number | bigint
}

export function createPairingCode(store: Store, input: CreatePairingCodeInput): PairingCode {
  assertOpen(store)
  const req = asRecord(input, 'pairing', 'INVALID_PAIRING_CODE')
  const code = asCode(req.code)
  const accountId = asNonEmptyString(req.accountId, 'pairing.accountId', 'INVALID_PAIRING_CODE')
  const workspaceId = asOptionalString(req.workspaceId, 'pairing.workspaceId', 'INVALID_PAIRING_CODE')
  const expiresAt = asInteger(req.expiresAt, 'pairing.expiresAt', 1, 'INVALID_PAIRING_CODE')
  const now =
    req.now === undefined || req.now === null
      ? Date.now()
      : asInteger(req.now, 'pairing.now', 0, 'INVALID_PAIRING_CODE')

  if (expiresAt <= now) {
    throw new StoreError('INVALID_PAIRING_CODE', 'pairing.expiresAt must be in the future')
  }

  // 读-删-插放在一个 savepoint 里：重签失败时不能把旧记录删掉。
  store.db.exec('SAVEPOINT roost_create_pairing_code')
  try {
    const existing = pairingByCode(store, code)
    if (existing !== null) {
      if (existing.usedAt === null && existing.expiresAt > now) {
        throw new StoreError('PAIRING_CODE_CONFLICT', `pairing code ${code} is still live`)
      }
      // 已用/已过期的码允许重新签发：6 位数字空间有限，不让历史记录长期占用名额。
      store.db.prepare('DELETE FROM pairing_codes WHERE code = ?').run(code)
    }

    store.db
      .prepare(
        'INSERT INTO pairing_codes (code, account_id, workspace_id, created_at, expires_at, used_at, attempts) VALUES (?, ?, ?, ?, ?, NULL, 0)',
      )
      .run(code, accountId, workspaceId, now, expiresAt)

    store.db.exec('RELEASE roost_create_pairing_code')
  } catch (err) {
    try {
      store.db.exec('ROLLBACK TO roost_create_pairing_code')
      store.db.exec('RELEASE roost_create_pairing_code')
    } catch {
      // savepoint 可能已随外层事务回滚；保留原始错误。
    }
    if (err instanceof StoreError) throw err

    const message = errorMessage(err)
    if (message.includes('UNIQUE')) {
      throw new StoreError('PAIRING_CODE_CONFLICT', `pairing code ${code} already exists`, {
        cause: err,
      })
    }
    throw new StoreError('PAIRING_WRITE_FAILED', `failed to create pairing code ${code}: ${message}`, {
      cause: err,
    })
  }

  return { code, accountId, workspaceId, createdAt: now, expiresAt, usedAt: null, attempts: 0 }
}

/**
 * 兑换一次配对码。
 *
 * 只统计失败：成功时重置 attempts=0；失败累计到上限（默认 PAIRING_MAX_ATTEMPTS，
 * 调用方可用 maxAttempts 覆盖）即锁死。第 5 次失败后的下一次尝试返回 LOCKED。
 * 锁没有时间窗：auth.md §3 的「锁 10 分钟」在 §9 的表里没有对应列，而码本身 5 分钟就过期，
 * 所以锁保持到码被重新签发为止。
 * 单次使用：第二次兑换抛 PAIRING_CODE_USED；过期抛 PAIRING_CODE_EXPIRED。
 * 整个判定在一个 savepoint 里，读-改-写不会与别的写者交错。
 */
export function claimPairingCode(store: Store, input: ClaimPairingInput): PairingClaim {
  assertOpen(store)
  const req = asRecord(input, 'claim', 'INVALID_PAIRING_CODE')
  const code = asCode(req.code)
  const now =
    req.now === undefined || req.now === null
      ? Date.now()
      : asInteger(req.now, 'claim.now', 0, 'INVALID_PAIRING_CODE')
  const maxAttempts =
    req.maxAttempts === undefined || req.maxAttempts === null
      ? PAIRING_MAX_ATTEMPTS
      : asInteger(req.maxAttempts, 'claim.maxAttempts', 1, 'INVALID_PAIRING_CODE')

  let failure: StoreError | null = null
  let claim: PairingClaim | null = null

  store.db.exec('SAVEPOINT roost_claim_pairing_code')
  try {
    const existing = pairingByCode(store, code)

    if (existing === null) {
      failure = new StoreError('PAIRING_CODE_NOT_FOUND', `unknown pairing code ${code}`)
    } else {
      // 一旦失败次数达到上限，后续任何尝试都直接拒绝（含正确码）。
      if (existing.attempts >= maxAttempts) {
        failure = new StoreError(
          'PAIRING_CODE_LOCKED',
          `pairing code ${code} is locked after ${existing.attempts} failed attempts (auth.md §3)`,
        )
      } else if (existing.usedAt !== null) {
        // 已用码再试也算一次失败：否则可以无限枚举已用码。
        store.db.prepare('UPDATE pairing_codes SET attempts = attempts + 1 WHERE code = ?').run(code)
        failure = new StoreError('PAIRING_CODE_USED', `pairing code ${code} was already used`)
      } else if (existing.expiresAt <= now) {
        store.db.prepare('UPDATE pairing_codes SET attempts = attempts + 1 WHERE code = ?').run(code)
        failure = new StoreError('PAIRING_CODE_EXPIRED', `pairing code ${code} expired`)
      } else {
        // 成功：原子置 used_at，并把失败计数清零。
        const result = store.db
          .prepare('UPDATE pairing_codes SET used_at = ?, attempts = 0 WHERE code = ? AND used_at IS NULL')
          .run(now, code)
        if (toNumber(result.changes) !== 1) {
          failure = new StoreError('PAIRING_CODE_USED', `pairing code ${code} was already used`)
        } else {
          claim = {
            code,
            accountId: existing.accountId,
            workspaceId: existing.workspaceId,
            createdAt: existing.createdAt,
            usedAt: now,
            attempts: 0,
          }
        }
      }
    }

    store.db.exec('RELEASE roost_claim_pairing_code')
  } catch (err) {
    try {
      store.db.exec('ROLLBACK TO roost_claim_pairing_code')
      store.db.exec('RELEASE roost_claim_pairing_code')
    } catch {
      // savepoint 可能已随外层事务回滚；保留原始错误。
    }
    throw err
  }

  if (failure !== null) throw failure
  if (claim === null) {
    throw new StoreError('PAIRING_WRITE_FAILED', 'claim finished without a result')
  }
  return claim
}

function asCode(value: unknown): string {
  const code = asNonEmptyString(value, 'pairing.code', 'INVALID_PAIRING_CODE')
  if (!/^\d{6}$/.test(code)) {
    throw new StoreError('INVALID_PAIRING_CODE', 'pairing.code must be exactly 6 digits (auth.md §3)')
  }
  return code
}

function pairingByCode(store: Store, code: string): PairingCode | null {
  const row = store.db
    .prepare(
      'SELECT code, account_id, workspace_id, created_at, expires_at, used_at, attempts FROM pairing_codes WHERE code = ?',
    )
    .get(code)
  if (row === undefined || row === null) return null
  return rowToPairingCode(row)
}

function rowToPairingCode(row: unknown): PairingCode {
  const r = row as PairingRow
  return {
    code: r.code,
    accountId: r.account_id,
    workspaceId: r.workspace_id,
    createdAt: toNumber(r.created_at),
    expiresAt: toNumber(r.expires_at),
    usedAt: r.used_at === null || r.used_at === undefined ? null : toNumber(r.used_at),
    attempts: toNumber(r.attempts),
  }
}
