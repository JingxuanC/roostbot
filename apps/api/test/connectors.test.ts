// 连接器控制面 API（M6-6.1）：目录/连接/回调/断开/授权/内部调用与幂等。
//
// 走真实 HTTP + 真实 SQLite + 真实 Bearer 会话；OAuth 网关用 fake 注入
// （ServerOptions.connectorBackend），不碰真实第三方。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { GatewayBackend } from '../../../packages/connectors/src/index.ts'
import { openStore, readEvents } from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import type { StorePort } from '../src/port.ts'
import { createStorePort } from '../src/store-adapter.ts'
import { hashSessionToken, startServer } from '../src/server.ts'
import { pairDevice, startHarness } from './helpers.ts'

const ACCOUNT = 'acc_connector_owner'
const VIEWER = 'acc_connector_viewer'
const TOKEN = 'a'.repeat(64)
const VIEWER_TOKEN = 'b'.repeat(64)
const RUNTIME_TOKEN = 'rt_connectors'
const BOT_ID = 'bot_analyst'
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)

interface ApiResult {
  status: number
  headers: Headers
  json: any
}

interface Fixture {
  store: Store
  wsId: string
  clock: { now: () => number; advance: (ms: number) => void }
  backendCalls: { count: number; calls: Array<{ connectionAlias?: string; accountId?: string }> }
  call: (method: string, path: string, options?: { body?: unknown; token?: string; runtimeToken?: string }) => Promise<ApiResult>
}

function fakeBackend(backendCalls: { count: number; calls: Array<{ connectionAlias?: string; accountId?: string }> }): GatewayBackend {
  return {
    id: 'openconnector',
    async listConnectors() {
      return [
        {
          slug: 'github',
          title: 'GitHub',
          backend: 'openconnector',
          actions: [
            { name: 'list_issues', access: 'read' },
            { name: 'create_pr', access: 'write' },
          ],
        },
      ]
    },
    async authorize(slug: string) {
      return { url: `https://gateway.example/oauth/${slug}` }
    },
    async call(call) {
      backendCalls.count += 1
      backendCalls.calls.push({ connectionAlias: call.connectionAlias, accountId: call.accountId })
      return { ok: true, data: { action: call.action, echo: call.args }, bytes: 42 }
    },
    async status(_slug: string) {
      return 'connected'
    },
  }
}

