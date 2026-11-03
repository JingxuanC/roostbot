// 配对：6 位码 / 5 分钟 / 单次 / 失败 401 / 尝试过多 429。
import assert from 'node:assert/strict'
import test from 'node:test'
import { PAIRING_CODE_TTL_MS, PAIRING_LOCK_MS, SESSION_TTL_MS, hashSessionToken } from '../src/server.ts'
import { TEST_ACCOUNT, startHarness } from './helpers.ts'

test('签发配对码：6 位数字，5 分钟后过期', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const result = await harness.call('POST', '/api/pairing/code', { body: { accountId: TEST_ACCOUNT } })
  assert.equal(result.status, 200)
  assert.match(result.json.code, /^\d{6}$/)
  assert.equal(result.json.expiresAt, harness.clock.now() + PAIRING_CODE_TTL_MS)
})

test('claim 成功：设备 id + 32 字节 hex 会话 token，且 token 只以 hash 落库', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const minted = await harness.call('POST', '/api/pairing/code', { body: { accountId: TEST_ACCOUNT } })
  const claimed = await harness.call('POST', '/api/pairing/claim', { body: { code: minted.json.code } })

  assert.equal(claimed.status, 200)
  assert.match(claimed.json.deviceId, /^dev_[0-9a-f]{18}$/)
  assert.match(claimed.json.sessionToken, /^[0-9a-f]{64}$/)
  assert.equal(claimed.json.expiresAt, harness.clock.now() + SESSION_TTL_MS)

  const token = claimed.json.sessionToken
  const session = await harness.store.findSessionByToken(hashSessionToken(token))
  assert.ok(session !== null)
  assert.notEqual(session.tokenHash, token)
  assert.equal(session.tokenHash, hashSessionToken(token))
  assert.equal(session.deviceId, claimed.json.deviceId)
  assert.equal(session.accountId, TEST_ACCOUNT)
})

test('同一个码只能换一次会话：重复 claim → 401 pairing_code_used', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const minted = await harness.call('POST', '/api/pairing/code', { body: { accountId: TEST_ACCOUNT } })
  const first = await harness.call('POST', '/api/pairing/claim', { body: { code: minted.json.code } })
  assert.equal(first.status, 200)

  const second = await harness.call('POST', '/api/pairing/claim', { body: { code: minted.json.code } })
  assert.equal(second.status, 401)
  assert.equal(second.json.ok, false)
  assert.equal(second.json.error.code, 'pairing_code_used')
  assert.notEqual(second.json.sessionToken, first.json.sessionToken)
})

test('不存在的码 → 401 pairing_code_invalid', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const result = await harness.call('POST', '/api/pairing/claim', { body: { code: '000000' } })
  assert.equal(result.status, 401)
  assert.equal(result.json.error.code, 'pairing_code_invalid')
})

test('格式不对的码 → 400 invalid_body（不是 401，也不是 500）', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  for (const code of ['12345', '1234567', 'abcdef', 123456, null] as const) {
    const result = await harness.call('POST', '/api/pairing/claim', { body: { code } })
    assert.equal(result.status, 400, `code=${String(code)}`)
    assert.equal(result.json.error.code, 'invalid_body')
  }
})

test('过期的码 → 401 pairing_code_expired', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const minted = await harness.call('POST', '/api/pairing/code', { body: { accountId: TEST_ACCOUNT } })
  harness.clock.advance(PAIRING_CODE_TTL_MS + 1)

  const result = await harness.call('POST', '/api/pairing/claim', { body: { code: minted.json.code } })
  assert.equal(result.status, 401)
  assert.equal(result.json.error.code, 'pairing_code_expired')
})

test('同一个码错满 5 次 → 429 pairing_code_locked，并带 retry-after', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const minted = await harness.call('POST', '/api/pairing/code', { body: { accountId: TEST_ACCOUNT } })
  harness.clock.advance(PAIRING_CODE_TTL_MS + 1)

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = await harness.call('POST', '/api/pairing/claim', { body: { code: minted.json.code } })
    assert.equal(result.status, 401, `第 ${attempt} 次失败`)
    assert.equal(result.json.error.code, 'pairing_code_expired')
  }

  const fifth = await harness.call('POST', '/api/pairing/claim', { body: { code: minted.json.code } })
  assert.equal(fifth.status, 429)
  assert.equal(fifth.json.error.code, 'pairing_code_locked')
  assert.equal(fifth.headers.get('retry-after'), String(Math.ceil(PAIRING_LOCK_MS / 1000)))

  const sixth = await harness.call('POST', '/api/pairing/claim', { body: { code: minted.json.code } })
  assert.equal(sixth.status, 429)
  assert.equal(sixth.json.error.code, 'pairing_code_locked')
})

test('全局失败窗口：20 次乱猜后 429 too_many_attempts', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = String(attempt).padStart(6, '0')
    const result = await harness.call('POST', '/api/pairing/claim', { body: { code } })
    assert.equal(result.status, 401, `第 ${attempt + 1} 次`)
    assert.equal(result.json.error.code, 'pairing_code_invalid')
  }

  const blocked = await harness.call('POST', '/api/pairing/claim', { body: { code: '999999' } })
  assert.equal(blocked.status, 429)
  assert.equal(blocked.json.error.code, 'too_many_attempts')
  assert.ok(Number(blocked.headers.get('retry-after')) > 0)
})

test('配对码可以绑定 workspace：会话继承 workspaceId', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const minted = await harness.call('POST', '/api/pairing/code', {
    body: { accountId: TEST_ACCOUNT, workspaceId: 'ws_demo' }
  })
  const claimed = await harness.call('POST', '/api/pairing/claim', { body: { code: minted.json.code } })
  assert.equal(claimed.status, 200)

  const session = await harness.store.findSessionByToken(hashSessionToken(claimed.json.sessionToken))
  assert.equal(session?.workspaceId, 'ws_demo')
})

test('claim 可带 deviceLabel / platform，非法 platform → 400', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const minted = await harness.call('POST', '/api/pairing/code', { body: { accountId: TEST_ACCOUNT } })
  const claimed = await harness.call('POST', '/api/pairing/claim', {
    body: { code: minted.json.code, deviceLabel: 'paopao 的 MacBook', platform: 'desktop' }
  })
  assert.equal(claimed.status, 200)

  const other = await harness.call('POST', '/api/pairing/code', { body: { accountId: TEST_ACCOUNT } })
  const bad = await harness.call('POST', '/api/pairing/claim', {
    body: { code: other.json.code, platform: 'toaster' }
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'invalid_body')
})
