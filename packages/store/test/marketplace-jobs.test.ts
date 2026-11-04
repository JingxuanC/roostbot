// 插件安装作业 store（迁移 0020）：生命周期、状态机守卫、失败/回滚、tools_json。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createInstall,
  getInstall,
  openStore,
  storeErrorTag,
  upsertMarketPlugin,
  upsertPublisher,
  upsertVersion,
} from '../src/index.ts'
import {
  JOB_ERROR_CODES,
  JOB_TRANSITIONS,
  PLUGIN_JOB_EVENTS,
  PLUGIN_JOB_STATES,
  advanceJob,
  createJob,
  deleteJob,
  getInstallTools,
  getJob,
  isJobEvent,
  isJobState,
  latestJobForInstall,
  listJobs,
  nextJobStateFor,
  setInstallTools,
  updateJob,
} from '../src/marketplace-jobs.ts'
import type { Store } from '../src/types.ts'
import { assertStoreError, withStore } from './helpers.ts'

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)

function seedInstall(store: Store): string {
  upsertPublisher(store, { id: 'pub_roost', name: 'Roost', verified: true, registry: 'roost', at: NOW })
  upsertMarketPlugin(store, {
    slug: 'market-center',
    title: '行情中心',
    publisherId: 'pub_roost',
    category: '数据',
    tier: 'B',
    summary: '行情与资金流',
    latest: '1.2.0',
    updatedAt: NOW,
  })
  upsertVersion(store, {
    slug: 'market-center',
    version: '1.2.0',
    integrity: 'sha512-market',
    engines: '^0.2.1-alpha.2',
    manifest: { engines: '^0.2.1-alpha.2' },
    permissions: { tools: 12 },
    publishedAt: NOW,
  })
  const install = createInstall(store, {
    workspaceId: 'ws_one',
    slug: 'market-center',
    version: '1.2.0',
    lock: JSON.stringify({ kind: 'roost.profile-lock-summary', integrity: 'sha512-market' }),
    installedBy: 'acc_owner',
    installedAt: NOW,
  })
  return install.id
}

function newJob(store: Store, overrides: Record<string, unknown> = {}) {
  return createJob(store, {
    installId: 'pli_preallocated',
    workspaceId: 'ws_one',
    slug: 'market-center',
    version: '1.2.0',
    lockJson: JSON.stringify({ kind: 'roost.profile-lock', id: 'lock-abc' }),
    snapshotJson: JSON.stringify({ kind: 'roost.plugin-install-snapshot', install: null }),
    permissionsJson: { tier: 'B', permissions: { tools: 12 } },
    at: NOW,
    ...overrides,
  } as Parameters<typeof createJob>[1])
}

function taggedCode(fn: () => unknown): string | null {
  try {
    fn()
  } catch (err) {
    return storeErrorTag(err)
  }
  return null
}

test('状态机守卫：每条边都能写；非法迁移抛 PLUGIN_JOB_ILLEGAL_TRANSITION', async () => {
  await withStore((store) => {
    for (const state of PLUGIN_JOB_STATES) {
      for (const event of PLUGIN_JOB_EVENTS) {
        // 每条边一个独立作业：合法迁移会改状态，不能复用同一个 job。
        const job = newJob(store, { state })
        const expected = nextJobStateFor(state, event)
        if (expected === null) {
          assert.equal(
            taggedCode(() => advanceJob(store, { id: job.id, event, at: NOW })),
            JOB_ERROR_CODES.illegalTransition,
            `${state} + ${event} should be illegal`,
          )
          assert.equal(getJob(store, job.id)?.state, state, `${state} + ${event} must not move`)
        } else {
          const moved = advanceJob(store, { id: job.id, event, at: NOW })
          assert.equal(moved.state, expected, `${state} + ${event}`)
        }
      }
    }
  })
})

test('JOB_TRANSITIONS 与纯函数一致，且只含契约状态', async () => {
  for (const state of Object.keys(JOB_TRANSITIONS) as (keyof typeof JOB_TRANSITIONS)[]) {
    assert.ok(isJobState(state))
    for (const [event, next] of Object.entries(JOB_TRANSITIONS[state])) {
      assert.ok(isJobEvent(event))
      assert.ok(isJobState(next))
      assert.equal(nextJobStateFor(state, event as any), next)
    }
  }
  assert.equal(nextJobStateFor('preflight', 'sync-ok'), null)
  assert.equal(nextJobStateFor('installed', 'approve'), null)
  assert.equal(isJobState('waiting'), false)
  assert.equal(isJobEvent('sync'), false)
})

