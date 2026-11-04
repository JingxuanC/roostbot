// 设备会话（auth.md §9）：token 只以 hash 落库，明文只在 claim 的响应里出现一次。
//
// 这一层只做存取，不做签发：token 由控制面用 crypto.randomBytes 生成，hash 用 sha256。
// 换会话的时机、30 天有效期、180 天封顶都在控制面（apps/api），因为它要读 devices 与账号。

import { StoreError } from './errors.ts'
import { asInteger, asNonEmptyString, asOptionalString, asRecord, assertOpen, toNumber } from './internal.ts'
import type { CreateSessionInput, Session, Store } from './types.ts'

interface SessionRow {
  id: string
  account_id: string
  device_id: string
  token_hash: string
  created_at: number | bigint
  last_seen_at: number | bigint | null
  expires_at: number | bigint
  revoked_at: number | bigint | null
}

// sessions 自己没有 account_id：账号经 devices 关联（migrations/0001_core.sql）。
const SELECT = `SELECT s.id, d.account_id AS account_id, s.device_id, s.token_hash, s.created_at,
       s.last_seen_at, s.expires_at, s.revoked_at
  FROM sessions s JOIN devices d ON d.id = s.device_id`

export function createSession(store: Store, input: CreateSessionInput): Session {
  assertOpen(store)
  const req = asRecord(input, 'session', 'INVALID_SESSION')
  const id = asNonEmptyString(req.id, 'session.id', 'INVALID_SESSION')
  const accountId = asNonEmptyString(req.accountId, 'session.accountId', 'INVALID_SESSION')
  const deviceId = asNonEmptyString(req.deviceId, 'session.deviceId', 'INVALID_SESSION')
  const tokenHash = asNonEmptyString(req.tokenHash, 'session.tokenHash', 'INVALID_SESSION')
  const createdAt = asInteger(req.createdAt, 'session.createdAt', 0, 'INVALID_SESSION')
  const expiresAt = asInteger(req.expiresAt, 'session.expiresAt', 1, 'INVALID_SESSION')
  if (expiresAt <= createdAt) {
    throw new StoreError('INVALID_SESSION', 'session.expiresAt must be after createdAt')
  }
  // 设备必须存在且属于这个账号；会话不自己存 account_id，靠 devices 关联。
  const device = store.db.prepare('SELECT account_id FROM devices WHERE id = ?').get(deviceId) as
    | { account_id: string }
    | undefined
  if (device === undefined) {
    throw new StoreError('DEVICE_NOT_FOUND', `unknown device ${deviceId}`)
  }
  if (device.account_id !== accountId) {
    throw new StoreError('DEVICE_ACCOUNT_MISMATCH', `device ${deviceId} does not belong to ${accountId}`)
  }

  try {
    store.db
      .prepare(
        'INSERT INTO sessions (id, device_id, token_hash, created_at, last_seen_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL, ?, NULL)',
      )
      .run(id, deviceId, tokenHash, createdAt, expiresAt)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('UNIQUE')) {
      throw new StoreError('SESSION_EXISTS', `session ${id} or its token hash already exists`, { cause: err })
    }
    throw new StoreError('SESSION_WRITE_FAILED', `failed to create session ${id}: ${message}`, { cause: err })
  }

  return { id, accountId, deviceId, tokenHash, createdAt, lastSeenAt: null, expiresAt, revokedAt: null }
}

/** 只按 hash 查；不存在返回 null（不区分“没这个会话”和“token 错”，避免枚举）。 */
export function findSessionByTokenHash(store: Store, tokenHash: string): Session | null {
  assertOpen(store)
  const hash = asNonEmptyString(tokenHash, 'session.tokenHash', 'INVALID_SESSION')
  const row = store.db.prepare(`${SELECT} WHERE s.token_hash = ?`).get(hash)
  return row === undefined || row === null ? null : rowToSession(row)
}

export function findSessionById(store: Store, id: string): Session | null {
  assertOpen(store)
  const sessionId = asNonEmptyString(id, 'session.id', 'INVALID_SESSION')
  const row = store.db.prepare(`${SELECT} WHERE s.id = ?`).get(sessionId)
  return row === undefined || row === null ? null : rowToSession(row)
}

/**
 * 记一次活跃；会话续期由调用方决定 expiresAt（auth.md §3：剩余 <15 天时续到 180 天封顶）。
 * 只允许把 expiresAt 往后推，不能缩短。
 */
