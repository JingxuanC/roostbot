// 插件市场 API（M5-5.1）：列表/详情/版本、预检、安装记录与事件、幂等与权限。
//
// 走真实 HTTP + 真实 SQLite + 真实 Bearer 会话，并使用 server.ts 的路由接线，
// 顺带验证 /api/marketplace/* 与 /api/plugin-installs 已经接上。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  openStore,
  readEvents,
  upsertMarketPlugin,
  upsertPublisher,
  upsertVersion,
} from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import type { StorePort } from '../src/port.ts'
import { createStorePort } from '../src/store-adapter.ts'
import { hashSessionToken, startServer } from '../src/server.ts'
import { pairDevice, startHarness } from './helpers.ts'

const ACCOUNT = 'acc_market_owner'
const VIEWER = 'acc_market_viewer'
const TOKEN = 'a'.repeat(64)
const VIEWER_TOKEN = 'b'.repeat(64)
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)

interface ApiResult {
  status: number
  headers: Headers
  json: any
}

interface Fixture {
  store: Store
  wsId: string
  call: (method: string, path: string, options?: { body?: unknown; token?: string }) => Promise<ApiResult>
}

async function withApi(fn: (fx: Fixture) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'roost-market-api-'))
  const store = openStore(join(dir, 'workspace.db'))
  const port = createStorePort(store)
  let started: Awaited<ReturnType<typeof startServer>> | null = null

  try {
    const ws = await port.createWorkspace({ accountId: ACCOUNT, name: '市场工作区', now: NOW })
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
    seedMarketplace(store)

    // store-adapter 的 listWorkspaces 目前按 tenant_id 近似成员关系；
    // 这里补上 workspace_members 里的 viewer，让 403 用例走真实角色判断。
    const listWorkspacesBase = port.listWorkspaces.bind(port)
    const storePort: StorePort = {
      ...port,
      async listWorkspaces(input) {
        const rows = await listWorkspacesBase(input)
        if (input.accountId === VIEWER && !rows.some((row) => row.id === ws.id)) {
          rows.push({ ...ws, role: 'viewer' })
        }
        return rows
      },
    }

    started = await startServer({ store: storePort, rawStore: store, now: () => NOW, port: 0, host: '127.0.0.1' })
    const baseUrl = started.url

    async function call(
      method: string,
      path: string,
      options: { body?: unknown; token?: string } = {},
    ): Promise<ApiResult> {
      const headers: Record<string, string> = {}
      if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`
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

    await fn({ store, wsId: ws.id, call })
  } finally {
    if (started !== null) await started.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function seedMarketplace(store: Store): void {
  upsertPublisher(store, { id: 'pub_roost', name: 'Roost', verified: true, registry: 'roost', at: NOW })
  upsertPublisher(store, { id: 'pub_bad', name: '未验证发布者', verified: false, registry: 'npm', at: NOW })

  upsertMarketPlugin(store, {
    slug: 'market-center',
    title: '行情中心',
    publisherId: 'pub_roost',
    category: '数据',
    tier: 'B',
    summary: '行情与资金流',
    readme: '# 行情中心\n提供行情工具。',
    latest: '1.2.0',
    icon: 'https://example.com/icon.png',
    screenshots: ['https://example.com/shot-1.png'],
    updatedAt: NOW,
  })
  upsertVersion(store, {
    slug: 'market-center',
    version: '1.0.0',
    integrity: 'sha512-1.0.0',
    engines: '^0.2.1-alpha.2',
    manifest: { engines: '^0.2.1-alpha.2', routes: ['/api/market-center'], panels: 0 },
    permissions: { tools: 12, network: ['api.tushare.pro'], credentials: ['tushare'], diskBytes: 320_000_000 },
    publishedAt: NOW,
  })
  upsertVersion(store, {
    slug: 'market-center',
    version: '1.2.0',
    integrity: 'sha512-1.2.0',
    engines: '^0.2.1-alpha.2',
    manifest: { engines: '^0.2.1-alpha.2', routes: ['/api/market-center'], panels: 0 },
    permissions: { tools: 12, network: ['api.tushare.pro'], credentials: ['tushare'], diskBytes: 320_000_000 },
    publishedAt: NOW + 100,
  })

  upsertMarketPlugin(store, {
    slug: 'desktop-tool',
    title: '桌面工具',
    publisherId: 'pub_roost',
    category: '工具',
    tier: 'D',
    summary: '读本地文件',
    latest: '1.0.0',
    updatedAt: NOW,
  })
  upsertVersion(store, {
    slug: 'desktop-tool',
    version: '1.0.0',
    integrity: 'sha512-desktop',
    engines: '^0.2.1-alpha.2',
    manifest: { engines: '^0.2.1-alpha.2' },
    permissions: { desktopOnly: true },
    publishedAt: NOW,
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
    publishedAt: NOW,
  })

  upsertMarketPlugin(store, {
    slug: 'unverified-plugin',
    title: '未验证插件',
    publisherId: 'pub_bad',
    category: '工具',
    tier: 'A',
    summary: '发布者未验证',
    latest: '1.0.0',
    updatedAt: NOW,
  })
  upsertVersion(store, {
    slug: 'unverified-plugin',
    version: '1.0.0',
    integrity: 'sha512-bad',
    engines: '^0.2.1-alpha.2',
    manifest: { engines: '^0.2.1-alpha.2' },
    permissions: {},
    publishedAt: NOW,
  })

  upsertMarketPlugin(store, {
    slug: 'client-plugin',
    title: '面板插件',
    publisherId: 'pub_roost',
    category: '工具',
    tier: 'C',
    summary: '需要 DSH Web',
    latest: '1.0.0',
    updatedAt: NOW,
  })
  upsertVersion(store, {
    slug: 'client-plugin',
    version: '1.0.0',
    integrity: 'sha512-client',
    engines: '^0.2.1-alpha.2',
    manifest: { engines: '^0.2.1-alpha.2' },
    permissions: { clientHalf: true, panels: 2 },
    publishedAt: NOW,
  })

}

function installBody(workspaceId: string, version = '1.2.0', slug = 'market-center'): Record<string, unknown> {
  return { workspaceId, version, slug }
}

function pluginEventKinds(store: Store): string[] {
  return readEvents(store, { domain: 'plugin' }).map((event) => event.kind)
}

test('GET /api/marketplace/plugins：Bearer、过滤、workspace installed 标记', async () => {
  await withApi(async ({ wsId, call }) => {
    const unauthorized = await call('GET', '/api/marketplace/plugins')
    assert.equal(unauthorized.status, 401)
    assert.equal(unauthorized.json.error.code, 'unauthenticated')

    const all = await call('GET', '/api/marketplace/plugins', { token: TOKEN })
    assert.equal(all.status, 200)
    assert.equal(all.json.plugins.length, 5)
    const card = all.json.plugins.find((plugin: any) => plugin.slug === 'market-center')
    assert.equal(card.title, '行情中心')
    assert.equal(card.tier, 'B')
    assert.equal(card.tierLabel, '需要授权资源')
    assert.deepEqual(card.permissions.network, ['api.tushare.pro'])
    assert.equal(card.installed, false)

    const byQuery = await call('GET', '/api/marketplace/plugins?q=%E8%A1%8C%E6%83%85', { token: TOKEN })
    assert.deepEqual(byQuery.json.plugins.map((plugin: any) => plugin.slug), ['market-center'])

    const byCategory = await call('GET', '/api/marketplace/plugins?category=%E5%B7%A5%E5%85%B7', { token: TOKEN })
    assert.ok(byCategory.json.plugins.every((plugin: any) => plugin.category === '工具'))

    const byTier = await call('GET', '/api/marketplace/plugins?tier=D', { token: TOKEN })
    assert.deepEqual(byTier.json.plugins.map((plugin: any) => plugin.slug), ['desktop-tool'])

    const badTier = await call('GET', '/api/marketplace/plugins?tier=X', { token: TOKEN })
    assert.equal(badTier.status, 400)

    const withWorkspace = await call('GET', `/api/marketplace/plugins?workspaceId=${wsId}`, { token: TOKEN })
    assert.equal(withWorkspace.status, 200)
    assert.ok(withWorkspace.json.plugins.every((plugin: any) => plugin.installed === false))

    const outsider = await call('GET', `/api/marketplace/plugins?workspaceId=${wsId}`, { token: VIEWER_TOKEN })
    assert.equal(outsider.status, 200, 'viewer 也算成员，可以看安装标记')

    const nonMember = await call('GET', '/api/marketplace/plugins?workspaceId=ws_other', { token: TOKEN })
    assert.equal(nonMember.status, 403)
  })
})

test('详情与版本：readme/截图/发布者/各版本 tier', async () => {
  await withApi(async ({ call }) => {
    const detail = await call('GET', '/api/marketplace/plugins/market-center', { token: TOKEN })
    assert.equal(detail.status, 200)
    assert.equal(detail.json.plugin.title, '行情中心')
    assert.match(detail.json.plugin.readme, /行情中心/)
    assert.deepEqual(detail.json.plugin.screenshots, ['https://example.com/shot-1.png'])
    assert.equal(detail.json.plugin.publisher.verified, true)
    assert.equal(detail.json.plugin.tier, 'B')
    assert.deepEqual(detail.json.plugin.permissions.credentials, ['tushare'])
    assert.equal(detail.json.versions.length, 2)
    assert.ok(detail.json.versions.every((version: any) => version.tier === 'B'))

    const versions = await call('GET', '/api/marketplace/plugins/market-center/versions', { token: TOKEN })
    assert.equal(versions.status, 200)
    assert.deepEqual(versions.json.versions.map((version: any) => version.version), ['1.2.0', '1.0.0'])

    const missing = await call('GET', '/api/marketplace/plugins/nope', { token: TOKEN })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.code, 'plugin.not_found')

    const badSlug = await call('GET', '/api/marketplace/plugins/Bad_Slug', { token: TOKEN })
    assert.equal(badSlug.status, 404)
  })
})

test('预检：tier D 阻断、DSH 版本不满足阻断、B 级返回权限清单', async () => {
  await withApi(async ({ call }) => {
    const ok = await call('POST', '/api/marketplace/plugins/market-center/preflight', {
      token: TOKEN,
      body: { version: '1.2.0' },
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.ok, true)
    assert.equal(ok.json.tier, 'B')
    assert.deepEqual(ok.json.problems, [])
    assert.deepEqual(ok.json.permissions.network, ['api.tushare.pro'])
    assert.equal(ok.json.requires.diskBytes, 320_000_000)
    assert.equal(ok.json.engines, '^0.2.1-alpha.2')

    const desktop = await call('POST', '/api/marketplace/plugins/desktop-tool/preflight', {
      token: TOKEN,
      body: {},
    })
    assert.equal(desktop.status, 200)
    assert.equal(desktop.json.tier, 'D')
    assert.equal(desktop.json.ok, false)
    assert.ok(desktop.json.problems.some((problem: any) => problem.code === 'tier-unsupported'))

    const future = await call('POST', '/api/marketplace/plugins/future-plugin/preflight', {
      token: TOKEN,
      body: {},
    })
    assert.equal(future.status, 200)
    assert.equal(future.json.ok, false)
    assert.ok(future.json.problems.some((problem: any) => problem.code === 'dsh-version'))

    const unknownVersion = await call('POST', '/api/marketplace/plugins/market-center/preflight', {
      token: TOKEN,
      body: { version: '9.9.9' },
    })
    assert.equal(unknownVersion.status, 404)
    assert.equal(unknownVersion.json.error.code, 'plugin.version_not_found')

    const invalid = await call('POST', '/api/marketplace/plugins/market-center/preflight', {
      token: TOKEN,
      body: { version: 42 },
    })
    assert.equal(invalid.status, 400)
  })
})

test('安装：owner/admin 校验、发布者白名单、tier/预检阻断、幂等', async () => {
  await withApi(async ({ store, wsId, call }) => {
    const unauthorized = await call('POST', '/api/marketplace/plugins/market-center/install', {
      body: { workspaceId: wsId, version: '1.2.0' },
    })
    assert.equal(unauthorized.status, 401)

    const viewer = await call('POST', '/api/marketplace/plugins/market-center/install', {
      token: VIEWER_TOKEN,
      body: { workspaceId: wsId, version: '1.2.0' },
    })
    assert.equal(viewer.status, 403)
    assert.equal(viewer.json.error.code, 'forbidden')

    const missingWorkspace = await call('POST', '/api/marketplace/plugins/market-center/install', {
      token: TOKEN,
      body: { version: '1.2.0' },
    })
    assert.equal(missingWorkspace.status, 400)

    const unverified = await call('POST', '/api/marketplace/plugins/unverified-plugin/install', {
      token: TOKEN,
      body: { workspaceId: wsId, version: '1.0.0' },
    })
    assert.equal(unverified.status, 403)
    assert.equal(unverified.json.error.code, 'plugin.publisher_unverified')

    const desktop = await call('POST', '/api/marketplace/plugins/desktop-tool/install', {
      token: TOKEN,
      body: { workspaceId: wsId, version: '1.0.0' },
    })
    assert.equal(desktop.status, 400)
    assert.equal(desktop.json.error.code, 'plugin.tier')

    const future = await call('POST', '/api/marketplace/plugins/future-plugin/install', {
      token: TOKEN,
      body: { workspaceId: wsId, version: '1.0.0' },
    })
    assert.equal(future.status, 400)
    assert.equal(future.json.error.code, 'plugin.preflight_failed')

    const installed = await call('POST', '/api/marketplace/plugins/market-center/install', {
      token: TOKEN,
      body: installBody(wsId),
    })
    assert.equal(installed.status, 202)
    assert.equal(installed.json.next, 'sync')
    assert.equal(installed.json.install.state, 'installing')
    assert.equal(installed.json.install.version, '1.2.0')
    assert.equal(installed.json.install.enabled, true)
    assert.equal(installed.json.install.lock.kind, 'roost.profile-lock-summary')
    assert.equal(pluginEventKinds(store).filter((kind) => kind === 'plugin.install').length, 1)

    // 重复安装：幂等返回同一行，不写第二条事件。
    const again = await call('POST', '/api/marketplace/plugins/market-center/install', {
      token: TOKEN,
      body: installBody(wsId),
    })
    assert.equal(again.status, 200)
    assert.equal(again.json.alreadyInstalled, true)
    assert.equal(again.json.install.id, installed.json.install.id)
    assert.equal(pluginEventKinds(store).filter((kind) => kind === 'plugin.install').length, 1)

    // 列表里的 installed 标记开始为 true。
    const list = await call('GET', `/api/marketplace/plugins?workspaceId=${wsId}`, { token: TOKEN })
    const card = list.json.plugins.find((plugin: any) => plugin.slug === 'market-center')
    assert.equal(card.installed, true)
  })
})

test('已安装列表、PATCH 升级/启停（事件）与 DELETE 幂等（事件）', async () => {
  await withApi(async ({ store, wsId, call }) => {
    const installed = await call('POST', '/api/marketplace/plugins/market-center/install', {
      token: TOKEN,
      body: installBody(wsId, '1.0.0'),
    })
    assert.equal(installed.status, 202)
    const installId = installed.json.install.id as string

    const list = await call('GET', `/api/plugin-installs?workspaceId=${wsId}`, { token: TOKEN })
    assert.equal(list.status, 200)
    assert.equal(list.json.installs.length, 1)
    assert.equal(list.json.installs[0].latest, '1.2.0')
    assert.equal(list.json.installs[0].updateAvailable, true)

    const viewerPatch = await call('PATCH', `/api/plugin-installs/${installId}`, {
      token: VIEWER_TOKEN,
      body: { enabled: false },
    })
    assert.equal(viewerPatch.status, 403)

    const disabled = await call('PATCH', `/api/plugin-installs/${installId}`, {
      token: TOKEN,
      body: { enabled: false },
    })
    assert.equal(disabled.status, 200)
    assert.equal(disabled.json.install.enabled, false)
    assert.equal(pluginEventKinds(store).filter((kind) => kind === 'plugin.update').length, 0)

    const upgraded = await call('PATCH', `/api/plugin-installs/${installId}`, {
      token: TOKEN,
      body: { version: '1.2.0' },
    })
    assert.equal(upgraded.status, 200)
    assert.equal(upgraded.json.install.version, '1.2.0')
    assert.equal(upgraded.json.install.enabled, false)
    // 升级后锁已变，等待第二批 sync：必须先回到 installing。
    assert.equal(upgraded.json.install.state, 'installing')
    assert.equal(pluginEventKinds(store).filter((kind) => kind === 'plugin.update').length, 1)

    const sameVersion = await call('PATCH', `/api/plugin-installs/${installId}`, {
      token: TOKEN,
      body: { version: '1.2.0' },
    })
    assert.equal(sameVersion.status, 200)
    assert.equal(pluginEventKinds(store).filter((kind) => kind === 'plugin.update').length, 1)

    const emptyPatch = await call('PATCH', `/api/plugin-installs/${installId}`, {
      token: TOKEN,
      body: {},
    })
    assert.equal(emptyPatch.status, 400)

    const viewerDelete = await call('DELETE', `/api/plugin-installs/${installId}`, { token: VIEWER_TOKEN })
    assert.equal(viewerDelete.status, 403)

    const deleted = await call('DELETE', `/api/plugin-installs/${installId}`, { token: TOKEN })
    assert.equal(deleted.status, 204)
    assert.equal(pluginEventKinds(store).filter((kind) => kind === 'plugin.uninstall').length, 1)

    const again = await call('DELETE', `/api/plugin-installs/${installId}`, { token: TOKEN })
    assert.equal(again.status, 204)
    assert.equal(pluginEventKinds(store).filter((kind) => kind === 'plugin.uninstall').length, 1)

    const missing = await call('PATCH', '/api/plugin-installs/pli_missing', {
      token: TOKEN,
      body: { enabled: true },
    })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.code, 'plugin.install_not_found')
  })
})

test('内存 port（无 rawStore）返回 503 runtime.not_configured', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())
  const token = await pairDevice(harness)

  const list = await harness.call('GET', '/api/marketplace/plugins', { token })
  assert.equal(list.status, 503)
  assert.equal(list.json.error.code, 'runtime.not_configured')

  const install = await harness.call('POST', '/api/marketplace/plugins/market-center/install', {
    token,
    body: { workspaceId: 'ws_memory', version: '1.2.0' },
  })
  assert.equal(install.status, 503)
  assert.equal(install.json.error.code, 'runtime.not_configured')

  const installs = await harness.call('GET', '/api/plugin-installs?workspaceId=ws_memory', { token })
  assert.equal(installs.status, 503)
})
