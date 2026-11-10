// E6 接线：每 workspace 短期 runtime token 在内部接口与沙箱启动链路里的行为。
//
// 覆盖三类：
//   1. 内部接口鉴权：全局 token 仍可用；workspace token 只能访问自己的 workspace
//      （伪造 workspaceId/roomId → 403）；过期/吊销 → 401；没有 rawStore 时仍是 404。
//   2. 各模块的归属校验点：rooms/messages/say、budget、memories、attachments、
//      plugins sync、schedules tick、approvals、rounds。
//   3. 沙箱启动：ensure 签发的短 token 被注入 env、能在库里 verify，失败/复用会回收。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { ensureQuota } from '../../../packages/store/src/budget.ts'
import { createWorkspace } from '../../../packages/store/src/workspaces.ts'
import { createRoom, sendMessage } from '../../../packages/store/src/rooms.ts'
import { createBot } from '../../../packages/store/src/bots.ts'
import { createRoutine, enqueueRoutineNow } from '../../../packages/store/src/routines.ts'
import {
  issueRuntimeToken,
  revokeRuntimeToken,
  verifyRuntimeToken,
} from '../../../packages/store/src/runtime-tokens.ts'
import { createMemoryStore } from '../src/memory-store.ts'
import { createStorePort } from '../src/store-adapter.ts'
import { startServer } from '../src/server.ts'
import { openShellRuntimeManager } from '../src/runtime-manager-openshell.ts'
import { manualClock } from './helpers.ts'
import type { ManualClock } from './helpers.ts'

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
const GLOBAL = 'rt_global_admin_token'
const HOUR = 3_600_000

interface Seeded {
  wsA: string
  wsB: string
  roomA: string
  roomB: string
  messageA: number
  messageB: number
}

function seed(rawStore: Store): Seeded {
  const wsA = createWorkspace(rawStore, { tenantId: 'acc_a', name: 'A', profileVersion: 'dev', createdAt: NOW })
  const wsB = createWorkspace(rawStore, { tenantId: 'acc_b', name: 'B', profileVersion: 'dev', createdAt: NOW })
  const roomA = createRoom(rawStore, { workspaceId: wsA.id, name: 'room A', createdAt: NOW })
  const roomB = createRoom(rawStore, { workspaceId: wsB.id, name: 'room B', createdAt: NOW })
  // 预算测试要能真的走到 reserve/settle：两个 workspace 都先给一档 day/tokens 配额。
  for (const workspaceId of [wsA.id, wsB.id]) {
    ensureQuota(rawStore, {
      scope: 'workspace',
      scopeId: workspaceId,
      period: 'day',
      metric: 'tokens',
      limitValue: 1000,
      at: NOW,
    })
  }
  const messageA = sendMessage(rawStore, {
    roomId: roomA.id,
    text: 'hello A',
    actor: { kind: 'user', id: 'acc_a' },
    at: NOW,
  })
  const messageB = sendMessage(rawStore, {
    roomId: roomB.id,
    text: 'hello B',
    actor: { kind: 'user', id: 'acc_b' },
    at: NOW,
  })
  return {
    wsA: wsA.id,
    wsB: wsB.id,
    roomA: roomA.id,
    roomB: roomB.id,
    messageA: messageA.seq,
    messageB: messageB.seq,
  }
}

function issue(rawStore: Store, workspaceId: string, clock: ManualClock, ttlMs = 24 * HOUR) {
  return issueRuntimeToken(rawStore, { workspaceId, ttlMs, at: clock.now() })
}

interface ApiOptions {
  token?: string
  runtimeToken?: string
  body?: unknown
  headers?: Record<string, string>
}

