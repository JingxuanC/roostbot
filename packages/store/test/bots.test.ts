// Bot 域：名字锁、模型必填、人设版本、软删与恢复（bots.md §5/§8，迁移 0010）。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BOT_SOFT_DELETE_WINDOW_MS,
  addRoomMembers,
  createBot,
  createRoom,
  createWorkspace,
  deleteBot,
  getBot,
  listBotVersions,
  listBots,
  listRoomMembers,
  readEvents,
  restoreBot,
  updateBot,
} from '../src/index.ts'
import { assertStoreError, withStore } from './helpers.ts'

const BASE = 1_760_000_000_000
const MODEL = 'deepseek-v3'

function seedWorkspace(store: Parameters<typeof createWorkspace>[0], name = '量化研究组', tenantId = 'acc_1') {
  return createWorkspace(store, { tenantId, name, profileVersion: 'dev', createdAt: BASE })
}

function seedBot(
  store: Parameters<typeof createBot>[0],
  workspaceId: string,
  name: string,
  extra: { model?: string; role?: string; persona?: string } = {},
) {
  return createBot(store, {
    workspaceId,
    name,
    model: extra.model ?? MODEL,
    createdBy: 'acc_1',
    createdAt: BASE,
    ...(extra.role === undefined ? {} : { role: extra.role }),
    ...(extra.persona === undefined ? {} : { persona: extra.persona }),
  })
}

test('创建 Bot：默认值、get 与 list', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const bot = seedBot(store, workspace.id, '研究员')

    assert.equal(bot.workspaceId, workspace.id)
    assert.equal(bot.role, '')
    assert.equal(bot.persona, '')
    assert.equal(bot.provider, 'deepseek-official')
    assert.equal(bot.model, MODEL)
    assert.equal(bot.approval, 'ask')
    assert.deepEqual(bot.memoryScopes, ['team'])
    assert.deepEqual(bot.skills, [])
    assert.deepEqual(bot.toolsAllow, [])
    assert.deepEqual(bot.toolsDeny, [])
    assert.equal(bot.status, 'active')
    assert.equal(bot.createdBy, 'acc_1')
    assert.equal(bot.createdAt, BASE)

    assert.deepEqual(getBot(store, bot.id), bot)
    assert.equal(getBot(store, 'bot_missing'), null)
    assert.deepEqual(listBots(store, workspace.id).map((row) => row.name), ['研究员'])
  })
})

test('名字：空、过长、非法字符都报 INVALID_BOT', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    for (const name of ['', '   ', 'x'.repeat(41), 'a/b', 'a@b', 'a:b']) {
      assertStoreError(() => seedBot(store, workspace.id, name), 'INVALID_BOT')
    }
    // 40 个字符是允许的上限。
    assert.equal(seedBot(store, workspace.id, 'x'.repeat(40)).name.length, 40)
  })
})

test('名字锁：同 workspace 重名 BOT_NAME_TAKEN，别的 workspace 可以同名', async () => {
  await withStore((store) => {
    const first = seedWorkspace(store)
    const second = seedWorkspace(store, '另一个组', 'acc_2')
    seedBot(store, first.id, '研究员')

    assertStoreError(() => seedBot(store, first.id, '研究员'), 'BOT_NAME_TAKEN')
    // 前后空白会先 trim，所以这仍算重名。
    assertStoreError(() => seedBot(store, first.id, '  研究员  '), 'BOT_NAME_TAKEN')
    assert.equal(seedBot(store, second.id, '研究员').workspaceId, second.id)
  })
})

test('模型必填：缺 model / 空 model 都是 BOT_NO_MODEL', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    assertStoreError(
      () => createBot(store, { workspaceId: workspace.id, name: '没有模型', createdBy: 'acc_1' } as never),
      'BOT_NO_MODEL',
    )
    assertStoreError(() => seedBot(store, workspace.id, '空模型', { model: '   ' }), 'BOT_NO_MODEL')
  })
})

