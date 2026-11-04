// 内部接口鉴权的纯函数测试：header 解析、全局 token、workspace token 命中/过期/吊销、
// 跨 workspace 隔离、失败一律 unauthorized。
//
// 大部分用例用 fake verifier（不需要真库）；最后几条用真 SQLite 验证适配器与生命周期。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import {
  issueRuntimeToken,
  revokeRuntimeToken,
} from '../../../packages/store/src/runtime-tokens.ts'
import {
  authorizeRuntimeRequest,
  runtimeTokenFromRequest,
  storeRuntimeTokenVerifier,
} from '../src/runtime-token.ts'
import type { RuntimeTokenVerifier } from '../src/runtime-token.ts'

const BASE = 1_760_000_000_000
const HOUR = 3_600_000
const GLOBAL = 'global-admin-token'

/** 固定的假校验端口：token → workspace 的映射。 */
function fakeStore(table: Record<string, string>): RuntimeTokenVerifier & { calls: (string | undefined)[][] } {
  const calls: (string | undefined)[][] = []
  return {
    calls,
    verify(token: string, at?: number) {
      calls.push([token, at])
      const workspaceId = table[token]
      return workspaceId === undefined ? null : { id: `rtk_${workspaceId}`, workspaceId }
    },
  }
}

test('没有 header → unauthorized', () => {
  assert.deepEqual(
    authorizeRuntimeRequest({ globalToken: GLOBAL }, { headers: {} }),
    { ok: false, code: 'unauthorized' },
  )
})

test('完全没有 req / headers → unauthorized', () => {
  assert.deepEqual(authorizeRuntimeRequest({ globalToken: GLOBAL }), {
    ok: false,
    code: 'unauthorized',
  })
  assert.deepEqual(authorizeRuntimeRequest({ globalToken: GLOBAL }, null), {
    ok: false,
    code: 'unauthorized',
  })
  assert.deepEqual(authorizeRuntimeRequest({ globalToken: GLOBAL }, {}), {
    ok: false,
    code: 'unauthorized',
  })
})

test('空 header token（empty / 空白 Authorization）→ unauthorized', () => {
  const headers = { 'x-runtime-token': '' }
  assert.deepEqual(authorizeRuntimeRequest({ globalToken: GLOBAL }, { headers }), {
    ok: false,
    code: 'unauthorized',
  })
  // 显式传空串：不 fallback 去读 req（显式值优先）。
  assert.deepEqual(
    authorizeRuntimeRequest(
      { globalToken: GLOBAL, headerToken: '', store: fakeStore({ [GLOBAL]: 'ws_x' }) },
      { headers: { 'x-runtime-token': GLOBAL } },
    ),
    { ok: false, code: 'unauthorized' },
  )
  assert.deepEqual(
    authorizeRuntimeRequest({ globalToken: GLOBAL }, { headers: { authorization: 'Runtime   ' } }),
    { ok: false, code: 'unauthorized' },
  )
})

test('等于全局 token → ok global，workspaceId 为 null', () => {
  assert.deepEqual(
    authorizeRuntimeRequest(
      { globalToken: GLOBAL },
      { headers: { 'x-runtime-token': GLOBAL } },
    ),
    { ok: true, workspaceId: null, kind: 'global' },
  )
})

test('全局 token 比较区分大小写，错一个字符就是 unauthorized', () => {
  for (const bad of [GLOBAL.toUpperCase(), `${GLOBAL} `, GLOBAL.slice(0, -1), 'global-admin-toke']) {
    assert.deepEqual(
      authorizeRuntimeRequest({ globalToken: GLOBAL }, { headers: { 'x-runtime-token': bad } }),
      { ok: false, code: 'unauthorized' },
      `token ${JSON.stringify(bad)} should not pass`,
    )
  }
})

test('未配置全局 token（空/undefined）时，任何 token 都不会被当成 global', () => {
  for (const globalToken of ['', undefined, null]) {
    assert.deepEqual(
      authorizeRuntimeRequest({ globalToken }, { headers: { 'x-runtime-token': '' } }),
      { ok: false, code: 'unauthorized' },
    )
    // 空全局 token 不能被空 header 命中（否则等于没有鉴权）。
    assert.deepEqual(
      authorizeRuntimeRequest({ globalToken }, { headers: { 'x-runtime-token': 'anything' } }),
      { ok: false, code: 'unauthorized' },
    )
  }
})

