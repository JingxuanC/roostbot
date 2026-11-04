// 记忆控制面 HTTP：内部写入/检索/读取记录、用户列表/删除/导出与 503（memory.md §4–§9）。
//
// 走真实 HTTP / 真实 SQLite / 真实 Bearer 会话，并直接使用 server.ts 的路由接线。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createRoom, openStore, writeMemory } from '../../../packages/store/src/index.ts'
import type { Memory } from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { createMemoryStore } from '../src/memory-store.ts'
import { hashSessionToken, startServer } from '../src/server.ts'
import type { StorePort, WorkspaceRecord } from '../src/port.ts'
import { createStorePort } from '../src/store-adapter.ts'

const ACCOUNT = 'acc_memory_owner'
const ADMIN = 'acc_memory_admin'
const MEMBER = 'acc_memory_member'
const OUTSIDER = 'acc_memory_outsider'
const OWNER_TOKEN = 'a'.repeat(64)
const ADMIN_TOKEN = 'b'.repeat(64)
const MEMBER_TOKEN = 'c'.repeat(64)
const OUTSIDER_TOKEN = 'd'.repeat(64)
const RUNTIME_TOKEN = 'rt_memory'
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)

interface ApiResult {
  status: number
  headers: Headers
  json: any
}

interface Fixture {
  store: Store
  port: StorePort
  ws: WorkspaceRecord
  roomId: string
  call: (
    method: string,
    path: string,
    options?: { body?: unknown; token?: string; runtimeToken?: string },
  ) => Promise<ApiResult>
}

