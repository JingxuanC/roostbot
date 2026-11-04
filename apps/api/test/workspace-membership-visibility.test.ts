// 被邀请的账号能在 /api/workspaces 里看到 workspace，并能列它的 Bot（回归：只按 tenant_id 查会 403）。

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import { createBot } from '../../../packages/store/src/bots.ts'
import { createWorkspace } from '../../../packages/store/src/workspaces.ts'
import { startServer } from '../src/server.ts'
import { createStorePort } from '../src/store-adapter.ts'

const NOW = 1_760_000_000_000

test('成员账号可见被邀请的 workspace 并列出 Bot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-member-ws-'))
  const store = openStore(join(dir, 'workspace.db'))
  const started = await startServer({ store: createStorePort(store), rawStore: store, now: () => NOW, port: 0, host: '127.0.0.1' })
  try {
    const owner = createWorkspace(store, { tenantId: 'acc_owner', name: 'Owner', profileVersion: 'dev', createdAt: NOW })
    store.db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, invited_by, created_at) VALUES (?,?,?,?,?)').run(owner.id, 'acc_member', 'admin', 'acc_owner', NOW)
    const bot = createBot(store, { workspaceId: owner.id, name: '成员可见', model: 'deepseek-chat', createdBy: 'acc_owner' })

    // 建一个 member 的会话（控制面其余路由在别的测试覆盖；这里直接插入）
    const token = 'b'.repeat(64)
    const deviceId = 'dev_member_e2e'
    store.db.prepare('INSERT INTO devices (id, account_id, label, platform, last_seen_at, revoked_at, created_at) VALUES (?,?,?,?,?,NULL,?)').run(deviceId, 'acc_member', 'e2e', 'web', NOW, NOW)
    store.db.prepare('INSERT INTO sessions (id, device_id, token_hash, created_at, last_seen_at, expires_at, revoked_at) VALUES (?,?,?,?,?,?,NULL)').run('ses_member_e2e', deviceId, createHash('sha256').update(token).digest('hex'), NOW, NOW, NOW + 3_600_000)

    const headers = { authorization: `Bearer ${token}` }
    const list = await fetch(`${started.url}/api/workspaces`, { headers })
    const listBody = (await list.json()) as { workspaces: Array<{ id: string; role: string }> }
    assert.equal(list.status, 200)
    assert.equal(listBody.workspaces.some((workspace) => workspace.id === owner.id && workspace.role === 'admin'), true)

    const bots = await fetch(`${started.url}/api/bots?workspaceId=${owner.id}`, { headers })
    assert.equal(bots.status, 200)
    const botsBody = (await bots.json()) as { bots: Array<{ id: string }> }
    assert.equal(botsBody.bots.some((candidate) => candidate.id === bot.id), true)
  } finally {
    await started.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