export function touchSession(
  store: Store,
  id: string,
  input: { lastSeenAt: number; expiresAt?: number },
): Session {
  assertOpen(store)
  const sessionId = asNonEmptyString(id, 'session.id', 'INVALID_SESSION')
  const req = asRecord(input, 'session.touch', 'INVALID_SESSION')
  const lastSeenAt = asInteger(req.lastSeenAt, 'touch.lastSeenAt', 0, 'INVALID_SESSION')
  const current = findSessionById(store, sessionId)
  if (current === null) throw new StoreError('SESSION_NOT_FOUND', `unknown session ${sessionId}`)
  const expiresAt =
    req.expiresAt === undefined || req.expiresAt === null
      ? current.expiresAt
      : Math.max(current.expiresAt, asInteger(req.expiresAt, 'touch.expiresAt', 1, 'INVALID_SESSION'))
  store.db
    .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
    .run(lastSeenAt, expiresAt, sessionId)
  return { ...current, lastSeenAt, expiresAt }
}

/**
 * 设备列表投影（auth.md §10 GET /api/devices）：会话 + 设备上的展示字段。
 * sessions 没有 account_id，账号经 devices 关联；label/platform 也来自 devices。
 */
export interface SessionWithDevice {
  id: string
  accountId: string
  deviceId: string
  label: string | null
  platform: string | null
  createdAt: number
  lastSeenAt: number | null
  expiresAt: number
  revokedAt: number | null
  /** 设备级吊销时间；会话吊销与设备吊销任一发生都算不可用。 */
  deviceRevokedAt: number | null
}

interface SessionDeviceRow {
  id: string
  account_id: string
  device_id: string
  label: string | null
  platform: string | null
  created_at: number | bigint
  last_seen_at: number | bigint | null
  expires_at: number | bigint
  revoked_at: number | bigint | null
  device_revoked_at: number | bigint | null
}

/** 该账号的全部设备会话（含已吊销），按签发时间升序。 */
export function listSessionsByAccount(store: Store, accountId: string): SessionWithDevice[] {
  assertOpen(store)
  const id = asNonEmptyString(accountId, 'accountId', 'INVALID_SESSION')
  const rows = store.db
    .prepare(
      `SELECT s.id, d.account_id, s.device_id, d.label, d.platform, s.created_at,
              s.last_seen_at, s.expires_at, s.revoked_at, d.revoked_at AS device_revoked_at
         FROM sessions s JOIN devices d ON d.id = s.device_id
        WHERE d.account_id = ?
        ORDER BY s.created_at ASC, s.id ASC`,
    )
    .all(id) as SessionDeviceRow[]
  return rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    deviceId: row.device_id,
    label: row.label,
    platform: row.platform,
    createdAt: toNumber(row.created_at),
    lastSeenAt: row.last_seen_at === null ? null : toNumber(row.last_seen_at),
    expiresAt: toNumber(row.expires_at),
    revokedAt: row.revoked_at === null ? null : toNumber(row.revoked_at),
    deviceRevokedAt: row.device_revoked_at === null ? null : toNumber(row.device_revoked_at),
  }))
}

/**
 * 账号是否还有有效会话（未吊销、未过期、设备未吊销）。
 * 用于配对码 bootstrap 判定：账号一旦有会话，就不能再无凭据签发新码。
 */
export function hasActiveSessionsForAccount(store: Store, accountId: string, now: number): boolean {
  assertOpen(store)
  const id = asNonEmptyString(accountId, 'accountId', 'INVALID_SESSION')
  const at = asInteger(now, 'now', 0, 'INVALID_SESSION')
  const row = store.db
    .prepare(
      `SELECT 1 AS ok
         FROM sessions s JOIN devices d ON d.id = s.device_id
        WHERE d.account_id = ? AND s.revoked_at IS NULL AND d.revoked_at IS NULL AND s.expires_at > ?
        LIMIT 1`,
    )
    .get(id, at)
  return row !== undefined && row !== null
}

export function revokeSession(store: Store, id: string, at: number): Session {
  assertOpen(store)
  const sessionId = asNonEmptyString(id, 'session.id', 'INVALID_SESSION')
  const current = findSessionById(store, sessionId)
  if (current === null) throw new StoreError('SESSION_NOT_FOUND', `unknown session ${sessionId}`)
  store.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(at, sessionId)
  return { ...current, revokedAt: at }
}

function rowToSession(row: unknown): Session {
  const r = row as SessionRow
  return {
    id: r.id,
    accountId: r.account_id,
    deviceId: r.device_id,
    tokenHash: r.token_hash,
    createdAt: toNumber(r.created_at),
    lastSeenAt: r.last_seen_at === null || r.last_seen_at === undefined ? null : toNumber(r.last_seen_at),
    expiresAt: toNumber(r.expires_at),
    revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : toNumber(r.revoked_at),
  }
}