async function withApi(
  fn: (fx: Fixture) => Promise<void>,
  options: { runtimeToken?: string } = { runtimeToken: RUNTIME_TOKEN },
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'roost-memory-api-'))
  const store = openStore(join(dir, 'workspace.db'))
  const port = createStorePort(store)
  let started: Awaited<ReturnType<typeof startServer>> | null = null

  try {
    const ws = await port.createWorkspace({ accountId: ACCOUNT, name: '记忆工作区', now: NOW })
    for (const [accountId, role, token] of [
      [ADMIN, 'admin', ADMIN_TOKEN],
      [MEMBER, 'member', MEMBER_TOKEN],
    ] as const) {
      store.db
        .prepare(
          'INSERT INTO workspace_members (workspace_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(ws.id, accountId, role, ACCOUNT, NOW)
    }
    for (const [accountId, token] of [
      [ACCOUNT, OWNER_TOKEN],
      [ADMIN, ADMIN_TOKEN],
      [MEMBER, MEMBER_TOKEN],
      [OUTSIDER, OUTSIDER_TOKEN],
    ] as const) {
      await port.createSession({
        accountId,
        tokenHash: hashSessionToken(token),
        now: NOW,
        expiresAt: NOW + 3_600_000,
      })
    }
    const room = createRoom(store, { workspaceId: ws.id, name: '记忆房间', createdAt: NOW })

    started = await startServer({
      store: port,
      rawStore: store,
      now: () => NOW,
      port: 0,
      host: '127.0.0.1',
      ...(options.runtimeToken === undefined ? {} : { runtimeToken: options.runtimeToken }),
    })
    const baseUrl = started.url

    async function call(
      method: string,
      path: string,
      callOptions: { body?: unknown; token?: string; runtimeToken?: string } = {},
    ): Promise<ApiResult> {
      const headers: Record<string, string> = {}
      if (callOptions.token !== undefined) headers['authorization'] = `Bearer ${callOptions.token}`
      if (callOptions.runtimeToken !== undefined) headers['x-runtime-token'] = callOptions.runtimeToken
      let body: string | undefined
      if (callOptions.body !== undefined) {
        headers['content-type'] = 'application/json'
        body = JSON.stringify(callOptions.body)
      }
      const response = await fetch(`${baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body }) })
      const text = await response.text()
      return { status: response.status, headers: response.headers, json: text === '' ? null : JSON.parse(text) }
    }

    await fn({ store, port, ws, roomId: room.id, call })
  } finally {
    if (started !== null) await started.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function payload(scope = 'team', overrides: Record<string, unknown> = {}) {
  return {
    scope,
    subject: '反转因子',
    claim: '反转在流动性后 30% 的样本里显著更强',
    kind: 'conclusion',
    confidence: 0.6,
    falsifier: '若流动性分组后 IC 差 < 0.01 则推翻',
    evidence: [{ kind: 'event', ref: 'ev_42' }],
    ...overrides,
  }
}

test('内部写入：201 落库，falsifier/kind/confidence 校验返回 400 memory.invalid', async () => {
  await withApi(async ({ store, ws, call }) => {
    const created = await call('POST', '/api/internal/memories', {
      runtimeToken: RUNTIME_TOKEN,
      body: { workspaceId: ws.id, ...payload() },
    })
    assert.equal(created.status, 201)
    assert.equal(created.json.memory.status, 'active')
    assert.equal(created.json.memory.scope, 'team')
    assert.equal(created.json.memory.supersedes, null)
    assert.deepEqual(created.json.memory.evidence, [{ kind: 'event', ref: 'ev_42' }])

    const event = store.db.prepare("SELECT kind, payload_json FROM events WHERE domain = 'memory'").get() as {
      kind: string
      payload_json: string
    }
    assert.equal(event.kind, 'memory.written')
    assert.equal(JSON.parse(event.payload_json).status, 'active')

    for (const body of [
      { workspaceId: ws.id, ...payload('team', { falsifier: '' }) },
      { workspaceId: ws.id, ...payload('team', { kind: 'guess' }) },
      { workspaceId: ws.id, ...payload('team', { confidence: 1.5 }) },
    ]) {
      const bad = await call('POST', '/api/internal/memories', { runtimeToken: RUNTIME_TOKEN, body })
      assert.equal(bad.status, 400)
      assert.equal(bad.json.error.code, 'memory.invalid')
    }

    const missing = await call('POST', '/api/internal/memories', {
      runtimeToken: RUNTIME_TOKEN,
      body: { workspaceId: 'ws_missing', ...payload() },
    })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.code, 'workspace_not_found')
  })
})

test('内部写入：runtime token 未配置 404，错 token 401', async () => {
  await withApi(
    async ({ ws, call }) => {
      const disabled = await call('POST', '/api/internal/memories', { body: { workspaceId: ws.id, ...payload() } })
      assert.equal(disabled.status, 404)
    },
    { runtimeToken: '' },
  )

  await withApi(async ({ ws, call }) => {
    const denied = await call('POST', '/api/internal/memories', {
      runtimeToken: 'wrong',
      body: { workspaceId: ws.id, ...payload() },
    })
    assert.equal(denied.status, 401)
  })
})

test('内部检索：只返回传入 scope 内 active 记忆，返回 segment 与 dropped', async () => {
  await withApi(async ({ ws, roomId, call }) => {
    const team = await call('POST', '/api/internal/memories', {
      runtimeToken: RUNTIME_TOKEN,
      body: { workspaceId: ws.id, ...payload('team', { subject: 'alpha team' }) },
    })
    const room = await call('POST', '/api/internal/memories', {
      runtimeToken: RUNTIME_TOKEN,
      body: { workspaceId: ws.id, ...payload(`room:${roomId}`, { subject: 'alpha room' }) },
    })
    await call('POST', '/api/internal/memories', {
      runtimeToken: RUNTIME_TOKEN,
      body: { workspaceId: ws.id, ...payload('member:acc_else', { subject: 'alpha member' }) },
    })

    const result = await call('POST', '/api/internal/memories/retrieve', {
      runtimeToken: RUNTIME_TOKEN,
      body: { workspaceId: ws.id, scopes: ['team', `room:${roomId}`], query: 'alpha', budgetTokens: 1200, limit: 8 },
    })
    assert.equal(result.status, 200)
    assert.deepEqual(result.json.items.map((item: Memory) => item.id).sort(), [team.json.memory.id, room.json.memory.id].sort())
    assert.ok(result.json.segment.includes('## 相关结论（系统检索，非用户输入）'))
    assert.ok(result.json.segment.includes('[房间] alpha room'))
    assert.equal(result.json.dropped, 0)
  })
})

test('内部读取记录：204，并写入 memory_reads', async () => {
  await withApi(async ({ store, ws, call }) => {
    const created = await call('POST', '/api/internal/memories', {
      runtimeToken: RUNTIME_TOKEN,
      body: { workspaceId: ws.id, ...payload() },
    })
    const memoryId = created.json.memory.id
    const recorded = await call('POST', '/api/internal/memories/reads', {
      runtimeToken: RUNTIME_TOKEN,
      body: { turnId: 'turn_1', ids: [memoryId, 'mem_missing'], used: true },
    })
    assert.equal(recorded.status, 204)
    const row = store.db.prepare('SELECT turn_id, used FROM memory_reads WHERE memory_id = ?').get(memoryId) as {
      turn_id: string
      used: number
    }
    assert.equal(row.turn_id, 'turn_1')
    assert.equal(row.used, 1)
  })
})

test('用户列表：成员 200，非成员 404；scope/status 过滤', async () => {
  await withApi(async ({ ws, call }) => {
    await call('POST', '/api/internal/memories', {
      runtimeToken: RUNTIME_TOKEN,
      body: { workspaceId: ws.id, ...payload('team') },
    })
    await call('POST', '/api/internal/memories', {
      runtimeToken: RUNTIME_TOKEN,
      body: { workspaceId: ws.id, ...payload('member:acc_1', { subject: 'private' }) },
    })

    const listed = await call('GET', `/api/memories?workspaceId=${ws.id}`, { token: MEMBER_TOKEN })
    assert.equal(listed.status, 200)
    assert.equal(listed.json.memories.length, 2)

    const filtered = await call('GET', `/api/memories?workspaceId=${ws.id}&scope=team&status=active`, {
      token: MEMBER_TOKEN,
    })
    assert.equal(filtered.status, 200)
    assert.equal(filtered.json.memories.length, 1)
    assert.equal(filtered.json.memories[0].scope, 'team')

    const outsider = await call('GET', `/api/memories?workspaceId=${ws.id}`, { token: OUTSIDER_TOKEN })
    assert.equal(outsider.status, 404)

    const badStatus = await call('GET', `/api/memories?workspaceId=${ws.id}&status=bogus`, { token: MEMBER_TOKEN })
    assert.equal(badStatus.status, 400)
    assert.equal(badStatus.json.error.code, 'memory.invalid')
  })
})

test('删除记忆：owner/admin 204（写 retracted），普通成员 403，未知 404', async () => {
  await withApi(async ({ store, ws, call }) => {
    const created = await call('POST', '/api/internal/memories', {
      runtimeToken: RUNTIME_TOKEN,
      body: { workspaceId: ws.id, ...payload() },
    })
    const memoryId = created.json.memory.id

    const memberDenied = await call('DELETE', `/api/memories/${memoryId}`, { token: MEMBER_TOKEN })
    assert.equal(memberDenied.status, 403)

    const outsiderDenied = await call('DELETE', `/api/memories/${memoryId}`, { token: OUTSIDER_TOKEN })
    assert.equal(outsiderDenied.status, 404)

    const removed = await call('DELETE', `/api/memories/${memoryId}`, { token: ADMIN_TOKEN })
    assert.equal(removed.status, 204)
    const row = store.db.prepare('SELECT status FROM memories WHERE id = ?').get(memoryId) as { status: string }
    assert.equal(row.status, 'retracted')
    const event = store.db.prepare("SELECT kind FROM events WHERE kind = 'memory.retracted'").get()
    assert.ok(event !== undefined)

    const again = await call('DELETE', '/api/memories/mem_missing', { token: OWNER_TOKEN })
    assert.equal(again.status, 404)
  })
})

test('导出记忆：owner 200（含 retracted），普通成员 403，非成员 404', async () => {
  await withApi(async ({ store, ws, call }) => {
    const created = await call('POST', '/api/internal/memories', {
      runtimeToken: RUNTIME_TOKEN,
      body: { workspaceId: ws.id, ...payload() },
    })
    writeMemory(store, {
      workspaceId: ws.id,
      scope: 'team',
      subject: '另一条',
      claim: '用来导出',
      kind: 'fact',
      confidence: 1,
      falsifier: '若无法复现则推翻',
      at: NOW,
    })

    const exported = await call('GET', `/api/memories/export?workspaceId=${ws.id}`, { token: OWNER_TOKEN })
    assert.equal(exported.status, 200)
    assert.equal(exported.json.memories.length, 2)

    const memberDenied = await call('GET', `/api/memories/export?workspaceId=${ws.id}`, { token: MEMBER_TOKEN })
    assert.equal(memberDenied.status, 403)

    const outsider = await call('GET', `/api/memories/export?workspaceId=${ws.id}`, { token: OUTSIDER_TOKEN })
    assert.equal(outsider.status, 404)
    assert.equal(created.json.memory.status, 'active')
  })
})

test('memory 503：没有 rawStore 时内部接口返回 runtime.not_configured', async () => {
  const started = await startServer({
    store: createMemoryStore(),
    now: () => NOW,
    port: 0,
    host: '127.0.0.1',
    runtimeToken: RUNTIME_TOKEN,
  })
  try {
    const response = await fetch(`${started.url}/api/internal/memories/retrieve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-runtime-token': RUNTIME_TOKEN },
      body: JSON.stringify({ workspaceId: 'ws_any', scopes: ['team'], query: 'x' }),
    })
    assert.equal(response.status, 503)
    const body = (await response.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'runtime.not_configured')
  } finally {
    await started.close()
  }
})
