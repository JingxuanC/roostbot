// 插件市场 store（M5-5.1）：目录/版本/安装记录、唯一约束与 plugin.* 事件。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MARKETPLACE_ERROR_CODES,
  StoreError,
  createInstall,
  deleteInstall,
  getInstall,
  getMarketPlugin,
  getPublisher,
  listInstalls,
  listMarketPlugins,
  listPublishers,
  listVersions,
  readEvents,
  storeErrorTag,
  updateInstall,
  upsertMarketPlugin,
  upsertPublisher,
  upsertVersion,
} from '../src/index.ts'
import { assertStoreError, withStore } from './helpers.ts'

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)

function seedPublisher(store: Parameters<typeof upsertPublisher>[0]) {
  return upsertPublisher(store, { id: 'pub_roost', name: 'Roost', verified: true, registry: 'roost', at: NOW })
}

function seedPlugin(store: Parameters<typeof upsertMarketPlugin>[0], overrides: Partial<Parameters<typeof upsertMarketPlugin>[1]> = {}) {
  return upsertMarketPlugin(store, {
    slug: 'market-center',
    title: '行情中心',
    publisherId: 'pub_roost',
    category: '数据',
    tier: 'B',
    summary: '行情与资金流',
    readme: '# 行情中心',
    latest: '1.2.0',
    icon: 'https://example.com/icon.png',
    screenshots: ['https://example.com/1.png'],
    updatedAt: NOW,
    ...overrides,
  })
}

function pluginEvents(store: Parameters<typeof readEvents>[0]): { kind: string; payload: Record<string, unknown>; actor: unknown; subject: unknown }[] {
  return readEvents(store, { domain: 'plugin' }).map((event) => ({
    kind: event.kind,
    payload: event.payload,
    actor: event.actor,
    subject: event.subject,
  }))
}

test('空库返回空列表（不写假插件数据）', async () => {
  await withStore((store) => {
    assert.deepEqual(listPublishers(store), [])
    assert.deepEqual(listMarketPlugins(store), [])
    assert.deepEqual(listVersions(store, 'market-center'), [])
    assert.deepEqual(listInstalls(store, 'ws_empty'), [])
  })
})

test('发布者 upsert：重复 id 更新 name/verified，createdAt 不变', async () => {
  await withStore((store) => {
    const first = seedPublisher(store)
    assert.equal(first.verified, true)

    const updated = upsertPublisher(store, {
      id: 'pub_roost',
      name: 'Roost 官方',
      verified: false,
      registry: 'roost',
      at: NOW + 10,
    })
    assert.equal(updated.name, 'Roost 官方')
    assert.equal(updated.verified, false)
    assert.equal(listPublishers(store).length, 1)
    // created_at 保留第一次的值：发布者身份不随更新漂移。
    assert.equal(getPublisher(store, 'pub_roost')?.createdAt, NOW)
  })
})

test('市场目录：upsert、读取与 q/category/tier 过滤', async () => {
  await withStore((store) => {
    seedPublisher(store)
    seedPlugin(store)
    seedPlugin(store, {
      slug: 'report-engine',
      title: '报告引擎',
      category: '报告',
      tier: 'B',
      summary: 'Python 报告生成',
      readme: null,
      screenshots: null,
      updatedAt: NOW + 100,
    })
    seedPlugin(store, {
      slug: 'desk-only',
      title: '桌面工具',
      category: '工具',
      tier: 'D',
      summary: '读本地文件',
      updatedAt: NOW + 50,
    })

    assert.equal(listMarketPlugins(store).length, 3)
    assert.deepEqual(listMarketPlugins(store, { q: '行情' }).map((p) => p.slug), ['market-center'])
    assert.deepEqual(listMarketPlugins(store, { q: 'report' }).map((p) => p.slug), ['report-engine'])
    assert.deepEqual(listMarketPlugins(store, { category: '工具' }).map((p) => p.slug), ['desk-only'])
    assert.deepEqual(listMarketPlugins(store, { tier: 'D' }).map((p) => p.slug), ['desk-only'])
    assert.deepEqual(listMarketPlugins(store, { q: '不存在的插件' }), [])

    // updated_at 倒序：最近更新的排前面。
    assert.equal(listMarketPlugins(store)[0]?.slug, 'report-engine')

    const detail = getMarketPlugin(store, 'market-center')
    assert.equal(detail?.title, '行情中心')
    assert.deepEqual(detail?.screenshots, ['https://example.com/1.png'])
    assert.equal(detail?.readme, '# 行情中心')

    // upsert 同一 slug：覆盖元数据而不是新增。
    seedPlugin(store, { title: '行情中心 v2', summary: '新摘要' })
    assert.equal(listMarketPlugins(store).length, 3)
    assert.equal(getMarketPlugin(store, 'market-center')?.title, '行情中心 v2')
  })
})