test('作业生命周期：preflight → awaiting-approval → installing → installed；重复 sync 幂等', async () => {
  await withStore((store) => {
    const installId = seedInstall(store)
    const created = createJob(store, {
      installId,
      workspaceId: 'ws_one',
      slug: 'market-center',
      version: '1.2.0',
      at: NOW,
    })
    assert.match(created.id, /^plj_/)
    assert.equal(created.state, 'preflight')
    assert.equal(created.createdAt, NOW)
    assert.equal(created.updatedAt, NOW)
    assert.equal(created.error, null)

    const awaiting = advanceJob(store, { id: created.id, event: 'request-approval', at: NOW + 1 })
    assert.equal(awaiting.state, 'awaiting-approval')
    assert.equal(awaiting.updatedAt, NOW + 1)

    const installing = advanceJob(store, { id: created.id, event: 'approve', at: NOW + 2 })
    assert.equal(installing.state, 'installing')

    const installed = advanceJob(store, { id: created.id, event: 'sync-ok', at: NOW + 3 })
    assert.equal(installed.state, 'installed')

    // 重复投递：状态不变、不报错
    const again = advanceJob(store, { id: created.id, event: 'sync-ok', at: NOW + 4 })
    assert.equal(again.state, 'installed')
    assert.equal(again.id, created.id)
    assert.equal(again.updatedAt, NOW + 4)

    // 读回来一致
    const read = getJob(store, created.id)
    assert.deepEqual(read, again)
  })
})

test('失败与回滚：installing → failed（带 error）→ rolling-back → rolled-back', async () => {
  await withStore((store) => {
    const installId = seedInstall(store)
    const job = newJob(store, { installId, state: 'installing' })

    const failed = advanceJob(store, { id: job.id, event: 'sync-fail', error: 'pnpm exited 1', at: NOW + 1 })
    assert.equal(failed.state, 'failed')
    assert.equal(failed.error, 'pnpm exited 1')

    // 重复失败保持第一条 error（幂等，不覆盖）
    const again = advanceJob(store, { id: job.id, event: 'sync-fail', at: NOW + 2 })
    assert.equal(again.error, 'pnpm exited 1')

    const rolling = advanceJob(store, { id: job.id, event: 'rollback', at: NOW + 3 })
    assert.equal(rolling.state, 'rolling-back')

    const snapshot = JSON.stringify({ kind: 'roost.plugin-install-snapshot', at: NOW, install: null })
    const done = advanceJob(store, {
      id: job.id,
      event: 'rollback-ok',
      snapshotJson: snapshot,
      at: NOW + 4,
    })
    assert.equal(done.state, 'rolled-back')
    assert.equal(done.snapshotJson, snapshot)

    // rolled-back 是终态：不能再 rollback，但重复 rollback-ok 幂等
    assert.equal(
      taggedCode(() => advanceJob(store, { id: job.id, event: 'rollback', at: NOW + 5 })),
      JOB_ERROR_CODES.illegalTransition,
    )
    assert.equal(advanceJob(store, { id: job.id, event: 'rollback-ok', at: NOW + 5 }).state, 'rolled-back')
  })
})

test('停用 / 启用 / 升级：job 态跟着安装行语义走', async () => {
  await withStore((store) => {
    const installId = seedInstall(store)
    const job = newJob(store, { installId, state: 'installed' })
    assert.equal(advanceJob(store, { id: job.id, event: 'disable', at: NOW + 1 }).state, 'disabled')
    assert.equal(advanceJob(store, { id: job.id, event: 'enable', at: NOW + 2 }).state, 'installed')
    assert.equal(advanceJob(store, { id: job.id, event: 'update', at: NOW + 3 }).state, 'installing')
  })
})

test('updateJob：直接改 state 也守状态机；同状态幂等；未知 job 404 码', async () => {
  await withStore((store) => {
    const job = newJob(store, { state: 'installing' })
    assert.equal(updateJob(store, { id: job.id, state: 'installed', at: NOW + 1 }).state, 'installed')
    assert.equal(updateJob(store, { id: job.id, state: 'installed', at: NOW + 2 }).state, 'installed')
    assert.equal(
      taggedCode(() => updateJob(store, { id: job.id, state: 'awaiting-approval', at: NOW + 3 })),
      JOB_ERROR_CODES.illegalTransition,
    )
    assert.equal(
      taggedCode(() => updateJob(store, { id: 'plj_missing', state: 'installed' })),
      JOB_ERROR_CODES.notFound,
    )
  })
})

test('创建校验：slug / state / 文档大小 / 权限 JSON', async () => {
  await withStore((store) => {
    assertStoreError(() => newJob(store, { slug: 'Bad Slug' }), 'INVALID_INPUT')
    assertStoreError(() => newJob(store, { state: 'waiting' }), 'INVALID_INPUT')
    assertStoreError(() => newJob(store, { version: '' }), 'INVALID_INPUT')
    assertStoreError(() => newJob(store, { lockJson: 'x'.repeat(512 * 1024 + 1) }), 'INVALID_INPUT')
    assertStoreError(() => newJob(store, { permissionsJson: 'nope' }), 'INVALID_INPUT')
    assertStoreError(() => newJob(store, { workspaceId: '' }), 'INVALID_INPUT')
  })
})

