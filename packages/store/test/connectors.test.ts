// 连接器存储（M6-6.1）：连接/授权/调用审计、事件与 idem 幂等。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createWorkspace,
  deleteConnection,
  findCallByIdem,
  findGrant,
  getConnection,
  listConnections,
  listGrants,
  readEvents,
  recordCall,
  setGrant,
  upsertConnection,
} from '../src/index.ts'
import type { Store } from '../src/index.ts'
import { assertStoreError, withStore } from './helpers.ts'

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)

function seedWorkspace(store: Store, id = 'ws_connectors'): string {
  createWorkspace(store, {
    id,
    tenantId: 'acc_connectors',
    name: '连接器工作区',
    profileVersion: 'v1',
    createdAt: NOW,
  })
  return id
}

function eventsOf(store: Store, kind: string): { payload: Record<string, unknown> }[] {
  return readEvents(store, { domain: 'connector' })
    .filter((event) => event.kind === kind)
    .map((event) => ({ payload: event.payload }))
}

test('连接：upsert 覆盖、按 workspace 列出、断开幂等并写事件', async () => {
  await withStore(async (store) => {
    const wsId = seedWorkspace(store)

    const first = upsertConnection(store, {
      workspaceId: wsId,
      slug: 'github',
      backend: 'openconnector',
      status: 'connected',
      accountLabel: 'dev@example.com',
      connectedBy: 'acc_owner',
      at: NOW,
    })
    assert.equal(first.slug, 'github')
    assert.equal(first.status, 'connected')

    // 同一 workspace+slug 覆盖：id 保持不变，状态/展示名更新。
    const second = upsertConnection(store, {
      workspaceId: wsId,
      slug: 'github',
      backend: 'openconnector',
      status: 'expired',
      accountLabel: 'dev2@example.com',
      connectedBy: 'acc_admin',
      at: NOW + 1000,
    })
    assert.equal(second.id, first.id)
    assert.equal(second.status, 'expired')
    assert.equal(second.accountLabel, 'dev2@example.com')
    assert.equal(listConnections(store, wsId).length, 1)
    assert.equal(getConnection(store, wsId, 'github')?.connectedBy, 'acc_admin')
    assert.equal(getConnection(store, wsId, 'missing'), null)
    assert.deepEqual(eventsOf(store, 'connector.connected').length, 2)

    assert.equal(deleteConnection(store, { workspaceId: wsId, slug: 'github', by: 'acc_owner', at: NOW + 2000 }), true)
    assert.equal(deleteConnection(store, { workspaceId: wsId, slug: 'github', by: 'acc_owner', at: NOW + 3000 }), false)
    assert.equal(getConnection(store, wsId, 'github'), null)
    assert.equal(eventsOf(store, 'connector.disconnected').length, 1)
    assert.deepEqual(eventsOf(store, 'connector.disconnected')[0]!.payload['slug'], 'github')
  })
})

test('授权：同 workspace+bot+slug 覆盖，list/find 返回规范化 actions', async () => {
  await withStore(async (store) => {
    const wsId = seedWorkspace(store)

    const first = setGrant(store, {
      workspaceId: wsId,
      botId: 'bot_analyst',
      slug: 'github',
      access: 'read',
      actions: ['list_issues'],
      grantedBy: 'acc_owner',
      at: NOW,
    })
    assert.equal(first.access, 'read')
    assert.deepEqual(first.actions, ['list_issues'])

    const second = setGrant(store, {
      workspaceId: wsId,
      botId: 'bot_analyst',
      slug: 'github',
      access: 'write',
      actions: ['create_pr', 'create_pr', 'update_issue'],
      grantedBy: 'acc_admin',
      at: NOW + 1000,
    })
    assert.equal(second.id, first.id)
    assert.equal(second.access, 'write')
    assert.deepEqual(second.actions, ['create_pr', 'update_issue'])
    assert.equal(listGrants(store, wsId).length, 1)
    assert.equal(listGrants(store, wsId, 'github').length, 1)
    assert.equal(listGrants(store, wsId, 'gmail').length, 0)
    assert.equal(findGrant(store, wsId, 'bot_analyst', 'github')?.access, 'write')
    assert.equal(findGrant(store, wsId, 'bot_other', 'github'), null)

    // 空 actions = 该 access 下全部。
    const all = setGrant(store, {
      workspaceId: wsId,
      botId: 'bot_analyst',
      slug: 'github',
      access: 'read',
      actions: [],
      grantedBy: 'acc_owner',
      at: NOW + 2000,
    })
    assert.equal(all.actions, null)
    assert.deepEqual(eventsOf(store, 'connector.grant.changed').length, 3)

    assertStoreError(
      () => setGrant(store, { workspaceId: wsId, botId: 'bot_analyst', slug: 'github', access: 'admin' as never, grantedBy: 'acc_owner' }),
      'INVALID_INPUT',
    )
  })
})

