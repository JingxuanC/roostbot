// 预算控制面 HTTP：runtime 预留-结算、用量幂等、配额读写与发消息准入（budget.md §4–§6）。
//
// 走真实 HTTP / 真实 SQLite / 真实 Bearer 会话，并直接使用 server.ts 的路由接线。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createRoom, ensureQuota, openStore, reserve } from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { createMemoryStore } from '../src/memory-store.ts'
import { hashSessionToken, startServer } from '../src/server.ts'
import type { StorePort, WorkspaceRecord } from '../src/port.ts'
import { createStorePort } from '../src/store-adapter.ts'

const ACCOUNT = 'acc_budget_owner'
const ADMIN = 'acc_budget_admin'
const MEMBER = 'acc_budget_member'
const OWNER_TOKEN = 'a'.repeat(64)
const ADMIN_TOKEN = 'b'.repeat(64)
const MEMBER_TOKEN = 'c'.repeat(64)
const RUNTIME_TOKEN = 'rt_budget'
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
  const dir = mkdtempSync(join(tmpdir(), 'roost-budget-api-'))
  const store = openStore(join(dir, 'workspace.db'))
  const port = createStorePort(store)
  let started: Awaited<ReturnType<typeof startServer>> | null = null

  try {
    const ws = await port.createWorkspace({ accountId: ACCOUNT, name: '预算工作区', now: NOW })
    for (const [accountId, role, token] of [
      [ADMIN, 'admin', ADMIN_TOKEN],
      [MEMBER, 'member', MEMBER_TOKEN],
    ] as const) {
      store.db
        .prepare(
          'INSERT INTO workspace_members (workspace_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(ws.id, accountId, role, ACCOUNT, NOW)
      await port.createSession({
        accountId,
        tokenHash: hashSessionToken(token),
        now: NOW,
        expiresAt: NOW + 3_600_000,
      })
    }
    await port.createSession({
      accountId: ACCOUNT,
      tokenHash: hashSessionToken(OWNER_TOKEN),
      now: NOW,
      expiresAt: NOW + 3_600_000,
    })
    const room = createRoom(store, { workspaceId: ws.id, name: '预算房间', createdAt: NOW })

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

function quota(store: Store, workspaceId: string, limitValue: number, metric: 'tokens' | 'runs' = 'tokens') {
  return ensureQuota(store, {
    scope: 'workspace',
    scopeId: workspaceId,
    period: 'day',
    metric,
    limitValue,
    at: NOW,
  })
}

function eventCount(store: Store, kind: string): number {
  const row = store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE kind = ?').get(kind) as { n: number | bigint }
  return Number(row.n)
}

test('runtime token：全局未配置但 SQLite 可用 → 401，缺失 401；memory port 503', async () => {
  // 有 rawStore 时 workspace token 可用，所以全局 token 未配置是 401 而不是 404。
  await withApi(
    async (fx) => {
      const disabled = await fx.call('POST', '/api/internal/budget/reserve', {
        body: { workspaceId: fx.ws.id, runId: 'run_1', metric: 'tokens', amount: 1 },
        runtimeToken: RUNTIME_TOKEN,
      })
      assert.equal(disabled.status, 401)
      assert.equal(disabled.json.error.code, 'unauthenticated')
    },
    { runtimeToken: '' },
  )

  await withApi(async (fx) => {
    const missing = await fx.call('POST', '/api/internal/budget/reserve', {
      body: { workspaceId: fx.ws.id, runId: 'run_1', metric: 'tokens', amount: 1 },
    })
    assert.equal(missing.status, 401)
  })

  const started = await startServer({
    store: createMemoryStore(),
    now: () => NOW,
    runtimeToken: RUNTIME_TOKEN,
    port: 0,
    host: '127.0.0.1',
  })
  try {
    const response = await fetch(`${started.url}/api/internal/budget/reserve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-runtime-token': RUNTIME_TOKEN },
      body: JSON.stringify({ workspaceId: 'ws_x', runId: 'run_1', metric: 'tokens', amount: 1 }),
    })
    assert.equal(response.status, 503)
    assert.equal(((await response.json()) as any).error.code, 'runtime.not_configured')
  } finally {
    await started.close()
  }
})

test('POST reserve/settle：201 预留、200 结算并回落 remaining', async () => {
  await withApi(async (fx) => {
    quota(fx.store, fx.ws.id, 1000)

    const reserved = await fx.call('POST', '/api/internal/budget/reserve', {
      body: { workspaceId: fx.ws.id, runId: 'run_1', metric: 'tokens', amount: 300 },
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(reserved.status, 201)
    assert.equal(reserved.json.remaining, 700)
    assert.equal(reserved.json.reservation.amount, 300)

    const settled = await fx.call('POST', '/api/internal/budget/settle', {
      body: { reservationId: reserved.json.reservation.id, actual: 350 },
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(settled.status, 200)
    assert.equal(settled.json.remaining, 650)

    // 重复结算：原样返回，不再扣 used。
    const again = await fx.call('POST', '/api/internal/budget/settle', {
      body: { reservationId: reserved.json.reservation.id, actual: 999 },
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(again.status, 200)
    assert.equal(again.json.reservation.actual, 350)

    const quotas = await fx.call('GET', `/api/quotas?workspaceId=${fx.ws.id}`, { token: MEMBER_TOKEN })
    assert.equal(quotas.status, 200)
    assert.equal(quotas.json.quotas[0].usedValue, 350)
    assert.equal(quotas.json.quotas[0].reserved, 0)
  })
})

test('POST reserve：配额不足 429 quota_exhausted', async () => {
  await withApi(async (fx) => {
    quota(fx.store, fx.ws.id, 100)
    const response = await fx.call('POST', '/api/internal/budget/reserve', {
      body: { workspaceId: fx.ws.id, runId: 'run_big', metric: 'tokens', amount: 101 },
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(response.status, 429)
    assert.equal(response.json.error.code, 'quota_exhausted')
  })
})

test('POST /api/internal/usage：同 turnId+source 重放 200 + deduped', async () => {
  await withApi(async (fx) => {
    const body = {
      workspaceId: fx.ws.id,
      runId: 'run_1',
      turnId: 'turn_1',
      botId: 'bot_a',
      model: 'model-x',
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 10,
      toolCalls: 2,
      costUsd: 0.25,
      source: 'provider_report',
    }
    const first = await fx.call('POST', '/api/internal/usage', { body, runtimeToken: RUNTIME_TOKEN })
    assert.equal(first.status, 201)
    assert.equal(first.json.deduped, false)

    const replay = await fx.call('POST', '/api/internal/usage', { body, runtimeToken: RUNTIME_TOKEN })
    assert.equal(replay.status, 200)
    assert.equal(replay.json.deduped, true)
    assert.equal(replay.json.usage.id, first.json.usage.id)
    assert.equal(eventCount(fx.store, 'billing.usage'), 1)

    const usage = await fx.call(
      'GET',
      `/api/usage?workspaceId=${fx.ws.id}&from=${NOW - 1}&to=${NOW + 1}`,
      { token: OWNER_TOKEN },
    )
    assert.equal(usage.status, 200)
    assert.equal(usage.json.totals.tokens, 160)
    assert.equal(usage.json.byBot[0].key, 'bot_a')
    assert.equal(usage.json.byModel[0].key, 'model-x')
  })
})

test('GET quotas 成员可看；PATCH 仅 owner，写 billing.quota.changed', async () => {
  await withApi(async (fx) => {
    const created = quota(fx.store, fx.ws.id, 100)

    const memberView = await fx.call('GET', `/api/quotas?workspaceId=${fx.ws.id}`, { token: MEMBER_TOKEN })
    assert.equal(memberView.status, 200)
    assert.equal(memberView.json.quotas[0].ratio, 0)
    assert.equal(memberView.json.quotas[0].warning, false)

    const adminPatch = await fx.call('PATCH', `/api/quotas/${created.id}`, {
      token: ADMIN_TOKEN,
      body: { limitValue: 500 },
    })
    assert.equal(adminPatch.status, 403)

    const ownerPatch = await fx.call('PATCH', `/api/quotas/${created.id}`, {
      token: OWNER_TOKEN,
      body: { limitValue: 500 },
    })
    assert.equal(ownerPatch.status, 200)
    assert.equal(ownerPatch.json.quota.limitValue, 500)
    assert.equal(eventCount(fx.store, 'billing.quota.changed'), 1)

    const missing = await fx.call('PATCH', '/api/quotas/qta_missing', {
      token: OWNER_TOKEN,
      body: { limitValue: 1 },
    })
    assert.equal(missing.status, 404)
  })
})

test('GET quotas：达到 80% 返回 warning 但不阻断', async () => {
  await withApi(async (fx) => {
    const created = quota(fx.store, fx.ws.id, 100)
    const reserved = reserve(fx.store, {
      quotaId: created.id,
      runId: 'run_1',
      workspaceId: fx.ws.id,
      amount: 100,
      at: NOW,
    })
    await fx.call('POST', '/api/internal/budget/settle', {
      body: { reservationId: reserved.reservation.id, actual: 80 },
      runtimeToken: RUNTIME_TOKEN,
    })
    const quotas = await fx.call('GET', `/api/quotas?workspaceId=${fx.ws.id}`, { token: MEMBER_TOKEN })
    assert.equal(quotas.json.quotas[0].ratio, 0.8)
    assert.equal(quotas.json.quotas[0].warning, true)
    assert.equal(eventCount(fx.store, 'billing.cap'), 1)
  })
})

test('POST reserve：多命中层一起校验，run 不足 429 且 error.layer=run', async () => {
  await withApi(async (fx) => {
    quota(fx.store, fx.ws.id, 1000)
    ensureQuota(fx.store, {
      scope: 'run', scopeId: 'run_1', period: 'day', metric: 'tokens', limitValue: 100, at: NOW,
    })
    ensureQuota(fx.store, {
      scope: 'turn', scopeId: 'turn_1', period: 'day', metric: 'tokens', limitValue: 500, at: NOW,
    })

    const blocked = await fx.call('POST', '/api/internal/budget/reserve', {
      body: { workspaceId: fx.ws.id, runId: 'run_1', turnId: 'turn_1', metric: 'tokens', amount: 101 },
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(blocked.status, 429)
    assert.equal(blocked.json.error.code, 'quota_exhausted')
    assert.equal(blocked.json.error.layer, 'run')

    const ok = await fx.call('POST', '/api/internal/budget/reserve', {
      body: { workspaceId: fx.ws.id, runId: 'run_1', turnId: 'turn_1', metric: 'tokens', amount: 100 },
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(ok.status, 201)
    assert.deepEqual(ok.json.layers.map((layer: any) => layer.scope), ['workspace', 'run', 'turn'])
    assert.equal(ok.json.reservations.length, 3)
    assert.equal(ok.json.remaining, 0)
  })
})

test('POST /api/internal/meter：容器秒/存储入账，同 idem 幂等', async () => {
  await withApi(async (fx) => {
    const first = await fx.call('POST', '/api/internal/meter', {
      body: { workspaceId: fx.ws.id, kind: 'container_seconds', amount: 12.5, idem: 'meter_1' },
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(first.status, 202)
    assert.equal(first.json.deduped, false)
    assert.equal(first.json.usage.containerSeconds, 12.5)

    const replay = await fx.call('POST', '/api/internal/meter', {
      body: { workspaceId: fx.ws.id, kind: 'container_seconds', amount: 999, idem: 'meter_1' },
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(replay.status, 202)
    assert.equal(replay.json.deduped, true)
    assert.equal(replay.json.usage.containerSeconds, 12.5)
    assert.equal(eventCount(fx.store, 'billing.usage'), 1)

    const storage = await fx.call('POST', '/api/internal/meter', {
      body: { workspaceId: fx.ws.id, kind: 'storage_bytes', amount: 4096, idem: 'meter_2' },
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(storage.status, 202)
    assert.equal(storage.json.usage.storageBytes, 4096)
    assert.equal(storage.json.usage.containerSeconds, null)

    const badKind = await fx.call('POST', '/api/internal/meter', {
      body: { workspaceId: fx.ws.id, kind: 'tokens', amount: 1 },
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(badKind.status, 400)

    const badStorage = await fx.call('POST', '/api/internal/meter', {
      body: { workspaceId: fx.ws.id, kind: 'storage_bytes', amount: 1.5 },
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(badStorage.status, 400)
  })
})

test('GET /api/usage：totals 带容器秒/存储，daily 按 UTC 日聚合', async () => {
  await withApi(async (fx) => {
    await fx.call('POST', '/api/internal/usage', {
      body: {
        workspaceId: fx.ws.id, runId: 'run_1', turnId: 'turn_1', source: 'provider_report',
        inputTokens: 100, containerSeconds: 12.5, storageBytes: 4096,
      },
      runtimeToken: RUNTIME_TOKEN,
    })
    await fx.call('POST', '/api/internal/usage', {
      body: {
        workspaceId: fx.ws.id, idem: 'sample_1', source: 'container_seconds',
        containerSeconds: 7.5, storageBytes: 8192,
      },
      runtimeToken: RUNTIME_TOKEN,
    })

    const usage = await fx.call(
      'GET',
      `/api/usage?workspaceId=${fx.ws.id}&from=${NOW - 3 * 86_400_000}&to=${NOW + 1}`,
      { token: OWNER_TOKEN },
    )
    assert.equal(usage.status, 200)
    assert.equal(usage.json.totals.containerSeconds, 20)
    assert.equal(usage.json.totals.storageBytes, 8192)
    assert.equal(usage.json.totals.tokens, 100)
    assert.equal(Array.isArray(usage.json.daily), true)
    assert.equal(usage.json.daily.length, 4)
    assert.deepEqual(usage.json.daily.map((day: any) => day.date), [
      '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04',
    ])
    assert.equal(usage.json.daily[3].tokens, 100)
    assert.equal(usage.json.daily[3].containerSeconds, 20)
    assert.equal(usage.json.daily[3].storageBytes, 8192)
  })
})

test('发消息准入：日 runs 配额耗尽 429，消息不落库', async () => {
  await withApi(async (fx) => {
    const first = await fx.call('POST', `/api/rooms/${fx.roomId}/messages`, {
      token: OWNER_TOKEN,
      body: { text: '第一条' },
    })
    assert.equal(first.status, 201)
    assert.equal(eventCount(fx.store, 'chat.message'), 1)

    const runs = quota(fx.store, fx.ws.id, 1, 'runs')
    reserve(fx.store, { quotaId: runs.id, runId: 'run_1', workspaceId: fx.ws.id, amount: 1, at: NOW })

    const blocked = await fx.call('POST', `/api/rooms/${fx.roomId}/messages`, {
      token: OWNER_TOKEN,
      body: { text: '第二条' },
    })
    assert.equal(blocked.status, 429)
    assert.equal(blocked.json.error.code, 'quota_exhausted')
    assert.equal(eventCount(fx.store, 'chat.message'), 1)
  })
})