async function call(base: string, method: string, path: string, options: ApiOptions = {}) {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`
  if (options.runtimeToken !== undefined) headers['x-runtime-token'] = options.runtimeToken
  let body: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  })
  const text = await res.text()
  let json: any = null
  if (text !== '') {
    try {
      json = JSON.parse(text)
    } catch {
      json = { __unparsed: text }
    }
  }
  return { status: res.status, json, text }
}

interface SqliteApi {
  base: string
  rawStore: Store
  clock: ManualClock
  ids: Seeded
}

/** 起一个真 SQLite 控制面（默认带全局 token），并种两个 workspace / 房间 / 消息。 */
async function withSqliteApi(
  fn: (api: SqliteApi) => Promise<void>,
  options: { runtimeToken?: string; attachmentsDir?: string; seed?: boolean } = {},
): Promise<void> {
  const rawStore = openStore(':memory:')
  const store = createStorePort(rawStore)
  const clock = manualClock(NOW)
  const ids = options.seed === false
    ? { wsA: '', wsB: '', roomA: '', roomB: '', messageA: 0, messageB: 0 }
    : seed(rawStore)
  const started = await startServer({
    store,
    rawStore,
    now: clock.now,
    port: 0,
    host: '127.0.0.1',
    runtimeToken: options.runtimeToken === undefined ? GLOBAL : options.runtimeToken,
    ...(options.attachmentsDir === undefined ? {} : { attachmentsDir: options.attachmentsDir, signingSecret: 'test-secret' }),
  })
  try {
    await fn({ base: started.url, rawStore, clock, ids })
  } finally {
    await started.close()
    rawStore.close()
  }
}

// ---- 内部 rooms / messages / say ---------------------------------------------

test('全局 token 仍可跨 workspace 读内部房间（旧部署兼容）', async () => {
  await withSqliteApi(async ({ base, ids }) => {
    const res = await call(base, 'GET', `/api/internal/rooms?workspaceId=${ids.wsB}`, { runtimeToken: GLOBAL })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json.rooms.map((room: { id: string }) => room.id), [ids.roomB])
  })
})

test('workspace token：不带 workspaceId 时只返回自己的房间', async () => {
  await withSqliteApi(async ({ base, rawStore, clock, ids }) => {
    const token = issue(rawStore, ids.wsA, clock)
    const res = await call(base, 'GET', '/api/internal/rooms', { runtimeToken: token.token })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json.rooms.map((room: { id: string }) => room.id), [ids.roomA])
  })
})

test('workspace token：伪造 workspaceId → 403 forbidden_workspace', async () => {
  await withSqliteApi(async ({ base, rawStore, clock, ids }) => {
    const token = issue(rawStore, ids.wsA, clock)
    const res = await call(base, 'GET', `/api/internal/rooms?workspaceId=${ids.wsB}`, {
      runtimeToken: token.token,
    })
    assert.equal(res.status, 403)
    assert.equal(res.json.error.code, 'forbidden_workspace')
  })
})

test('workspace token：读别的 workspace 的消息 → 403；读自己的 → 200', async () => {
  await withSqliteApi(async ({ base, rawStore, clock, ids }) => {
    const token = issue(rawStore, ids.wsA, clock)
    const denied = await call(base, 'GET', `/api/internal/rooms/${ids.roomB}/messages`, {
      runtimeToken: token.token,
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.json.error.code, 'forbidden_workspace')

    const ok = await call(base, 'GET', `/api/internal/rooms/${ids.roomA}/messages?after=0`, {
      runtimeToken: token.token,
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.messages.length, 1)
  })
})

test('workspace token：以 Bot 身份往别的 workspace 说话 → 403；自己的 → 201', async () => {
  await withSqliteApi(async ({ base, rawStore, clock, ids }) => {
    const token = issue(rawStore, ids.wsA, clock)
    const denied = await call(base, 'POST', `/api/rooms/${ids.roomB}/say`, {
      runtimeToken: token.token,
      body: { botId: 'selector', text: '越界' },
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.json.error.code, 'forbidden_workspace')

    const ok = await call(base, 'POST', `/api/rooms/${ids.roomA}/say`, {
      runtimeToken: token.token,
      body: { botId: 'selector', text: '自己人' },
    })
    assert.equal(ok.status, 201)
  })
})

test('workspace token：过期 → 401', async () => {
  await withSqliteApi(async ({ base, rawStore, clock, ids }) => {
    const token = issue(rawStore, ids.wsA, clock, 1000)
    clock.advance(2000)
    const res = await call(base, 'GET', '/api/internal/rooms?workspaceId=' + ids.wsA, {
      runtimeToken: token.token,
    })
    assert.equal(res.status, 401)
    assert.equal(res.json.error.code, 'unauthenticated')
  })
})

test('workspace token：吊销后立即 401', async () => {
  await withSqliteApi(async ({ base, rawStore, clock, ids }) => {
    const token = issue(rawStore, ids.wsA, clock)
    revokeRuntimeToken(rawStore, { id: token.id, at: clock.now() })
    const res = await call(base, 'GET', `/api/internal/rooms?workspaceId=${ids.wsA}`, {
      runtimeToken: token.token,
    })
    assert.equal(res.status, 401)
  })
})

test('没有 rawStore（memory port）且没有全局 token：内部接口仍是 404', async () => {
  const { url, close } = await startServer({
    store: createMemoryStore(),
    port: 0,
    host: '127.0.0.1',
    runtimeToken: '',
  })
  try {
    const res = await call(url, 'POST', '/api/internal/approvals', {
      runtimeToken: 'rt_anything',
      body: { workspaceId: 'ws_x', kind: 'send_email', requester: 'bot' },
    })
    assert.equal(res.status, 404)
    assert.equal(res.json.error.code, 'not_found')
  } finally {
    await close()
  }
})

// ---- budget --------------------------------------------------------------------

test('budget：workspace token 预留别的 workspace → 403；自己的进入正常预算路径', async () => {
  await withSqliteApi(async ({ base, rawStore, clock, ids }) => {
    const token = issue(rawStore, ids.wsA, clock)
    const body = { workspaceId: ids.wsB, runId: 'run_1', scope: 'workspace', scopeId: ids.wsB, period: 'day', metric: 'tokens', amount: 1 }
    const denied = await call(base, 'POST', '/api/internal/budget/reserve', {
      runtimeToken: token.token,
      body,
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.json.error.code, 'forbidden_workspace')

    const own = await call(base, 'POST', '/api/internal/budget/reserve', {
      runtimeToken: token.token,
      body: { ...body, workspaceId: ids.wsA, scopeId: ids.wsA },
    })
    assert.equal(own.status, 201)
  })
})

test('budget：按 reservationId 结算时校验归属 → 403', async () => {
  await withSqliteApi(async ({ base, rawStore, clock, ids }) => {
    const body = { workspaceId: ids.wsB, runId: 'run_b', scope: 'workspace', scopeId: ids.wsB, period: 'day', metric: 'tokens', amount: 3 }
    const reserved = await call(base, 'POST', '/api/internal/budget/reserve', { runtimeToken: GLOBAL, body })
    assert.equal(reserved.status, 201)
    const reservationId = reserved.json.reservation.id as string

    const token = issue(rawStore, ids.wsA, clock)
    const denied = await call(base, 'POST', '/api/internal/budget/settle', {
      runtimeToken: token.token,
      body: { reservationId, actual: 1 },
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.json.error.code, 'forbidden_workspace')

    const global = await call(base, 'POST', '/api/internal/budget/settle', {
      runtimeToken: GLOBAL,
      body: { reservationId, actual: 1 },
    })
    assert.equal(global.status, 200)
  })
})

// ---- memories -------------------------------------------------------------------

const MEMORY_BODY = {
  scope: 'team',
  subject: 'alpha',
  claim: 'alpha 今天放量',
  kind: 'conclusion',
  confidence: 0.8,
  falsifier: '收盘缩量',
} as const

test('memories：workspace token 写/检索别的 workspace → 403，自己 → 201/200', async () => {
  await withSqliteApi(async ({ base, rawStore, clock, ids }) => {
    const token = issue(rawStore, ids.wsA, clock)
    const denied = await call(base, 'POST', '/api/internal/memories', {
      runtimeToken: token.token,
      body: { workspaceId: ids.wsB, ...MEMORY_BODY },
    })
    assert.equal(denied.status, 403)

    const ok = await call(base, 'POST', '/api/internal/memories', {
      runtimeToken: token.token,
      body: { workspaceId: ids.wsA, ...MEMORY_BODY },
    })
    assert.equal(ok.status, 201)

    const retrieveDenied = await call(base, 'POST', '/api/internal/memories/retrieve', {
      runtimeToken: token.token,
      body: { workspaceId: ids.wsB, scopes: ['team'], query: 'alpha' },
    })
    assert.equal(retrieveDenied.status, 403)
  })
})

test('memories：recordReads 不能给别的 workspace 的记忆记 hit → 403', async () => {
  await withSqliteApi(async ({ base, rawStore, clock, ids }) => {
    const created = await call(base, 'POST', '/api/internal/memories', {
      runtimeToken: GLOBAL,
      body: { workspaceId: ids.wsB, ...MEMORY_BODY },
    })
    assert.equal(created.status, 201)
    const memoryId = created.json.memory.id as string

    const token = issue(rawStore, ids.wsA, clock)
    const denied = await call(base, 'POST', '/api/internal/memories/reads', {
      runtimeToken: token.token,
      body: { turnId: 'turn_1', ids: [memoryId] },
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.json.error.code, 'forbidden_workspace')
  })
})

// ---- attachments ----------------------------------------------------------------

function artifactHeaders(workspaceId: string, messageSeq: number): Record<string, string> {
  return {
    'x-workspace-id': workspaceId,
    'x-produced-by': 'selector',
    'x-artifact-kind': 'code',
    'x-artifact-name': 'note.txt',
    'x-file-mime': 'text/plain',
    'x-message-seq': String(messageSeq),
    'content-type': 'application/octet-stream',
  }
}

test('attachments：workspace token 往别的 workspace 登记产物 → 403；自己的 → 201', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-runtime-token-att-'))
  try {
    await withSqliteApi(
      async ({ base, rawStore, clock, ids }) => {
        const token = issue(rawStore, ids.wsA, clock)
        const denied = await fetch(`${base}/api/internal/artifacts`, {
          method: 'POST',
          headers: { 'x-runtime-token': token.token, ...artifactHeaders(ids.wsB, ids.messageB) },
          body: 'hello',
        })
        assert.equal(denied.status, 403)
        assert.equal(((await denied.json()) as { error: { code: string } }).error.code, 'forbidden_workspace')

        const ok = await fetch(`${base}/api/internal/artifacts`, {
          method: 'POST',
          headers: { 'x-runtime-token': token.token, ...artifactHeaders(ids.wsA, ids.messageA) },
          body: 'hello',
        })
        assert.equal(ok.status, 201)
      },
      { attachmentsDir: dir },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('workspace token：事件流、delta、notify 不能跨 workspace', async () => {
  await withSqliteApi(async ({ base, rawStore, clock, ids }) => {
    const token = issue(rawStore, ids.wsA, clock)
    const forged = await call(base, 'GET', `/api/internal/events?after=0&workspaceId=${ids.wsB}`, {
      runtimeToken: token.token,
    })
    assert.equal(forged.status, 403)
    assert.equal(forged.json.error.code, 'forbidden_workspace')

    const own = await call(base, 'GET', '/api/internal/events?after=0', { runtimeToken: token.token })
    assert.equal(own.status, 200)
    const events = own.json.events as Array<{ roomId: string; payload?: { text?: string } }>
    assert.ok(events.length > 0)
    assert.ok(events.every((event) => event.roomId === ids.roomA))
    assert.ok(!events.some((event) => event.payload?.text === 'hello B'))

    const delta = await call(base, 'POST', `/api/internal/rooms/${ids.roomB}/deltas`, {
      runtimeToken: token.token,
      body: { botId: 'selector', delta: '越界' },
    })
    assert.equal(delta.status, 403)
    assert.equal(delta.json.error.code, 'forbidden_workspace')

    const notify = await call(base, 'POST', '/api/internal/notify', {
      runtimeToken: token.token,
      body: { roomId: ids.roomB, seq: 0 },
    })
    assert.equal(notify.status, 403)
    assert.equal(notify.json.error.code, 'forbidden_workspace')
  })
})

test('workspace token：不能给别的 workspace 的 routine run 写结果', async () => {
  await withSqliteApi(async ({ base, rawStore, clock, ids }) => {
    const bot = createBot(rawStore, {
      workspaceId: ids.wsB,
      name: '乙的助手',
      model: 'deepseek-chat',
      createdBy: 'acc_b',
    })
    const routine = createRoutine(rawStore, {
      workspaceId: ids.wsB,
      botId: bot.id,
      name: '早报',
      cron: '0 8 * * *',
      prompt: '汇总',
      roomId: ids.roomB,
      at: clock.now(),
    })
    const run = enqueueRoutineNow(rawStore, routine.id, clock.now())
    const token = issue(rawStore, ids.wsA, clock)
    const denied = await call(base, 'POST', `/api/internal/routine-runs/${run.id}/result`, {
      runtimeToken: token.token,
      body: { text: '不该写进乙' },
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.json.error.code, 'forbidden')

    const allowed = issue(rawStore, ids.wsB, clock)
    const ok = await call(base, 'POST', `/api/internal/routine-runs/${run.id}/result`, {
      runtimeToken: allowed.token,
      body: { text: '早报正文' },
    })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.json.run.status, 'posted')
  })
})

test('消息签名不会给别的 workspace 的产物发读取地址', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-runtime-token-sign-'))
  try {
    await withSqliteApi(
      async ({ base, rawStore, ids }) => {
        const uploaded = await fetch(`${base}/api/internal/artifacts`, {
          method: 'POST',
          headers: { 'x-runtime-token': GLOBAL, ...artifactHeaders(ids.wsB, ids.messageB) },
          body: 'secret-bytes',
        })
        assert.equal(uploaded.status, 201, await uploaded.clone().text())
        const artifactId = ((await uploaded.json()) as { artifact: { id: string } }).artifact.id
        sendMessage(rawStore, {
          roomId: ids.roomA,
          text: '引用了别的 workspace',
          actor: { kind: 'user', id: 'acc_a' },
          parts: [{ type: 'image', artifactId }],
          at: NOW,
        })
        const listed = await call(
          base,
          'GET',
          `/api/internal/events?after=0&workspaceId=${encodeURIComponent(ids.wsA)}`,
          { runtimeToken: GLOBAL },
        )
        assert.equal(listed.status, 200, listed.text)
        const events = listed.json.events as Array<{
          payload?: { text?: string }
          message?: { parts?: Array<{ type: string; artifactId?: string; url?: string }> }
        }>
        const event = events.find((item) => item.payload?.text === '引用了别的 workspace')
        assert.ok(event)
        const part = event.message?.parts?.find((item) => item.type === 'image')
        assert.equal(part?.artifactId, artifactId)
        assert.equal(part?.url, undefined)
      },
      { attachmentsDir: dir },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- plugins sync ---------------------------------------------------------------

test('plugins sync：workspace token 必须声明自己的 workspace（缺失/伪造 → 403）', async () => {
  await withSqliteApi(async ({ base, rawStore, clock, ids }) => {
    const token = issue(rawStore, ids.wsA, clock)

    const missing = await call(base, 'POST', '/api/internal/plugins/sync', { runtimeToken: token.token })
    assert.equal(missing.status, 403)
    assert.equal(missing.json.error.code, 'forbidden_workspace')

    const forged = await call(base, 'POST', '/api/internal/plugins/sync', {
      runtimeToken: token.token,
      headers: { 'x-roost-workspace-id': ids.wsB },
    })
    assert.equal(forged.status, 403)

    const ok = await call(base, 'POST', '/api/internal/plugins/sync', {
      runtimeToken: token.token,
      headers: { 'x-roost-workspace-id': ids.wsA },
    })
    assert.equal(ok.status, 200)
    assert.equal(typeof ok.json.lock.id, 'string')

    // 全局 token 不需要声明 workspace。
    const global = await call(base, 'POST', '/api/internal/plugins/sync', { runtimeToken: GLOBAL })
    assert.equal(global.status, 200)
  })
})

// ---- schedules tick -------------------------------------------------------------

test('schedules tick：workspace token → 403（控制面全局操作）；全局 token → 200', async () => {
  await withSqliteApi(async ({ base, rawStore, clock, ids }) => {
    const token = issue(rawStore, ids.wsA, clock)
    const denied = await call(base, 'POST', '/api/internal/scheduler/tick', { runtimeToken: token.token })
    assert.equal(denied.status, 403)
    assert.equal(denied.json.error.code, 'forbidden_workspace')

    const ok = await call(base, 'POST', '/api/internal/scheduler/tick', { runtimeToken: GLOBAL })
    assert.equal(ok.status, 200)
  })
})

// ---- approvals ------------------------------------------------------------------

function approvalBody(workspaceId: string) {
  return {
    workspaceId,
    kind: 'send_email',
    requester: 'bot_analyst',
    requesterKind: 'bot',
    action: '发送邮件',
    target: 'research@example.com',
    consequence: '会发信',
    payload: { subject: '今日异动' },
  }
}

test('approvals：workspace token 只能给自己的 workspace 申请/读取审批', async () => {
  await withSqliteApi(async ({ base, rawStore, clock, ids }) => {
    const token = issue(rawStore, ids.wsA, clock)
    const denied = await call(base, 'POST', '/api/internal/approvals', {
      runtimeToken: token.token,
      body: approvalBody(ids.wsB),
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.json.error.code, 'forbidden_workspace')

    const own = await call(base, 'POST', '/api/internal/approvals', {
      runtimeToken: token.token,
      body: approvalBody(ids.wsA),
    })
    assert.equal(own.status, 201)

    const foreign = await call(base, 'POST', '/api/internal/approvals', {
      runtimeToken: GLOBAL,
      body: approvalBody(ids.wsB),
    })
    assert.equal(foreign.status, 201)
    const foreignId = foreign.json.approval.id as string

    const readDenied = await call(base, 'GET', `/api/internal/approvals/${foreignId}`, {
      runtimeToken: token.token,
    })
    assert.equal(readDenied.status, 403)
  })
})

// ---- rounds ---------------------------------------------------------------------

test('rounds：workspace token 读/推进别的 workspace 的房间轮次 → 403', async () => {
  await withSqliteApi(async ({ base, rawStore, clock, ids }) => {
    const token = issue(rawStore, ids.wsA, clock)
    const denied = await call(base, 'GET', `/api/internal/rooms/${ids.roomB}/assignments`, {
      runtimeToken: token.token,
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.json.error.code, 'forbidden_workspace')

    const roundDenied = await call(base, 'GET', `/api/internal/rooms/${ids.roomB}/round`, {
      runtimeToken: token.token,
    })
    assert.equal(roundDenied.status, 403)

    const own = await call(base, 'GET', `/api/internal/rooms/${ids.roomA}/assignments`, {
      runtimeToken: token.token,
    })
    assert.equal(own.status, 200)
  })
})

// ---- 沙箱启动签发 ---------------------------------------------------------------

test('runtime manager：ensure 为 workspace 签发 24h token，注入 env 且库里可 verify', async () => {
  await withSqliteApi(
    async ({ base, rawStore, clock, ids }) => {
      const captured: { token: string; env: Record<string, string> }[] = []
      const address = new URL(base)
      const manager = openShellRuntimeManager({
        image: 'roost/agent:dev',
        cpHost: '127.0.0.1',
        cpPort: Number(address.port),
        runtimeToken: 'legacy-global-should-not-be-used',
        rawStore,
        now: clock.now,
        ensureSandbox: async (workspaceId, _lockId, context) => {
          captured.push({ token: context.runtimeToken, env: context.env })
          return { sandbox: `user-${workspaceId.slice(-6)}`, phase: 'ready' as const, created: true }
        },
      })

      const result = await manager.ensure(ids.wsA, { store: rawStore })
      assert.equal(result.phase, 'ready')
      assert.equal(typeof result.tokenId, 'string')

      const env = captured[0]!.env
      assert.equal(env.ROOST_WORKSPACE_ID, ids.wsA)
      // 沙箱拿到的是签发的短 token，不是全局 env token。
      assert.notEqual(env.ROOST_RUNTIME_TOKEN, 'legacy-global-should-not-be-used')
      assert.equal(env.ROOST_RUNTIME_TOKEN, captured[0]!.token)
      const verified = verifyRuntimeToken(rawStore, { token: env.ROOST_RUNTIME_TOKEN!, at: clock.now() })
      assert.equal(verified?.workspaceId, ids.wsA)
      assert.equal(verified?.id, result.tokenId)

      // 返回值里的 tokenId 可以吊销这张凭据。
      revokeRuntimeToken(rawStore, { id: result.tokenId!, at: clock.now() })
      assert.equal(verifyRuntimeToken(rawStore, { token: env.ROOST_RUNTIME_TOKEN!, at: clock.now() }), null)
    },
    { runtimeToken: '' },
  )
})

test('runtime manager：复用既有沙箱（env 未重写）时回收本次签发的新 token', async () => {
  await withSqliteApi(
    async ({ base, rawStore, clock, ids }) => {
      let capturedToken = ''
      const address = new URL(base)
      const manager = openShellRuntimeManager({
        image: 'roost/agent:dev',
        cpHost: '127.0.0.1',
        cpPort: Number(address.port),
        runtimeToken: '',
        rawStore,
        now: clock.now,
        ensureSandbox: async (_workspaceId, _lockId, context) => {
          capturedToken = context.runtimeToken
          return { sandbox: 'user-reused', phase: 'ready' as const, created: false }
        },
      })

      const result = await manager.ensure(ids.wsA, { store: rawStore })
      assert.equal(result.tokenId, undefined)
      assert.notEqual(capturedToken, '')
      assert.equal(verifyRuntimeToken(rawStore, { token: capturedToken, at: clock.now() }), null)
    },
    { runtimeToken: '' },
  )
})

test('runtime manager：沙箱启动失败时吊销已签发的 token', async () => {
  const rawStore = openStore(':memory:')
  try {
    let issued: { token: string; id: string } | null = null
    const manager = openShellRuntimeManager({
      image: 'roost/agent:dev',
      cpHost: '127.0.0.1',
      cpPort: 1, // 没有监听：拉锁失败
      runtimeToken: '',
      rawStore,
      tokenIssuer: (workspaceId) => {
        const token = issueRuntimeToken(rawStore, { workspaceId, ttlMs: 24 * HOUR, at: NOW })
        issued = { token: token.token, id: token.id }
        return token
      },
    })
    await assert.rejects(() => manager.ensure('ws_fail'), /profile lock sync failed/)
    assert.notEqual(issued, null)
    assert.equal(verifyRuntimeToken(rawStore, { token: issued!.token, at: NOW }), null)
  } finally {
    rawStore.close()
  }
})

test('runtime manager：没有 rawStore 时退回全局 env token（旧部署兼容）', async () => {
  const { url, close, server } = await startServer({
    store: createMemoryStore(),
    port: 0,
    host: '127.0.0.1',
    runtimeToken: GLOBAL,
  })
  try {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const captured: string[] = []
    const manager = openShellRuntimeManager({
      image: 'roost/agent:dev',
      cpHost: '127.0.0.1',
      cpPort: port,
      runtimeToken: GLOBAL,
      ensureSandbox: async (_workspaceId, _lockId, context) => {
        captured.push(context.runtimeToken)
        return { sandbox: 'user-legacy', phase: 'ready' as const }
      },
    })
    const result = await manager.ensure('ws_legacy')
    assert.equal(result.tokenId, undefined)
    assert.deepEqual(captured, [GLOBAL])
    assert.equal(new URL(url).port, String(port))
  } finally {
    await close()
  }
})
