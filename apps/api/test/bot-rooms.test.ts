// Bot 建群 / 审批 HTTP 层（docs/build/m4-addendum.md §B）。
//
// 这些 handler 由 Lead 接进 server.ts 的路由表；本测试用一个只挂三条路由的
// 迷你 http server 直接驱动 handler，避免修改共享文件，同时仍然走真实 HTTP、
// 真实 SQLite 与真实 Bearer 会话。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { createWorkspace } from '../../../packages/store/src/workspaces.ts'
import { createBot } from '../../../packages/store/src/bots.ts'
import { createApproval } from '../../../packages/store/src/approvals.ts'
import { handleBotCreateRoom, handleDecideApproval, handleListApprovals } from '../src/bot-rooms-routes.ts'
import type { BotRoomsRouteContext } from '../src/bot-rooms-routes.ts'
import type { StorePort, WorkspaceRecord } from '../src/port.ts'
import { createStorePort } from '../src/store-adapter.ts'
import { hashSessionToken, sendError } from '../src/server.ts'

const ACCOUNT = 'acc_bot_rooms'
const TOKEN = 'a'.repeat(64)
const RUNTIME_TOKEN = 'rt_bot_rooms'
const NOW = new Date(2026, 10, 4, 12, 0, 0).getTime()

interface ApiResult {
  status: number
  headers: Headers
  json: any
}

interface Fixture {
  store: Store
  port: StorePort
  ws: WorkspaceRecord
  otherWs: string
  bots: string[]
  foreignBot: string
  call: (method: string, path: string, options?: { body?: unknown; token?: string; runtimeToken?: string }) => Promise<ApiResult>
}

async function withApi(
  fn: (fx: Fixture) => Promise<void>,
  options: { runtimeToken?: string } = { runtimeToken: RUNTIME_TOKEN },
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'roost-bot-rooms-api-'))
  const store = openStore(join(dir, 'workspace.db'))
  const port = createStorePort(store)
  let server: http.Server | null = null

  try {
    const ws = await port.createWorkspace({ accountId: ACCOUNT, name: '工作区 A', now: NOW })
    const otherWs = createWorkspace(store, {
      tenantId: 'acc_other',
      name: '工作区 B',
      profileVersion: 'dev',
      createdAt: NOW,
    })
    const bots = ['研究员', '评审员', '观察员'].map(
      (name) =>
        createBot(store, {
          workspaceId: ws.id,
          name,
          model: 'deepseek-official',
          createdBy: ACCOUNT,
          createdAt: NOW,
        }).id,
    )
    const foreignBot = createBot(store, {
      workspaceId: otherWs.id,
      name: '外来 Bot',
      model: 'deepseek-official',
      createdBy: 'acc_other',
      createdAt: NOW,
    }).id

    await port.createSession({
      accountId: ACCOUNT,
      tokenHash: hashSessionToken(TOKEN),
      now: NOW,
      expiresAt: NOW + 3_600_000,
    })

    const ctx: BotRoomsRouteContext = {
      store: port,
      now: () => NOW,
      rawStore: store,
      runtimeToken: options.runtimeToken,
    }

    server = http.createServer((req, res) => {
      void dispatch(ctx, req, res)
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => resolve())
    })
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

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
      const init: RequestInit = { method, headers }
      if (body !== undefined) init.body = body
      const response = await fetch(`${baseUrl}${path}`, init)
      const text = await response.text()
      let json: any = null
      if (text !== '') {
        try {
          json = JSON.parse(text)
        } catch {
          json = { __unparsed: text }
        }
      }
      return { status: response.status, headers: response.headers, json }
    }

    await fn({ store, port, ws, otherWs: otherWs.id, bots, foreignBot, call })
  } finally {
    if (server !== null) {
      const active = server
      await new Promise<void>((resolve) => {
        active.close(() => resolve())
        active.closeAllConnections()
      })
    }
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function dispatch(ctx: BotRoomsRouteContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://control-plane.local')
  const path = url.pathname.replace(/\/+$/, '') || '/'
  try {
    if (req.method === 'POST' && path === '/api/internal/bot-rooms') {
      await handleBotCreateRoom(ctx, req, res)
      return
    }
    if (req.method === 'GET' && path === '/api/approvals') {
      await handleListApprovals(ctx, req, res)
      return
    }
    if (req.method === 'POST' && /^\/api\/approvals\/[^/]+$/.test(path)) {
      await handleDecideApproval(ctx, req, res, url)
      return
    }
    sendError(res, 404, 'not_found', `no route for ${req.method ?? 'GET'} ${path}`)
  } catch (err) {
    sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err))
  }
}

function requestBody(fx: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: fx.ws.id,
    botId: fx.bots[0]!,
    name: '早盘研究组',
    purpose: '盘前异动',
    memberBotIds: [fx.bots[0]!, fx.bots[1]!],
    ...overrides,
  }
}

function countRooms(store: Store): number {
  const row = store.db.prepare('SELECT COUNT(*) AS n FROM rooms').get() as { n: number | bigint }
  return Number(row.n)
}

