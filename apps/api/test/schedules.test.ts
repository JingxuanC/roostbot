// 控制面调度 HTTP：权限、404/400、tick runtime token 与内存 port 503。
// 走真实 HTTP / 真实 SQLite / 真实 Bearer 会话，并使用 server.ts 的路由接线。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { createMemoryStore } from '../src/memory-store.ts'
import { hashSessionToken, startServer } from '../src/server.ts'
import type { StorePort, WorkspaceRecord } from '../src/port.ts'
import { createStorePort } from '../src/store-adapter.ts'
import { pairDevice, startHarness } from './helpers.ts'

const ACCOUNT = 'acc_sched_owner'
const ADMIN = 'acc_sched_admin'
const MEMBER = 'acc_sched_member'
const OUTSIDER = 'acc_sched_outsider'
const OWNER_TOKEN = 'a'.repeat(64)
const ADMIN_TOKEN = 'b'.repeat(64)
const MEMBER_TOKEN = 'c'.repeat(64)
const OUTSIDER_TOKEN = 'd'.repeat(64)
const RUNTIME_TOKEN = 'rt_sched'
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
  call: (
    method: string,
    path: string,
    options?: { body?: unknown; token?: string; runtimeToken?: string },
  ) => Promise<ApiResult>
}

async function withApi(
  fn: (fx: Fixture) => Promise<void>,
  options: { runtimeToken?: string | null } = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'roost-schedules-api-'))
  const store = openStore(join(dir, 'workspace.db'))
  const port = createStorePort(store)
  let started: Awaited<ReturnType<typeof startServer>> | null = null
  const runtimeToken = options.runtimeToken === undefined ? RUNTIME_TOKEN : options.runtimeToken

  try {
    const ws = await port.createWorkspace({ accountId: ACCOUNT, name: '调度工作区', now: NOW })
    for (const [accountId, role, token] of [
      [ADMIN, 'admin', ADMIN_TOKEN],
      [MEMBER, 'member', MEMBER_TOKEN],
      [OUTSIDER, 'member', OUTSIDER_TOKEN],
    ] as const) {
      if (role === 'member' && accountId === OUTSIDER) continue
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

    started = await startServer({
      store: port,
      rawStore: store,
      now: () => NOW,
      port: 0,
      host: '127.0.0.1',
      runtimeToken: runtimeToken ?? '',
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
      const init: RequestInit = { method, headers }
      if (callOptions.body !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(callOptions.body)
      }
      const response = await fetch(`${baseUrl}${path}`, init)
      const text = await response.text()
      return {
        status: response.status,
        headers: response.headers,
        json: text === '' ? null : JSON.parse(text),
      }
    }

    await fn({ store, port, ws, call })
  } finally {
    await started?.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function scheduleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    botId: 'bot_1',
    routineId: 'daily-premarket',
    cron: 'daily 09:00',
    timezone: 'UTC',
    ...overrides,
  }
}

test('schedule CRUD 权限：成员只读，owner/admin 可写', async () => {
  await withApi(async (fx) => {
    const base = `/api/workspaces/${fx.ws.id}/schedules`

    assert.equal((await fx.call('GET', base)).status, 401)
    const empty = await fx.call('GET', base, { token: MEMBER_TOKEN })
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.json.schedules, [])

    const denied = await fx.call('POST', base, { token: MEMBER_TOKEN, body: scheduleBody() })
    assert.equal(denied.status, 403)

    const created = await fx.call('POST', base, { token: OWNER_TOKEN, body: scheduleBody() })
    assert.equal(created.status, 201)
    assert.equal(created.json.schedule.routineId, 'daily-premarket')
    assert.equal(created.json.schedule.enabled, true)
    assert.equal(created.json.nextRunAt, Date.UTC(2026, 10, 5, 9, 0, 0))

    const duplicate = await fx.call('POST', base, { token: ADMIN_TOKEN, body: scheduleBody() })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.json.error.code, 'schedule.exists')

    const scheduleId = created.json.schedule.id as string
    const listed = await fx.call('GET', base, { token: MEMBER_TOKEN })
    assert.equal(listed.json.schedules.length, 1)
    assert.equal(listed.json.schedules[0].id, scheduleId)

    const patchDenied = await fx.call('PATCH', `/api/schedules/${scheduleId}`, {
      token: MEMBER_TOKEN,
      body: { enabled: false },
    })
    assert.equal(patchDenied.status, 403)

    const patched = await fx.call('PATCH', `/api/schedules/${scheduleId}`, {
      token: ADMIN_TOKEN,
      body: { enabled: false, cron: 'daily 10:00' },
    })
    assert.equal(patched.status, 200)
    assert.equal(patched.json.schedule.enabled, false)
    assert.equal(patched.json.schedule.cron, 'daily 10:00')

    assert.equal(
      (await fx.call('DELETE', `/api/schedules/${scheduleId}`, { token: MEMBER_TOKEN })).status,
      403,
    )
    assert.equal(
      (await fx.call('DELETE', `/api/schedules/${scheduleId}`, { token: OWNER_TOKEN })).status,
      204,
    )
    assert.equal((await fx.call('GET', base, { token: MEMBER_TOKEN })).json.schedules.length, 0)
  })
})

