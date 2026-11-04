// 私聊房间：每个 (workspace, bot) 唯一、幂等、单成员 host、跨 workspace 拒绝。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createDmRoom, findDmRoom } from '../src/dm.ts'
import { createBot } from '../src/bots.ts'
import { addRoomMembers, listRoomMembers } from '../src/room-members.ts'
import { createRoom, listRooms } from '../src/rooms.ts'
import { createRoomExt } from '../src/rooms-ext.ts'
import { createWorkspace } from '../src/workspaces.ts'
import { assertStoreError, withStore } from './helpers.ts'

const BASE = 1_760_000_000_000
const MODEL = 'deepseek-v3'

function seedWorkspace(store: Parameters<typeof createWorkspace>[0], name = '量化研究组') {
  return createWorkspace(store, { tenantId: 'acc_1', name, profileVersion: 'dev', createdAt: BASE })
}

function seedBot(store: Parameters<typeof createBot>[0], workspaceId: string, name: string) {
  return createBot(store, { workspaceId, name, model: MODEL, createdBy: 'acc_1', createdAt: BASE })
}

test('建 DM：单成员 host、notice 空、reply_mode admin、dm=1，findDmRoom 能读回', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const bot = seedBot(store, workspace.id, '研究员')

    const dm = createDmRoom(store, {
      workspaceId: workspace.id,
      botId: bot.id,
      createdBy: 'acc_1',
      at: BASE,
    })

    assert.equal(dm.dm, true)
    assert.equal(dm.workspaceId, workspace.id)
    assert.equal(dm.name, '研究员')
    assert.equal(dm.notice, null)
    assert.equal(dm.replyMode, 'admin')
    assert.equal(dm.createdAt, BASE)

    const members = listRoomMembers(store, dm.id)
    assert.deepEqual(members.map((member) => ({ botId: member.botId, role: member.role })), [
      { botId: bot.id, role: 'host' },
    ])

    const found = findDmRoom(store, workspace.id, bot.id)
    assert.deepEqual(found, dm)
    assert.equal(findDmRoom(store, workspace.id, 'bot_missing'), null)
  })
})

test('DM 幂等：重复创建返回同一个房间，库里只有一行 dm=1', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const bot = seedBot(store, workspace.id, '研究员')

    const first = createDmRoom(store, { workspaceId: workspace.id, botId: bot.id, createdBy: 'acc_1', at: BASE })
    const second = createDmRoom(store, {
      workspaceId: workspace.id,
      botId: bot.id,
      createdBy: 'acc_2',
      at: BASE + 1_000,
    })

    assert.equal(second.id, first.id)
    assert.equal(second.createdAt, BASE, '重复创建不应该改已有房间')
    const count = store.db.prepare('SELECT COUNT(*) AS n FROM rooms WHERE dm = 1').get() as { n: number | bigint }
    assert.equal(Number(count.n), 1)
  })
})

test('DM 按 (workspace, bot) 隔离：两个 Bot 各有 DM，群聊不是 DM', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const a = seedBot(store, workspace.id, '研究员')
    const b = seedBot(store, workspace.id, '评审员')

    const dmA = createDmRoom(store, { workspaceId: workspace.id, botId: a.id, createdBy: 'acc_1' })
    const dmB = createDmRoom(store, { workspaceId: workspace.id, botId: b.id, createdBy: 'acc_1' })
    assert.notEqual(dmA.id, dmB.id)
    assert.equal(findDmRoom(store, workspace.id, a.id)?.id, dmA.id)
    assert.equal(findDmRoom(store, workspace.id, b.id)?.id, dmB.id)

    const group = createRoomExt(store, {
      workspaceId: workspace.id,
      memberBotIds: [a.id, b.id],
      createdBy: 'acc_1',
    })
    assert.equal(findDmRoom(store, workspace.id, a.id)?.id, dmA.id, '群聊不会顶掉 DM')
    assert.notEqual(group.room.id, dmA.id)

    const dmRows = store.db.prepare('SELECT dm FROM rooms WHERE id = ?').get(group.room.id) as { dm: number }
    assert.equal(Number(dmRows.dm), 0)
  })
})

test('DM 拒绝未知 Bot、跨 workspace Bot、空参数', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store, '一号')
    const other = seedWorkspace(store, '二号')
    const bot = seedBot(store, other.id, '外来者')

    assertStoreError(
      () => createDmRoom(store, { workspaceId: workspace.id, botId: 'bot_missing', createdBy: 'acc_1' }),
      'ROOM_MEMBERS_INVALID',
    )
    assertStoreError(
      () => createDmRoom(store, { workspaceId: workspace.id, botId: bot.id, createdBy: 'acc_1' }),
      'ROOM_MEMBERS_INVALID',
    )
    assertStoreError(
      () => createDmRoom(store, { workspaceId: '', botId: bot.id, createdBy: 'acc_1' }),
      'INVALID_ROOM',
    )
    assertStoreError(
      () => createDmRoom(store, { workspaceId: workspace.id, botId: bot.id, createdBy: '' }),
      'INVALID_ROOM',
    )
    assert.equal(findDmRoom(store, other.id, bot.id), null)
  })
})

test('普通房间不会被误认成 DM；DM 不要求 ≥2 个成员', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const bot = seedBot(store, workspace.id, '独行侠')

    const plain = createRoom(store, { workspaceId: workspace.id, name: '空房间' })
    addRoomMembers(store, { roomId: plain.id, botIds: [bot.id] })
    assert.equal(findDmRoom(store, workspace.id, bot.id), null)

    // DM 恰好一个成员也能建（createRoomExt 的群聊路径不走这里）。
    const dm = createDmRoom(store, { workspaceId: workspace.id, botId: bot.id, createdBy: 'acc_1' })
    assert.equal(listRoomMembers(store, dm.id).length, 1)

    const names = listRooms(store, { workspaceId: workspace.id }).map((room) => room.name).sort()
    assert.deepEqual(names, ['独行侠', '空房间'])
  })
})