test('runtime token：缺失/错误 401；全局未配置但 SQLite 可用 → 401', async () => {
  await withApi(async (fx) => {
    const missing = await fx.call('POST', '/api/internal/bot-rooms', { body: requestBody(fx) })
    assert.equal(missing.status, 401)
    assert.equal(missing.json.error.code, 'unauthenticated')

    const wrong = await fx.call('POST', '/api/internal/bot-rooms', {
      body: requestBody(fx),
      runtimeToken: 'rt_wrong',
    })
    assert.equal(wrong.status, 401)
  })

  await withApi(
    async (fx) => {
      // E6：有 rawStore 就能用每 workspace token，因此这里是 401（缺凭据）。
      const disabled = await fx.call('POST', '/api/internal/bot-rooms', {
        body: requestBody(fx),
        runtimeToken: RUNTIME_TOKEN,
      })
      assert.equal(disabled.status, 401)
      assert.equal(disabled.json.error.code, 'unauthenticated')
    },
    { runtimeToken: undefined },
  )
})

test('Bot 申请建群：202 {approval}，pending，不建房', async () => {
  await withApi(async (fx) => {
    const result = await fx.call('POST', '/api/internal/bot-rooms', {
      body: requestBody(fx),
      runtimeToken: RUNTIME_TOKEN,
    })

    assert.equal(result.status, 202)
    assert.equal(result.headers.get('cache-control'), 'no-store')
    assert.equal(result.json.approval.status, 'pending')
    assert.equal(result.json.approval.kind, 'create_room')
    assert.equal(result.json.approval.requesterKind, 'bot')
    assert.equal(result.json.approval.requester, fx.bots[0])
    assert.deepEqual(result.json.approval.payload.memberBotIds, [fx.bots[0], fx.bots[1]])
    assert.equal(countRooms(fx.store), 0, '审批通过前不建房')
  })
})