test('非法 cron / timezone 返回 400，未知 schedule 返回 404', async () => {
  await withApi(async (fx) => {
    const base = `/api/workspaces/${fx.ws.id}/schedules`
    const badCron = await fx.call('POST', base, {
      token: OWNER_TOKEN,
      body: scheduleBody({ cron: 'not a cron' }),
    })
    assert.equal(badCron.status, 400)
    assert.equal(badCron.json.error.code, 'schedule.invalid')

    const badTz = await fx.call('POST', base, {
      token: OWNER_TOKEN,
      body: scheduleBody({ timezone: 'Mars/Olympus' }),
    })
    assert.equal(badTz.status, 400)
    assert.equal(badTz.json.error.code, 'schedule.invalid')

    const created = await fx.call('POST', base, { token: OWNER_TOKEN, body: scheduleBody() })
    const scheduleId = created.json.schedule.id as string

    const badPatch = await fx.call('PATCH', `/api/schedules/${scheduleId}`, {
      token: OWNER_TOKEN,
      body: { cron: '61 * * * *' },
    })
    assert.equal(badPatch.status, 400)

    assert.equal(
      (await fx.call('PATCH', '/api/schedules/sch_missing', { token: OWNER_TOKEN, body: {} })).status,
      404,
    )
    assert.equal(
      (await fx.call('DELETE', '/api/schedules/sch_missing', { token: OWNER_TOKEN })).status,
      404,
    )
    assert.equal(
      (await fx.call('POST', '/api/schedules/sch_missing/run', { token: OWNER_TOKEN })).status,
      404,
    )
  })
})

test('立即触发、runs 查询与 stop 的权限与生命周期', async () => {
  await withApi(async (fx) => {
    const base = `/api/workspaces/${fx.ws.id}/schedules`
    const created = await fx.call('POST', base, { token: OWNER_TOKEN, body: scheduleBody() })
    const scheduleId = created.json.schedule.id as string

    assert.equal(
      (await fx.call('POST', `/api/schedules/${scheduleId}/run`, { token: MEMBER_TOKEN })).status,
      403,
    )
    const run = await fx.call('POST', `/api/schedules/${scheduleId}/run`, { token: ADMIN_TOKEN })
    assert.equal(run.status, 201)
    assert.equal(run.json.run.status, 'queued')
    assert.equal(run.json.run.kind, 'manual')
    assert.equal(run.json.run.routineId, 'daily-premarket')

    assert.equal((await fx.call('GET', '/api/runs', { token: MEMBER_TOKEN })).status, 400)
    const runs = await fx.call('GET', `/api/runs?workspaceId=${fx.ws.id}`, { token: MEMBER_TOKEN })
    assert.equal(runs.status, 200)
    assert.equal(runs.json.runs.length, 1)
    assert.equal(runs.json.runs[0].status, 'queued')

    const stopped = await fx.call('POST', `/api/runs/${run.json.run.id}/stop`, {
      token: MEMBER_TOKEN,
    })
    assert.equal(stopped.status, 403)
    const stoppedByAdmin = await fx.call('POST', `/api/runs/${run.json.run.id}/stop`, {
      token: ADMIN_TOKEN,
    })
    assert.equal(stoppedByAdmin.status, 200)
    assert.equal(stoppedByAdmin.json.run.status, 'completed')
    assert.equal(stoppedByAdmin.json.run.outcome, 'stopped')

    const completed = await fx.call(
      'GET',
      `/api/runs?workspaceId=${fx.ws.id}&status=completed`,
      { token: MEMBER_TOKEN },
    )
    assert.equal(completed.json.runs.length, 1)

    assert.equal(
      (await fx.call('POST', '/api/runs/run_missing/stop', { token: OWNER_TOKEN })).status,
      404,
    )
  })
})

