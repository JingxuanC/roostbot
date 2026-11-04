// 运行时审批申请 + 用户侧长期授权 + 决策事件（M5-5.4）。
//
// 走真实 HTTP / 真实 SQLite / 真实 Bearer 会话，并直接使用 server.ts 的路由接线，
// 这样也顺带验证 /api/internal/approvals 与 /api/approval-grants 已经接上。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { createBot } from '../../../packages/store/src/bots.ts'
import { hashSessionToken, startServer } from '../src/server.ts'
import type { StorePort, WorkspaceRecord } from '../src/port.ts'
import { createStorePort } from '../src/store-adapter.ts'

const ACCOUNT = 'acc_approvals'
const VIEWER = 'acc_approvals_viewer'
const TOKEN = 'a'.repeat(64)
const VIEWER_TOKEN = 'b'.repeat(64)
const RUNTIME_TOKEN = 'rt_approvals'
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
  const dir = mkdtempSync(join(tmpdir(), 'roost-approvals-api-'))
  const store = openStore(join(dir, 'workspace.db'))
  const port = createStorePort(store)
  let started: Awaited<ReturnType<typeof startServer>> | null = null

  try {
    const ws = await port.createWorkspace({ accountId: ACCOUNT, name: '审批工作区', now: NOW })
    store.db
      .prepare(
        'INSERT INTO workspace_members (workspace_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(ws.id, VIEWER, 'viewer', ACCOUNT, NOW)
    await port.createSession({
      accountId: ACCOUNT,
      tokenHash: hashSessionToken(TOKEN),
      now: NOW,
      expiresAt: NOW + 3_600_000,
    })
    await port.createSession({
      accountId: VIEWER,
      tokenHash: hashSessionToken(VIEWER_TOKEN),
      now: NOW,
      expiresAt: NOW + 3_600_000,
    })

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

    await fn({ store, port, ws, call })
  } finally {
    if (started !== null) await started.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function approvalKinds(store: Store): string[] {
  return store.db
    .prepare("SELECT kind FROM events WHERE domain = 'approval' ORDER BY seq ASC")
    .all()
    .map((row) => (row as { kind: string }).kind)
}

function countApprovals(store: Store): number {
  const row = store.db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number | bigint }
  return Number(row.n)
}

function internalBody(fx: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: fx.ws.id,
    kind: 'send_email',
    action: '发送邮件',
    target: 'research@example.com',
    consequence: '会向外部地址发送今日异动摘要',
    requester: 'bot_analyst',
    requesterKind: 'bot',
    payload: { subject: '今日异动摘要' },
    ...overrides,
  }
}

test('runtime token：未配置 404、缺失/错误 401', async () => {
  await withApi(
    async (fx) => {
      const disabled = await fx.call('POST', '/api/internal/approvals', {
        body: internalBody(fx),
        runtimeToken: RUNTIME_TOKEN,
      })
      assert.equal(disabled.status, 404)
      assert.equal(disabled.json.error.code, 'not_found')
    },
    { runtimeToken: '' },
  )

  await withApi(async (fx) => {
    const missing = await fx.call('POST', '/api/internal/approvals', { body: internalBody(fx) })
    assert.equal(missing.status, 401)
    assert.equal(missing.json.error.code, 'unauthenticated')

    const wrong = await fx.call('POST', '/api/internal/approvals', {
      body: internalBody(fx),
      runtimeToken: 'rt_wrong',
    })
    assert.equal(wrong.status, 401)

    const getMissing = await fx.call('GET', '/api/internal/approvals/apr_missing')
    assert.equal(getMissing.status, 401)
  })
})