test('版本：upsert 同一 slug+version 覆盖字段，按发布时间倒序列出', async () => {
  await withStore((store) => {
    upsertVersion(store, {
      slug: 'market-center',
      version: '1.0.0',
      integrity: 'sha512-old',
      engines: '^0.2.1-alpha.2',
      manifest: { engines: '^0.2.1-alpha.2', routes: ['/api/market'] },
      permissions: { tools: 3 },
      publishedAt: NOW,
    })
    upsertVersion(store, {
      slug: 'market-center',
      version: '1.2.0',
      integrity: 'sha512-new',
      engines: '^0.2.1-alpha.2',
      manifest: { engines: '^0.2.1-alpha.2' },
      permissions: { tools: 12, network: ['api.tushare.pro'] },
      publishedAt: NOW + 100,
    })
    upsertVersion(store, {
      slug: 'market-center',
      version: '1.0.0',
      integrity: 'sha512-old-fixed',
      engines: '^0.2.1-alpha.2',
      manifest: { engines: '^0.2.1-alpha.2', routes: ['/api/market'] },
      permissions: { tools: 4 },
      publishedAt: NOW + 999,
    })

    const versions = listVersions(store, 'market-center')
    assert.deepEqual(versions.map((v) => v.version), ['1.2.0', '1.0.0'])
    const old = versions.find((v) => v.version === '1.0.0')
    assert.equal(old?.integrity, 'sha512-old-fixed')
    assert.deepEqual(old?.permissions, { tools: 4 })
    // 重写同一版本不推高 published_at（发布时间是版本事实，不是更新时间）。
    assert.equal(old?.publishedAt, NOW)
  })
})

test('createInstall 写行与 plugin.install 事件；listInstalls 按 workspace 过滤', async () => {
  await withStore((store) => {
    const install = createInstall(store, {
      workspaceId: 'ws_a',
      slug: 'market-center',
      version: '1.2.0',
      lock: '{"id":"lock-abc"}',
      installedBy: 'acc_owner',
      installedAt: NOW,
      preflight: { tier: 'B', ok: true, problems: [] },
    })

    assert.equal(install.state, 'installing')
    assert.equal(install.enabled, true)
    assert.equal(getInstall(store, install.id)?.version, '1.2.0')
    assert.deepEqual(listInstalls(store, 'ws_a').map((entry) => entry.id), [install.id])
    assert.deepEqual(listInstalls(store, 'ws_b'), [])

    const events = pluginEvents(store)
    assert.equal(events.length, 1)
    assert.equal(events[0]?.kind, 'plugin.install')
    assert.deepEqual(events[0]?.actor, { kind: 'user', id: 'acc_owner' })
    assert.deepEqual(events[0]?.subject, { kind: 'plugin', id: 'market-center' })
    assert.equal(events[0]?.payload.workspaceId, 'ws_a')
    assert.equal(events[0]?.payload.slug, 'market-center')
    assert.equal(events[0]?.payload.version, '1.2.0')
    assert.equal(events[0]?.payload.lock, '{"id":"lock-abc"}')
  })
})

test('UNIQUE(workspace_id, slug) 冲突返回明确的 PLUGIN_INSTALL_EXISTS', async () => {
  await withStore((store) => {
    const input = {
      workspaceId: 'ws_a',
      slug: 'market-center',
      version: '1.2.0',
      lock: 'lock-1',
      installedBy: 'acc_owner',
      installedAt: NOW,
    }
    createInstall(store, input)
    assert.throws(
      () => createInstall(store, { ...input, version: '1.3.0', lock: 'lock-2' }),
      (err: unknown) => {
        assert.ok(err instanceof StoreError)
        assert.equal(err.code, 'INVALID_INPUT')
        assert.equal(storeErrorTag(err), MARKETPLACE_ERROR_CODES.installExists)
        return true
      },
    )
    // 冲突不写第二条安装事件。
    assert.equal(pluginEvents(store).length, 1)

    // 不同 workspace 同 slug 是允许的。
    createInstall(store, { ...input, workspaceId: 'ws_b', lock: 'lock-3' })
    assert.equal(listInstalls(store, 'ws_b').length, 1)
  })
})

