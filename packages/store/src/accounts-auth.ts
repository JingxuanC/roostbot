// 账号与一次性令牌（migrations/0019_auth.sql）。
//
// 事实源：docs/design/auth.md §4（账号方式）、§9（数据模型）、docs/build/wave1.md §A。
//
// 密码哈希 —— 与设计文档的偏差（有意）：
//   auth.md §4 写的是 Argon2id，但仓库零依赖，Node 内置没有 Argon2。
//   这里用 node:crypto 的 scrypt（N=2^15, r=8, p=1, 64 字节 key），参数取 OWASP 的
//   scrypt 下限；同样是内存硬、抗 GPU 的 KDF，单次校验 ~50ms。换成 Argon2id 需要引入
//   原生依赖，不在这一层的决策范围内（见 packages/store/README.md「设计文档不一致」）。
//   格式 `scrypt$N$r$p$saltB64$hashB64`：参数随哈希一起存，将来调参不需要迁移；
//   比较用 timingSafeEqual（长度不同直接 false，不抛）。
//
// 这个模块只做存取，不做签发策略：TTL、邮件发送、限流、Cookie 都在 apps/api。
// 所有 now / expiresAt 都是 epoch 毫秒，由调用方传入（createAuthToken 例外，可省略 now）。
//
// 一次性令牌：明文 token 只在 createAuthToken 的返回值里出现一次；库里只存 sha256。
// consumeAuthToken 用一条带条件的 UPDATE 原子地标记 used_at，天然单次（并发下只有一个赢）。

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

import { StoreError } from './errors.ts'
import { newRoostId } from './ids.ts'
import { asInteger, asNonEmptyString, asRecord, assertOpen, errorMessage, toNumber } from './internal.ts'
import type { Store } from './types.ts'

// ---- 密码哈希（scrypt）-------------------------------------------------------

export const SCRYPT_N = 2 ** 15
export const SCRYPT_R = 8
export const SCRYPT_P = 1
export const SCRYPT_KEY_BYTES = 64
export const SCRYPT_SALT_BYTES = 16

/** N=2^15、r=8 需要 32MiB 工作区；Node 默认 maxmem 正好卡在边界，显式抬到 64MiB。 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024
/** 上限只是防滥用（口令策略在 API 层）；下限 1 允许空口令测试之外的调用方自己把关。 */
const PASSWORD_MAX = 1024
const EMAIL_MAX = 254
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function asPassword(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > PASSWORD_MAX) {
    throw new StoreError(
      'INVALID_ACCOUNT',
      `password must be a non-empty string of at most ${PASSWORD_MAX} chars`,
    )
  }
  return value
}

interface ParsedPasswordHash {
  n: number
  r: number
  p: number
  salt: Buffer
  hash: Buffer
}

/**
 * 解析 `scrypt$N$r$p$saltB64$hashB64`；畸形/参数越界一律 null（登录按「密码不对」处理）。
 * 参数上限是为了不让一条脏库值把单次校验拖成内存炸弹。
 */
function parsePasswordHash(stored: unknown): ParsedPasswordHash | null {
  if (typeof stored !== 'string') return null
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(n) || n < 2 || n > 2 ** 20 || (n & (n - 1)) !== 0) return null
  if (!Number.isInteger(r) || r < 1 || r > 32) return null
  if (!Number.isInteger(p) || p < 1 || p > 16) return null
  // 128*N*r 是 scrypt 的工作区下限；超过我们的 maxmem 就没法在进程内验证。
  if (128 * n * r > SCRYPT_MAXMEM) return null
  let salt: Buffer
  let hash: Buffer
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64')
    hash = Buffer.from(parts[5] ?? '', 'base64')
  } catch {
    return null
  }
  if (salt.byteLength < 8 || hash.byteLength < 16) return null
  return { n, r, p, salt, hash }
}

