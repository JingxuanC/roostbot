// workspace 列表/创建 + Bearer 鉴权 + 会话过期。
import assert from 'node:assert/strict'
import test from 'node:test'
import { SESSION_TTL_MS, hashSessionToken } from '../src/server.ts'
import { TEST_ACCOUNT, pairDevice, startHarness } from './helpers.ts'

test('GET /api/workspaces 无 token → 401 unauthenticated + www-authenticate', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const result = await harness.call('GET', '/api/workspaces')
  assert.equal(result.status, 401)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error.code, 'unauthenticated')
  assert.equal(result.headers.get('www-authenticate'), 'Bearer')
})

test('错误/伪造的 token → 401，且不会建出 workspace', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const cases = [
    'deadbeef',
    'a'.repeat(64),
    'A'.repeat(64),
    'f'.repeat(63),
    'g'.repeat(64)
  ]
  for (const token of cases) {
    const result = await harness.call('GET', '/api/workspaces', { token })
    assert.equal(result.status, 401, `token=${token.slice(0, 12)}…`)
    assert.equal(result.json.error.code, 'unauthenticated')
  }

  const created = await harness.call('POST', '/api/workspaces', { token: 'a'.repeat(64), body: { name: 'Nope' } })
  assert.equal(created.status, 401)
  const list = await harness.store.listWorkspaces({ accountId: TEST_ACCOUNT })
  assert.equal(list.length, 0)
})

test('配对 → claim → 建 workspace → 带 token 列出来', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const token = await pairDevice(harness)

  const empty = await harness.call('GET', '/api/workspaces', { token })
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.json.workspaces, [])

  const created = await harness.call('POST', '/api/workspaces', { token, body: { name: 'Harbor' } })
  assert.equal(created.status, 201)
  const workspace = created.json.workspace
  assert.match(workspace.id, /^ws_[0-9a-f]{18}$/)
  assert.equal(workspace.name, 'Harbor')
  assert.equal(workspace.homeMode, 'local')
  assert.equal(workspace.state, 'stopped')
  assert.equal(workspace.role, 'owner')
  assert.equal(workspace.tenantId, TEST_ACCOUNT)
  assert.equal(typeof workspace.profileVersion, 'string')
  assert.equal(typeof workspace.createdAt, 'number')

  const listed = await harness.call('GET', '/api/workspaces', { token })
  assert.equal(listed.status, 200)
  assert.equal(listed.json.workspaces.length, 1)
  assert.deepEqual(listed.json.workspaces[0], workspace)

  // token 绝不出现在 workspace 响应里
  const raw = JSON.stringify(listed.json)
  assert.equal(raw.includes(token), false)
  assert.equal(raw.includes(hashSessionToken(token)), false)
})

test('多个 workspace 按 createdAt 升序返回，homeMode 可显式指定', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const token = await pairDevice(harness)

  const first = await harness.call('POST', '/api/workspaces', {
    token,
    body: { name: 'Local Nest', homeMode: 'local' }
  })
  assert.equal(first.status, 201)
  assert.equal(first.json.workspace.homeMode, 'local')

  harness.clock.advance(1000)
  const second = await harness.call('POST', '/api/workspaces', {
    token,
    body: { name: 'Cloud Nest', homeMode: 'cloud' }
  })
  assert.equal(second.status, 201)
  assert.equal(second.json.workspace.homeMode, 'cloud')

  const listed = await harness.call('GET', '/api/workspaces', { token })
  assert.deepEqual(
    listed.json.workspaces.map((w: any) => w.name),
    ['Local Nest', 'Cloud Nest']
  )
})

test('POST /api/workspaces：名字缺失/空白/过长 → 400，homeMode 非法 → 400', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const token = await pairDevice(harness)

  for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(121) }, { name: 42 }]) {
    const result = await harness.call('POST', '/api/workspaces', { token, body })
    assert.equal(result.status, 400, JSON.stringify(body))
    assert.equal(result.json.error.code, 'invalid_body')
  }

  const badMode = await harness.call('POST', '/api/workspaces', { token, body: { name: 'ok', homeMode: 'edge' } })
  assert.equal(badMode.status, 400)
  assert.equal(badMode.json.error.code, 'invalid_body')
})

test('会话过期 → 401 session_expired', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const token = await pairDevice(harness)
  const ok = await harness.call('GET', '/api/workspaces', { token })
  assert.equal(ok.status, 200)

  harness.clock.advance(SESSION_TTL_MS + 1)
  const expired = await harness.call('GET', '/api/workspaces', { token })
  assert.equal(expired.status, 401)
  assert.equal(expired.json.error.code, 'session_expired')
})

test('token 大小写敏感：同值大写不算同一个会话', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const token = await pairDevice(harness)
  const upper = await harness.call('GET', '/api/workspaces', { token: token.toUpperCase() })
  assert.equal(upper.status, 401)
  assert.equal(upper.json.error.code, 'unauthenticated')
})