test('调用审计：成功/拒绝都落行与事件；idem 重放不写第二行/第二条事件', async () => {
  await withStore(async (store) => {
    const wsId = seedWorkspace(store)

    const ok = recordCall(store, {
      workspaceId: wsId,
      botId: 'bot_analyst',
      slug: 'github',
      action: 'list_issues',
      ok: true,
      resultBytes: 128,
      idem: 'call-1',
      at: NOW,
    })
    assert.equal(ok.duplicate, false)
    assert.equal(ok.call.ok, true)
    assert.equal(ok.call.resultBytes, 128)

    const replay = recordCall(store, {
      workspaceId: wsId,
      botId: 'bot_analyst',
      slug: 'github',
      action: 'list_issues',
      ok: true,
      resultBytes: 128,
      idem: 'call-1',
      at: NOW + 1000,
    })
    assert.equal(replay.duplicate, true)
    assert.equal(replay.call.id, ok.call.id)
    assert.equal(findCallByIdem(store, wsId, 'bot_analyst', 'call-1')?.id, ok.call.id)
    assert.equal(findCallByIdem(store, wsId, 'bot_other', 'call-1'), null)

    const denied = recordCall(store, {
      workspaceId: wsId,
      botId: 'bot_analyst',
      slug: 'gmail',
      action: 'send_email',
      ok: false,
      deniedReason: 'no_grant',
      at: NOW + 2000,
    })
    assert.equal(denied.duplicate, false)

    // 无 idem 的重复调用各自保留审计行。
    recordCall(store, { workspaceId: wsId, botId: 'bot_analyst', slug: 'github', action: 'list_issues', ok: true, at: NOW + 3000 })

    const count = store.db.prepare('SELECT COUNT(*) AS n FROM connector_calls').get() as { n: number }
    assert.equal(Number(count.n), 3)

    const callEvents = eventsOf(store, 'connector.call')
    assert.equal(callEvents.length, 3)
    assert.equal(callEvents[1]!.payload['deniedReason'], 'no_grant')
  })
})

test('幂等索引：idem 非空时 (workspace,bot,idem) 唯一；为空可多条', async () => {
  await withStore(async (store) => {
    const wsId = seedWorkspace(store)
    const index = store.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_connector_calls_idem'")
      .get() as { sql: string } | undefined
    assert.ok(index, 'partial unique index must exist')
    assert.match(index!.sql, /WHERE idem IS NOT NULL/i)

    recordCall(store, { workspaceId: wsId, botId: 'bot_a', slug: 'github', action: 'a', ok: true, at: NOW })
    recordCall(store, { workspaceId: wsId, botId: 'bot_a', slug: 'github', action: 'b', ok: true, at: NOW })
    const count = store.db.prepare('SELECT COUNT(*) AS n FROM connector_calls WHERE idem IS NULL').get() as { n: number }
    assert.equal(Number(count.n), 2)
  })
})

test('校验与未知 workspace', async () => {
  await withStore(async (store) => {
    seedWorkspace(store)
    assertStoreError(
      () =>
        upsertConnection(store, {
          workspaceId: 'ws_missing',
          slug: 'github',
          backend: 'openconnector',
          status: 'connected',
          connectedBy: 'acc_owner',
        }),
      'WORKSPACE_NOT_FOUND',
    )
    assertStoreError(
      () =>
        upsertConnection(store, {
          workspaceId: 'ws_connectors',
          slug: 'Bad Slug',
          backend: 'openconnector',
          status: 'connected',
          connectedBy: 'acc_owner',
        }),
      'INVALID_INPUT',
    )
  })
})