test('内部 tick：runtime token、幂等与 miss/skip 计数', async () => {
  await withApi(async (fx) => {
    const base = `/api/workspaces/${fx.ws.id}/schedules`
    const created = await fx.call('POST', base, {
      token: OWNER_TOKEN,
      body: scheduleBody({ cron: 'every 3600' }),
    })
    const scheduleId = created.json.schedule.id as string
    // 把 next_run_at 拨到 now，模拟到点。
    fx.store.db.prepare('UPDATE workspace_schedules SET next_run_at = ? WHERE id = ?').run(NOW, scheduleId)

    assert.equal(
      (await fx.call('POST', '/api/internal/scheduler/tick')).status,
      401,
    )
    const first = await fx.call('POST', '/api/internal/scheduler/tick', {
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(first.status, 200)
    assert.deepEqual(first.json, { created: 1, missed: 0, skipped: 0 })

    const second = await fx.call('POST', '/api/internal/scheduler/tick', {
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.deepEqual(second.json, { created: 0, missed: 0, skipped: 0 })

    // 重放同一个 scheduledFor：next_run_at 拨回也不会重复建。
    fx.store.db.prepare('UPDATE workspace_schedules SET next_run_at = ? WHERE id = ?').run(NOW, scheduleId)
    const replay = await fx.call('POST', '/api/internal/scheduler/tick', {
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.deepEqual(replay.json, { created: 0, missed: 0, skipped: 0 })
  })
})

test('全局 token 未配置但 SQLite 可用时内部接口 401（workspace token 模式）', async () => {
  // E6：有 rawStore 就能校验每 workspace token，因此不再是 404 关闭。
  await withApi(
    async (fx) => {
      const response = await fx.call('POST', '/api/internal/scheduler/tick', {
        runtimeToken: RUNTIME_TOKEN,
      })
      assert.equal(response.status, 401)
      assert.equal(response.json.error.code, 'unauthenticated')
    },
    { runtimeToken: null },
  )
})

test('内存 port（无 rawStore）返回 503 runtime.not_configured', async () => {
  const harness = await startHarness()
  try {
    const token = await pairDevice(harness)
    const response = await harness.call('GET', '/api/workspaces/ws_memory/schedules', { token })
    assert.equal(response.status, 503)
    assert.equal(response.json.error.code, 'runtime.not_configured')

    const memoryStore = createMemoryStore()
    const started = await startServer({
      store: memoryStore,
      now: () => NOW,
      port: 0,
      host: '127.0.0.1',
      runtimeToken: RUNTIME_TOKEN,
    })
    try {
      const tick = await fetch(`${started.url}/api/internal/scheduler/tick`, {
        method: 'POST',
        headers: { 'x-runtime-token': RUNTIME_TOKEN },
      })
      assert.equal(tick.status, 503)
      assert.equal((await tick.json() as any).error.code, 'runtime.not_configured')
    } finally {
      await started.close()
    }
  } finally {
    await harness.close()
  }
})
