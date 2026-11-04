// 审计查询 API（M6-6.6）：workspace 归属过滤、参数校验、倒序游标分页、权限。
import assert from 'node:assert/strict'
import test from 'node:test'

import { appendEvent } from '../../../packages/store/src/index.ts'
import { hashSessionToken } from '../src/server.ts'
import { pairDevice, startHarness, startSqliteHarness } from './helpers.ts'

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)

function at(minutes: number): string {
  return new Date(NOW + minutes * 60_000).toISOString()
}

function auditPath(workspaceId: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams({ workspaceId, ...params })
  return `/api/audit?${search.toString()}`
}

test('审计：workspace 归属保守过滤、domain/kind/时间过滤、倒序分页', async (t) => {
  const harness = await startSqliteHarness()
  t.after(() => harness.close())
  const store = harness.rawStore
  assert.ok(store)
  const token = await pairDevice(harness)

  const createdA = await harness.call('POST', '/api/workspaces', {
    token,
    body: { name: '审计 A' },
  })
  assert.equal(createdA.status, 201)
  const workspaceA = createdA.json.workspace.id as string
  const createdB = await harness.call('POST', '/api/workspaces', {
    token,
    body: { name: '审计 B' },
  })
  const workspaceB = createdB.json.workspace.id as string

  store.db
    .prepare(
      "INSERT INTO rooms (id, workspace_id, name, notice, reply_mode, created_at) VALUES ('rm_audit_a', ?, '审计房间', NULL, 'admin', ?)",
    )
    .run(workspaceA, NOW)

  const eventRoom = appendEvent(store, {
    domain: 'chat',
    kind: 'chat.message',
    at: at(1),
    actor: { kind: 'user', id: 'acc_test_one' },
    subject: { kind: 'room', id: 'rm_audit_a' },
    audience: 'room:rm_audit_a',
    payload: { roomId: 'rm_audit_a', text: '审计用消息' },
  })
  const eventRole = appendEvent(store, {
    domain: 'auth',
    kind: 'auth.role.changed',
    at: at(2),
    actor: { kind: 'user', id: 'acc_test_one' },
    subject: { kind: 'member', id: 'acc_other' },
    audience: 'team',
    payload: { workspaceId: workspaceA, from: 'member', to: 'admin' },
  })
  const eventOtherWorkspace = appendEvent(store, {
    domain: 'auth',
    kind: 'auth.role.changed',
    at: at(3),
    actor: { kind: 'user', id: 'acc_test_one' },
    subject: { kind: 'member', id: 'acc_other' },
    audience: 'team',
    payload: { workspaceId: workspaceB, from: 'member', to: 'admin' },
  })
  const eventTeamActor = appendEvent(store, {
    domain: 'bot',
    kind: 'bot.updated',
    at: at(4),
    actor: { kind: 'user', id: 'acc_test_one' },
    subject: { kind: 'member', id: 'acc_other' },
    audience: 'team',
    payload: { changed: ['role'] },
  })
  const eventUnattributed = appendEvent(store, {
    domain: 'system',
    kind: 'system.ping',
    at: at(5),
    actor: { kind: 'system', id: 'cron' },
    audience: null,
    payload: { foo: 'bar' },
  })
  const eventWorkspacePayload = appendEvent(store, {
    domain: 'plugin',
    kind: 'plugin.install',
    at: at(6),
    actor: { kind: 'user', id: 'acc_test_one' },
    subject: { kind: 'plugin', id: 'demo' },
    audience: 'team',
    payload: { workspaceId: workspaceA, slug: 'demo' },
  })

  const all = await harness.call('GET', auditPath(workspaceA), { token })
  assert.equal(all.status, 200)
  assert.deepEqual(
    all.json.events.map((event: any) => event.seq),
    [eventWorkspacePayload.seq, eventTeamActor.seq, eventRole.seq, eventRoom.seq],
    '按 seq 倒序，且只含能归属 workspace A 的事件',
  )
  assert.equal(all.json.nextBefore, undefined)
  const roomEvent = all.json.events[all.json.events.length - 1]
  assert.deepEqual(Object.keys(roomEvent).sort(), ['actor', 'at', 'domain', 'kind', 'payload', 'seq', 'subject'])
  assert.equal(roomEvent.domain, 'chat')
  assert.deepEqual(roomEvent.actor, { kind: 'user', id: 'acc_test_one' })
  assert.deepEqual(roomEvent.subject, { kind: 'room', id: 'rm_audit_a' })

  const seqs = all.json.events.map((event: any) => event.seq)
  assert.equal(seqs.includes(eventOtherWorkspace.seq), false)
  assert.equal(seqs.includes(eventUnattributed.seq), false)

  const firstPage = await harness.call('GET', auditPath(workspaceA, { limit: '2' }), { token })
  assert.equal(firstPage.status, 200)
  assert.deepEqual(
    firstPage.json.events.map((event: any) => event.seq),
    [eventWorkspacePayload.seq, eventTeamActor.seq],
  )
  assert.equal(firstPage.json.nextBefore, eventTeamActor.seq)

  const secondPage = await harness.call(
    'GET',
    auditPath(workspaceA, { limit: '2', before: String(firstPage.json.nextBefore) }),
    { token },
  )
  assert.deepEqual(
    secondPage.json.events.map((event: any) => event.seq),
    [eventRole.seq, eventRoom.seq],
  )
  assert.equal(secondPage.json.nextBefore, undefined)

  const chatOnly = await harness.call('GET', auditPath(workspaceA, { domain: 'chat' }), { token })
  assert.deepEqual(chatOnly.json.events.map((event: any) => event.seq), [eventRoom.seq])

  const roleOnly = await harness.call('GET', auditPath(workspaceA, { kind: 'auth.role.changed' }), { token })
  assert.deepEqual(roleOnly.json.events.map((event: any) => event.seq), [eventRole.seq])

  const timeWindow = await harness.call(
    'GET',
    auditPath(workspaceA, { from: at(2), to: at(4) }),
    { token },
  )
  assert.deepEqual(timeWindow.json.events.map((event: any) => event.seq), [eventRole.seq])
})

