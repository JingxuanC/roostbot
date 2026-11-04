// 房间扩展列：建房（成员/host/responder/notice/purpose 一次落库）与更新。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createBot,
  createRoomExt,
  createWorkspace,
  getRoomDetail,
  getRoomExtras,
  updateRoomExtras,
} from '../src/index.ts'
import { assertStoreError, withStore } from './helpers.ts'

const BASE = 1_760_000_000_000
const MODEL = 'deepseek-v3'

function seedWorkspace(store: Parameters<typeof createWorkspace>[0], name = '量化研究组', tenantId = 'acc_1') {
  return createWorkspace(store, { tenantId, name, profileVersion: 'dev', createdAt: BASE })
}

function seedBot(store: Parameters<typeof createBot>[0], workspaceId: string, name: string) {
  return createBot(store, { workspaceId, name, model: MODEL, createdBy: 'acc_1', createdAt: BASE })
}

test('建群：没名字时按成员名生成；第一个成员默认 host；responder 默认指向 host', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const a = seedBot(store, workspace.id, '研究员')
    const b = seedBot(store, workspace.id, '评审员')

    const detail = createRoomExt(store, {
      workspaceId: workspace.id,
      memberBotIds: [a.id, b.id],
      notice: '先说结论，再给证据。',
      purpose: '盘前讨论',
      createdBy: 'acc_1',
      createdAt: BASE,
    })

    assert.equal(detail.room.name, '研究员、评审员')
    assert.equal(detail.room.workspaceId, workspace.id)
    assert.equal(detail.room.replyMode, 'admin')
    assert.equal(detail.room.notice, '先说结论，再给证据。')
    assert.equal(detail.extras.notice, '先说结论，再给证据。')
    assert.equal(detail.extras.purpose, '盘前讨论')
    assert.equal(detail.extras.hostBotId, a.id)
    assert.deepEqual(detail.extras.responder, { kind: 'member', botId: a.id })
    assert.equal(detail.extras.createdByKind, 'user')
    assert.equal(detail.extras.createdBy, 'acc_1')
    assert.equal(detail.members.length, 2)
    assert.equal(detail.members[0]?.role, 'host')
  })
})

test('建群：显式 name/hostBotId/responder=everyone；reply_mode 跟着 responder 走', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const a = seedBot(store, workspace.id, 'A')
    const b = seedBot(store, workspace.id, 'B')

    const detail = createRoomExt(store, {
      workspaceId: workspace.id,
      name: '盘前小组',
      memberBotIds: [a.id, b.id],
      hostBotId: b.id,
      responder: { kind: 'everyone' },
    })
    assert.equal(detail.room.name, '盘前小组')
    assert.equal(detail.room.replyMode, 'everyone')
    assert.equal(detail.extras.hostBotId, b.id)
    assert.deepEqual(detail.extras.responder, { kind: 'everyone' })
    assert.equal(detail.members.find((member) => member.botId === b.id)?.role, 'host')
  })
})

test('建群：responder 指向非成员 → ROOM_RESPONDER_INVALID；跨 workspace 成员 → ROOM_MEMBERS_INVALID', async () => {
  await withStore((store) => {
    const first = seedWorkspace(store)
    const second = seedWorkspace(store, '另一个组', 'acc_2')
    const a = seedBot(store, first.id, 'A')
    const b = seedBot(store, first.id, 'B')
    const foreign = seedBot(store, second.id, '外组')

    assertStoreError(
      () =>
        createRoomExt(store, {
          workspaceId: first.id,
          memberBotIds: [a.id, b.id],
          responder: { kind: 'member', botId: foreign.id },
        }),
      'ROOM_RESPONDER_INVALID',
    )
    assertStoreError(
      () => createRoomExt(store, { workspaceId: first.id, memberBotIds: [a.id, foreign.id] }),
      'ROOM_MEMBERS_INVALID',
    )
    assertStoreError(
      () => createRoomExt(store, { workspaceId: first.id, memberBotIds: [a.id], hostBotId: b.id }),
      'ROOM_MEMBERS_INVALID',
    )
  })
})