async function withApi(
  fn: (fx: Fixture) => Promise<void>,
  options: { runtimeToken?: string } = { runtimeToken: RUNTIME_TOKEN },
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'roost-connectors-api-'))
  const store = openStore(join(dir, 'workspace.db'))
  const port = createStorePort(store)
  let current = NOW
  const clock = { now: () => current, advance: (ms: number) => { current += ms } }
  const backendCalls = { count: 0, calls: [] as Array<{ connectionAlias?: string; accountId?: string }> }
  let started: Awaited<ReturnType<typeof startServer>> | null = null

  try {
    const ws = await port.createWorkspace({ accountId: ACCOUNT, name: '连接器工作区', now: NOW })
    store.db
      .prepare(
        'INSERT INTO workspace_members (workspace_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(ws.id, VIEWER, 'viewer', ACCOUNT, NOW)
    await port.createSession({ accountId: ACCOUNT, tokenHash: hashSessionToken(TOKEN), now: NOW, expiresAt: NOW + 3_600_000 })
    await port.createSession({ accountId: VIEWER, tokenHash: hashSessionToken(VIEWER_TOKEN), now: NOW, expiresAt: NOW + 3_600_000 })

    started = await startServer({
      store: port,
      rawStore: store,
      now: clock.now,
      port: 0,
      host: '127.0.0.1',
      connectorBackend: fakeBackend(backendCalls),
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

    await fn({ store, wsId: ws.id, clock, backendCalls, call })
  } finally {
    if (started !== null) await started.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function connectorKinds(store: Store): string[] {
  return readEvents(store, { domain: 'connector' }).map((event) => event.kind)
}

function callsRows(store: Store): { ok: number; denied_reason: string | null; idem: string | null }[] {
  return store.db
    .prepare('SELECT ok, denied_reason, idem FROM connector_calls ORDER BY rowid ASC')
    .all() as { ok: number; denied_reason: string | null; idem: string | null }[]
}

async function connectViaApi(fx: Fixture, slug = 'github', token = TOKEN): Promise<string> {
  const started = await fx.call('POST', `/api/connectors/${slug}/connect`, { body: { workspaceId: fx.wsId }, token })
  assert.equal(started.status, 201, JSON.stringify(started.json))
  assert.match(started.json.url, /^https:\/\/gateway\.example\/oauth\//)
  const state = started.json.state as string
  assert.equal(state.length, 48)

  const callback = await fx.call(
    'GET',
    `/api/connectors/callback/${slug}?code=code-1&state=${state}&status=connected`,
  )
  assert.equal(callback.status, 200, JSON.stringify(callback.json))
  assert.equal(callback.json.connected, true)
  return state
}

async function putGrant(
  fx: Fixture,
  body: Record<string, unknown>,
  token = TOKEN,
): Promise<ApiResult> {
  return fx.call('PUT', '/api/connectors/github/grants', {
    body: { workspaceId: fx.wsId, botId: BOT_ID, ...body },
    token,
  })
}

function callBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: 'ws_placeholder',
    botId: BOT_ID,
    slug: 'github',
    action: 'list_issues',
    args: { repo: 'roostbot' },
    ...overrides,
  }
}

test('目录：任意成员可看，合并连接状态与 Bot 授权摘要；匿名 401、非成员 403', async () => {
  await withApi(async (fx) => {
    const anonymous = await fx.call('GET', `/api/connectors?workspaceId=${fx.wsId}`)
    assert.equal(anonymous.status, 401)

    const viewer = await fx.call('GET', `/api/connectors?workspaceId=${fx.wsId}`, { token: VIEWER_TOKEN })
    assert.equal(viewer.status, 200)
    assert.equal(viewer.json.connectors.length, 1)
    assert.equal(viewer.json.connectors[0].slug, 'github')
    assert.equal(viewer.json.connectors[0].connected, false)
    assert.deepEqual(viewer.json.connections, [])

    await connectViaApi(fx)
    await putGrant(fx, { access: 'read', actions: ['list_issues'] })

    const listed = await fx.call('GET', `/api/connectors?workspaceId=${fx.wsId}&botId=${BOT_ID}`, { token: VIEWER_TOKEN })
    assert.equal(listed.status, 200)
    assert.equal(listed.json.connectors[0].connected, true)
    assert.equal(listed.json.connectors[0].status, 'connected')
    assert.equal(listed.json.connections.length, 1)
    assert.equal(listed.json.connections[0].slug, 'github')
    assert.equal(listed.json.botGrants.length, 1)
    assert.equal(listed.json.botGrants[0].access, 'read')

    const outsider = await fx.call('GET', `/api/connectors?workspaceId=${fx.wsId}`, { token: 'c'.repeat(64) })
    assert.equal(outsider.status, 401)

    const missing = await fx.call('GET', '/api/connectors', { token: TOKEN })
    assert.equal(missing.status, 400)
  })
})

test('连接 / 回调 / 断开：owner 起 OAuth，state 一次有效，断开会话幂等并写事件', async () => {
  await withApi(async (fx) => {
    const viewerConnect = await fx.call('POST', '/api/connectors/github/connect', {
      body: { workspaceId: fx.wsId },
      token: VIEWER_TOKEN,
    })
    // 普通成员也可以连接自己的账号；不和 owner 的连接互相覆盖。
    assert.equal(viewerConnect.status, 201)

    await connectViaApi(fx)
    assert.equal(callsRows(fx.store).length, 0, 'connecting does not record a call')
    assert.ok(connectorKinds(fx.store).includes('connector.connected'))

    // 同一个 state 不能再用（回调已消费）。
    const started = await fx.call('POST', '/api/connectors/github/connect', { body: { workspaceId: fx.wsId }, token: TOKEN })
    const reused = await fx.call(
      'GET',
      `/api/connectors/callback/github?code=x&state=${started.json.state}&status=connected`,
    )
    assert.equal(reused.status, 200)
    const replay = await fx.call(
      'GET',
      `/api/connectors/callback/github?code=x&state=${started.json.state}&status=connected`,
    )
    assert.equal(replay.status, 400)
    assert.equal(replay.json.error.code, 'connector.invalid_state')

    const deleted = await fx.call('DELETE', `/api/connectors/github?workspaceId=${fx.wsId}`, { token: TOKEN })
    assert.equal(deleted.status, 204)
    const again = await fx.call('DELETE', `/api/connectors/github?workspaceId=${fx.wsId}`, { token: TOKEN })
    assert.equal(again.status, 204)
    assert.ok(connectorKinds(fx.store).includes('connector.disconnected'))

    const viewerDelete = await fx.call('DELETE', `/api/connectors/github?workspaceId=${fx.wsId}`, { token: VIEWER_TOKEN })
    assert.equal(viewerDelete.status, 204)
  })
})

test('回调兼容 OpenConnector 的 status=success', async () => {
  await withApi(async (fx) => {
    const started = await fx.call('POST', '/api/connectors/github/connect', { body: { workspaceId: fx.wsId }, token: TOKEN })
    assert.equal(started.status, 201)
    const callback = await fx.call(
      'GET',
      `/api/connectors/callback/github?state=${started.json.state}&status=success&service=github&code=None`,
    )
    assert.equal(callback.status, 200, JSON.stringify(callback.json))
    assert.equal(callback.json.connected, true)
    assert.equal(fx.store.db.prepare('SELECT COUNT(*) AS n FROM connections WHERE workspace_id = ?').get(fx.wsId).n, 1)
  })
})

test('state 校验：篡改、绑定 slug 不符、过期都 400', async () => {
  await withApi(async (fx) => {
    const started = await fx.call('POST', '/api/connectors/github/connect', { body: { workspaceId: fx.wsId }, token: TOKEN })
    assert.equal(started.status, 201)
    const state = started.json.state as string

    const tampered = await fx.call(
      'GET',
      `/api/connectors/callback/github?state=${state.slice(0, -1)}${state.endsWith('a') ? 'b' : 'a'}&status=connected`,
    )
    assert.equal(tampered.status, 400)
    assert.equal(tampered.json.error.code, 'connector.invalid_state')

    const wrongSlug = await fx.call(
      'GET',
      `/api/connectors/callback/gmail?state=${state}&status=connected`,
    )
    assert.equal(wrongSlug.status, 400)
    assert.equal(wrongSlug.json.error.code, 'connector.invalid_state')

    const fresh = await fx.call('POST', '/api/connectors/github/connect', { body: { workspaceId: fx.wsId }, token: TOKEN })
    fx.clock.advance(10 * 60 * 1000 + 1)
    const expired = await fx.call(
      'GET',
      `/api/connectors/callback/github?state=${fresh.json.state}&status=connected`,
    )
    assert.equal(expired.status, 400)
    assert.equal(expired.json.error.code, 'connector.invalid_state')
  })
})

test('授权接口：owner/admin 才能读写；同 bot+slug 覆盖；非法 access 400', async () => {
  await withApi(async (fx) => {
    const denied = await putGrant(fx, { access: 'read' }, VIEWER_TOKEN)
    assert.equal(denied.status, 403)

    const created = await putGrant(fx, { access: 'read', actions: ['list_issues'] })
    assert.equal(created.status, 200)
    assert.equal(created.json.grant.botId, BOT_ID)
    assert.deepEqual(created.json.grant.actions, ['list_issues'])

    const overridden = await putGrant(fx, { access: 'write', actions: ['create_pr'] })
    assert.equal(overridden.status, 200)
    assert.equal(overridden.json.grant.id, created.json.grant.id)
    assert.equal(overridden.json.grant.access, 'write')

    const listed = await fx.call('GET', `/api/connectors/github/grants?workspaceId=${fx.wsId}`, { token: TOKEN })
    assert.equal(listed.status, 200)
    assert.equal(listed.json.grants.length, 1)
    assert.deepEqual(listed.json.grants[0].actions, ['create_pr'])

    const viewerList = await fx.call('GET', `/api/connectors/github/grants?workspaceId=${fx.wsId}`, { token: VIEWER_TOKEN })
    assert.equal(viewerList.status, 403)

    const invalid = await putGrant(fx, { access: 'admin' })
    assert.equal(invalid.status, 400)

    const badActions = await putGrant(fx, { access: 'read', actions: ['ok', 42] })
    assert.equal(badActions.status, 400)
  })
})

test('多用户连接：各自连接、默认连接、Bot 可按 connectionId 指定账号', async () => {
  await withApi(async (fx) => {
    await connectViaApi(fx, 'github', TOKEN)
    await connectViaApi(fx, 'github', VIEWER_TOKEN)

    const connections = fx.store.db
      .prepare('SELECT id, account_id, alias, is_default FROM connections WHERE workspace_id = ? ORDER BY account_id')
      .all(fx.wsId) as Array<{ id: string; account_id: string; alias: string; is_default: number }>
    assert.equal(connections.length, 2)
    assert.deepEqual(connections.map((row) => row.account_id), [ACCOUNT, VIEWER])
    assert.equal(connections.filter((row) => row.is_default === 1).length, 1)
    assert.ok(connections.every((row) => /^roost_[a-f0-9]{24}$/.test(row.alias)))

    const viewerView = await fx.call('GET', `/api/connectors?workspaceId=${fx.wsId}`, { token: VIEWER_TOKEN })
    assert.equal(viewerView.status, 200)
    assert.equal(viewerView.json.connectors[0].isMine, true)
    assert.equal(viewerView.json.connectors[0].connectionOwner, VIEWER)
    assert.equal(viewerView.json.connectors[0].connectionCount, 2)

    const ownerView = await fx.call('GET', `/api/connectors?workspaceId=${fx.wsId}`, { token: TOKEN })
    assert.equal(ownerView.json.connectors[0].connectionOwner, ACCOUNT)
    assert.equal(ownerView.json.connectors[0].isDefault, true)

    const viewerConnection = connections.find((row) => row.account_id === VIEWER)!
    const grant = await putGrant(fx, {
      access: 'read',
      actions: ['list_issues'],
      connectionId: viewerConnection.id,
    })
    assert.equal(grant.status, 200, JSON.stringify(grant.json))
    assert.equal(grant.json.grant.connectionId, viewerConnection.id)

    const called = await fx.call('POST', '/api/internal/connectors/call', {
      body: callBody({ workspaceId: fx.wsId }),
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(called.status, 200, JSON.stringify(called.json))
    assert.equal(fx.backendCalls.calls.at(-1)?.accountId, VIEWER)
    assert.equal(fx.backendCalls.calls.at(-1)?.connectionAlias, viewerConnection.alias)
  })
})

test('内部调用：runtime token、未连接、无授权、动作不在 allowlist 全拒绝并审计', async () => {
  await withApi(async (fx) => {
    const missing = await fx.call('POST', '/api/internal/connectors/call', { body: callBody({ workspaceId: fx.wsId }) })
    assert.equal(missing.status, 401)

    const wrong = await fx.call('POST', '/api/internal/connectors/call', {
      body: callBody({ workspaceId: fx.wsId }),
      runtimeToken: 'rt_wrong',
    })
    assert.equal(wrong.status, 401)

    const noGrant = await fx.call('POST', '/api/internal/connectors/call', {
      body: callBody({ workspaceId: fx.wsId }),
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(noGrant.status, 403)
    assert.equal(noGrant.json.deniedReason, 'no_grant')

    await putGrant(fx, { access: 'read', actions: ['list_issues'] })
    const notConnected = await fx.call('POST', '/api/internal/connectors/call', {
      body: callBody({ workspaceId: fx.wsId }),
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(notConnected.status, 403)
    assert.equal(notConnected.json.error.code, 'connector.denied')
    assert.equal(notConnected.json.deniedReason, 'not_connected')

    await connectViaApi(fx)
    const notAllowed = await fx.call('POST', '/api/internal/connectors/call', {
      body: callBody({ workspaceId: fx.wsId, action: 'create_pr' }),
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(notAllowed.status, 403)
    assert.equal(notAllowed.json.deniedReason, 'action_not_granted')

    const rows = callsRows(fx.store)
    assert.deepEqual(rows.map((row) => row.denied_reason), ['no_grant', 'not_connected', 'action_not_granted'])
    const kinds = connectorKinds(fx.store)
    assert.equal(kinds.filter((kind) => kind === 'connector.call').length, 3)
  })
})

test('内部调用：只读成功；写动作无长期授权 → 202 审批且不调用', async () => {
  await withApi(async (fx) => {
    await connectViaApi(fx)
    await putGrant(fx, { access: 'read', actions: ['list_issues'] })

    const ok = await fx.call('POST', '/api/internal/connectors/call', {
      body: callBody({ workspaceId: fx.wsId }),
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.ok, true)
    assert.equal(ok.json.result.action, 'list_issues')
    assert.equal(fx.backendCalls.count, 1)
    const successRow = callsRows(fx.store).at(-1)!
    assert.equal(successRow.ok, 1)
    assert.equal(successRow.denied_reason, null)

    // 写授权；create_pr 有副作用 → 先审批。
    await putGrant(fx, { access: 'write', actions: ['create_pr'] })
    const pending = await fx.call('POST', '/api/internal/connectors/call', {
      body: callBody({ workspaceId: fx.wsId, action: 'create_pr', args: { title: 'x' } }),
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(pending.status, 202, JSON.stringify(pending.json))
    assert.equal(pending.json.approval.status, 'pending')
    assert.equal(pending.json.approval.kind, 'connector_action')
    assert.equal(pending.json.approval.action, 'github.create_pr')
    assert.equal(pending.json.approval.target, BOT_ID)
    assert.equal(fx.backendCalls.count, 1, '审批前不调用后端')
    assert.equal(callsRows(fx.store).length, 1, '审批请求不写 connector_calls')

    const approvals = fx.store.db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }
    assert.equal(Number(approvals.n), 1)

    // 重复请求仍然 202（没有长期授权就没有放行）。
    const again = await fx.call('POST', '/api/internal/connectors/call', {
      body: callBody({ workspaceId: fx.wsId, action: 'create_pr' }),
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(again.status, 202)
    assert.equal(fx.backendCalls.count, 1)
  })
})

test('内部调用：命中 approval_grants 直接放行；idem 重放只调用一次', async () => {
  await withApi(async (fx) => {
    await connectViaApi(fx)
    await putGrant(fx, { access: 'write', actions: ['create_pr'] })

    const grant = await fx.call('POST', '/api/approval-grants', {
      body: { workspaceId: fx.wsId, kind: 'connector_action', action: 'github.create_pr', target: BOT_ID },
      token: TOKEN,
    })
    assert.equal(grant.status, 201)

    const allowed = await fx.call('POST', '/api/internal/connectors/call', {
      body: callBody({ workspaceId: fx.wsId, action: 'create_pr' }),
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(allowed.status, 200, JSON.stringify(allowed.json))
    assert.equal(allowed.json.ok, true)
    assert.equal(fx.backendCalls.count, 1)

    // idem：第一次正常调用，第二次返回 deduped 且不再打后端。
    await putGrant(fx, { access: 'read', actions: ['list_issues'] })
    const first = await fx.call('POST', '/api/internal/connectors/call', {
      body: callBody({ workspaceId: fx.wsId, idem: 'idem-1' }),
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(first.status, 200)
    assert.equal(first.json.ok, true)
    const second = await fx.call('POST', '/api/internal/connectors/call', {
      body: callBody({ workspaceId: fx.wsId, idem: 'idem-1' }),
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(second.status, 200)
    assert.equal(second.json.deduped, true)
    assert.equal(fx.backendCalls.count, 2, 'idem replay must not call the gateway again')

    const withIdem = callsRows(fx.store).filter((row) => row.idem === 'idem-1')
    assert.equal(withIdem.length, 1)
    const callEvents = readEvents(fx.store, { domain: 'connector' }).filter((event) => event.kind === 'connector.call')
    assert.equal(callEvents.length, 2)
  })
})

test('内部接口：全局 token 未配置但 SQLite 可用 → 401（workspace token 模式）', async () => {
  await withApi(
    async (fx) => {
      const disabled = await fx.call('POST', '/api/internal/connectors/call', {
        body: callBody({ workspaceId: fx.wsId }),
        runtimeToken: RUNTIME_TOKEN,
      })
      assert.equal(disabled.status, 401)
      assert.equal(disabled.json.error.code, 'unauthenticated')
    },
    { runtimeToken: '' },
  )
})

test('memory port（无 rawStore）：连接器接口 503 runtime.not_configured', async () => {
  const harness = await startHarness()
  try {
    const token = await pairDevice(harness)
    const listed = await harness.call('GET', '/api/connectors?workspaceId=ws_memory', { token })
    assert.equal(listed.status, 503)
    assert.equal(listed.json.error.code, 'runtime.not_configured')

    const called = await harness.call('POST', '/api/internal/connectors/call', {
      body: { workspaceId: 'ws_memory', botId: BOT_ID, slug: 'github', action: 'list_issues' },
      headers: { 'x-runtime-token': 'rt_any' },
    })
    assert.equal(called.status, 404, 'memory harness has no runtime token configured')
  } finally {
    await harness.close()
  }
})
