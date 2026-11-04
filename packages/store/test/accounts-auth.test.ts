import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AUTH_TOKEN_KINDS,
  SCRYPT_KEY_BYTES,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  consumeAuthToken,
  createAccountWithPassword,
  createAuthToken,
  findAccountByEmail,
  findAccountById,
  hashAuthToken,
  hashPassword,
  isEmailShaped,
  markEmailVerified,
  normalizeEmail,
  setPassword,
  upsertOidcAccount,
  verifyPassword,
} from '../src/accounts-auth.ts'
import { assertStoreError, withStore } from './helpers.ts'

const BASE = 1_800_000_000_000
const PASSWORD = 'correct horse battery staple'

// ---- 密码哈希（scrypt）-------------------------------------------------------

test('hashPassword 按契约格式输出，verifyPassword 认对的口令', () => {
  const stored = hashPassword(PASSWORD)
  const parts = stored.split('$')
  assert.equal(parts.length, 6)
  assert.equal(parts[0], 'scrypt')
  assert.equal(Number(parts[1]), SCRYPT_N)
  assert.equal(Number(parts[2]), SCRYPT_R)
  assert.equal(Number(parts[3]), SCRYPT_P)
  assert.equal(SCRYPT_N, 2 ** 15)
  assert.equal(SCRYPT_R, 8)
  assert.equal(SCRYPT_P, 1)
  // salt 16 字节 / hash 64 字节，都是 base64
  assert.equal(Buffer.from(parts[4]!, 'base64').byteLength, 16)
  assert.equal(Buffer.from(parts[5]!, 'base64').byteLength, SCRYPT_KEY_BYTES)

  assert.equal(verifyPassword(PASSWORD, stored), true)
  assert.equal(verifyPassword(`${PASSWORD} `, stored), false)
  assert.equal(verifyPassword('', stored), false)
})

test('同口令两次哈希不同（每次新盐）但都能验证', () => {
  const first = hashPassword(PASSWORD)
  const second = hashPassword(PASSWORD)
  assert.notEqual(first, second)
  assert.equal(verifyPassword(PASSWORD, first), true)
  assert.equal(verifyPassword(PASSWORD, second), true)
})

test('畸形/不可用的存储值返回 false，不抛（登录层不去区分原因）', () => {
  for (const stored of [
    '',
    'plain-text',
    'scrypt$1$2$3',
    'argon2id$m=1,t=1,p=1$c2FsdA==$aGFzaA==',
    'scrypt$999999999$8$1$c2FsdHNhbHQ=$aGFzaGhhc2g=',
    'scrypt$32768$8$1$$',
    'scrypt$32768$0$1$c2FsdHNhbHQ=$aGFzaGhhc2g=',
  ]) {
    assert.equal(verifyPassword(PASSWORD, stored), false, `stored=${stored}`)
  }
  assert.equal(verifyPassword('x', null as unknown as string), false)
  assertStoreError(() => hashPassword(''), 'INVALID_ACCOUNT')
})

// ---- 账号 --------------------------------------------------------------------

test('建号：email 小写去空白、字段齐全、口令可验证', async () => {
  await withStore((store) => {
    const account = createAccountWithPassword(store, {
      email: '  Foo.Bar@Example.COM ',
      password: PASSWORD,
      now: BASE,
    })
    assert.equal(account.email, 'foo.bar@example.com')
    assert.ok(account.id.startsWith('acc_'))
    assert.equal(account.oidcSubject, null)
    assert.equal(account.createdAt, BASE)
    assert.equal(account.disabledAt, null)
    assert.equal(account.emailVerifiedAt, null)
    assert.equal(account.passwordUpdatedAt, BASE)
    assert.equal(typeof account.passwordHash, 'string')
    assert.equal(verifyPassword(PASSWORD, account.passwordHash!), true)

    // 格式化口径一致：normalizeEmail 就是库里存的值
    assert.equal(normalizeEmail('  Foo.Bar@Example.COM '), 'foo.bar@example.com')
  })
})

test('重名（大小写/空白变体）→ ACCOUNT_EXISTS，不覆盖已有口令', async () => {
  await withStore((store) => {
    const created = createAccountWithPassword(store, { email: 'a@example.com', password: PASSWORD, now: BASE })
    assertStoreError(
      () => createAccountWithPassword(store, { email: ' A@Example.com ', password: 'another password!', now: BASE + 1 }),
      'ACCOUNT_EXISTS',
    )
    const found = findAccountById(store, created.id)
    assert.equal(found?.passwordHash, created.passwordHash)
    assert.equal(verifyPassword(PASSWORD, found!.passwordHash!), true)
  })
})

test('非邮箱形状 / 空口令直接报 INVALID_ACCOUNT', async () => {
  await withStore((store) => {
    assertStoreError(
      () => createAccountWithPassword(store, { email: 'not-an-email', password: PASSWORD, now: BASE }),
      'INVALID_ACCOUNT',
    )
    assertStoreError(
      () => createAccountWithPassword(store, { email: 'ok@example.com', password: '', now: BASE }),
      'INVALID_ACCOUNT',
    )
    assert.equal(isEmailShaped('ok@example.com'), true)
    assert.equal(isEmailShaped('ok@example'), false)
    assert.equal(isEmailShaped(42), false)
  })
})