test('角色超长、审批值非法 → INVALID_BOT；workspace 不存在 → WORKSPACE_NOT_FOUND', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    assertStoreError(() => seedBot(store, workspace.id, '角色太长', { role: 'x'.repeat(25) }), 'INVALID_BOT')
    assertStoreError(() => seedBot(store, 'ws_missing', '孤儿'), 'WORKSPACE_NOT_FOUND')
    const bot = seedBot(store, workspace.id, '审批')
    assertStoreError(
      () => updateBot(store, { botId: bot.id, actor: 'acc_1', patch: { approval: 'nope' as never } }),
      'INVALID_BOT',
    )
  })
})

test('人设变化写 bot_versions；没变不写；改名字也留版本吗（不，只有 persona）', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const bot = seedBot(store, workspace.id, '研究员', { persona: '你是一个谨慎的研究员。' })

    // 创建时写入初始人设版本。
    const initial = listBotVersions(store, bot.id)
    assert.equal(initial.length, 1)
    assert.equal(initial[0]!.field, 'persona')
    assert.equal(initial[0]!.value, '你是一个谨慎的研究员。')

    updateBot(store, {
      botId: bot.id,
      actor: 'acc_1',
      patch: { persona: '你是一个更谨慎的研究员。', role: '数据' },
    })
    const after = listBotVersions(store, bot.id)
    assert.equal(after.length, 2)
    assert.equal(after[1]!.value, '你是一个更谨慎的研究员。')
    assert.equal(after[1]!.actor, 'acc_1')
    assert.equal(getBot(store, bot.id)?.role, '数据')

    // 同值再写一次不算变化。
    updateBot(store, { botId: bot.id, actor: 'acc_1', patch: { persona: '你是一个更谨慎的研究员。' } })
    assert.equal(listBotVersions(store, bot.id).length, 2)

    // 改名字/角色不写 persona 版本。
    updateBot(store, { botId: bot.id, actor: 'acc_1', patch: { name: '首席研究员', role: '研究' } })
    assert.equal(listBotVersions(store, bot.id).length, 2)
    assert.equal(getBot(store, bot.id)?.name, '首席研究员')
  })
})

test('updateBot：改名要过名字锁；status 可暂停；未知 Bot 报 BOT_NOT_FOUND', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const a = seedBot(store, workspace.id, 'A')
    const b = seedBot(store, workspace.id, 'B')

    assertStoreError(() => updateBot(store, { botId: b.id, actor: 'acc_1', patch: { name: 'A' } }), 'BOT_NAME_TAKEN')
    // 改成自己的名字不算冲突。
    assert.equal(updateBot(store, { botId: b.id, actor: 'acc_1', patch: { name: 'B' } }).name, 'B')

    assert.equal(updateBot(store, { botId: b.id, actor: 'acc_1', patch: { status: 'paused' } }).status, 'paused')
    assertStoreError(
      () => updateBot(store, { botId: b.id, actor: 'acc_1', patch: { status: 'deleted' as never } }),
      'INVALID_BOT',
    )
    assertStoreError(() => updateBot(store, { botId: 'bot_missing', actor: 'acc_1', patch: { role: 'x' } }), 'BOT_NOT_FOUND')
    assert.equal(getBot(store, a.id)?.status, 'active')
  })
})

