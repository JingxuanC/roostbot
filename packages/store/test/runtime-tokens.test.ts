// 每 workspace 短期 runtime token：hash 落库、过期/吊销即失效、按 workspace 隔离。
//
// 真库（临时目录 + SQLite），不 mock。时间全部显式传 `at`，不依赖系统时钟。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  hashRuntimeToken,
  issueRuntimeToken,
  revokeRuntimeToken,
  revokeRuntimeTokens,
  verifyRuntimeToken,
} from '../src/runtime-tokens.ts'
import { assertStoreError, withStore } from './helpers.ts'

const BASE = 1_760_000_000_000
const HOUR = 3_600_000

test('签发后能按明文校验；库里只有 hash，没有明文', async () => {
  await withStore((store) => {
    const issued = issueRuntimeToken(store, { workspaceId: 'ws_1', ttlMs: HOUR, at: BASE })
    assert.equal(issued.workspaceId, 'ws_1')
    assert.equal(issued.expiresAt, BASE + HOUR)
    assert.match(issued.token, /^[0-9a-f]{64}$/)

    const verified = verifyRuntimeToken(store, { token: issued.token, at: BASE })
    assert.deepEqual(verified, { id: issued.id, workspaceId: 'ws_1' })

    const row = store.db
      .prepare('SELECT token_hash, issued_at, expires_at, revoked_at FROM runtime_tokens WHERE id = ?')
      .get(issued.id) as { token_hash: string; issued_at: number; expires_at: number; revoked_at: null }
    assert.equal(row.token_hash, hashRuntimeToken(issued.token))
    assert.notEqual(row.token_hash, issued.token)
    assert.equal(row.issued_at, BASE)
    assert.equal(row.expires_at, BASE + HOUR)
    assert.equal(row.revoked_at, null)

    // 明文不在任何列里：按明文当 hash 查不到。
    assert.equal(verifyRuntimeToken(store, { token: row.token_hash, at: BASE }), null)
  })
})

test('每次签发的 token 与 id 都不同（32 字节随机）', async () => {
  await withStore((store) => {
    const first = issueRuntimeToken(store, { workspaceId: 'ws_1', ttlMs: HOUR, at: BASE })
    const second = issueRuntimeToken(store, { workspaceId: 'ws_1', ttlMs: HOUR, at: BASE })
    assert.notEqual(first.token, second.token)
    assert.notEqual(first.id, second.id)
    // 同一 workspace 可以同时有多个有效 token（滚动轮换期）。
    assert.equal(verifyRuntimeToken(store, { token: first.token, at: BASE })?.workspaceId, 'ws_1')
    assert.equal(verifyRuntimeToken(store, { token: second.token, at: BASE })?.workspaceId, 'ws_1')
  })
})

test('过期边界：expiresAt 前 1ms 有效，等于 expiresAt 即失效', async () => {
  await withStore((store) => {
    const issued = issueRuntimeToken(store, { workspaceId: 'ws_1', ttlMs: HOUR, at: BASE })
    assert.ok(verifyRuntimeToken(store, { token: issued.token, at: BASE + HOUR - 1 }))
    assert.equal(verifyRuntimeToken(store, { token: issued.token, at: BASE + HOUR }), null)
    assert.equal(verifyRuntimeToken(store, { token: issued.token, at: BASE + 2 * HOUR }), null)
  })
})

test('吊销单个 token 后立即失效，返回第一次的 revokedAt', async () => {
  await withStore((store) => {
    const issued = issueRuntimeToken(store, { workspaceId: 'ws_1', ttlMs: HOUR, at: BASE })
    const revoked = revokeRuntimeToken(store, { id: issued.id, at: BASE + 1000 })
    assert.deepEqual(revoked, { id: issued.id, workspaceId: 'ws_1', revokedAt: BASE + 1000 })
    assert.equal(verifyRuntimeToken(store, { token: issued.token, at: BASE + 1001 }), null)

    // 吊销行还在（审计要能区分过期与吊销）。
    const row = store.db
      .prepare('SELECT revoked_at FROM runtime_tokens WHERE id = ?')
      .get(issued.id) as { revoked_at: number }
    assert.equal(row.revoked_at, BASE + 1000)
  })
})

test('重复吊销幂等：不覆盖时间戳', async () => {
  await withStore((store) => {
    const issued = issueRuntimeToken(store, { workspaceId: 'ws_1', ttlMs: HOUR, at: BASE })
    revokeRuntimeToken(store, { id: issued.id, at: BASE + 1000 })
    const again = revokeRuntimeToken(store, { id: issued.id, at: BASE + 5000 })
    assert.equal(again.revokedAt, BASE + 1000)
  })
})

test('吊销不存在的 id 抛 RUNTIME_TOKEN_NOT_FOUND', async () => {
  await withStore((store) => {
    assertStoreError(
      () => revokeRuntimeToken(store, { id: 'rtk_missing', at: BASE }),
      'RUNTIME_TOKEN_NOT_FOUND',
    )
  })
})