test('审计：参数非法 400、viewer 403、无 Bearer 401', async (t) => {
  const harness = await startSqliteHarness()
  t.after(() => harness.close())
  const store = harness.rawStore
  assert.ok(store)
  const token = await pairDevice(harness)
  const created = await harness.call('POST', '/api/workspaces', { token, body: { name: '权限审计' } })
  const workspaceId = created.json.workspace.id as string

  const anonymous = await harness.call('GET', auditPath(workspaceId))
  assert.equal(anonymous.status, 401)

  const missingWorkspace = await harness.call('GET', '/api/audit', { token })
  assert.equal(missingWorkspace.status, 400)

  for (const params of [
    { limit: '0' },
    { limit: 'abc' },
    { before: '0' },
    { from: 'not-a-time' },
    { from: at(2), to: at(1) },
  ]) {
    const result = await harness.call('GET', auditPath(workspaceId, params), { token })
    assert.equal(result.status, 400, JSON.stringify(params))
  }

  const viewerToken = 'b'.repeat(64)
  store.db
    .prepare(
      'INSERT INTO workspace_members (workspace_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(workspaceId, 'acc_audit_viewer', 'viewer', 'acc_test_one', NOW)
  await harness.store.createSession({
    accountId: 'acc_audit_viewer',
    tokenHash: hashSessionToken(viewerToken),
    now: NOW,
    expiresAt: NOW + 3_600_000,
  })

  const viewer = await harness.call('GET', auditPath(workspaceId), { token: viewerToken })
  assert.equal(viewer.status, 403)
  assert.equal(viewer.json.error.code, 'forbidden')
})

test('审计：内存 port 返回 503', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())
  const token = await pairDevice(harness)
  const result = await harness.call('GET', auditPath('ws_memory'), { token })
  assert.equal(result.status, 503)
  assert.equal(result.json.error.code, 'runtime.not_configured')
})
