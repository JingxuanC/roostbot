// 头像：dataURL 上限、格式校验、程序化 shape/color 仍严格。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore } from './../src/index.ts'
import { createBot } from './../src/bots.ts'
import { createWorkspace } from './../src/workspaces.ts'

const AT = 1_760_000_000_000
const PNG = 'data:image/png;base64,' + 'A'.repeat(350_000)

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-avatar-'))
  const store = openStore(join(dir, 'workspace.db'))
  const workspace = createWorkspace(store, { tenantId: 't', name: 'W', profileVersion: 'dev', createdAt: AT })
  return { dir, store, workspace }
}

test('256KB 图片的 dataURL 可以被接受', () => {
  const ctx = setup()
  try {
    const bot = createBot(ctx.store, { workspaceId: ctx.workspace.id, name: '有头像', model: 'deepseek-chat', createdBy: 'a', avatar: { image: PNG } })
    assert.equal(bot.avatar?.image, PNG)
  } finally {
    ctx.store.close(); rmSync(ctx.dir, { recursive: true, force: true })
  }
})

test('非 dataURL / 过大 / 未知字段都被拒', () => {
  const ctx = setup()
  try {
    assert.throws(() => createBot(ctx.store, { workspaceId: ctx.workspace.id, name: 'A', model: 'deepseek-chat', createdBy: 'a', avatar: { image: 'https://example.com/a.png' } }), /data URL/)
    assert.throws(() => createBot(ctx.store, { workspaceId: ctx.workspace.id, name: 'B', model: 'deepseek-chat', createdBy: 'a', avatar: { image: 'data:image/png;base64,' + 'A'.repeat(600_000) } }), /too long/)
    assert.throws(() => createBot(ctx.store, { workspaceId: ctx.workspace.id, name: 'C', model: 'deepseek-chat', createdBy: 'a', avatar: { nope: 'x' } as never }), /unknown field/)
  } finally {
    ctx.store.close(); rmSync(ctx.dir, { recursive: true, force: true })
  }
})