test('按 workspace 批量吊销：只影响该 workspace，条数可计数，重复调用为 0', async () => {
  await withStore((store) => {
    const a1 = issueRuntimeToken(store, { workspaceId: 'ws_a', ttlMs: HOUR, at: BASE })
    const a2 = issueRuntimeToken(store, { workspaceId: 'ws_a', ttlMs: HOUR, at: BASE })
    const b1 = issueRuntimeToken(store, { workspaceId: 'ws_b', ttlMs: HOUR, at: BASE })

    assert.deepEqual(revokeRuntimeTokens(store, { workspaceId: 'ws_a', at: BASE + 1 }), { revoked: 2 })
    assert.equal(verifyRuntimeToken(store, { token: a1.token, at: BASE + 1 }), null)
    assert.equal(verifyRuntimeToken(store, { token: a2.token, at: BASE + 1 }), null)
    // 另一个 workspace 不受影响（跨 workspace 隔离）。
    assert.deepEqual(verifyRuntimeToken(store, { token: b1.token, at: BASE + 1 }), {
      id: b1.id,
      workspaceId: 'ws_b',
    })
    // 再吊销一次：没有新增。
    assert.deepEqual(revokeRuntimeTokens(store, { workspaceId: 'ws_a', at: BASE + 2 }), { revoked: 0 })
    // 从未签发过的 workspace：0，不抛错。
    assert.deepEqual(revokeRuntimeTokens(store, { workspaceId: 'ws_none', at: BASE }), { revoked: 0 })
  })
})

test('跨 workspace 隔离：每个 token 只能校验出自己的 workspaceId', async () => {
  await withStore((store) => {
    const a = issueRuntimeToken(store, { workspaceId: 'ws_a', ttlMs: HOUR, at: BASE })
    const b = issueRuntimeToken(store, { workspaceId: 'ws_b', ttlMs: HOUR, at: BASE })
    assert.equal(verifyRuntimeToken(store, { token: a.token, at: BASE })?.workspaceId, 'ws_a')
    assert.equal(verifyRuntimeToken(store, { token: b.token, at: BASE })?.workspaceId, 'ws_b')
    // 不存在的 token 不会 fallback 到任何 workspace。
    assert.equal(verifyRuntimeToken(store, { token: 'deadbeef', at: BASE }), null)
  })
})

test('空/畸形 token 返回 null，不抛错（输入来自请求头）', async () => {
  await withStore((store) => {
    issueRuntimeToken(store, { workspaceId: 'ws_1', ttlMs: HOUR, at: BASE })
    assert.equal(verifyRuntimeToken(store, { token: '', at: BASE }), null)
    assert.equal(verifyRuntimeToken(store, { token: ' '.repeat(8), at: BASE }), null)
    assert.equal(verifyRuntimeToken(store, { token: 123 as unknown as string, at: BASE }), null)
    assert.equal(verifyRuntimeToken(store, { token: null as unknown as string, at: BASE }), null)
  })
})

test('输入校验：ttlMs、workspaceId、id、at 不合法抛 INVALID_RUNTIME_TOKEN', async () => {
  await withStore((store) => {
    assertStoreError(
      () => issueRuntimeToken(store, { workspaceId: 'ws_1', ttlMs: 0, at: BASE }),
      'INVALID_RUNTIME_TOKEN',
    )
    assertStoreError(
      () => issueRuntimeToken(store, { workspaceId: '  ', ttlMs: HOUR, at: BASE }),
      'INVALID_RUNTIME_TOKEN',
    )
    assertStoreError(
      () => issueRuntimeToken(store, { workspaceId: 'ws_1', ttlMs: HOUR, at: -1 }),
      'INVALID_RUNTIME_TOKEN',
    )
    assertStoreError(
      () => revokeRuntimeToken(store, { id: '', at: BASE }),
      'INVALID_RUNTIME_TOKEN',
    )
    assertStoreError(
      () => revokeRuntimeTokens(store, { workspaceId: '', at: BASE }),
      'INVALID_RUNTIME_TOKEN',
    )
    assertStoreError(() => verifyRuntimeToken(store, { token: 'x', at: -1 }), 'INVALID_RUNTIME_TOKEN')
  })
})

test('关库后读写抛 STORE_CLOSED', async () => {
  await withStore((store) => {
    const issued = issueRuntimeToken(store, { workspaceId: 'ws_1', ttlMs: HOUR, at: BASE })
    store.close()
    assertStoreError(
      () => issueRuntimeToken(store, { workspaceId: 'ws_1', ttlMs: HOUR, at: BASE }),
      'STORE_CLOSED',
    )
    assertStoreError(() => verifyRuntimeToken(store, { token: issued.token, at: BASE }), 'STORE_CLOSED')
    assertStoreError(() => revokeRuntimeToken(store, { id: issued.id, at: BASE }), 'STORE_CLOSED')
    assertStoreError(() => revokeRuntimeTokens(store, { workspaceId: 'ws_1', at: BASE }), 'STORE_CLOSED')
  })
})

test('迁移建了表和索引，token_hash 在库层唯一', async () => {
  await withStore((store) => {
    const indexes = store.db.prepare("PRAGMA index_list('runtime_tokens')").all() as {
      name: string
      unique: number
    }[]
    assert.ok(indexes.some((row) => row.name === 'idx_runtime_tokens_workspace'))
    // token_hash UNIQUE：SQLite 的自动唯一索引 origin='u'，PRAGMA 里看 unique=1。
    assert.ok(indexes.some((row) => row.unique === 1))

    const issued = issueRuntimeToken(store, { workspaceId: 'ws_1', ttlMs: HOUR, at: BASE })
    assert.throws(() =>
      store.db
        .prepare(
          'INSERT INTO runtime_tokens (id, workspace_id, token_hash, issued_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)',
        )
        .run('rtk_dup', 'ws_2', hashRuntimeToken(issued.token), BASE, BASE + HOUR),
    )
  })
})