/** 生成 `scrypt$N$r$p$saltB64$hashB64`；每次调用新盐。 */
export function hashPassword(password: string): string {
  const pw = asPassword(password)
  const salt = randomBytes(SCRYPT_SALT_BYTES)
  const derived = scryptSync(pw, salt, SCRYPT_KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`
}

/** 校验口令。存储值畸形、参数不可用、口令不对都返回 false（登录层不区分原因）。 */
export function verifyPassword(password: string, stored: string): boolean {
  if (typeof password !== 'string' || password === '' || password.length > PASSWORD_MAX) return false
  const parsed = parsePasswordHash(stored)
  if (parsed === null) return false
  let derived: Buffer
  try {
    derived = scryptSync(password, parsed.salt, parsed.hash.byteLength, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      maxmem: SCRYPT_MAXMEM,
    })
  } catch {
    return false
  }
  if (derived.byteLength !== parsed.hash.byteLength) return false
  return timingSafeEqual(derived, parsed.hash)
}

// ---- 账号 --------------------------------------------------------------------

export interface Account {
  id: string
  email: string
  /** OIDC-only 账号为 null。 */
  passwordHash: string | null
  oidcSubject: string | null
  createdAt: number
  disabledAt: number | null
  /** null = 邮箱还没验证。 */
  emailVerifiedAt: number | null
  passwordUpdatedAt: number | null
}

interface AccountRow {
  id: string
  email: string
  password_hash: string | null
  oidc_subject: string | null
  created_at: number | bigint
  disabled_at: number | bigint | null
  email_verified_at: number | bigint | null
  password_updated_at: number | bigint | null
}

const ACCOUNT_COLUMNS = `id, email, password_hash, oidc_subject, created_at, disabled_at,
       email_verified_at, password_updated_at`

function rowToAccount(row: unknown): Account {
  const r = row as AccountRow
  return {
    id: r.id,
    email: r.email,
    passwordHash: r.password_hash,
    oidcSubject: r.oidc_subject,
    createdAt: toNumber(r.created_at),
    disabledAt: r.disabled_at === null ? null : toNumber(r.disabled_at),
    emailVerifiedAt: r.email_verified_at === null ? null : toNumber(r.email_verified_at),
    passwordUpdatedAt: r.password_updated_at === null ? null : toNumber(r.password_updated_at),
  }
}

/** 邮箱规范化：小写 + 去首尾空白（auth.md §9 的 email UNIQUE 按这个口径）。 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function isEmailShaped(email: unknown): email is string {
  if (typeof email !== 'string') return false
  const normalized = normalizeEmail(email)
  return normalized.length > 0 && normalized.length <= EMAIL_MAX && EMAIL_SHAPE.test(normalized)
}

function parseEmail(value: unknown): string {
  if (!isEmailShaped(value)) {
    throw new StoreError('INVALID_ACCOUNT', 'email must look like name@example.com (at most 254 chars)')
  }
  return normalizeEmail(value)
}

export interface CreateAccountInput {
  email: string
  password: string
  now: number
}

/** 建一个邮箱 + 密码账号；email 冲突映射 ACCOUNT_EXISTS（不覆盖、不合并）。 */
export function createAccountWithPassword(store: Store, input: CreateAccountInput): Account {
  assertOpen(store)
  const req = asRecord(input, 'account', 'INVALID_ACCOUNT')
  const email = parseEmail(req.email)
  const password = asPassword(req.password)
  const now = asInteger(req.now, 'account.now', 0, 'INVALID_ACCOUNT')
  const passwordHash = hashPassword(password)
  const id = newRoostId('acc', now)

  try {
    store.db
      .prepare(
        `INSERT INTO accounts (id, email, password_hash, oidc_subject, created_at, disabled_at,
                               email_verified_at, password_updated_at)
         VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?)`,
      )
      .run(id, email, passwordHash, now, now)
  } catch (err) {
    const message = errorMessage(err)
    if (message.includes('UNIQUE')) {
      throw new StoreError('ACCOUNT_EXISTS', `email ${email} is already registered`, { cause: err })
    }
    throw new StoreError('ACCOUNT_WRITE_FAILED', `failed to create account: ${message}`, { cause: err })
  }

  return {
    id,
    email,
    passwordHash,
    oidcSubject: null,
    createdAt: now,
    disabledAt: null,
    emailVerifiedAt: null,
    passwordUpdatedAt: now,
  }
}

/** 按规范化后的邮箱查；查不到返回 null（不区分「没这个账号」和别的失败）。 */
export function findAccountByEmail(store: Store, email: string): Account | null {
  assertOpen(store)
  if (typeof email !== 'string') {
    throw new StoreError('INVALID_ACCOUNT', 'email must be a string')
  }
  const normalized = normalizeEmail(email)
  if (normalized === '') return null
  const row = store.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE email = ?`).get(normalized)
  return row === undefined || row === null ? null : rowToAccount(row)
}