test('POST /api/internal/approvals：无授权 → 201 pending，写审批四要素与 approval.requested', async () => {
  await withApi(async (fx) => {
    const created = await fx.call('POST', '/api/internal/approvals', {
      body: internalBody(fx),
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(created.status, 201)
    assert.equal(created.headers.get('cache-control'), 'no-store')
    const approval = created.json.approval
    assert.equal(approval.status, 'pending')
    assert.equal(approval.kind, 'send_email')
    assert.equal(approval.action, '发送邮件')
    assert.equal(approval.target, 'research@example.com')
    assert.equal(approval.consequence, '会向外部地址发送今日异动摘要')
    assert.equal(approval.requester, 'bot_analyst')
    assert.equal(approval.requesterKind, 'bot')
    assert.deepEqual(approval.payload, { subject: '今日异动摘要' })

    const fetched = await fx.call('GET', `/api/internal/approvals/${approval.id}`, { runtimeToken: RUNTIME_TOKEN })
    assert.equal(fetched.status, 200)
    assert.deepEqual(fetched.json.approval, approval)

    assert.deepEqual(approvalKinds(fx.store), ['approval.requested'])

    const missing = await fx.call('GET', '/api/internal/approvals/apr_missing', { runtimeToken: RUNTIME_TOKEN })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.code, 'approval.not_found')

    const bad = await fx.call('POST', '/api/internal/approvals', {
      body: { workspaceId: fx.ws.id, kind: 'send_email' },
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.error.code, 'invalid_body')
  })
})

test('长期授权命中：200 {approval:null, granted:true}，不建 pending；不匹配则 201', async () => {
  await withApi(async (fx) => {
    const grant = await fx.call('POST', '/api/approval-grants', {
      body: { workspaceId: fx.ws.id, kind: 'send_email', action: '发送邮件', target: 'research@example.com' },
      token: TOKEN,
    })
    assert.equal(grant.status, 201)
    assert.equal(grant.headers.get('cache-control'), 'no-store')
    assert.equal(grant.json.grant.grantedBy, ACCOUNT)
    assert.equal(grant.json.grant.revokedAt, null)

    const allowed = await fx.call('POST', '/api/internal/approvals', {
      body: internalBody(fx),
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(allowed.status, 200)
    assert.deepEqual(allowed.json, { approval: null, granted: true })
    assert.equal(countApprovals(fx.store), 0, '命中授权不落 pending 行')
    assert.deepEqual(approvalKinds(fx.store), [], '命中授权不写 approval.requested')

    // 精确匹配：target 不同就不算命中。
    const mismatch = await fx.call('POST', '/api/internal/approvals', {
      body: internalBody(fx, { target: 'other@example.com' }),
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(mismatch.status, 201)
    assert.equal(mismatch.json.approval.status, 'pending')

    const listed = await fx.call('GET', `/api/approval-grants?workspaceId=${fx.ws.id}`, { token: TOKEN })
    assert.equal(listed.status, 200)
    assert.equal(listed.json.grants.length, 1)
    assert.equal(listed.json.grants[0].id, grant.json.grant.id)
  })
})

test('撤销：DELETE 204 且幂等；撤销后同一请求重新落 pending；未知 id 404', async () => {
  await withApi(async (fx) => {
    const grant = await fx.call('POST', '/api/approval-grants', {
      body: { workspaceId: fx.ws.id, kind: 'send_email' },
      token: TOKEN,
    })
    const grantId = grant.json.grant.id as string

    const first = await fx.call('DELETE', `/api/approval-grants/${grantId}`, { token: TOKEN })
    assert.equal(first.status, 204)
    const second = await fx.call('DELETE', `/api/approval-grants/${grantId}`, { token: TOKEN })
    assert.equal(second.status, 204)

    const listed = await fx.call('GET', `/api/approval-grants?workspaceId=${fx.ws.id}`, { token: TOKEN })
    assert.deepEqual(listed.json.grants, [])

    const after = await fx.call('POST', '/api/internal/approvals', {
      body: internalBody(fx, { action: null, target: null }),
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(after.status, 201)
    assert.equal(after.json.approval.status, 'pending')

    const unknown = await fx.call('DELETE', '/api/approval-grants/apg_missing', { token: TOKEN })
    assert.equal(unknown.status, 404)
    assert.equal(unknown.json.error.code, 'approval_grant.not_found')
  })
})

test('长期授权权限：仅 workspace owner/admin；无 Bearer 401；缺 workspaceId 400', async () => {
  await withApi(async (fx) => {
    const anonymous = await fx.call('GET', `/api/approval-grants?workspaceId=${fx.ws.id}`)
    assert.equal(anonymous.status, 401)

    const viewerList = await fx.call('GET', `/api/approval-grants?workspaceId=${fx.ws.id}`, { token: VIEWER_TOKEN })
    assert.equal(viewerList.status, 403)
    assert.equal(viewerList.json.error.code, 'forbidden')

    const viewerCreate = await fx.call('POST', '/api/approval-grants', {
      body: { workspaceId: fx.ws.id, kind: 'send_email' },
      token: VIEWER_TOKEN,
    })
    assert.equal(viewerCreate.status, 403)

    const ownerCreate = await fx.call('POST', '/api/approval-grants', {
      body: { workspaceId: fx.ws.id, kind: 'send_email' },
      token: TOKEN,
    })
    assert.equal(ownerCreate.status, 201)
    const viewerDelete = await fx.call('DELETE', `/api/approval-grants/${ownerCreate.json.grant.id as string}`, {
      token: VIEWER_TOKEN,
    })
    assert.equal(viewerDelete.status, 403)

    const missingWorkspace = await fx.call('GET', '/api/approval-grants', { token: TOKEN })
    assert.equal(missingWorkspace.status, 400)
  })
})

test('单次决策：approval.decided 恰好一次；重复决策不再写；不隐式产生长期授权', async () => {
  await withApi(async (fx) => {
    const created = await fx.call('POST', '/api/internal/approvals', {
      body: internalBody(fx),
      runtimeToken: RUNTIME_TOKEN,
    })
    const approvalId = created.json.approval.id as string

    const approved = await fx.call('POST', `/api/approvals/${approvalId}`, {
      body: { decision: 'approved' },
      token: TOKEN,
    })
    assert.equal(approved.status, 200)
    assert.equal(approved.json.approval.status, 'approved')
    assert.equal(approved.json.approval.decidedBy, ACCOUNT)
    assert.deepEqual(approvalKinds(fx.store), ['approval.requested', 'approval.decided'])

    const again = await fx.call('POST', `/api/approvals/${approvalId}`, {
      body: { decision: 'approved' },
      token: TOKEN,
    })
    assert.equal(again.status, 200)
    assert.deepEqual(approvalKinds(fx.store), ['approval.requested', 'approval.decided'], '幂等不重复写事件')

    const grants = await fx.call('GET', `/api/approval-grants?workspaceId=${fx.ws.id}`, { token: TOKEN })
    assert.deepEqual(grants.json.grants, [], '单次决策绝不创建长期授权')

    // 同一请求再次申请：仍要重新审批（说明上一次只是单次放行）。
    const retry = await fx.call('POST', '/api/internal/approvals', {
      body: internalBody(fx),
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(retry.status, 201)
    assert.equal(retry.json.approval.status, 'pending')

    // 拒绝同样写一次 approval.decided。
    const rejectedId = retry.json.approval.id as string
    const rejected = await fx.call('POST', `/api/approvals/${rejectedId}`, {
      body: { decision: 'rejected' },
      token: TOKEN,
    })
    assert.equal(rejected.status, 200)
    assert.equal(rejected.json.approval.status, 'rejected')
    assert.deepEqual(approvalKinds(fx.store), [
      'approval.requested',
      'approval.decided',
      'approval.requested',
      'approval.decided',
    ])
  })
})

test('Bot 建群批准：决策事件恰好一次，重复批准不重复写', async () => {
  await withApi(async (fx) => {
    const bot = createBot(fx.store, {
      workspaceId: fx.ws.id,
      name: '研究员',
      model: 'deepseek-official',
      createdBy: ACCOUNT,
      createdAt: NOW,
    })
    const created = await fx.call('POST', '/api/internal/bot-rooms', {
      body: { workspaceId: fx.ws.id, botId: bot.id, memberBotIds: [bot.id, 'bot_missing'] },
      runtimeToken: RUNTIME_TOKEN,
    })
    // 缺第二个 Bot 会被拒；这里只验证审批事件路径，直接用合法成员。
    assert.equal(created.status, 400)

    const other = createBot(fx.store, {
      workspaceId: fx.ws.id,
      name: '评审员',
      model: 'deepseek-official',
      createdBy: ACCOUNT,
      createdAt: NOW,
    })
    const ok = await fx.call('POST', '/api/internal/bot-rooms', {
      body: { workspaceId: fx.ws.id, botId: bot.id, memberBotIds: [bot.id, other.id] },
      runtimeToken: RUNTIME_TOKEN,
    })
    assert.equal(ok.status, 202)
    const approvalId = ok.json.approval.id as string
    assert.equal(ok.json.approval.action, null, '旧 kind 不填 action/target/consequence')

    const approved = await fx.call('POST', `/api/approvals/${approvalId}`, {
      body: { decision: 'approved' },
      token: TOKEN,
    })
    assert.equal(approved.status, 200)
    assert.equal(approved.json.approval.status, 'approved')
    assert.deepEqual(approvalKinds(fx.store), ['approval.requested', 'approval.decided'])

    const again = await fx.call('POST', `/api/approvals/${approvalId}`, {
      body: { decision: 'approved' },
      token: TOKEN,
    })
    assert.equal(again.status, 200)
    assert.deepEqual(approvalKinds(fx.store), ['approval.requested', 'approval.decided'])
  })
})
