import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorkspace, listWorkspaces } from '../src/index.ts'
import { assertStoreError, withStore } from './helpers.ts'

const base = {
  tenantId: 'tn_1',
  name: 'quant',
  profileVersion: '1.4.0',
}

test('创建 workspace 的默认值（cloud / stopped / 无卷）', async () => {
  await withStore((store) => {
    const workspace = createWorkspace(store, base)

    assert.match(workspace.id, /^ws_[0-9A-HJKMNP-TV-Z]{26}$/)
    assert.equal(workspace.tenantId, 'tn_1')
    assert.equal(workspace.name, 'quant')
    assert.equal(workspace.homeMode, 'cloud')
    assert.equal(workspace.state, 'stopped')
    assert.equal(workspace.volumeId, null)
    assert.equal(workspace.profileVersion, '1.4.0')
    assert.ok(Number.isInteger(workspace.createdAt))
  })
})

test('创建并列出，按 created_at 升序', async () => {
  await withStore((store) => {
    assert.deepEqual(listWorkspaces(store), [])

    createWorkspace(store, { ...base, id: 'ws_b', name: 'b', createdAt: 200 })
    createWorkspace(store, { ...base, id: 'ws_a', name: 'a', createdAt: 100 })
    createWorkspace(store, {
      ...base,
      id: 'ws_c',
      name: 'c',
      homeMode: 'local',
      state: 'running',
      volumeId: 'vol_9',
      createdAt: 300,
    })

    const all = listWorkspaces(store)
    assert.deepEqual(all.map((w) => w.id), ['ws_a', 'ws_b', 'ws_c'])
    assert.equal(all[2].homeMode, 'local')
    assert.equal(all[2].state, 'running')
    assert.equal(all[2].volumeId, 'vol_9')
  })
})

test('按 tenant 过滤', async () => {
  await withStore((store) => {
    createWorkspace(store, { ...base, id: 'ws_1', tenantId: 'tn_1' })
    createWorkspace(store, { ...base, id: 'ws_2', tenantId: 'tn_2' })

    const scoped = listWorkspaces(store, { tenantId: 'tn_2' })
    assert.deepEqual(scoped.map((w) => w.id), ['ws_2'])
  })
})

test('重复 id 报 WORKSPACE_EXISTS', async () => {
  await withStore((store) => {
    createWorkspace(store, { ...base, id: 'ws_dup' })
    assertStoreError(() => createWorkspace(store, { ...base, id: 'ws_dup' }), 'WORKSPACE_EXISTS')
  })
})

test('非法 home_mode / state / 缺 profileVersion 直接报错', async () => {
  await withStore((store) => {
    assertStoreError(
      () => createWorkspace(store, { ...base, homeMode: 'edge' as never }),
      'INVALID_WORKSPACE',
    )
    assertStoreError(
      () => createWorkspace(store, { ...base, state: 'sleeping' as never }),
      'INVALID_WORKSPACE',
    )
    assertStoreError(
      () => createWorkspace(store, { ...base, profileVersion: '' }),
      'INVALID_WORKSPACE',
    )
    assertStoreError(
      () => createWorkspace(store, { tenantId: 'tn_1', name: 'x' } as never),
      'INVALID_WORKSPACE',
    )
    assert.deepEqual(listWorkspaces(store), [])
  })
})