export function findAccountById(store: Store, accountId: string): Account | null {
  assertOpen(store)
  const id = asNonEmptyString(accountId, 'accountId', 'INVALID_ACCOUNT')
  const row = store.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).get(id)
  return row === undefined || row === null ? null : rowToAccount(row)
}

function findAccountByOidcSubject(store: Store, subject: string): Account | null {
  const row = store.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE oidc_subject = ?`).get(subject)
  return row === undefined || row === null ? null : rowToAccount(row)
}

/** 标记邮箱已验证；幂等（重复调用保留第一次的验证时间）。 */
export function markEmailVerified(store: Store, accountId: string, at: number): Account {
  assertOpen(store)
  const id = asNonEmptyString(accountId, 'accountId', 'INVALID_ACCOUNT')
  const now = asInteger(at, 'verifiedAt', 0, 'INVALID_ACCOUNT')
  const current = findAccountById(store, id)
  if (current === null) throw new StoreError('ACCOUNT_NOT_FOUND', `unknown account ${id}`)
  if (current.emailVerifiedAt !== null) return current
  store.db.prepare('UPDATE accounts SET email_verified_at = ? WHERE id = ?').run(now, id)
  return { ...current, emailVerifiedAt: now }
}

/** 设/重置密码；同时刷新 password_updated_at（会话是否早于改密由调用方判断）。 */
export function setPassword(store: Store, accountId: string, password: string, at: number): Account {
  assertOpen(store)
  const id = asNonEmptyString(accountId, 'accountId', 'INVALID_ACCOUNT')
  const pw = asPassword(password)
  const now = asInteger(at, 'passwordUpdatedAt', 0, 'INVALID_ACCOUNT')
  const current = findAccountById(store, id)
  if (current === null) throw new StoreError('ACCOUNT_NOT_FOUND', `unknown account ${id}`)
  const passwordHash = hashPassword(pw)
  store.db.prepare('UPDATE accounts SET password_hash = ?, password_updated_at = ? WHERE id = ?').run(passwordHash, now, id)
  return { ...current, passwordHash, passwordUpdatedAt: now }
}

export interface UpsertOidcAccountInput {
  /** OIDC 提供方的 `sub`（稳定、不随邮箱变）。 */
  subject: string
  email: string
  now: number
}

/**
 * OIDC 登录落账号：
 * 1. subject 已绑定 → 直接返回那个账号（邮箱改了也不动）；
 * 2. 邮箱已有 OIDC-only 账号（没有密码）→ 补上 subject，验证时间沿用；
 * 3. 邮箱已有密码账号 → 拒绝（ACCOUNT_EXISTS），按 auth.md §8「先用密码登录再绑定」，不自动合并；
 * 4. 都没有 → 建 OIDC-only 账号（password_hash = NULL）。
 * OIDC 提供方已经证明了邮箱归属，所以新建时 email_verified_at = now。
 */
export function upsertOidcAccount(store: Store, input: UpsertOidcAccountInput): Account {
  assertOpen(store)
  const req = asRecord(input, 'oidcAccount', 'INVALID_ACCOUNT')
  const subject = asNonEmptyString(req.subject, 'oidcAccount.subject', 'INVALID_ACCOUNT')
  const email = parseEmail(req.email)
  const now = asInteger(req.now, 'oidcAccount.now', 0, 'INVALID_ACCOUNT')

  const linked = findAccountByOidcSubject(store, subject)
  if (linked !== null) return linked

  const existing = findAccountByEmail(store, email)
  if (existing !== null) {
    if (existing.passwordHash !== null) {
      throw new StoreError(
        'ACCOUNT_EXISTS',
        `email ${email} already has a password account; sign in with the password to link OIDC`,
      )
    }
    if (existing.oidcSubject !== null) {
      throw new StoreError(
        'ACCOUNT_EXISTS',
        `account ${existing.id} is already linked to another OIDC subject`,
      )
    }
    store.db
      .prepare('UPDATE accounts SET oidc_subject = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?')
      .run(subject, now, existing.id)
    const updated = findAccountById(store, existing.id)
    if (updated === null) throw new StoreError('ACCOUNT_NOT_FOUND', `unknown account ${existing.id}`)
    return updated
  }

  const id = newRoostId('acc', now)
  try {
    store.db
      .prepare(
        `INSERT INTO accounts (id, email, password_hash, oidc_subject, created_at, disabled_at,
                               email_verified_at, password_updated_at)
         VALUES (?, ?, NULL, ?, ?, NULL, ?, NULL)`,
      )
      .run(id, email, subject, now, now)
  } catch (err) {
    const message = errorMessage(err)
    if (message.includes('UNIQUE')) {
      throw new StoreError('ACCOUNT_EXISTS', `email ${email} is already registered`, { cause: err })
    }
    throw new StoreError('ACCOUNT_WRITE_FAILED', `failed to create OIDC account: ${message}`, { cause: err })
  }

  return {
    id,
    email,
    passwordHash: null,
    oidcSubject: subject,
    createdAt: now,
    disabledAt: null,
    emailVerifiedAt: now,
    passwordUpdatedAt: null,
  }
}

// ---- 一次性令牌 --------------------------------------------------------------

export const AUTH_TOKEN_KINDS = ['email_verify', 'password_reset', 'oidc_state'] as const
export type AuthTokenKind = (typeof AUTH_TOKEN_KINDS)[number]

export interface AuthToken {
  id: string
  accountId: string
  kind: AuthTokenKind
  createdAt: number
  expiresAt: number
  usedAt: number | null
  payload: Record<string, unknown> | null
}

/** 明文 token 只在这里出现一次；之后只能靠调用方自己保存。 */
export type IssuedAuthToken = AuthToken & { token: string }

export interface CreateAuthTokenInput {
  accountId: string
  kind: AuthTokenKind
  ttlMs: number
  payload?: Record<string, unknown> | null
  /** 省略 = Date.now()；store 自己不读时钟是惯例，这个参数只是便利。 */
  now?: number
}

export interface ConsumeAuthTokenInput {
  token: string
  kind: AuthTokenKind
  now?: number
}

const TOKEN_BYTES = 32
const TOKEN_PATTERN = /^[0-9a-f]{64}$/

function asAuthTokenKind(value: unknown): AuthTokenKind {
  if (typeof value !== 'string' || !(AUTH_TOKEN_KINDS as readonly string[]).includes(value)) {
    throw new StoreError('INVALID_AUTH_TOKEN', `kind must be one of ${AUTH_TOKEN_KINDS.join(', ')}`)
  }
  return value as AuthTokenKind
}

/** sha256(token) 十六进制；令牌本身永不落库。 */
export function hashAuthToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function parsePayload(json: string | null): Record<string, unknown> | null {
  if (json === null) return null
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function rowToAuthToken(row: unknown): AuthToken {
  const r = row as {
    id: string
    account_id: string
    kind: string
    payload_json: string | null
    created_at: number | bigint
    expires_at: number | bigint
    used_at: number | bigint | null
  }
  return {
    id: r.id,
    accountId: r.account_id,
    kind: r.kind as AuthTokenKind,
    createdAt: toNumber(r.created_at),
    expiresAt: toNumber(r.expires_at),
    usedAt: r.used_at === null ? null : toNumber(r.used_at),
    payload: parsePayload(r.payload_json),
  }
}

const AUTH_TOKEN_COLUMNS = 'id, account_id, kind, payload_json, created_at, expires_at, used_at'

/**
 * 发一个一次性令牌。返回值里的 `token` 是明文（仅此一次），库里只有 sha256。
 * accountId 不校验存在性：OIDC state 在登录前签发，还没有账号可绑（路由层用哨兵 id）。
 */
export function createAuthToken(store: Store, input: CreateAuthTokenInput): IssuedAuthToken {
  assertOpen(store)
  const req = asRecord(input, 'authToken', 'INVALID_AUTH_TOKEN')
  const accountId = asNonEmptyString(req.accountId, 'authToken.accountId', 'INVALID_AUTH_TOKEN')
  const kind = asAuthTokenKind(req.kind)
  const ttlMs = asInteger(req.ttlMs, 'authToken.ttlMs', 1, 'INVALID_AUTH_TOKEN')
  const now =
    req.now === undefined || req.now === null
      ? Date.now()
      : asInteger(req.now, 'authToken.now', 0, 'INVALID_AUTH_TOKEN')
  const payload =
    req.payload === undefined || req.payload === null
      ? null
      : asRecord(req.payload, 'authToken.payload', 'INVALID_AUTH_TOKEN')

  const token = randomBytes(TOKEN_BYTES).toString('hex')
  const id = newRoostId('atk', now)
  const expiresAt = now + ttlMs

  try {
    store.db
      .prepare(
        `INSERT INTO auth_tokens (id, account_id, kind, token_hash, payload_json, created_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        accountId,
        kind,
        hashAuthToken(token),
        payload === null ? null : JSON.stringify(payload),
        now,
        expiresAt,
      )
  } catch (err) {
    throw new StoreError('AUTH_TOKEN_WRITE_FAILED', `failed to issue ${kind} token: ${errorMessage(err)}`, {
      cause: err,
    })
  }

  return { id, accountId, kind, createdAt: now, expiresAt, usedAt: null, payload, token }
}

