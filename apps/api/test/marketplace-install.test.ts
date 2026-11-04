// 插件安装流水线 API（M5-5.1 第二批）：安装→审批→sync→已安装→回滚/卸载。
//
// 这里起一个真实 HTTP server，但路由表是**本文件内**按 wave1.md §B 的路径接的
// （server.ts 由 Lead 接线；本文件只验证 handler 行为与状态机）。真实 SQLite +
// 真实 Bearer 会话 + 真实 runtime token 校验，只有 pnpm 不真跑（5.1.9 只固定命令）。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { nextJobState } from '../../../packages/plugins/src/install.ts'
import {
  decideApproval,
  listApprovals,
  openStore,
  upsertMarketPlugin,
  upsertPublisher,
  upsertVersion,
} from '../../../packages/store/src/index.ts'
import {
  JOB_TRANSITIONS,
  PLUGIN_JOB_EVENTS,
  PLUGIN_JOB_STATES,
  getJob,
  listJobs,
} from '../../../packages/store/src/marketplace-jobs.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import {
  DEFAULT_MIN_RELEASE_AGE_MS,
  INSTALL_COMMAND,
  handleMarketplaceInstallStart,
  handlePluginInstallDisable,
  handlePluginInstallEnable,
  handlePluginInstallGet,
  handlePluginInstallList,
  handlePluginInstallRollback,
  handlePluginInstallSynced,
  handlePluginInstallUninstall,
  handlePluginInstallUpdate,
  installCommandFor,
  onInstallApproved,
} from '../src/marketplace-install-routes.ts'
import type { MarketplaceInstallRouteContext } from '../src/marketplace-install-routes.ts'
import type { StorePort } from '../src/port.ts'
import { hashSessionToken } from '../src/server.ts'
import { createStorePort } from '../src/store-adapter.ts'

const ACCOUNT = 'acc_install_owner'
const VIEWER = 'acc_install_viewer'
const TOKEN = 'c'.repeat(64)
const VIEWER_TOKEN = 'd'.repeat(64)
const RUNTIME_TOKEN = 'rt_install_0123456789abcdef'
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000

// 白名单走环境变量（与生产同一个来源）；空 = 拒绝，所以这里显式列出可装插件。
process.env['ROOST_PLUGIN_ALLOWLIST'] =
  'market-center,future-plugin,fresh-plugin,no-integrity-plugin,client-plugin,desktop-plugin'