test('命中 store → ok workspace，带该 token 的 workspaceId', () => {
  const store = fakeStore({ 'ws-a-token': 'ws_a' })
  assert.deepEqual(
    authorizeRuntimeRequest({ globalToken: GLOBAL, store }, { headers: { 'x-runtime-token': 'ws-a-token' } }),
    { ok: true, workspaceId: 'ws_a', kind: 'workspace' },
  )
  assert.deepEqual(store.calls, [['ws-a-token', undefined]])
})

test('store 未命中 → unauthorized（不会降级成 global）', () => {
  const store = fakeStore({ 'ws-a-token': 'ws_a' })
  assert.deepEqual(
    authorizeRuntimeRequest({ globalToken: GLOBAL, store }, { headers: { 'x-runtime-token': 'nope' } }),
    { ok: false, code: 'unauthorized' },
  )
})

test('跨 workspace 隔离：两个 token 各自只得到自己的 workspaceId', () => {
  const store = fakeStore({ 'token-a': 'ws_a', 'token-b': 'ws_b' })
  const a = authorizeRuntimeRequest({ globalToken: GLOBAL, store }, { headers: { 'x-runtime-token': 'token-a' } })
  const b = authorizeRuntimeRequest({ globalToken: GLOBAL, store }, { headers: { 'x-runtime-token': 'token-b' } })
  assert.deepEqual(a, { ok: true, workspaceId: 'ws_a', kind: 'workspace' })
  assert.deepEqual(b, { ok: true, workspaceId: 'ws_b', kind: 'workspace' })
  assert.notEqual(a.ok && a.workspaceId, b.ok && b.workspaceId)
})

test('Authorization: Runtime <token> 也能取到 token；x-runtime-token 优先', () => {
  assert.equal(runtimeTokenFromRequest({ headers: { authorization: 'Runtime abc123' } }), 'abc123')
  assert.equal(runtimeTokenFromRequest({ headers: { authorization: 'Bearer abc123' } }), null)
  assert.equal(
    runtimeTokenFromRequest({
      headers: { 'x-runtime-token': 'primary', authorization: 'Runtime secondary' },
    }),
    'primary',
  )
  // 重复 header（数组）取第一个。
  assert.equal(runtimeTokenFromRequest({ headers: { 'x-runtime-token': ['one', 'two'] } }), 'one')
  // Authorization 路径同样能通过鉴权。
  assert.deepEqual(
    authorizeRuntimeRequest({ globalToken: GLOBAL }, { headers: { authorization: `Runtime ${GLOBAL}` } }),
    { ok: true, workspaceId: null, kind: 'global' },
  )
})

test('headerToken 显式传入时优先于 req 的 header', () => {
  const store = fakeStore({ 'token-a': 'ws_a' })
  assert.deepEqual(
    authorizeRuntimeRequest(
      { globalToken: GLOBAL, store, headerToken: 'token-a' },
      { headers: { 'x-runtime-token': GLOBAL } },
    ),
    { ok: true, workspaceId: 'ws_a', kind: 'workspace' },
  )
})

test('store 返回畸形命中（无 workspaceId / null）→ unauthorized', () => {
  const badVerifiers = [
    { verify: () => null },
    { verify: () => ({ id: 'rtk_1', workspaceId: '' }) },
    { verify: () => ({ id: 'rtk_1' }) as unknown as { id: string; workspaceId: string } },
    { verify: () => undefined as unknown as { id: string; workspaceId: string } },
  ]
  for (const store of badVerifiers) {
    assert.deepEqual(
      authorizeRuntimeRequest({ globalToken: GLOBAL, store }, { headers: { 'x-runtime-token': 't' } }),
      { ok: false, code: 'unauthorized' },
    )
  }
})

test('store 缺 verify / 为 null 时只认全局 token', () => {
  assert.deepEqual(
    authorizeRuntimeRequest(
      { globalToken: GLOBAL, store: null },
      { headers: { 'x-runtime-token': 'ws-a-token' } },
    ),
    { ok: false, code: 'unauthorized' },
  )
  assert.deepEqual(
    authorizeRuntimeRequest(
      { globalToken: GLOBAL, store: {} as RuntimeTokenVerifier },
      { headers: { 'x-runtime-token': 'ws-a-token' } },
    ),
    { ok: false, code: 'unauthorized' },
  )
})