test('软删：list/get 默认不可见，行与人设版本保留，名字仍占用', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const bot = seedBot(store, workspace.id, '要删的', { persona: '旧人设' })
    assert.equal(listBotVersions(store, bot.id).length, 1)

    deleteBot(store, bot.id, { actor: 'acc_1', now: BASE + 1000 })

    // 默认视角：已删 Bot 不存在。
    assert.equal(getBot(store, bot.id), null)
    assert.deepEqual(listBots(store, workspace.id), [])
    assertStoreError(() => deleteBot(store, bot.id, { now: BASE + 2000 }), 'BOT_NOT_FOUND')
    assertStoreError(() => deleteBot(store, 'bot_missing'), 'BOT_NOT_FOUND')
    assertStoreError(
      () => updateBot(store, { botId: bot.id, actor: 'acc_1', patch: { role: 'x' } }),
      'BOT_NOT_FOUND',
    )

    // includeDeleted：行还在，带 deletedAt。
    const tombstone = getBot(store, bot.id, { includeDeleted: true })
    assert.equal(tombstone?.deletedAt, BASE + 1000)
    assert.deepEqual(listBots(store, workspace.id, { includeDeleted: true }).map((row) => row.id), [bot.id])

    // 软删期间名字仍被占用（恢复窗口内身份完整保留）。
    assertStoreError(() => seedBot(store, workspace.id, '要删的'), 'BOT_NAME_TAKEN')

    // 人设版本历史保留，恢复后还能回滚。
    assert.equal(listBotVersions(store, bot.id).length, 1)
  })
})

test('删除：退出所有房间并逐房写 bot.removed_from_room，再写 bot.deleted', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const bot = seedBot(store, workspace.id, '要删的')
    const other = seedBot(store, workspace.id, '留下的')
    const roomA = createRoom(store, { workspaceId: workspace.id, name: '甲班', createdAt: BASE })
    const roomB = createRoom(store, { workspaceId: workspace.id, name: '乙班', createdAt: BASE })
    addRoomMembers(store, { roomId: roomA.id, botIds: [bot.id, other.id], now: BASE })
    addRoomMembers(store, { roomId: roomB.id, botIds: [bot.id], now: BASE })

    deleteBot(store, bot.id, { actor: 'acc_1', now: BASE + 1000 })

    // 成员关系移除：两个房间都不再有这个 Bot；另一个成员不受影响。
    assert.deepEqual(listRoomMembers(store, roomA.id).map((m) => m.botId), [other.id])
    assert.deepEqual(listRoomMembers(store, roomB.id), [])

    const botEvents = readEvents(store, { domain: 'bot' })
    const kinds = botEvents.map((event) => event.kind)
    assert.deepEqual(
      kinds,
      ['bot.created', 'bot.created', 'bot.removed_from_room', 'bot.removed_from_room', 'bot.deleted'],
    )

    const removed = botEvents.filter((event) => event.kind === 'bot.removed_from_room')
    assert.deepEqual(
      new Set(removed.map((event) => event.audience)),
      new Set([`room:${roomA.id}`, `room:${roomB.id}`]),
    )
    for (const event of removed) {
      assert.deepEqual(event.subject, { kind: 'bot', id: bot.id })
      assert.deepEqual(event.actor, { kind: 'user', id: 'acc_1' })
    }

    const deleted = botEvents.find((event) => event.kind === 'bot.deleted')
    assert.equal(deleted?.audience, 'team')
    assert.deepEqual(deleted?.subject, { kind: 'bot', id: bot.id })
    const payload = deleted?.payload as { name?: string; rooms?: string[] }
    assert.equal(payload.name, '要删的')
    assert.equal(payload.rooms?.length, 2)
  })
})

