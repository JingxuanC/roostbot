// 每 workspace 短期 runtime token（migrations/0021_runtime_tokens.sql）。
//
// 事实源：docs/build/wave3.md §B、docs/decisions/0005-runtime-token.md「provider 方案」。
//
// 分工：这一层只做存取与生命周期判定，不做签发策略。TTL 多久、什么时候签发
// （start）、什么时候吊销（stop）、怎么注入沙箱 env，都在 apps/api。
//
// 与 sessions / auth_tokens 同一原则：
//   * 明文 token 只在 issueRuntimeToken 的返回值里出现一次，库里只有 sha256；
//   * 校验按 hash 等值查库（不走明文比较），未命中/过期/吊销一律返回 null，
//     调用方不需要区分「没这个 token」和「token 错了」；
//   * 时间都是 epoch 毫秒，由调用方传入（`at` 省略才读 Date.now，便于测试注入时钟）。
//
// 为什么不用 timingSafeEqual 比较 token：库里查的是 sha256(token)，等值比较发生在
// SQLite 的索引上；攻击者能控制的只有输入串，拿不到 hash 的逐字节比较时序，
// 所以明文层不需要（也无法）做到定时安全。这一点与 ADR 0005 的说明一致。

import { createHash, randomBytes } from 'node:crypto'

import { StoreError } from './errors.ts'
import { newRoostId } from './ids.ts'
import { asInteger, asNonEmptyString, asRecord, assertOpen, toNumber } from './internal.ts'
import type { Store } from './types.ts'

/** 32 字节 = 256 位随机；与 sessions / auth_tokens 的 token 等长。 */
export const RUNTIME_TOKEN_BYTES = 32

export interface IssueRuntimeTokenInput {
  workspaceId: string
  /** 有效期毫秒数，必须 >= 1；过期后 verify 返回 null。 */
  ttlMs: number
  /** 省略 = Date.now()。 */
  at?: number
}

/** 明文 `token` 只在这里出现一次；调用方负责立刻注入沙箱 env，不再落库。 */
export interface IssuedRuntimeToken {
  id: string
  token: string
  workspaceId: string
  expiresAt: number
}

export interface RuntimeTokenVerification {
  id: string
  workspaceId: string
}

export interface VerifyRuntimeTokenInput {
  token: string
  /** 省略 = Date.now()。 */
  at?: number
}

export interface RevokeRuntimeTokenInput {
  id: string
  /** 省略 = Date.now()。 */
  at?: number
}

export interface RevokeRuntimeTokensInput {
  workspaceId: string
  /** 省略 = Date.now()。 */
  at?: number
}

export interface RevokeRuntimeTokensResult {
  /** 本次真正改写的行数；已吊销的不重复计数。 */
  revoked: number
}

export interface RevokedRuntimeToken {
  id: string
  workspaceId: string
  /** 第一次吊销的时间（重复吊销不覆盖）。 */
  revokedAt: number
}

interface RuntimeTokenRow {
  id: string
  workspace_id: string
  revoked_at: number | bigint | null
}

/** sha256(token) 十六进制；token 本身永不落库。 */
export function hashRuntimeToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function resolveAt(value: unknown, code: 'INVALID_RUNTIME_TOKEN'): number {
  if (value === undefined || value === null) return Date.now()
  return asInteger(value, 'runtimeToken.at', 0, code)
}

/**
 * 签发一个 runtime token。返回值里的 `token` 是明文（仅此一次），库里只有 sha256。
 *
 * 不校验 workspace 是否存在：这一层不认识 tenants，workspace 生命周期由调用方保证；
 * 与 sessions「设备必须存在」不同，token 可以先于 workspace 的运行时存在。
 */