test('用户审批列表：workspace 过滤、跨 workspace 403、状态过滤、无会话 401', async () => {
  await withApi(async (fx) => {
    const created = await fx.call('POST', '/api/internal/bot-rooms', {
      body: requestBody(fx),
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(created.status, 202)

    const scoped = await fx.call('GET', `/api/approvals?workspaceId=${fx.ws.id}`, { token: TOKEN })
    assert.equal(scoped.status, 200)
    assert.equal(scoped.headers.get('cache-control'), 'no-store')
    assert.equal(scoped.json.approvals.length, 1)
    assert.equal(scoped.json.approvals[0].id, created.json.approval.id)

    const inbox = await fx.call('GET', '/api/approvals', { token: TOKEN })
    assert.equal(inbox.status, 200)
    assert.equal(inbox.json.approvals.length, 1)

    const pendingOnly = await fx.call('GET', `/api/approvals?workspaceId=${fx.ws.id}&status=pending`, { token: TOKEN })
    assert.equal(pendingOnly.json.approvals.length, 1)
    const approvedOnly = await fx.call('GET', `/api/approvals?workspaceId=${fx.ws.id}&status=approved`, { token: TOKEN })
    assert.equal(approvedOnly.json.approvals.length, 0)

    const foreignWorkspace = await fx.call('GET', `/api/approvals?workspaceId=${fx.otherWs}`, { token: TOKEN })
    assert.equal(foreignWorkspace.status, 403)
    assert.equal(foreignWorkspace.json.error.code, 'forbidden')

    const badStatus = await fx.call('GET', `/api/approvals?workspaceId=${fx.ws.id}&status=bogus`, { token: TOKEN })
    assert.equal(badStatus.status, 400)
    assert.equal(badStatus.json.error.code, 'approval.invalid')

    const anonymous = await fx.call('GET', '/api/approvals')
    assert.equal(anonymous.status, 401)
  })
})

test('批准：200 {room}，成员/host/created_by_kind=bot，审批落 approved', async () => {
  await withApi(async (fx) => {
    const created = await fx.call('POST', '/api/internal/bot-rooms', {
      body: requestBody(fx),
      runtimeToken: RUNTIME_TOKEN,
    })
    const approvalId = created.json.approval.id as string

    const decided = await fx.call('POST', `/api/approvals/${approvalId}`, {
      body: { decision: 'approved' },
      token: TOKEN,
    })
    assert.equal(decided.status, 200)
    assert.equal(decided.headers.get('cache-control'), 'no-store')
    const room = decided.json.room
    assert.equal(room.workspaceId, fx.ws.id)
    assert.equal(room.name, '早盘研究组')
    assert.equal(room.purpose, '盘前异动')
    assert.equal(room.hostBotId, fx.bots[0])
    assert.equal(room.createdByKind, 'bot')
    assert.equal(room.createdBy, fx.bots[0])
    assert.equal(room.members[0].role, 'host')
    assert.deepEqual(room.members.map((member: { botId: string }) => member.botId).sort(), [fx.bots[0]!, fx.bots[1]!].sort())
    assert.equal(decided.json.approval.status, 'approved')
    assert.equal(decided.json.approval.decidedBy, ACCOUNT)

    const row = fx.store.db.prepare('SELECT created_by_kind, created_by, host_bot_id FROM rooms WHERE id = ?').get(room.id) as {
      created_by_kind: string
      created_by: string
      host_bot_id: string
    }
    assert.equal(row.created_by_kind, 'bot')
    assert.equal(row.created_by, fx.bots[0])
    assert.equal(row.host_bot_id, fx.bots[0])
    assert.equal(countRooms(fx.store), 1)
  })
})

test('重复批准幂等：同一个房间，不建第二个', async () => {
  await withApi(async (fx) => {
    const created = await fx.call('POST', '/api/internal/bot-rooms', {
      body: requestBody(fx),
      runtimeToken: RUNTIME_TOKEN,
    })
    const approvalId = created.json.approval.id as string

    const first = await fx.call('POST', `/api/approvals/${approvalId}`, { body: { decision: 'approved' }, token: TOKEN })
    const second = await fx.call('POST', `/api/approvals/${approvalId}`, { body: { decision: 'approved' }, token: TOKEN })

    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal(second.json.room.id, first.json.room.id)
    assert.equal(second.json.approval.decidedAt, first.json.approval.decidedAt)
    assert.equal(countRooms(fx.store), 1)
  })
})

test('拒绝：不建房；拒绝后再批准 409 approval.decided', async () => {
  await withApi(async (fx) => {
    const created = await fx.call('POST', '/api/internal/bot-rooms', {
      body: requestBody(fx),
      runtimeToken: RUNTIME_TOKEN,
    })
    const approvalId = created.json.approval.id as string

    const rejected = await fx.call('POST', `/api/approvals/${approvalId}`, { body: { decision: 'rejected' }, token: TOKEN })
    assert.equal(rejected.status, 200)
    assert.equal(rejected.json.approval.status, 'rejected')
    assert.equal(countRooms(fx.store), 0)

    const approveAfterReject = await fx.call('POST', `/api/approvals/${approvalId}`, {
      body: { decision: 'approved' },
      token: TOKEN,
    })
    assert.equal(approveAfterReject.status, 409)
    assert.equal(approveAfterReject.json.error.code, 'approval.decided')
    assert.equal(countRooms(fx.store), 0)
  })
})

test('每日配额：第 4 个申请 429 bot.room_quota', async () => {
  await withApi(async (fx) => {
    for (let index = 0; index < 3; index += 1) {
      const created = await fx.call('POST', '/api/internal/bot-rooms', {
        body: requestBody(fx, { name: `房间 ${index + 1}` }),
        runtimeToken: RUNTIME_TOKEN,
      })
      assert.equal(created.status, 202)
      const decided = await fx.call('POST', `/api/approvals/${created.json.approval.id as string}`, {
        body: { decision: 'approved' },
        token: TOKEN,
      })
      assert.equal(decided.status, 200)
    }
    assert.equal(countRooms(fx.store), 3)

    const fourth = await fx.call('POST', '/api/internal/bot-rooms', {
      body: requestBody(fx, { name: '第 4 个' }),
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(fourth.status, 429)
    assert.equal(fourth.json.error.code, 'bot.room_quota')
    assert.equal(countRooms(fx.store), 3)
  })
})

test('跨 workspace 成员：400 bot.room_members', async () => {
  await withApi(async (fx) => {
    const result = await fx.call('POST', '/api/internal/bot-rooms', {
      body: requestBody(fx, { memberBotIds: [fx.bots[0]!, fx.foreignBot] }),
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(result.status, 400)
    assert.equal(result.json.error.code, 'bot.room_members')
    assert.equal(countRooms(fx.store), 0)
  })
})

test('审批可见性：非成员/未知 id 都是 404；非法 decision 400', async () => {
  await withApi(async (fx) => {
    const foreign = createApproval(fx.store, {
      workspaceId: fx.otherWs,
      kind: 'create_room',
      requester: fx.foreignBot,
      payload: { botId: fx.foreignBot },
      at: NOW,
    })

    const notVisible = await fx.call('POST', `/api/approvals/${foreign.id}`, {
      body: { decision: 'approved' },
      token: TOKEN,
    })
    assert.equal(notVisible.status, 404)
    assert.equal(notVisible.json.error.code, 'approval.not_found')

    const missing = await fx.call('POST', '/api/approvals/apr_missing', {
      body: { decision: 'approved' },
      token: TOKEN,
    })
    assert.equal(missing.status, 404)

    const created = await fx.call('POST', '/api/internal/bot-rooms', {
      body: requestBody(fx),
      runtimeToken: RUNTIME_TOKEN,
    })
    const bad = await fx.call('POST', `/api/approvals/${created.json.approval.id as string}`, {
      body: { decision: 'maybe' },
      token: TOKEN,
    })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.error.code, 'approval.invalid')

    const noMembers = await fx.call('POST', '/api/internal/bot-rooms', {
      body: requestBody(fx, { memberBotIds: undefined }),
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(noMembers.status, 400)
    assert.equal(noMembers.json.error.code, 'bot.room_members')
  })
})