test('findAccountByEmail / findAccountById：命中与未命中', async () => {
  await withStore((store) => {
    const created = createAccountWithPassword(store, { email: 'b@example.com', password: PASSWORD, now: BASE })
    const byEmail = findAccountByEmail(store, ' B@Example.com ')
    assert.equal(byEmail?.id, created.id)
    assert.equal(findAccountById(store, created.id)?.email, 'b@example.com')
    assert.equal(findAccountByEmail(store, 'nobody@example.com'), null)
    assert.equal(findAccountById(store, 'acc_missing'), null)
  })
})

test('markEmailVerified 幂等（保留第一次时间），未知账号 ACCOUNT_NOT_FOUND', async () => {
  await withStore((store) => {
    const created = createAccountWithPassword(store, { email: 'c@example.com', password: PASSWORD, now: BASE })
    const verified = markEmailVerified(store, created.id, BASE + 1000)
    assert.equal(verified.emailVerifiedAt, BASE + 1000)
    const again = markEmailVerified(store, created.id, BASE + 5000)
    assert.equal(again.emailVerifiedAt, BASE + 1000)
    assertStoreError(() => markEmailVerified(store, 'acc_missing', BASE), 'ACCOUNT_NOT_FOUND')
  })
})

test('setPassword 换哈希、刷新 password_updated_at、旧口令失效', async () => {
  await withStore((store) => {
    const created = createAccountWithPassword(store, { email: 'd@example.com', password: PASSWORD, now: BASE })
    const next = 'a brand new passphrase'
    const updated = setPassword(store, created.id, next, BASE + 60_000)
    assert.equal(updated.passwordUpdatedAt, BASE + 60_000)
    assert.notEqual(updated.passwordHash, created.passwordHash)
    assert.equal(verifyPassword(next, updated.passwordHash!), true)
    assert.equal(verifyPassword(PASSWORD, updated.passwordHash!), false)
    assertStoreError(() => setPassword(store, 'acc_missing', next, BASE), 'ACCOUNT_NOT_FOUND')
  })
})

test('upsertOidcAccount：新建 OIDC-only 账号（无密码、邮箱已验证）', async () => {
  await withStore((store) => {
    const account = upsertOidcAccount(store, { subject: 'sub-1', email: 'Oidc@Example.com', now: BASE })
    assert.ok(account.id.startsWith('acc_'))
    assert.equal(account.email, 'oidc@example.com')
    assert.equal(account.oidcSubject, 'sub-1')
    assert.equal(account.passwordHash, null)
    assert.equal(account.passwordUpdatedAt, null)
    assert.equal(account.emailVerifiedAt, BASE)

    // 同一个 subject 再来：同账号，不会新建
    const again = upsertOidcAccount(store, { subject: 'sub-1', email: 'changed@example.com', now: BASE + 1 })
    assert.equal(again.id, account.id)
    assert.equal(again.email, 'oidc@example.com')
  })
})

test('upsertOidcAccount：同邮箱的 OIDC-only 账号会被绑定；密码账号拒绝自动合并', async () => {
  await withStore((store) => {
    const oidcOnly = upsertOidcAccount(store, { subject: 'sub-a', email: 'bind@example.com', now: BASE })
    // 先给一个「无密码」状态（模拟历史 OIDC 账号没有 subject 的极端情况）
    store.db.prepare('UPDATE accounts SET oidc_subject = NULL WHERE id = ?').run(oidcOnly.id)
    const rebound = upsertOidcAccount(store, { subject: 'sub-b', email: 'bind@example.com', now: BASE + 10 })
    assert.equal(rebound.id, oidcOnly.id)
    assert.equal(rebound.oidcSubject, 'sub-b')
    assert.equal(rebound.emailVerifiedAt, BASE) // COALESCE 保留第一次验证时间

    const withPassword = createAccountWithPassword(store, { email: 'pw@example.com', password: PASSWORD, now: BASE })
    assertStoreError(
      () => upsertOidcAccount(store, { subject: 'sub-c', email: 'pw@example.com', now: BASE + 20 }),
      'ACCOUNT_EXISTS',
    )
    // 原账号没有被改写
    assert.equal(findAccountById(store, withPassword.id)?.oidcSubject, null)
  })
})

// ---- 一次性令牌 --------------------------------------------------------------

