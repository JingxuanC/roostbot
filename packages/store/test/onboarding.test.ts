import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore } from '../src/index.ts'
import { createWorkspace } from '../src/workspaces.ts'
import { ensureMainBot, MAIN_BOT_MODEL, MAIN_BOT_NAME } from '../src/onboarding.ts'
import { findDmRoom } from '../src/dm.ts'

test('每个 workspace 幂等获得一个主 Bot 和私聊 DM', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-onboarding-'))
  const store = openStore(join(dir, 'db.sqlite'))
  try {
    const ws = createWorkspace(store, { tenantId: 'acc_1', name: 'W', profileVersion: 'dev', createdAt: 1000 })
    const first = ensureMainBot(store, { workspaceId: ws.id, accountId: 'acc_1', at: 2000 })
    assert.equal(first.bot.name, MAIN_BOT_NAME)
    assert.equal(first.bot.model, MAIN_BOT_MODEL)
    assert.equal(first.createdBot, true)
    assert.equal(first.room.dm, true)
    const dmRow = store.db.prepare('SELECT host_bot_id, dm FROM rooms WHERE id = ?').get(first.room.id) as { host_bot_id: string; dm: number }
    assert.equal(dmRow.host_bot_id, first.bot.id)
    assert.equal(dmRow.dm, 1)
    assert.equal(findDmRoom(store, ws.id, first.bot.id)?.id, first.room.id)

    const second = ensureMainBot(store, { workspaceId: ws.id, accountId: 'acc_1', at: 3000 })
    assert.equal(second.bot.id, first.bot.id)
    assert.equal(second.room.id, first.room.id)
    assert.equal(second.createdBot, false)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