type Handler = (
  ctx: MarketplaceInstallRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => Promise<void>

/** 按 wave1.md §B 的路径接 handler（Lead 的 server.ts diff 与此一致）。 */
const ROUTES: { method: string; pattern: RegExp; handler: Handler }[] = [
  { method: 'POST', pattern: /^\/api\/marketplace\/plugins\/[^/]+\/install$/, handler: handleMarketplaceInstallStart },
  { method: 'GET', pattern: /^\/api\/plugin-installs$/, handler: handlePluginInstallList },
  { method: 'GET', pattern: /^\/api\/plugin-installs\/[^/]+$/, handler: handlePluginInstallGet },
  { method: 'POST', pattern: /^\/api\/plugin-installs\/[^/]+\/update$/, handler: handlePluginInstallUpdate },
  { method: 'POST', pattern: /^\/api\/plugin-installs\/[^/]+\/disable$/, handler: handlePluginInstallDisable },
  { method: 'POST', pattern: /^\/api\/plugin-installs\/[^/]+\/enable$/, handler: handlePluginInstallEnable },
  { method: 'POST', pattern: /^\/api\/plugin-installs\/[^/]+\/uninstall$/, handler: handlePluginInstallUninstall },
  { method: 'POST', pattern: /^\/api\/plugin-installs\/[^/]+\/rollback$/, handler: handlePluginInstallRollback },
  {
    method: 'POST',
    pattern: /^\/api\/internal\/plugin-installs\/[^/]+\/synced$/,
    handler: handlePluginInstallSynced,
  },
]

interface ApiResult {
  status: number
  headers: Headers
  json: any
}

interface Fixture {
  store: Store
  port: StorePort
  wsId: string
  baseUrl: string
  call: (method: string, path: string, options?: { body?: unknown; token?: string; runtimeToken?: string }) => Promise<ApiResult>
  close: () => Promise<void>
}

async function startFixture(options: { runtimeToken?: string | null } = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'roost-install-api-'))
  const store = openStore(join(dir, 'workspace.db'))
  const base = createStorePort(store)
  const ws = await base.createWorkspace({ accountId: ACCOUNT, name: '插件工作区', now: NOW })

  // viewer 成员：listWorkspaces 按 tenant 过滤，viewer 需要补一条投影（与 marketplace.test 一致）。
  store.db
    .prepare('INSERT INTO workspace_members (workspace_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(ws.id, VIEWER, 'viewer', ACCOUNT, NOW)

  await base.createSession({ accountId: ACCOUNT, tokenHash: hashSessionToken(TOKEN), now: NOW, expiresAt: NOW + 3_600_000 })
  await base.createSession({
    accountId: VIEWER,
    tokenHash: hashSessionToken(VIEWER_TOKEN),
    now: NOW,
    expiresAt: NOW + 3_600_000,
  })

  const listWorkspacesBase = base.listWorkspaces.bind(base)
  const port: StorePort = {
    ...base,
    async listWorkspaces(input) {
      const rows = await listWorkspacesBase(input)
      if (input.accountId === VIEWER && !rows.some((row) => row.id === ws.id)) {
        rows.push({ ...ws, role: 'viewer' })
      }
      return rows
    },
  }

  seedMarketplace(store)

  const ctx: MarketplaceInstallRouteContext = {
    store: port,
    now: () => NOW,
    rawStore: store,
    ...(options.runtimeToken === null ? {} : { runtimeToken: options.runtimeToken ?? RUNTIME_TOKEN }),
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname.replace(/\/+$/, '') || '/'
      const method = req.method ?? 'GET'
      try {
        for (const route of ROUTES) {
          if (route.method !== method || !route.pattern.test(path)) continue
          await route.handler(ctx, req, res, url)
          return
        }
        res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: `no route for ${method} ${path}` } }))
      } catch (err) {
        if (!res.writableEnded) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: { code: 'internal_error', message: String(err) } }))
        }
      }
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not bind')
  const baseUrl = `http://127.0.0.1:${address.port}`

  async function call(
    method: string,
    path: string,
    options: { body?: unknown; token?: string; runtimeToken?: string } = {},
  ): Promise<ApiResult> {
    const headers: Record<string, string> = {}
    if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`
    if (options.runtimeToken !== undefined) headers['x-runtime-token'] = options.runtimeToken
    let body: string | undefined
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(options.body)
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

  return {
    store,
    port,
    wsId: ws.id,
    baseUrl,
    call,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function seedMarketplace(store: Store): void {
  upsertPublisher(store, { id: 'pub_roost', name: 'Roost', verified: true, registry: 'roost', at: NOW })

  upsertMarketPlugin(store, {
    slug: 'market-center',
    title: '行情中心',
    publisherId: 'pub_roost',
    category: '数据',
    tier: 'B',
    summary: '行情与资金流',
    latest: '2.0.0',
    updatedAt: NOW,
  })
  const permissions = {
    tools: 12,
    network: ['api.tushare.pro'],
    credentials: ['tushare'],
    diskBytes: 320_000_000,
  }
  upsertVersion(store, {
    slug: 'market-center',
    version: '1.2.0',
    integrity: 'sha512-market-1.2.0',
    engines: '^0.2.1-alpha.2',
    manifest: { engines: '^0.2.1-alpha.2', routes: ['/api/market-center'] },
    permissions,
    publishedAt: NOW - 3 * DAY,
  })
  upsertVersion(store, {
    slug: 'market-center',
    version: '2.0.0',
    integrity: 'sha512-market-2.0.0',
    engines: '^0.2.1-alpha.2',
    manifest: { engines: '^0.2.1-alpha.2', routes: ['/api/market-center'] },
    permissions,
    publishedAt: NOW - 3 * DAY,
  })

  upsertMarketPlugin(store, {
    slug: 'future-plugin',
    title: '未来插件',
    publisherId: 'pub_roost',
    category: '工具',
    tier: 'A',
    summary: '要求更高的 DSH',
    latest: '1.0.0',
    updatedAt: NOW,
  })
  upsertVersion(store, {
    slug: 'future-plugin',
    version: '1.0.0',
    integrity: 'sha512-future',
    engines: '^9.0.0',
    manifest: { engines: '^9.0.0' },
    permissions: {},
    publishedAt: NOW - 3 * DAY,
  })

  upsertMarketPlugin(store, {
    slug: 'fresh-plugin',
    title: '刚发布',
    publisherId: 'pub_roost',
    category: '工具',
    tier: 'A',
    summary: '发布时间太新，冷却期内',
    latest: '1.0.0',
    updatedAt: NOW,
  })
  upsertVersion(store, {
    slug: 'fresh-plugin',
    version: '1.0.0',
    integrity: 'sha512-fresh',
    engines: '^0.2.1-alpha.2',
    manifest: { engines: '^0.2.1-alpha.2' },
    permissions: { tools: 1 },
    publishedAt: NOW,
  })

  upsertMarketPlugin(store, {
    slug: 'no-integrity-plugin',
    title: '没有 integrity',
    publisherId: 'pub_roost',
    category: '工具',
    tier: 'A',
    summary: 'registry 同步缺字段',
    latest: '1.0.0',
    updatedAt: NOW,
  })
  upsertVersion(store, {
    slug: 'no-integrity-plugin',
    version: '1.0.0',
    integrity: 'sha512-placeholder',
    engines: '^0.2.1-alpha.2',
    manifest: { engines: '^0.2.1-alpha.2' },
    permissions: {},
    publishedAt: NOW - 3 * DAY,
  })
  upsertMarketPlugin(store, {
    slug: 'client-plugin',
    title: '面板插件',
    publisherId: 'pub_roost',
    category: '工具',
    tier: 'C',
    summary: '需要 DSH Web 面板容器',
    latest: '1.0.0',
    updatedAt: NOW,
  })
  upsertVersion(store, {
    slug: 'client-plugin',
    version: '1.0.0',
    integrity: 'sha512-client',
    engines: '^0.2.1-alpha.2',
    manifest: { engines: '^0.2.1-alpha.2', panels: 2 },
    permissions: { clientHalf: true, panels: 2, tools: 3 },
    publishedAt: NOW - 3 * DAY,
  })

  upsertMarketPlugin(store, {
    slug: 'desktop-plugin',
    title: '桌面工具',
    publisherId: 'pub_roost',
    category: '工具',
    tier: 'D',
    summary: '读本地文件',
    latest: '1.0.0',
    updatedAt: NOW,
  })
  upsertVersion(store, {
    slug: 'desktop-plugin',
    version: '1.0.0',
    integrity: 'sha512-desktop',
    engines: '^0.2.1-alpha.2',
    manifest: { engines: '^0.2.1-alpha.2' },
    permissions: { desktopOnly: true },
    publishedAt: NOW - 3 * DAY,
  })

  // upsertVersion 要求非空 integrity；这里模拟 registry 同步缺字段的坏数据。
  store.db.prepare("UPDATE plugin_versions SET integrity = '' WHERE slug = 'no-integrity-plugin'").run()
}

async function startInstall(fixture: Fixture, version = '1.2.0', slug = 'market-center'): Promise<ApiResult> {
  return fixture.call('POST', `/api/marketplace/plugins/${slug}/install`, {
    token: TOKEN,
    body: { workspaceId: fixture.wsId, version },
  })
}

async function approveInstall(fixture: Fixture, approvalId: string): Promise<void> {
  decideApproval(fixture.store, { id: approvalId, decision: 'approved', by: ACCOUNT, at: NOW })
  const result = onInstallApproved(fixture.store, {
    approvalId,
    decision: 'approved',
    by: ACCOUNT,
    at: NOW,
  })
  assert.ok(result.job !== null)
  assert.equal(result.job.state, 'installing')
}

async function syncOk(fixture: Fixture, installId: string, tools: unknown[] = []): Promise<ApiResult> {
  return fixture.call('POST', `/api/internal/plugin-installs/${installId}/synced`, {
    runtimeToken: RUNTIME_TOKEN,
    body: { ok: true, tools },
  })
}

async function installAndSync(fixture: Fixture, version = '1.2.0'): Promise<{ installId: string; jobId: string }> {
  const started = await startInstall(fixture, version)
  assert.equal(started.status, 202)
  await approveInstall(fixture, started.json.approval.id)
  const installId = started.json.job.installId as string
  const synced = await syncOk(fixture, installId, [{ name: 'market_quote', source: 'market-center' }])
  assert.equal(synced.status, 200)
  assert.equal(synced.json.job.state, 'installed')
  return { installId, jobId: started.json.job.id }
}

// ---- 安装入口 ----------------------------------------------------------------

test('安装入口：鉴权 / 角色 / 输入 / 版本 / 预检阻断（409 plugin.preflight）', async () => {
  const fixture = await startFixture()
  try {
    const anonymous = await fixture.call('POST', '/api/marketplace/plugins/market-center/install', {
      body: { workspaceId: fixture.wsId, version: '1.2.0' },
    })
    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.json.error.code, 'unauthenticated')

    const viewer = await fixture.call('POST', '/api/marketplace/plugins/market-center/install', {
      token: VIEWER_TOKEN,
      body: { workspaceId: fixture.wsId, version: '1.2.0' },
    })
    assert.equal(viewer.status, 403)
    assert.equal(viewer.json.error.code, 'forbidden')

    const noWorkspace = await fixture.call('POST', '/api/marketplace/plugins/market-center/install', {
      token: TOKEN,
      body: { version: '1.2.0' },
    })
    assert.equal(noWorkspace.status, 400)
    assert.equal(noWorkspace.json.error.code, 'invalid_body')

    const unknownPlugin = await fixture.call('POST', '/api/marketplace/plugins/nope/install', {
      token: TOKEN,
      body: { workspaceId: fixture.wsId, version: '1.0.0' },
    })
    assert.equal(unknownPlugin.status, 404)
    assert.equal(unknownPlugin.json.error.code, 'plugin.not_found')

    const unknownVersion = await startInstall(fixture, '9.9.9')
    assert.equal(unknownVersion.status, 404)
    assert.equal(unknownVersion.json.error.code, 'plugin.version_not_found')

    const engines = await startInstall(fixture, '1.0.0', 'future-plugin')
    assert.equal(engines.status, 409)
    assert.equal(engines.json.error.code, 'plugin.preflight')
    assert.match(engines.json.error.message, /engines/)

    const tooNew = await startInstall(fixture, '1.0.0', 'fresh-plugin')
    assert.equal(tooNew.status, 409)
    assert.match(tooNew.json.error.message, /release-age/)

    const missingIntegrity = await startInstall(fixture, '1.0.0', 'no-integrity-plugin')
    assert.equal(missingIntegrity.status, 409)
    assert.match(missingIntegrity.json.error.message, /integrity/)

    // 白名单：不在名单里的插件（清掉 env 后就是全部拒绝）
    const saved = process.env['ROOST_PLUGIN_ALLOWLIST']
    process.env['ROOST_PLUGIN_ALLOWLIST'] = 'other-plugin'
    try {
      const blocked = await startInstall(fixture)
      assert.equal(blocked.status, 409)
      assert.match(blocked.json.error.message, /allowlist/)
    } finally {
      process.env['ROOST_PLUGIN_ALLOWLIST'] = saved
    }

    // 失败的预检不留 job
    assert.deepEqual(listJobs(fixture.store), [])
  } finally {
    await fixture.close()
  }
})

test('安装：202 {job, approval}、等待审批、重复请求幂等；GET 显示 install=null', async () => {
  const fixture = await startFixture()
  try {
    const started = await startInstall(fixture)
    assert.equal(started.status, 202)
    assert.equal(started.headers.get('cache-control'), 'no-store')
    assert.equal(started.json.job.state, 'awaiting-approval')
    assert.equal(started.json.job.version, '1.2.0')
    assert.equal(started.json.job.slug, 'market-center')
    assert.match(started.json.job.id, /^plj_/)
    const installId = started.json.job.installId as string
    assert.match(installId, /^pli_/)
    // 锁文档形状与 profile-lock 一致（内容寻址）
    assert.equal(started.json.job.lock.kind, 'roost.profile-lock')
    assert.equal(started.json.job.lock.source, 'marketplace')
    assert.match(started.json.job.lock.integrity, /^[0-9a-f]{64}$/)
    assert.equal(started.json.job.command, INSTALL_COMMAND)

    assert.equal(started.json.approval.kind, 'plugin_install')
    assert.equal(started.json.approval.status, 'pending')
    assert.equal(started.json.approval.requester, ACCOUNT)
    assert.equal(started.json.approval.requesterKind, 'user')
    assert.equal(started.json.approval.payload.jobId, started.json.job.id)
    assert.match(started.json.approval.consequence, /工具/)
    assert.match(started.json.approval.consequence, /api\.tushare\.pro/)

    // 审批未通过前没有安装行：列表为空，详情 install=null
    const list = await fixture.call('GET', `/api/plugin-installs?workspaceId=${fixture.wsId}`, { token: TOKEN })
    assert.equal(list.status, 200)
    assert.deepEqual(list.json.installs, [])
    assert.equal(list.json.pending.length, 1)
    assert.equal(list.json.pending[0].state, 'awaiting-approval')

    const detail = await fixture.call('GET', `/api/plugin-installs/${installId}`, { token: TOKEN })
    assert.equal(detail.status, 200)
    assert.equal(detail.json.install, null)
    assert.equal(detail.json.job.state, 'awaiting-approval')

    // 重复安装：同一 job / 同一条审批，不新建
    const again = await startInstall(fixture)
    assert.equal(again.status, 202)
    assert.equal(again.json.job.id, started.json.job.id)
    assert.equal(again.json.approval.id, started.json.approval.id)
    assert.equal(listApprovals(fixture.store, fixture.wsId, 'pending').length, 1)
    assert.equal(listJobs(fixture.store).length, 1)
  } finally {
    await fixture.close()
  }
})

test('审批通过：job→installing、写安装行；重复回调幂等', async () => {
  const fixture = await startFixture()
  try {
    const started = await startInstall(fixture)
    const approvalId = started.json.approval.id as string
    const installId = started.json.job.installId as string

    decideApproval(fixture.store, { id: approvalId, decision: 'approved', by: ACCOUNT, at: NOW })
    const first = onInstallApproved(fixture.store, { approvalId, decision: 'approved', by: ACCOUNT, at: NOW })
    assert.equal(first.job?.state, 'installing')
    assert.equal(first.install?.id, installId)
    assert.equal(first.install?.state, 'installing')
    assert.equal(first.install?.version, '1.2.0')
    assert.equal(first.install?.enabled, true)
    assert.equal(first.install?.installedBy, ACCOUNT)

    // 重复回调：不重复写行、不推进状态
    const again = onInstallApproved(fixture.store, { approvalId, decision: 'approved', by: ACCOUNT, at: NOW + 5 })
    assert.equal(again.job?.state, 'installing')
    assert.equal(again.install?.id, installId)
    assert.equal(listJobs(fixture.store).length, 1)

    const detail = await fixture.call('GET', `/api/plugin-installs/${installId}`, { token: TOKEN })
    assert.equal(detail.status, 200)
    assert.equal(detail.json.install.state, 'installing')
    assert.equal(detail.json.install.lock.kind, 'roost.profile-lock')
    assert.equal(detail.json.job.state, 'installing')

    // 未审批完就重复升级同一版本：job 仍在执行 → 409 job_pending
    const busy = await fixture.call('POST', `/api/plugin-installs/${installId}/update`, {
      token: TOKEN,
      body: { version: '2.0.0' },
    })
    assert.equal(busy.status, 409)
    assert.equal(busy.json.error.code, 'plugin.job_pending')
  } finally {
    await fixture.close()
  }
})

test('审批拒绝：job→failed，没有安装行（不留幽灵安装）', async () => {
  const fixture = await startFixture()
  try {
    const started = await startInstall(fixture)
    const approvalId = started.json.approval.id as string
    decideApproval(fixture.store, { id: approvalId, decision: 'rejected', by: ACCOUNT, at: NOW })
    const result = onInstallApproved(fixture.store, { approvalId, decision: 'rejected', by: ACCOUNT, at: NOW })
    assert.equal(result.job?.state, 'failed')
    assert.equal(result.job?.error, 'approval.rejected')
    assert.equal(result.install, null)

    const list = await fixture.call('GET', `/api/plugin-installs?workspaceId=${fixture.wsId}`, { token: TOKEN })
    assert.deepEqual(list.json.installs, [])
    assert.deepEqual(list.json.pending, [])
  } finally {
    await fixture.close()
  }
})

test('tier：C 级只提示面板容器（202），D 级拒绝（409）', async () => {
  const fixture = await startFixture()
  try {
    const client = await startInstall(fixture, '1.0.0', 'client-plugin')
    assert.equal(client.status, 202)
    assert.equal(client.json.job.permissions.tier, 'C')
    assert.match(client.json.approval.consequence, /面板/)
    assert.ok(
      client.json.job.permissions.problems.some(
        (problem: any) => problem.code === 'tier' && problem.severity === 'warning',
      ),
    )

    const desktop = await startInstall(fixture, '1.0.0', 'desktop-plugin')
    assert.equal(desktop.status, 409)
    assert.match(desktop.json.error.message, /tier/)
    assert.match(desktop.json.error.message, /tier D/)
  } finally {
    await fixture.close()
  }
})

// ---- 沙箱 sync ---------------------------------------------------------------

test('synced：runtime token 校验（未配置 404 / 缺 token 401 / 错 token 401）', async () => {
  const disabled = await startFixture({ runtimeToken: null })
  try {
    const res = await disabled.call('POST', '/api/internal/plugin-installs/pli_x/synced', {
      body: { ok: true },
    })
    assert.equal(res.status, 404)
    assert.equal(res.json.error.code, 'not_found')
  } finally {
    await disabled.close()
  }

  const fixture = await startFixture()
  try {
    const none = await fixture.call('POST', '/api/internal/plugin-installs/pli_x/synced', { body: { ok: true } })
    assert.equal(none.status, 401)
    assert.equal(none.json.error.code, 'unauthenticated')

    const wrong = await fixture.call('POST', '/api/internal/plugin-installs/pli_x/synced', {
      runtimeToken: 'nope',
      body: { ok: true },
    })
    assert.equal(wrong.status, 401)

    const good = await fixture.call('POST', '/api/internal/plugin-installs/pli_x/synced', {
      runtimeToken: RUNTIME_TOKEN,
      body: { ok: true },
    })
    assert.equal(good.status, 404)
    assert.equal(good.json.error.code, 'plugin.job_not_found')
  } finally {
    await fixture.close()
  }
})

test('synced ok：installed + 写 tools_json；重复投递幂等；列表带工具来源', async () => {
  const fixture = await startFixture()
  try {
    const started = await startInstall(fixture)
    const installId = started.json.job.installId as string
    await approveInstall(fixture, started.json.approval.id)

    const synced = await syncOk(fixture, installId, [
      { name: 'market_quote', source: 'market-center' },
      'market_flow',
    ])
    assert.equal(synced.status, 200)
    assert.equal(synced.json.job.state, 'installed')
    assert.equal(synced.json.install.state, 'installed')
    assert.deepEqual(synced.json.install.tools, [
      { name: 'market_quote', source: 'market-center' },
      { name: 'market_flow', source: 'market-center' },
    ])

    const again = await syncOk(fixture, installId, [{ name: 'other', source: 'x' }])
    assert.equal(again.status, 200)
    assert.equal(again.json.job.state, 'installed')
    // 幂等：重复投递不改工具来源
    assert.deepEqual(again.json.install.tools.map((tool: any) => tool.name), ['market_quote', 'market_flow'])

    const list = await fixture.call('GET', `/api/plugin-installs?workspaceId=${fixture.wsId}`, { token: TOKEN })
    assert.equal(list.status, 200)
    assert.equal(list.json.installs.length, 1)
    assert.equal(list.json.installs[0].state, 'installed')
    assert.equal(list.json.installs[0].latest, '2.0.0')
    assert.equal(list.json.installs[0].updateAvailable, true)
    assert.deepEqual(list.json.installs[0].tools[0], { name: 'market_quote', source: 'market-center' })
    assert.equal(list.json.installs[0].job.state, 'installed')

    // 详情也能看到工具来源
    const detail = await fixture.call('GET', `/api/plugin-installs/${installId}`, { token: TOKEN })
    assert.deepEqual(detail.json.install.tools, synced.json.install.tools)
  } finally {
    await fixture.close()
  }
})

test('synced fail → failed + error；回滚 → rolling-back → rolled-back（全新安装删行）', async () => {
  const fixture = await startFixture()
  try {
    const started = await startInstall(fixture)
    const installId = started.json.job.installId as string
    await approveInstall(fixture, started.json.approval.id)

    const failed = await fixture.call('POST', `/api/internal/plugin-installs/${installId}/synced`, {
      runtimeToken: RUNTIME_TOKEN,
      body: { ok: false, error: 'pnpm exited 1' },
    })
    assert.equal(failed.status, 200)
    assert.equal(failed.json.job?.state, 'failed', JSON.stringify(failed.json))
    assert.equal(failed.json.job.error, 'pnpm exited 1')
    assert.equal(failed.json.install.state, 'failed')

    // 重复失败幂等，保留第一条 error
    const again = await fixture.call('POST', `/api/internal/plugin-installs/${installId}/synced`, {
      runtimeToken: RUNTIME_TOKEN,
      body: { ok: false, error: 'boom again' },
    })
    assert.equal(again.status, 200)
    assert.equal(again.json.job.error, 'pnpm exited 1')

    // 回滚：202 {job: rolling-back}，锁换回快照（全新安装是空快照）
    const rolling = await fixture.call('POST', `/api/plugin-installs/${installId}/rollback`, { token: TOKEN })
    assert.equal(rolling.status, 202)
    assert.equal(rolling.json.job.state, 'rolling-back')

    const rolled = await syncOk(fixture, installId)
    assert.equal(rolled.status, 200)
    assert.equal(rolled.json.job.state, 'rolled-back')
    assert.equal(rolled.json.install, null)

    // 行删掉后详情仍能按 job 找到（install=null）
    const detail = await fixture.call('GET', `/api/plugin-installs/${installId}`, { token: TOKEN })
    assert.equal(detail.status, 200)
    assert.equal(detail.json.install, null)
    assert.equal(detail.json.job.state, 'rolled-back')

    // 重复 rollback-ok 幂等
    const idempotent = await syncOk(fixture, installId)
    assert.equal(idempotent.status, 200, JSON.stringify(idempotent.json))
    assert.equal(idempotent.json.job.state, 'rolled-back')

    // 再回滚：rolled-back 是终态
    const noSnapshot = await fixture.call('POST', `/api/plugin-installs/${installId}/rollback`, { token: TOKEN })
    assert.equal(noSnapshot.status, 404)
    assert.equal(noSnapshot.json.error.code, 'plugin.job_not_found')
  } finally {
    await fixture.close()
  }
})

// ---- 升级 / 停用 / 启用 / 卸载 ------------------------------------------------

test('升级：同版本 200 unchanged；新版本 202 等审批；失败回滚恢复旧版本', async () => {
  const fixture = await startFixture()
  try {
    const { installId } = await installAndSync(fixture, '1.2.0')
    const before = await fixture.call('GET', `/api/plugin-installs/${installId}`, { token: TOKEN })
    const oldLockIntegrity = before.json.install.lock.integrity as string

    const same = await fixture.call('POST', `/api/plugin-installs/${installId}/update`, {
      token: TOKEN,
      body: { version: '1.2.0' },
    })
    assert.equal(same.status, 200)
    assert.equal(same.json.unchanged, true)

    const updated = await fixture.call('POST', `/api/plugin-installs/${installId}/update`, {
      token: TOKEN,
      body: { version: '2.0.0' },
    })
    assert.equal(updated.status, 202)
    assert.equal(updated.json.job.state, 'awaiting-approval')
    assert.equal(updated.json.approval.payload.previousVersion, '1.2.0')
    // 升级要应用的是新锁（与旧锁不同），回滚再换回旧锁
    assert.notEqual(updated.json.job.lock.integrity, oldLockIntegrity)

    await approveInstall(fixture, updated.json.approval.id)
    const afterApprove = await fixture.call('GET', `/api/plugin-installs/${installId}`, { token: TOKEN })
    assert.equal(afterApprove.json.install.version, '2.0.0')
    assert.equal(afterApprove.json.install.state, 'installing')

    const failed = await fixture.call('POST', `/api/internal/plugin-installs/${installId}/synced`, {
      runtimeToken: RUNTIME_TOKEN,
      body: { ok: false, error: 'smoke failed' },
    })
    assert.equal(failed.json.job?.state, 'failed', JSON.stringify(failed.json))
    assert.equal(failed.json.install.state, 'failed')
    assert.equal(failed.json.install.version, '2.0.0')

    const rolling = await fixture.call('POST', `/api/plugin-installs/${installId}/rollback`, { token: TOKEN })
    assert.equal(rolling.status, 202)
    assert.equal(rolling.json.job.state, 'rolling-back')
    // 回滚作业携带快照里的旧锁
    assert.equal(rolling.json.job.lock.integrity, oldLockIntegrity)

    const rolled = await syncOk(fixture, installId)
    assert.equal(rolled.status, 200)
    assert.equal(rolled.json.job.state, 'rolled-back')
    assert.equal(rolled.json.install.version, '1.2.0')
    assert.equal(rolled.json.install.state, 'installed')
    assert.equal(rolled.json.install.enabled, true)
  } finally {
    await fixture.close()
  }
})

test('升级成功后再回滚：版本 / 锁 / 工具来源都回到旧值', async () => {
  const fixture = await startFixture()
  try {
    const { installId } = await installAndSync(fixture, '1.2.0')
    const before = await fixture.call('GET', `/api/plugin-installs/${installId}`, { token: TOKEN })
    const oldLockIntegrity = before.json.install.lock.integrity as string
    assert.deepEqual(before.json.install.tools, [{ name: 'market_quote', source: 'market-center' }])

    const updated = await fixture.call('POST', `/api/plugin-installs/${installId}/update`, {
      token: TOKEN,
      body: { version: '2.0.0' },
    })
    await approveInstall(fixture, updated.json.approval.id)
    const synced = await syncOk(fixture, installId, [{ name: 'new_tool', source: 'market-center' }])
    assert.equal(synced.json.install.version, '2.0.0')
    assert.deepEqual(synced.json.install.tools, [{ name: 'new_tool', source: 'market-center' }])

    const rolling = await fixture.call('POST', `/api/plugin-installs/${installId}/rollback`, { token: TOKEN })
    assert.equal(rolling.status, 202)
    const rolled = await syncOk(fixture, installId)
    assert.equal(rolled.json.job.state, 'rolled-back')
    assert.equal(rolled.json.install.version, '1.2.0')
    assert.equal(rolled.json.install.state, 'installed')
    assert.equal(rolled.json.install.lock.integrity, oldLockIntegrity)
    // 工具来源也回到 1.2.0 的那一份，不留在 2.0.0 的列表上
    assert.deepEqual(rolled.json.install.tools, [{ name: 'market_quote', source: 'market-center' }])
  } finally {
    await fixture.close()
  }
})

test('停用 / 启用：enabled 翻转，job 状态跟着 installed ⇄ disabled', async () => {
  const fixture = await startFixture()
  try {
    const { installId } = await installAndSync(fixture)

    const disabled = await fixture.call('POST', `/api/plugin-installs/${installId}/disable`, { token: TOKEN })
    assert.equal(disabled.status, 200)
    assert.equal(disabled.json.install.enabled, false)
    let detail = await fixture.call('GET', `/api/plugin-installs/${installId}`, { token: TOKEN })
    assert.equal(detail.json.install.enabled, false)
    assert.equal(detail.json.job.state, 'disabled')

    const enabled = await fixture.call('POST', `/api/plugin-installs/${installId}/enable`, { token: TOKEN })
    assert.equal(enabled.status, 200)
    assert.equal(enabled.json.install.enabled, true)
    detail = await fixture.call('GET', `/api/plugin-installs/${installId}`, { token: TOKEN })
    assert.equal(detail.json.job.state, 'installed')

    // viewer 不能停用
    const viewer = await fixture.call('POST', `/api/plugin-installs/${installId}/disable`, { token: VIEWER_TOKEN })
    assert.equal(viewer.status, 403)
  } finally {
    await fixture.close()
  }
})

test('卸载：202 job、安装行 disabling；sync ok 后删行；缺失安装行 404', async () => {
  const fixture = await startFixture()
  try {
    const { installId } = await installAndSync(fixture)

    const started = await fixture.call('POST', `/api/plugin-installs/${installId}/uninstall`, { token: TOKEN })
    assert.equal(started.status, 202)
    assert.equal(started.json.job.state, 'installing')

    const detail = await fixture.call('GET', `/api/plugin-installs/${installId}`, { token: TOKEN })
    assert.equal(detail.json.install.state, 'disabling')
    // 卸载后的 profile 锁里没有这个插件了
    assert.equal(detail.json.job.lock.packageJson.includes('market-center'), false)

    const synced = await syncOk(fixture, installId)
    assert.equal(synced.status, 200)
    assert.equal(synced.json.job.state, 'installed')
    assert.equal(synced.json.install, null)

    const list = await fixture.call('GET', `/api/plugin-installs?workspaceId=${fixture.wsId}`, { token: TOKEN })
    assert.deepEqual(list.json.installs, [])

    const again = await fixture.call('POST', `/api/plugin-installs/${installId}/uninstall`, { token: TOKEN })
    assert.equal(again.status, 404)
    assert.equal(again.json.error.code, 'plugin.install_not_found')
  } finally {
    await fixture.close()
  }
})

// ---- 契约一致性 --------------------------------------------------------------

test('状态机：store 的迁移表与纯函数逐格一致（8 状态 × 13 事件）', () => {
  for (const state of PLUGIN_JOB_STATES) {
    for (const event of PLUGIN_JOB_EVENTS) {
      const pure = nextJobState(state, event)
      const stored = JOB_TRANSITIONS[state][event] ?? null
      assert.equal(stored, pure, `${state} + ${event}`)
    }
  }
})

test('安装命令固定（5.1.9）：--frozen-lockfile --ignore-scripts，不可被锁改写', () => {
  assert.equal(INSTALL_COMMAND, 'pnpm install --frozen-lockfile --ignore-scripts')
  assert.equal(installCommandFor(null), INSTALL_COMMAND)
  assert.equal(installCommandFor({ any: 'lock' }), INSTALL_COMMAND)
  assert.match(INSTALL_COMMAND, /--ignore-scripts/)
  assert.match(INSTALL_COMMAND, /--frozen-lockfile/)
  assert.equal(DEFAULT_MIN_RELEASE_AGE_MS, 24 * 60 * 60 * 1000)
})

test('错误响应形状：{ok:false,error:{code,message}} 且 no-store', async () => {
  const fixture = await startFixture()
  try {
    const res = await fixture.call('GET', '/api/plugin-installs/pli_missing')
    assert.equal(res.status, 401)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.json.ok, false)
    assert.equal(typeof res.json.error.code, 'string')
    assert.equal(typeof res.json.error.message, 'string')

    const missing = await fixture.call('GET', '/api/plugin-installs/pli_missing', { token: TOKEN })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.code, 'plugin.install_not_found')
  } finally {
    await fixture.close()
  }
})

test('审批拒绝后的 job 仍在库里（审计），安装行一律不出现', async () => {
  const fixture = await startFixture()
  try {
    const started = await startInstall(fixture)
    const approvalId = started.json.approval.id as string
    decideApproval(fixture.store, { id: approvalId, decision: 'rejected', by: ACCOUNT, at: NOW })
    onInstallApproved(fixture.store, { approvalId, decision: 'rejected', by: ACCOUNT, at: NOW })

    const job = getJob(fixture.store, started.json.job.id)
    assert.equal(job?.state, 'failed')
    assert.equal(listJobs(fixture.store).length, 1)
    assert.equal(listInstallsCount(fixture.store), 0)
  } finally {
    await fixture.close()
  }
})

function listInstallsCount(store: Store): number {
  const row = store.db.prepare('SELECT COUNT(*) AS n FROM plugin_installs').get() as { n: number | bigint }
  return Number(row.n)
}
