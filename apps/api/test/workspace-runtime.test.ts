// 工作区运行时：start 落库、复用 startedAt、失败落 error、status 读回。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import { createWorkspace } from '../../../packages/store/src/workspaces.ts'
import { getWorkspaceRuntime } from '../../../packages/store/src/workspace-runtime.ts'
import { readWorkspaceRuntime, startWorkspaceRuntime, stopWorkspaceRuntime, type RuntimeManager } from '../src/workspace-runtime.ts'

const AT = 1_760_000_000_000

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-ws-runtime-'))
  const store = openStore(join(dir, 'workspace.db'))
  const workspace = createWorkspace(store, { tenantId: 't', name: 'W', profileVersion: 'dev', createdAt: AT })
  return { dir, store, workspace }
}

test('start 落库；再次 start 复用 startedAt', async () => {
  const ctx = setup()
  try {
    const manager: RuntimeManager = {
      ensure: async (workspaceId) => ({ sandbox: `user-${workspaceId.slice(-8)}`, phase: 'ready' }),
      status: async () => null
    }
    const first = await startWorkspaceRuntime(ctx.store, ctx.workspace.id, manager)
    assert.equal(first.created, true)
    assert.equal(first.runtime.phase, 'ready')
    assert.equal(first.runtime.startedAt > 0, true)
    const second = await startWorkspaceRuntime(ctx.store, ctx.workspace.id, manager)
    assert.equal(second.created, false)
    assert.equal(second.runtime.startedAt, first.runtime.startedAt)
  } finally {
    ctx.store.close()
    rmSync(ctx.dir, { recursive: true, force: true })
  }
})

test('ensure 失败：已有记录标 error，异常抛给路由', async () => {
  const ctx = setup()
  try {
    const manager: RuntimeManager = {
      ensure: async () => {
        throw new Error('openshell missing')
      },
      status: async () => null
    }
    await assert.rejects(() => startWorkspaceRuntime(ctx.store, ctx.workspace.id, manager), /openshell missing/)
    assert.equal(getWorkspaceRuntime(ctx.store, ctx.workspace.id), null)

    await startWorkspaceRuntime(ctx.store, ctx.workspace.id, {
      ensure: async () => ({ sandbox: 'user-x', phase: 'ready' }),
      status: async () => null
    })
    await assert.rejects(
      () => startWorkspaceRuntime(ctx.store, ctx.workspace.id, manager),
      /openshell missing/
    )
    assert.equal(getWorkspaceRuntime(ctx.store, ctx.workspace.id)?.phase, 'error')
  } finally {
    ctx.store.close()
    rmSync(ctx.dir, { recursive: true, force: true })
  }
})

test('read 用 manager 的最新阶段刷新，没有 manager 时读库存', async () => {
  const ctx = setup()
  try {
    await startWorkspaceRuntime(ctx.store, ctx.workspace.id, {
      ensure: async () => ({ sandbox: 'user-1', phase: 'ready' }),
      status: async () => null
    })
    const stale = await readWorkspaceRuntime(ctx.store, ctx.workspace.id)
    assert.equal(stale?.phase, 'ready')

    const live = await readWorkspaceRuntime(ctx.store, ctx.workspace.id, {
      ensure: async () => ({ sandbox: 'user-1', phase: 'ready' }),
      status: async () => ({ sandbox: 'user-1', phase: 'stopped' })
    })
    assert.equal(live?.phase, 'stopped')
    assert.equal(getWorkspaceRuntime(ctx.store, ctx.workspace.id)?.phase, 'stopped')
  } finally {
    ctx.store.close()
    rmSync(ctx.dir, { recursive: true, force: true })
  }
})


test('stop 停止 runtime 并把阶段落为 stopped', async () => {
  const ctx = setup()
  try {
    let stoppedWith: string | null = null
    const manager: RuntimeManager = {
      ensure: async () => ({ sandbox: 'user-stop', phase: 'ready' }),
      status: async () => ({ sandbox: 'user-stop', phase: 'ready' }),
      stop: async (workspaceId) => { stoppedWith = workspaceId; return true }
    }
    await startWorkspaceRuntime(ctx.store, ctx.workspace.id, manager)
    const result = await stopWorkspaceRuntime(ctx.store, ctx.workspace.id, manager)
    assert.equal(result.stopped, true)
    assert.equal(stoppedWith, ctx.workspace.id)
    assert.equal(result.runtime?.phase, 'stopped')
    assert.equal(getWorkspaceRuntime(ctx.store, ctx.workspace.id)?.phase, 'stopped')
  } finally {
    ctx.store.close()
    rmSync(ctx.dir, { recursive: true, force: true })
  }
})