test('创建写 bot.created；PATCH 写 bot.updated（changed 只列真变了的字段）', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const bot = seedBot(store, workspace.id, '研究员', { persona: '旧人设' })

    const created = readEvents(store, { domain: 'bot' }).filter((event) => event.kind === 'bot.created')
    assert.equal(created.length, 1)
    assert.equal(created[0]!.audience, 'team')
    assert.deepEqual(created[0]!.subject, { kind: 'bot', id: bot.id })
    assert.deepEqual(created[0]!.actor, { kind: 'user', id: 'acc_1' })
    assert.equal(created[0]!.idem, `bot:${bot.id}:created`)
    assert.deepEqual(created[0]!.payload, {
      workspaceId: workspace.id,
      name: '研究员',
      model: MODEL,
      provider: 'deepseek-official',
    })

    updateBot(store, { botId: bot.id, actor: 'acc_1', patch: { role: '数据', persona: '新人设' } })
    const updates = readEvents(store, { domain: 'bot' }).filter((event) => event.kind === 'bot.updated')
    assert.equal(updates.length, 1)
    assert.deepEqual(updates[0]!.payload, { workspaceId: workspace.id, changed: ['role', 'persona'] })

    // 同值 PATCH：行照写，但不产生第二条 bot.updated。
    updateBot(store, { botId: bot.id, actor: 'acc_1', patch: { role: '数据' } })
    assert.equal(readEvents(store, { domain: 'bot' }).filter((event) => event.kind === 'bot.updated').length, 1)
  })
})

test('恢复：7 天内 restoreBot 还原身份并写 bot.restored；超窗 BOT_RESTORE_EXPIRED', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const bot = seedBot(store, workspace.id, '研究员', { persona: '旧人设' })
    const room = createRoom(store, { workspaceId: workspace.id, name: '甲班', createdAt: BASE })
    addRoomMembers(store, { roomId: room.id, botIds: [bot.id], now: BASE })

    deleteBot(store, bot.id, { actor: 'acc_1', now: BASE + 1000 })

    // 窗口边上（恰好 7 天）仍可恢复。
    const restored = restoreBot(store, bot.id, { actor: 'acc_1', now: BASE + 1000 + BOT_SOFT_DELETE_WINDOW_MS })
    assert.equal(restored.id, bot.id)
    assert.equal(restored.name, '研究员')
    assert.equal(restored.deletedAt, undefined)
    assert.deepEqual(getBot(store, bot.id), restored)
    assert.deepEqual(listBots(store, workspace.id).map((row) => row.id), [bot.id])

    // 房间成员关系不自动恢复（删除时已逐房写事件）。
    assert.deepEqual(listRoomMembers(store, room.id), [])

    const restoredEvents = readEvents(store, { domain: 'bot' }).filter((event) => event.kind === 'bot.restored')
    assert.equal(restoredEvents.length, 1)
    assert.equal(restoredEvents[0]!.audience, 'team')
    assert.deepEqual(restoredEvents[0]!.subject, { kind: 'bot', id: bot.id })

    // 未删除的 Bot 再 restore：幂等返回，不重复写事件。
    const again = restoreBot(store, bot.id, { actor: 'acc_1', now: BASE + 2000 })
    assert.equal(again.id, bot.id)
    assert.equal(readEvents(store, { domain: 'bot' }).filter((event) => event.kind === 'bot.restored').length, 1)

    // 超过 7 天：BOT_RESTORE_EXPIRED。
    const doomed = seedBot(store, workspace.id, '救不回来的')
    deleteBot(store, doomed.id, { actor: 'acc_1', now: BASE })
    assertStoreError(
      () => restoreBot(store, doomed.id, { actor: 'acc_1', now: BASE + BOT_SOFT_DELETE_WINDOW_MS + 1 }),
      'BOT_RESTORE_EXPIRED',
    )
    assert.equal(getBot(store, doomed.id), null)
    assertStoreError(() => restoreBot(store, 'bot_missing'), 'BOT_NOT_FOUND')
  })
})

test('已软删的 Bot 不能再被拉进房间', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const bot = seedBot(store, workspace.id, '要删的')
    const other = seedBot(store, workspace.id, '留下的')
    const room = createRoom(store, { workspaceId: workspace.id, name: '甲班', createdAt: BASE })
    addRoomMembers(store, { roomId: room.id, botIds: [other.id], now: BASE })

    deleteBot(store, bot.id, { now: BASE })
    assertStoreError(
      () => addRoomMembers(store, { roomId: room.id, botIds: [bot.id], now: BASE }),
      'ROOM_MEMBERS_INVALID',
    )
  })
})
