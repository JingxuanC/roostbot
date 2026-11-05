// 账号级一次性 token 额度（注册赠送）。
//
// 额度按 grant 维度存 remaining + expires_at：过期后不计入余额，消费时优先用最早过期的 grant。
// 所有写操作都在 savepoint 内，ledger 的 idem 保证重放不重复扣。

import { StoreError } from './errors.ts'
import { asInteger, asNonEmptyString, asOptionalString, asRecord, assertOpen } from './internal.ts'
import { newRoostId } from './ids.ts'
import type { Store } from './types.ts'

export const SIGNUP_CREDIT_TOKENS = 1_000_000
export const SIGNUP_CREDIT_TTL_MS = 90 * 86_400_000

export interface GrantTokenCreditInput {
  accountId: string
  amount: number
  ttlMs?: number
  reason?: string
  idem?: string
  at?: number
}

export interface TokenGrant {
  id: string
  accountId: string
  amount: number
  remaining: number
  reason: string
  expiresAt: number
  createdAt: number
}

export interface TokenCreditBalance {
  balance: number
  /** 最近一张仍有效的 grant 的过期时间；没有有效 grant 时为 null。 */
  expiresAt: number | null
}

export interface ConsumeTokenCreditInput {
  accountId: string
  tokens: number
  reason?: string
  idem?: string
  at?: number
}

export interface ConsumeTokenCreditResult {
  consumed: number
  balance: number
}

export function grantTokenCredit(store: Store, input: GrantTokenCreditInput): { grant: TokenGrant; created: boolean } {
  assertOpen(store)
  const req = asRecord(input, 'tokenCredit.grant')
  const accountId = asNonEmptyString(req.accountId, 'tokenCredit.accountId')
  const amount = asInteger(req.amount, 'tokenCredit.amount', 1)
  const ttlMs = asInteger(req.ttlMs ?? SIGNUP_CREDIT_TTL_MS, 'tokenCredit.ttlMs', 1)
  const reason = typeof req.reason === 'string' && req.reason !== '' ? req.reason : 'signup_bonus'
  const at = asInteger(req.at ?? Date.now(), 'tokenCredit.at', 0)
  const idem = asOptionalString(req.idem, 'tokenCredit.idem') ?? `${reason}:${accountId}`
  const expiresAt = at + ttlMs

  return withSavepoint(store, 'roost_token_grant', () => {
    const existing = store.db.prepare('SELECT * FROM account_token_grants WHERE idem = ?').get(idem) as
      | Record<string, unknown>
      | undefined
    if (existing !== undefined && existing !== null) return { grant: rowToGrant(existing), created: false }
    const id = newRoostId('tg', at)
    store.db
      .prepare(
        `INSERT INTO account_token_grants (id, account_id, amount, remaining, reason, expires_at, created_at, idem)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, accountId, amount, amount, reason, expiresAt, at, idem)
    store.db
      .prepare('INSERT INTO account_token_ledger (id, account_id, grant_id, delta, reason, idem, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(newRoostId('tl', at), accountId, id, amount, reason, idem, at)
    const row = store.db.prepare('SELECT * FROM account_token_grants WHERE id = ?').get(id) as Record<string, unknown>
    return { grant: rowToGrant(row), created: true }
  })
}

export function getTokenCreditBalance(store: Store, accountId: string, at = Date.now()): TokenCreditBalance {
  assertOpen(store)
  const id = asNonEmptyString(accountId, 'tokenCredit.accountId')
  const now = asInteger(at, 'tokenCredit.at', 0)
  const row = store.db
    .prepare(
      `SELECT COALESCE(SUM(remaining), 0) AS balance, MIN(expires_at) AS expires_at
         FROM account_token_grants
        WHERE account_id = ? AND remaining > 0 AND expires_at > ?`,
    )
    .get(id, now) as { balance?: number | bigint; expires_at?: number | bigint | null } | undefined
  return {
    balance: Number(row?.balance ?? 0),
    expiresAt: row?.expires_at === null || row?.expires_at === undefined ? null : Number(row.expires_at),
  }
}

/** 扣减额度；额度不足时只扣能扣的，返回实际扣减。idem 相同直接返回历史结果。 */
export function consumeTokenCredit(store: Store, input: ConsumeTokenCreditInput): ConsumeTokenCreditResult {
  assertOpen(store)
  const req = asRecord(input, 'tokenCredit.consume')
  const accountId = asNonEmptyString(req.accountId, 'tokenCredit.accountId')
  const tokens = asInteger(req.tokens, 'tokenCredit.tokens', 0)
  const now = asInteger(req.at ?? Date.now(), 'tokenCredit.at', 0)
  const reason = typeof req.reason === 'string' && req.reason !== '' ? req.reason : 'usage'
  const idem = asOptionalString(req.idem, 'tokenCredit.idem')

  return withSavepoint(store, 'roost_token_consume', () => {
    if (idem !== null) {
      const previous = store.db.prepare('SELECT delta FROM account_token_ledger WHERE idem = ?').get(idem) as
        | { delta?: number | bigint }
        | undefined
      if (previous !== undefined && previous !== null) {
        return { consumed: Math.max(0, -Number(previous.delta ?? 0)), balance: getTokenCreditBalance(store, accountId, now).balance }
      }
    }
    let left = tokens
    const grants = store.db
      .prepare(
        `SELECT id, remaining FROM account_token_grants
          WHERE account_id = ? AND remaining > 0 AND expires_at > ?
          ORDER BY expires_at ASC, created_at ASC`,
      )
      .all(accountId, now) as Array<{ id: string; remaining: number | bigint }>
    for (const grant of grants) {
      if (left <= 0) break
      const take = Math.min(left, Number(grant.remaining))
      store.db.prepare('UPDATE account_token_grants SET remaining = remaining - ? WHERE id = ?').run(take, grant.id)
      left -= take
    }
    const consumed = tokens - left
    if (consumed > 0) {
      store.db
        .prepare('INSERT INTO account_token_ledger (id, account_id, grant_id, delta, reason, idem, at) VALUES (?, ?, NULL, ?, ?, ?, ?)')
        .run(newRoostId('tl', now), accountId, -consumed, reason, idem, now)
    }
    return { consumed, balance: getTokenCreditBalance(store, accountId, now).balance }
  })
}

function rowToGrant(row: Record<string, unknown>): TokenGrant {
  return {
    id: String(row['id']),
    accountId: String(row['account_id']),
    amount: Number(row['amount']),
    remaining: Number(row['remaining']),
    reason: String(row['reason']),
    expiresAt: Number(row['expires_at']),
    createdAt: Number(row['created_at']),
  }
}

function withSavepoint<T>(store: Store, name: string, fn: () => T): T {
  store.db.exec(`SAVEPOINT ${name}`)
  try {
    const value = fn()
    store.db.exec(`RELEASE ${name}`)
    return value
  } catch (err) {
    try {
      store.db.exec(`ROLLBACK TO ${name}`)
      store.db.exec(`RELEASE ${name}`)
    } catch {
      // 原始错误更重要。
    }
    throw err
  }
}