/**
 * 消费一个令牌：单次、过期即失效。
 * 用一条带条件的 UPDATE 标记 used_at —— 两个并发请求里只有一个能把 changes 变成 1，
 * 所以不需要额外事务。失败（已用/过期/不存在/kind 不对/格式不对）一律 null。
 */
export function consumeAuthToken(store: Store, input: ConsumeAuthTokenInput): AuthToken | null {
  assertOpen(store)
  const req = asRecord(input, 'authToken', 'INVALID_AUTH_TOKEN')
  if (typeof req.token !== 'string' || !TOKEN_PATTERN.test(req.token)) return null
  const kind = asAuthTokenKind(req.kind)
  const now =
    req.now === undefined || req.now === null
      ? Date.now()
      : asInteger(req.now, 'authToken.now', 0, 'INVALID_AUTH_TOKEN')
  const tokenHash = hashAuthToken(req.token)

  const result = store.db
    .prepare(
      `UPDATE auth_tokens SET used_at = ?
        WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .run(now, tokenHash, kind, now)
  if (Number(result.changes) !== 1) return null

  const row = store.db
    .prepare(`SELECT ${AUTH_TOKEN_COLUMNS} FROM auth_tokens WHERE token_hash = ?`)
    .get(tokenHash)
  return row === undefined || row === null ? null : rowToAuthToken(row)
}