export function issueRuntimeToken(store: Store, input: IssueRuntimeTokenInput): IssuedRuntimeToken {
  assertOpen(store)
  const req = asRecord(input, 'runtimeToken', 'INVALID_RUNTIME_TOKEN')
  const workspaceId = asNonEmptyString(req.workspaceId, 'runtimeToken.workspaceId', 'INVALID_RUNTIME_TOKEN')
  const ttlMs = asInteger(req.ttlMs, 'runtimeToken.ttlMs', 1, 'INVALID_RUNTIME_TOKEN')
  const at = resolveAt(req.at, 'INVALID_RUNTIME_TOKEN')

  const token = randomBytes(RUNTIME_TOKEN_BYTES).toString('hex')
  const id = newRoostId('rtk', at)
  const expiresAt = at + ttlMs

  try {
    store.db
      .prepare(
        `INSERT INTO runtime_tokens (id, workspace_id, token_hash, issued_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, workspaceId, hashRuntimeToken(token), at, expiresAt)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new StoreError(
      'RUNTIME_TOKEN_WRITE_FAILED',
      `failed to issue runtime token ${id}: ${message}`,
      { cause: err },
    )
  }

  return { id, token, workspaceId, expiresAt }
}

/**
 * 按明文 token 校验：命中且未吊销、未过期才返回 {id, workspaceId}，其余一律 null。
 *
 * 入参来自请求头，所以空值/非字符串不抛错（返回 null 即可），避免把畸形 header
 * 变成 500。`at` 是调用方时钟：测试可把时间推到过期之后。
 */
export function verifyRuntimeToken(
  store: Store,
  input: VerifyRuntimeTokenInput,
): RuntimeTokenVerification | null {
  assertOpen(store)
  const req = asRecord(input, 'runtimeToken.verify', 'INVALID_RUNTIME_TOKEN')
  if (typeof req.token !== 'string' || req.token === '') return null
  const at = resolveAt(req.at, 'INVALID_RUNTIME_TOKEN')

  const row = store.db
    .prepare(
      `SELECT id, workspace_id FROM runtime_tokens
        WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .get(hashRuntimeToken(req.token), at) as { id: string; workspace_id: string } | undefined
  if (row === undefined) return null
  return { id: row.id, workspaceId: row.workspace_id }
}

/**
 * 吊销单个 token（stop 沙箱、发现泄露时用）。幂等：已吊销的返回第一次的 revokedAt，
 * 不覆盖时间戳——审计里要保留「什么时候开始不能用」。未知 id 抛 RUNTIME_TOKEN_NOT_FOUND。
 */
export function revokeRuntimeToken(store: Store, input: RevokeRuntimeTokenInput): RevokedRuntimeToken {
  assertOpen(store)
  const req = asRecord(input, 'runtimeToken.revoke', 'INVALID_RUNTIME_TOKEN')
  const id = asNonEmptyString(req.id, 'runtimeToken.id', 'INVALID_RUNTIME_TOKEN')
  const at = resolveAt(req.at, 'INVALID_RUNTIME_TOKEN')

  const row = store.db
    .prepare('SELECT id, workspace_id, revoked_at FROM runtime_tokens WHERE id = ?')
    .get(id) as RuntimeTokenRow | undefined
  if (row === undefined) {
    throw new StoreError('RUNTIME_TOKEN_NOT_FOUND', `unknown runtime token ${id}`)
  }
  const workspaceId = row.workspace_id
  if (row.revoked_at !== null && row.revoked_at !== undefined) {
    return { id, workspaceId, revokedAt: toNumber(row.revoked_at) }
  }

  store.db.prepare('UPDATE runtime_tokens SET revoked_at = ? WHERE id = ?').run(at, id)
  return { id, workspaceId, revokedAt: at }
}

/**
 * 吊销某 workspace 的全部有效 token（沙箱 stop、重建、workspace 归档时用）。
 * 返回本次真正吊销的条数；没有有效 token 时是 0，不抛错（停一个没起过的沙箱是正常的）。
 */
export function revokeRuntimeTokens(
  store: Store,
  input: RevokeRuntimeTokensInput,
): RevokeRuntimeTokensResult {
  assertOpen(store)
  const req = asRecord(input, 'runtimeToken.revokeAll', 'INVALID_RUNTIME_TOKEN')
  const workspaceId = asNonEmptyString(req.workspaceId, 'runtimeToken.workspaceId', 'INVALID_RUNTIME_TOKEN')
  const at = resolveAt(req.at, 'INVALID_RUNTIME_TOKEN')

  const result = store.db
    .prepare('UPDATE runtime_tokens SET revoked_at = ? WHERE workspace_id = ? AND revoked_at IS NULL')
    .run(at, workspaceId)
  return { revoked: toNumber(result.changes) }
}