test('listJobs / latestJobForInstall / deleteJob：同一安装行多次作业', async () => {
  await withStore((store) => {
    const installId = seedInstall(store)
    const first = newJob(store, { installId, at: NOW })
    const second = newJob(store, { installId, version: '1.3.0', state: 'installing', at: NOW + 10 })
    const other = newJob(store, { installId: 'pli_other', slug: 'report-engine', at: NOW + 20 })

    assert.equal(latestJobForInstall(store, installId)?.id, second.id)
    assert.deepEqual(
      listJobs(store, { installId }).map((job) => job.id),
      [first.id, second.id],
    )
    assert.deepEqual(
      listJobs(store, { workspaceId: 'ws_one' }).map((job) => job.id),
      [first.id, second.id, other.id],
    )
    assert.deepEqual(
      listJobs(store, { workspaceId: 'ws_one', state: 'preflight' }).map((job) => job.id),
      [first.id, other.id],
    )
    assert.deepEqual(
      listJobs(store, { workspaceId: 'ws_one', slug: 'report-engine' }).map((job) => job.id),
      [other.id],
    )
    assert.deepEqual(listJobs(store, { workspaceId: 'ws_two' }), [])
    assert.equal(latestJobForInstall(store, 'pli_missing'), null)

    assert.equal(deleteJob(store, other.id), true)
    assert.equal(deleteJob(store, other.id), false)
    assert.equal(getJob(store, other.id), null)
  })
})

test('tools_json：写入归一化、来源兜底、去重、读回', async () => {
  await withStore((store) => {
    const installId = seedInstall(store)
    assert.deepEqual(getInstallTools(store, installId), [])

    const written = setInstallTools(
      store,
      installId,
      [
        { name: ' market_quote ', source: 'market-center' },
        { name: 'market_flow' },
        'market_news',
        { name: 'market_quote', source: 'market-center' },
        { name: '', source: 'x' },
        { name: 'bad', source: 42 },
      ],
      { source: 'market-center' },
    )
    assert.deepEqual(written, [
      { name: 'market_quote', source: 'market-center' },
      { name: 'market_flow', source: 'market-center' },
      { name: 'market_news', source: 'market-center' },
      { name: 'bad', source: 'unknown' },
    ])
    assert.deepEqual(getInstallTools(store, installId), written)

    // 落库列存在且是 JSON
    const row = store.db
      .prepare('SELECT tools_json FROM plugin_installs WHERE id = ?')
      .get(installId) as { tools_json: string }
    assert.deepEqual(JSON.parse(row.tools_json), written)

    // 清空
    assert.deepEqual(setInstallTools(store, installId, [], {}), [])
    assert.deepEqual(getInstallTools(store, installId), [])

    // 不存在的安装行
    assert.equal(
      taggedCode(() => setInstallTools(store, 'pli_missing', [{ name: 'x', source: 'y' }])),
      'PLUGIN_INSTALL_NOT_FOUND',
    )
    assert.deepEqual(getInstallTools(store, 'pli_missing'), [])

    // 坏 JSON / 非数组读成 []
    store.db.prepare("UPDATE plugin_installs SET tools_json = '{not json' WHERE id = ?").run(installId)
    assert.deepEqual(getInstallTools(store, installId), [])
    store.db.prepare("UPDATE plugin_installs SET tools_json = '{\"a\":1}' WHERE id = ?").run(installId)
    assert.deepEqual(getInstallTools(store, installId), [])

    // 坏输入
    assertStoreError(() => setInstallTools(store, installId, 'nope'), 'INVALID_INPUT')
    assertStoreError(() => setInstallTools(store, installId, new Array(501).fill('x')), 'INVALID_INPUT')

    // tools_json 不影响 marketplace 的安装行读取
    assert.equal(getInstall(store, installId)?.slug, 'market-center')
  })
})

test('0020 迁移：工具列与作业表都在；on-disk 库重启后作业还在', async () => {
  await withStore((store) => {
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name)
    assert.ok(tables.includes('plugin_install_jobs'))
    const columns = store.db
      .prepare('PRAGMA table_info(plugin_installs)')
      .all()
      .map((row) => (row as { name: string }).name)
    assert.ok(columns.includes('tools_json'))
    assert.ok(store.appliedMigrations.includes('0020_marketplace_jobs.sql'))
  })

  // 文件库：重启后 job 仍在（迁移不重复执行）
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'roost-jobs-'))
  const path = join(dir, 'workspace.db')
  try {
    const first = openStore(path)
    const job = createJob(first, {
      installId: 'pli_one',
      workspaceId: 'ws_one',
      slug: 'market-center',
      version: '1.2.0',
      at: NOW,
    })
    first.close()

    const second = openStore(path)
    assert.equal(second.appliedMigrations.length, 0)
    assert.equal(getJob(second, job.id)?.state, 'preflight')
    second.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