test('updateInstall：版本变化写 plugin.update；仅 enabled 变化不写事件', async () => {
  await withStore((store) => {
    const install = createInstall(store, {
      workspaceId: 'ws_a',
      slug: 'market-center',
      version: '1.2.0',
      lock: 'lock-1',
      installedBy: 'acc_owner',
      installedAt: NOW,
    })

    const disabled = updateInstall(store, { id: install.id, enabled: false, by: 'acc_admin', at: NOW + 10 })
    assert.equal(disabled.enabled, false)
    assert.equal(pluginEvents(store).length, 1, 'enabled-only update must not write an event')

    const upgraded = updateInstall(store, {
      id: install.id,
      version: '1.3.0',
      lock: 'lock-2',
      by: 'acc_admin',
      at: NOW + 20,
    })
    assert.equal(upgraded.version, '1.3.0')
    assert.equal(upgraded.lock, 'lock-2')

    const events = pluginEvents(store)
    assert.equal(events.length, 2)
    assert.equal(events[1]?.kind, 'plugin.update')
    assert.deepEqual(events[1]?.actor, { kind: 'user', id: 'acc_admin' })
    assert.deepEqual(events[1]?.subject, { kind: 'plugin', id: 'market-center' })
    assert.equal(events[1]?.payload.version, '1.3.0')
    assert.equal(events[1]?.payload.previousVersion, '1.2.0')
    assert.equal(events[1]?.payload.lock, 'lock-2')

    // 同版本再 PATCH 不写事件。
    updateInstall(store, { id: install.id, version: '1.3.0', by: 'acc_admin', at: NOW + 30 })
    assert.equal(pluginEvents(store).length, 2)

    assert.throws(
      () => updateInstall(store, { id: 'pli_missing', enabled: true, by: 'acc_admin' }),
      (err: unknown) => {
        assert.ok(err instanceof StoreError)
        assert.equal(storeErrorTag(err), MARKETPLACE_ERROR_CODES.installNotFound)
        return true
      },
    )
  })
})

test('deleteInstall 写 plugin.uninstall；重复删除返回 false 且不重复写事件', async () => {
  await withStore((store) => {
    const install = createInstall(store, {
      workspaceId: 'ws_a',
      slug: 'market-center',
      version: '1.2.0',
      lock: 'lock-1',
      installedBy: 'acc_owner',
      installedAt: NOW,
    })

    assert.equal(deleteInstall(store, { id: install.id, by: 'acc_admin', at: NOW + 10 }), true)
    assert.equal(getInstall(store, install.id), null)

    const events = pluginEvents(store)
    assert.equal(events.length, 2)
    assert.equal(events[1]?.kind, 'plugin.uninstall')
    assert.deepEqual(events[1]?.actor, { kind: 'user', id: 'acc_admin' })
    assert.deepEqual(events[1]?.subject, { kind: 'plugin', id: 'market-center' })
    assert.equal(events[1]?.payload.version, '1.2.0')
    assert.equal(events[1]?.payload.lock, 'lock-1')

    assert.equal(deleteInstall(store, { id: install.id, by: 'acc_admin', at: NOW + 20 }), false)
    assert.equal(pluginEvents(store).length, 2)
  })
})

test('slug 只允许 [a-z0-9][a-z0-9._-]*', async () => {
  await withStore((store) => {
    for (const slug of ['Market_Center', '../etc/passwd', '-bad', 'bad/slug', '', '中文插件']) {
      assertStoreError(
        () =>
          createInstall(store, {
            workspaceId: 'ws_a',
            slug,
            version: '1.0.0',
            lock: 'lock-1',
            installedBy: 'acc_owner',
          }),
        'INVALID_INPUT',
      )
    }
    // 合法 slug 仍可写入。
    const ok = createInstall(store, {
      workspaceId: 'ws_a',
      slug: 'dsh-market-center.v2_beta',
      version: '1.0.0',
      lock: 'lock-1',
      installedBy: 'acc_owner',
    })
    assert.equal(ok.slug, 'dsh-market-center.v2_beta')
  })
})