test('now 透传给 store（过期判定由 store 按这个时钟做）', () => {
  const store = fakeStore({ 'token-a': 'ws_a' })
  authorizeRuntimeRequest(
    { globalToken: GLOBAL, store, now: BASE },
    { headers: { 'x-runtime-token': 'token-a' } },
  )
  assert.deepEqual(store.calls, [['token-a', BASE]])
})

test('全局 token 即使同时存在于 store，也按 global 授权（顺序固定、结果可预测）', () => {
  const store = fakeStore({ [GLOBAL]: 'ws_a' })
  assert.deepEqual(
    authorizeRuntimeRequest({ globalToken: GLOBAL, store }, { headers: { 'x-runtime-token': GLOBAL } }),
    { ok: true, workspaceId: null, kind: 'global' },
  )
})

test('真库：签发的 token 能通过鉴权，过期后 unauthorized', () => {
  const store = openStore(':memory:')
  try {
    const issued = issueRuntimeToken(store, { workspaceId: 'ws_real', ttlMs: HOUR, at: BASE })
    const verifier = storeRuntimeTokenVerifier(store)
    assert.deepEqual(
      authorizeRuntimeRequest(
        { globalToken: GLOBAL, store: verifier, now: BASE },
        { headers: { 'x-runtime-token': issued.token } },
      ),
      { ok: true, workspaceId: 'ws_real', kind: 'workspace' },
    )
    // 过期后（同一真库）立刻拒绝。
    assert.deepEqual(
      authorizeRuntimeRequest(
        { globalToken: GLOBAL, store: verifier, now: BASE + HOUR },
        { headers: { 'x-runtime-token': issued.token } },
      ),
      { ok: false, code: 'unauthorized' },
    )
    // 全局 token 仍然可用（旧部署兼容），且 workspaceId 为 null。
    assert.deepEqual(
      authorizeRuntimeRequest(
        { globalToken: GLOBAL, store: verifier, now: BASE + HOUR },
        { headers: { 'x-runtime-token': GLOBAL } },
      ),
      { ok: true, workspaceId: null, kind: 'global' },
    )
  } finally {
    store.close()
  }
})

test('真库：吊销后立即 unauthorized，且不影响别的 workspace', () => {
  const store = openStore(':memory:')
  try {
    const a = issueRuntimeToken(store, { workspaceId: 'ws_a', ttlMs: HOUR, at: BASE })
    const b = issueRuntimeToken(store, { workspaceId: 'ws_b', ttlMs: HOUR, at: BASE })
    const verifier = storeRuntimeTokenVerifier(store)
    revokeRuntimeToken(store, { id: a.id, at: BASE + 1 })

    assert.deepEqual(
      authorizeRuntimeRequest(
        { globalToken: GLOBAL, store: verifier, now: BASE + 2 },
        { headers: { 'x-runtime-token': a.token } },
      ),
      { ok: false, code: 'unauthorized' },
    )
    assert.deepEqual(
      authorizeRuntimeRequest(
        { globalToken: GLOBAL, store: verifier, now: BASE + 2 },
        { headers: { 'x-runtime-token': b.token } },
      ),
      { ok: true, workspaceId: 'ws_b', kind: 'workspace' },
    )
  } finally {
    store.close()
  }
})

test('真库：不存在的 token / 明文 hash / 空串都 unauthorized', () => {
  const store = openStore(':memory:')
  try {
    const issued = issueRuntimeToken(store, { workspaceId: 'ws_real', ttlMs: HOUR, at: BASE })
    const verifier = storeRuntimeTokenVerifier(store)
    for (const token of ['', 'deadbeef', issued.token.toUpperCase(), ' '.repeat(64)]) {
      assert.deepEqual(
        authorizeRuntimeRequest(
          { globalToken: '', store: verifier, now: BASE },
          { headers: { 'x-runtime-token': token } },
        ),
        { ok: false, code: 'unauthorized' },
      )
    }
  } finally {
    store.close()
  }
})
