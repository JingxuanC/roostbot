// M5 认证加固：配对码签发鉴权（5.3.7）、会话续期（5.3.5）、设备 API（5.3.4）。
import assert from 'node:assert/strict'
import test from 'node:test'

import { findSessionByTokenHash, readEvents } from '../../../packages/store/src/index.ts'
import {
  SESSION_MAX_AGE_MS,
  SESSION_RENEW_WINDOW_MS,
  SESSION_TTL_MS,
  hashSessionToken,
} from '../src/server.ts'
import { TEST_ACCOUNT, pairDevice, startHarness, startSqliteHarness } from './helpers.ts'

async function mint(harness: Awaited<ReturnType<typeof startSqliteHarness>>, body: Record<string, unknown>, token?: string) {
  return harness.call('POST', '/api/pairing/code', {
    body,
    ...(token === undefined ? {} : { token }),
  })
}

test('配对码 bootstrap：首配可无会话签发；账号有会话后必须带 Bearer', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  // 全新账号：回环 + 无会话 → bootstrap 放行。
  const first = await harness.call('POST', '/api/pairing/code', { body: { accountId: TEST_ACCOUNT } })
  assert.equal(first.status, 200)

  const token = await pairDevice(harness)

  // 同账号已有会话：无 Bearer 再签发 → 403。
  const denied = await harness.call('POST', '/api/pairing/code', { body: { accountId: TEST_ACCOUNT } })
  assert.equal(denied.status, 403)
  assert.equal(denied.json.error.code, 'pairing_forbidden')

  // 带有效会话 → 放行。
  const allowed = await harness.call('POST', '/api/pairing/code', {
    body: { accountId: TEST_ACCOUNT },
    token,
  })
  assert.equal(allowed.status, 200)

  // 另一个全新账号仍可走 bootstrap。
  const other = await harness.call('POST', '/api/pairing/code', { body: { accountId: 'acc_other' } })
  assert.equal(other.status, 200)
})

test('配对码签发：Bearer 账号与 body.accountId 不一致 → 403', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const token = await pairDevice(harness)
  const result = await harness.call('POST', '/api/pairing/code', {
    body: { accountId: 'acc_someone_else' },
    token,
  })
  assert.equal(result.status, 403)
  assert.equal(result.json.error.code, 'pairing_forbidden')
})

test('配对码签发：workspace 必须是该账号 owner/admin', async (t) => {
  const harness = await startSqliteHarness()
  t.after(() => harness.close())
  const raw = harness.rawStore
  assert.ok(raw !== undefined)

  const token = await pairDevice(harness)
  const created = await harness.call('POST', '/api/workspaces', { body: { name: '量化研究组' }, token })
  assert.equal(created.status, 201)
  const workspaceId = created.json.workspace.id as string

  const ownerMint = await mint(harness, { accountId: TEST_ACCOUNT, workspaceId }, token)
  assert.equal(ownerMint.status, 200)

  const unknown = await mint(harness, { accountId: TEST_ACCOUNT, workspaceId: 'ws_missing' }, token)
  assert.equal(unknown.status, 403)
  assert.equal(unknown.json.error.code, 'pairing_forbidden')

  // 降级成 member：不再是 owner/admin，签发被拒。
  raw.db
    .prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?')
    .run('member', workspaceId, TEST_ACCOUNT)
  const memberMint = await mint(harness, { accountId: TEST_ACCOUNT, workspaceId }, token)
  assert.equal(memberMint.status, 403)
  assert.equal(memberMint.json.error.code, 'pairing_forbidden')
})

test('会话续期：剩余 <15 天时续到 createdAt+180 天（不提前续、不缩短）', async (t) => {
  const harness = await startSqliteHarness()
  t.after(() => harness.close())
  const raw = harness.rawStore
  assert.ok(raw !== undefined)

  const token = await pairDevice(harness)
  const hash = hashSessionToken(token)
  const createdAt = harness.clock.now()
  const initial = findSessionByTokenHash(raw, hash)
  assert.ok(initial !== null)
  assert.equal(initial.createdAt, createdAt)
  assert.equal(initial.expiresAt, createdAt + SESSION_TTL_MS)

  // 剩余还有 30 天：不续。
  const early = await harness.call('GET', '/api/workspaces', { token })
  assert.equal(early.status, 200)
  assert.equal(findSessionByTokenHash(raw, hash)!.expiresAt, createdAt + SESSION_TTL_MS)

  // 剩余 16 天：仍未进入续期窗口。
  harness.clock.advance(SESSION_TTL_MS - SESSION_RENEW_WINDOW_MS - 24 * 60 * 60 * 1000)
  const beforeWindow = await harness.call('GET', '/api/workspaces', { token })
  assert.equal(beforeWindow.status, 200)
  assert.equal(findSessionByTokenHash(raw, hash)!.expiresAt, createdAt + SESSION_TTL_MS)

  // 剩余 15 天：进入窗口，续到 180 天封顶。
  harness.clock.advance(24 * 60 * 60 * 1000)
  const renewed = await harness.call('GET', '/api/workspaces', { token })
  assert.equal(renewed.status, 200)
  const after = findSessionByTokenHash(raw, hash)
  assert.ok(after !== null)
  assert.equal(after.expiresAt, createdAt + SESSION_MAX_AGE_MS)
  assert.equal(after.lastSeenAt, harness.clock.now())
})