test('没有成员的空房间：必须给名字，responder 回退 mentions', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    assertStoreError(() => createRoomExt(store, { workspaceId: workspace.id }), 'INVALID_ROOM')

    const detail = createRoomExt(store, { workspaceId: workspace.id, name: '空房间' })
    assert.deepEqual(detail.members, [])
    assert.equal(detail.extras.hostBotId, null)
    assert.deepEqual(detail.extras.responder, { kind: 'mentions' })
    assert.equal(detail.room.replyMode, 'mentions')
  })
})

test('更新：name/notice/purpose；notice 可以清空；responder 必须指向成员', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const a = seedBot(store, workspace.id, 'A')
    const b = seedBot(store, workspace.id, 'B')
    const c = seedBot(store, workspace.id, 'C')
    const created = createRoomExt(store, {
      workspaceId: workspace.id,
      memberBotIds: [a.id, b.id],
      notice: '旧公告',
      purpose: '旧目的',
    })

    const updated = updateRoomExtras(store, {
      roomId: created.room.id,
      name: '新名字',
      notice: '新公告',
      purpose: '新目的',
      responder: { kind: 'member', botId: b.id },
    })
    assert.equal(updated.room.name, '新名字')
    assert.equal(updated.extras.notice, '新公告')
    assert.equal(updated.extras.purpose, '新目的')
    assert.deepEqual(updated.extras.responder, { kind: 'member', botId: b.id })

    const cleared = updateRoomExtras(store, { roomId: created.room.id, notice: null, purpose: '' })
    assert.equal(cleared.extras.notice, null)
    assert.equal(cleared.extras.purpose, null)

    assertStoreError(
      () => updateRoomExtras(store, { roomId: created.room.id, responder: { kind: 'member', botId: c.id } }),
      'ROOM_RESPONDER_INVALID',
    )
    assertStoreError(
      () => updateRoomExtras(store, { roomId: created.room.id, hostBotId: c.id }),
      'ROOM_MEMBERS_INVALID',
    )
  })
})

test('更新 host：成员 role 与 rooms.host_bot_id 同步；清空有成员的 host 被拒', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const a = seedBot(store, workspace.id, 'A')
    const b = seedBot(store, workspace.id, 'B')
    const created = createRoomExt(store, { workspaceId: workspace.id, memberBotIds: [a.id, b.id] })

    const updated = updateRoomExtras(store, { roomId: created.room.id, hostBotId: b.id })
    assert.equal(updated.extras.hostBotId, b.id)
    assert.equal(updated.members.find((member) => member.botId === b.id)?.role, 'host')
    assert.equal(updated.members.find((member) => member.botId === a.id)?.role, 'member')
    const rows = store.db
      .prepare("SELECT bot_id FROM room_members WHERE room_id = ? AND role = 'host'")
      .all(created.room.id) as Array<{ bot_id: string }>
    assert.deepEqual(rows.map((row) => row.bot_id), [b.id])

    assertStoreError(() => updateRoomExtras(store, { roomId: created.room.id, hostBotId: null }), 'ROOM_MEMBERS_INVALID')
  })
})

test('长度与未知房间：notice 超限 INVALID_ROOM；getRoomExtras 未知返回 null', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const a = seedBot(store, workspace.id, 'A')
    const b = seedBot(store, workspace.id, 'B')
    assertStoreError(
      () =>
        createRoomExt(store, {
          workspaceId: workspace.id,
          memberBotIds: [a.id, b.id],
          notice: 'x'.repeat(2001),
        }),
      'INVALID_ROOM',
    )
    assert.equal(getRoomExtras(store, 'rm_missing'), null)
    assert.equal(getRoomDetail(store, 'rm_missing'), null)
    assertStoreError(() => updateRoomExtras(store, { roomId: 'rm_missing', name: 'x' }), 'ROOM_NOT_FOUND')
  })
})