test('createAuthToken 返回明文一次，库里只有 sha256(token)', async () => {
  await withStore((store) => {
    const account = createAccountWithPassword(store, { email: 'e@example.com', password: PASSWORD, now: BASE })
    const issued = createAuthToken(store, {
      accountId: account.id,
      kind: 'email_verify',
      ttlMs: 60_000,
      payload: { next: '/' },
      now: BASE,
    })

    assert.match(issued.token, /^[0-9a-f]{64}$/)
    assert.equal(issued.accountId, account.id)
    assert.equal(issued.kind, 'email_verify')
    assert.equal(issued.createdAt, BASE)
    assert.equal(issued.expiresAt, BASE + 60_000)
    assert.equal(issued.usedAt, null)
    assert.deepEqual(issued.payload, { next: '/' })
    assert.deepEqual(AUTH_TOKEN_KINDS, ['email_verify', 'password_reset', 'oidc_state'])

    const row = store.db
      .prepare('SELECT token_hash, payload_json, used_at FROM auth_tokens WHERE id = ?')
      .get(issued.id) as { token_hash: string; payload_json: string | null; used_at: number | null }
    assert.equal(row.token_hash, hashAuthToken(issued.token))
    assert.notEqual(row.token_hash, issued.token)
    assert.deepEqual(JSON.parse(row.payload_json!), { next: '/' })
    assert.equal(row.used_at, null)

    // 明文不在库里
    const plaintext = store.db.prepare('SELECT COUNT(*) AS n FROM auth_tokens WHERE token_hash = ?').get(issued.token) as {
      n: number
    }
    assert.equal(plaintext.n, 0)
  })
})

test('consumeAuthToken 单次：第二次返回 null，kind 不对不消耗', async () => {
  await withStore((store) => {
    const account = createAccountWithPassword(store, { email: 'f@example.com', password: PASSWORD, now: BASE })
    const issued = createAuthToken(store, {
      accountId: account.id,
      kind: 'password_reset',
      ttlMs: 60_000,
      payload: { note: 'x' },
      now: BASE,
    })

    // kind 不匹配：不消费，也不消耗令牌
    assert.equal(consumeAuthToken(store, { token: issued.token, kind: 'email_verify', now: BASE + 10 }), null)

    const consumed = consumeAuthToken(store, { token: issued.token, kind: 'password_reset', now: BASE + 10 })
    assert.ok(consumed !== null)
    assert.equal(consumed.id, issued.id)
    assert.equal(consumed.accountId, account.id)
    assert.equal(consumed.usedAt, BASE + 10)
    assert.deepEqual(consumed.payload, { note: 'x' })

    assert.equal(consumeAuthToken(store, { token: issued.token, kind: 'password_reset', now: BASE + 20 }), null)
    // 令牌记录本身还在（审计用），只是 used_at 已置
    const row = store.db.prepare('SELECT used_at FROM auth_tokens WHERE id = ?').get(issued.id) as {
      used_at: number | null
    }
    assert.equal(Number(row.used_at), BASE + 10)
  })
})

test('过期令牌返回 null 且不置 used_at；非法 token 直接 null', async () => {
  await withStore((store) => {
    const account = createAccountWithPassword(store, { email: 'g@example.com', password: PASSWORD, now: BASE })
    const issued = createAuthToken(store, {
      accountId: account.id,
      kind: 'email_verify',
      ttlMs: 1000,
      now: BASE,
    })
    assert.equal(consumeAuthToken(store, { token: issued.token, kind: 'email_verify', now: BASE + 1000 }), null)
    // 过期失败不会把令牌烧掉
    const before = store.db.prepare('SELECT used_at FROM auth_tokens WHERE id = ?').get(issued.id) as {
      used_at: number | null
    }
    assert.equal(before.used_at, null)
    // 到期前一刻仍然可用（expires_at > now）
    assert.equal(consumeAuthToken(store, { token: issued.token, kind: 'email_verify', now: BASE + 999 }) !== null, true)

    assert.equal(consumeAuthToken(store, { token: 'not-a-token', kind: 'email_verify', now: BASE }), null)
    assert.equal(consumeAuthToken(store, { token: 'a'.repeat(64), kind: 'email_verify', now: BASE }), null)
    assertStoreError(
      () => consumeAuthToken(store, { token: issued.token, kind: 'nope' as never, now: BASE }),
      'INVALID_AUTH_TOKEN',
    )
    // 缺 kind 的令牌参数校验
    assertStoreError(
      () => createAuthToken(store, { accountId: account.id, kind: 'email_verify', ttlMs: 0, now: BASE }),
      'INVALID_AUTH_TOKEN',
    )
  })
})

// ---- 迁移 0019 ---------------------------------------------------------------

test('0019 迁移：accounts 两列 + auth_tokens 唯一索引', async () => {
  await withStore((store) => {
    const accountColumns = (store.db.prepare('PRAGMA table_info(accounts)').all() as { name: string }[]).map(
      (row) => row.name,
    )
    assert.ok(accountColumns.includes('email_verified_at'), 'missing accounts.email_verified_at')
    assert.ok(accountColumns.includes('password_updated_at'), 'missing accounts.password_updated_at')

    const indexes = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'auth_tokens'")
      .all() as { name: string }[]
    assert.ok(indexes.some((row) => row.name === 'idx_auth_tokens_hash'))
    assert.ok(indexes.some((row) => row.name === 'idx_auth_tokens_account'))

    const unique = store.db.prepare('PRAGMA index_list(auth_tokens)').all() as { name: string; unique: number }[]
    assert.equal(unique.find((row) => row.name === 'idx_auth_tokens_hash')?.unique, 1)
  })
})