test('会话续期：现有 expiresAt 已超过 180 天封顶时不缩短', async (t) => {
  const harness = await startSqliteHarness()
  t.after(() => harness.close())
  const raw = harness.rawStore
  assert.ok(raw !== undefined)

  const token = 'a'.repeat(64)
  const createdAt = harness.clock.now()
  const longExpiry = createdAt + SESSION_MAX_AGE_MS + 24 * 60 * 60 * 1000
  await harness.store.createSession({
    accountId: TEST_ACCOUNT,
    tokenHash: hashSessionToken(token),
    now: createdAt,
    expiresAt: longExpiry,
  })

  // now 已进入续期窗口，但超过 180 天封顶，且当前 expiresAt 更晚 → 不动。
  harness.clock.set(createdAt + SESSION_MAX_AGE_MS - 24 * 60 * 60 * 1000)
  const result = await harness.call('GET', '/api/workspaces', { token })
  assert.equal(result.status, 200)
  assert.equal(findSessionByTokenHash(raw, hashSessionToken(token))!.expiresAt, longExpiry)
})

test('设备 API：列表字段、isCurrent、吊销他人/自己会话、写 auth.session.revoked', async (t) => {
  const harness = await startSqliteHarness()
  t.after(() => harness.close())
  const raw = harness.rawStore
  assert.ok(raw !== undefined)

  const token1 = await pairDevice(harness)
  // 同账号第二台设备（带 label/platform）。
  const secondMint = await mint(harness, { accountId: TEST_ACCOUNT }, token1)
  assert.equal(secondMint.status, 200)
  const claimed = await harness.call('POST', '/api/pairing/claim', {
    body: { code: secondMint.json.code, deviceLabel: '第二台', platform: 'desktop' },
  })
  assert.equal(claimed.status, 200)
  const token2 = claimed.json.sessionToken as string
  const session2Id = claimed.json.deviceId as string // 占位，稍后用列表里的会话 id 覆盖

  const list = await harness.call('GET', '/api/devices', { token: token1 })
  assert.equal(list.status, 200)
  assert.equal(list.json.devices.length, 2)
  const current = list.json.devices.find((device: any) => device.isCurrent === true)
  const other = list.json.devices.find((device: any) => device.isCurrent === false)
  assert.ok(current !== undefined)
  assert.ok(other !== undefined)
  assert.equal(other.label, '第二台')
  assert.equal(other.platform, 'desktop')
  assert.equal(other.revokedAt, null)
  assert.equal(other.lastSeenAt, undefined)
  // 列表 id 是会话 id，不是 device id。
  assert.notEqual(other.id, session2Id)
  const otherSessionId = other.id as string

  // 未鉴权 → 401。
  const anonymous = await harness.call('GET', '/api/devices')
  assert.equal(anonymous.status, 401)

  // 另一个账号的设备会话不能被当前账号吊销（当不存在）。
  const otherAccountMint = await mint(harness, { accountId: 'acc_other' })
  const otherClaim = await harness.call('POST', '/api/pairing/claim', { body: { code: otherAccountMint.json.code } })
  const otherToken = otherClaim.json.sessionToken as string
  const otherList = await harness.call('GET', '/api/devices', { token: otherToken })
  const foreignId = otherList.json.devices[0].id as string
  const foreignDelete = await harness.call('DELETE', `/api/devices/${foreignId}`, { token: token1 })
  assert.equal(foreignDelete.status, 404)
  assert.equal(foreignDelete.json.error.code, 'device_not_found')

  // 吊销第二台会话：204、无 body、事件落库。
  const revoked = await harness.call('DELETE', `/api/devices/${otherSessionId}`, { token: token1 })
  assert.equal(revoked.status, 204)
  assert.equal(revoked.json, null)

  const afterRevoke = await harness.call('GET', '/api/devices', { token: token1 })
  const revokedRow = afterRevoke.json.devices.find((device: any) => device.id === otherSessionId)
  assert.ok(revokedRow.revokedAt !== null)

  const rejected = await harness.call('GET', '/api/workspaces', { token: token2 })
  assert.equal(rejected.status, 401)
  assert.equal(rejected.json.error.code, 'session_revoked')

  const events = readEvents(raw, { domain: 'auth' })
  const revokedEvents = events.filter((event) => event.kind === 'auth.session.revoked')
  assert.equal(revokedEvents.length, 1)
  assert.equal(revokedEvents[0]!.subject?.id, otherSessionId)
  assert.equal(revokedEvents[0]!.actor?.id, TEST_ACCOUNT)

  // 不存在的会话 → 404。
  const missing = await harness.call('DELETE', '/api/devices/ses_missing', { token: token1 })
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error.code, 'device_not_found')

  // 吊销当前会话也允许；之后自己的 token 立即失效。
  const self = await harness.call('DELETE', `/api/devices/${current.id}`, { token: token1 })
  assert.equal(self.status, 204)
  const afterSelf = await harness.call('GET', '/api/workspaces', { token: token1 })
  assert.equal(afterSelf.status, 401)
  assert.equal(afterSelf.json.error.code, 'session_revoked')
})

test('设备 API：memory 模式没有会话查询接口 → 503 devices_unavailable', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const token = await pairDevice(harness)
  const list = await harness.call('GET', '/api/devices', { token })
  assert.equal(list.status, 503)
  assert.equal(list.json.error.code, 'devices_unavailable')

  const revoke = await harness.call('DELETE', '/api/devices/ses_whatever', { token })
  assert.equal(revoke.status, 503)
  assert.equal(revoke.json.error.code, 'devices_unavailable')
})
