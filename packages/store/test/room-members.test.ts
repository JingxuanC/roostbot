// 房间成员：host 唯一、同 workspace 校验、删除成员后的 host/responder 维护。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  addRoomMembers,
  createBot,
  createRoom,
  createRoomExt,
  createWorkspace,
  deleteBot,
  getRoomExtras,
  listRoomMembers,
  removeRoomMember,
  setRoomHost,
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

function seedRoom(store: Parameters<typeof createRoom>[0], workspaceId: string, name = '房间') {
  return createRoom(store, { workspaceId, name, createdAt: BASE })
}

test('添加成员：默认 member，第一个没有 host 的成员被提为 host，列表带名字且 host 在前', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const a = seedBot(store, workspace.id, 'A')
    const b = seedBot(store, workspace.id, 'B')
    const room = seedRoom(store, workspace.id)

    const members = addRoomMembers(store, { roomId: room.id, botIds: [a.id, b.id] })
    assert.equal(members.length, 2)
    assert.deepEqual(
      members.map((member) => [member.name, member.role]),
      [
        ['A', 'host'],
        ['B', 'member'],
      ],
    )
    assert.equal(getRoomExtras(store, room.id)?.hostBotId, a.id)
  })
})

test('host 唯一：role=host 只能带一个 Bot，setRoomHost 会把原 host 降级', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const a = seedBot(store, workspace.id, 'A')
    const b = seedBot(store, workspace.id, 'B')
    const c = seedBot(store, workspace.id, 'C')
    const room = seedRoom(store, workspace.id)
    addRoomMembers(store, { roomId: room.id, botIds: [a.id, b.id, c.id] })

    assertStoreError(
      () => addRoomMembers(store, { roomId: room.id, botIds: [b.id, c.id], role: 'host' }),
      'ROOM_HOST_CONFLICT',
    )

    const after = setRoomHost(store, { roomId: room.id, botId: b.id })
    assert.equal(after.filter((member) => member.role === 'host').length, 1)
    assert.equal(after.find((member) => member.botId === b.id)?.role, 'host')
    assert.equal(after.find((member) => member.botId === a.id)?.role, 'member')

    // 直接有一条 host 索引兜底：同一房间不允许两个 host。
    const hostRows = store.db.prepare("SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND role = 'host'").get(
      room.id,
    ) as { n: number }
    assert.equal(hostRows.n, 1)
  })
})

test('成员必须同 workspace；重复添加幂等', async () => {
  await withStore((store) => {
    const first = seedWorkspace(store)
    const second = seedWorkspace(store, '另一个组', 'acc_2')
    const local = seedBot(store, first.id, '本地')
    const foreign = seedBot(store, second.id, '外组')
    const room = seedRoom(store, first.id)

    assertStoreError(
      () => addRoomMembers(store, { roomId: room.id, botIds: [local.id, foreign.id] }),
      'ROOM_MEMBERS_INVALID',
    )
    assertStoreError(() => addRoomMembers(store, { roomId: room.id, botIds: ['bot_missing'] }), 'ROOM_MEMBERS_INVALID')

    const once = addRoomMembers(store, { roomId: room.id, botIds: [local.id] })
    const twice = addRoomMembers(store, { roomId: room.id, botIds: [local.id] })
    assert.equal(once.length, 1)
    assert.equal(twice.length, 1)
  })
})

test('成员上限 12（ROOM_LIMITS.membersMax）', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const bots = Array.from({ length: 13 }, (_, index) => seedBot(store, workspace.id, `B${index}`))
    const room = seedRoom(store, workspace.id)

    addRoomMembers(store, { roomId: room.id, botIds: bots.slice(0, 12).map((bot) => bot.id) })
    assertStoreError(
      () => addRoomMembers(store, { roomId: room.id, botIds: [bots[12]!.id] }),
      'ROOM_MEMBERS_INVALID',
    )
  })
})

test('移除 host：下一个成员接任；移除最后一个后 host 清空；responder 回退', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const a = seedBot(store, workspace.id, 'A')
    const b = seedBot(store, workspace.id, 'B')
    const detail = createRoomExt(store, {
      workspaceId: workspace.id,
      memberBotIds: [a.id, b.id],
      responder: { kind: 'member', botId: a.id },
    })
    assert.deepEqual(detail.extras.responder, { kind: 'member', botId: a.id })

    const afterHostRemoved = removeRoomMember(store, { roomId: detail.room.id, botId: a.id })
    assert.deepEqual(
      afterHostRemoved.map((member) => [member.name, member.role]),
      [['B', 'host']],
    )
    assert.equal(getRoomExtras(store, detail.room.id)?.hostBotId, b.id)
    assert.deepEqual(getRoomExtras(store, detail.room.id)?.responder, { kind: 'member', botId: b.id })

    const empty = removeRoomMember(store, { roomId: detail.room.id, botId: b.id })
    assert.deepEqual(empty, [])
    assert.equal(getRoomExtras(store, detail.room.id)?.hostBotId, null)
    assert.deepEqual(getRoomExtras(store, detail.room.id)?.responder, { kind: 'mentions' })
  })
})

test('移除不存在的成员 → ROOM_MEMBER_NOT_FOUND；setRoomHost 指向非成员 → ROOM_MEMBER_NOT_FOUND', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const a = seedBot(store, workspace.id, 'A')
    const b = seedBot(store, workspace.id, 'B')
    const room = seedRoom(store, workspace.id)
    addRoomMembers(store, { roomId: room.id, botIds: [a.id] })

    assertStoreError(() => removeRoomMember(store, { roomId: room.id, botId: b.id }), 'ROOM_MEMBER_NOT_FOUND')
    assertStoreError(() => setRoomHost(store, { roomId: room.id, botId: b.id }), 'ROOM_MEMBER_NOT_FOUND')
    assertStoreError(() => listRoomMembers(store, 'rm_missing'), 'ROOM_NOT_FOUND')
  })
})

test('删除 Bot：自动退出所有房间；删掉的 Bot 不能再被拉进房', async () => {
  await withStore((store) => {
    const workspace = seedWorkspace(store)
    const a = seedBot(store, workspace.id, 'A')
    const b = seedBot(store, workspace.id, 'B')
    const room = seedRoom(store, workspace.id)
    addRoomMembers(store, { roomId: room.id, botIds: [a.id, b.id] })

    deleteBot(store, a.id)
    assert.deepEqual(
      listRoomMembers(store, room.id).map((member) => [member.name, member.role]),
      [['B', 'host']],
    )
    assertStoreError(() => addRoomMembers(store, { roomId: room.id, botIds: [a.id] }), 'ROOM_MEMBERS_INVALID')

    // host 的 bot_sessions / room_seen 也被一起清掉。
    store.db.prepare('INSERT INTO room_seen (room_id, bot_id, seq) VALUES (?, ?, ?)').run(room.id, b.id, 1)
    store.db.prepare('INSERT INTO bot_sessions (room_id, bot_id, session_id, updated_at) VALUES (?, ?, ?, ?)').run(
      room.id,
      b.id,
      'sess_1',
      BASE,
    )
    deleteBot(store, b.id)
    const seen = store.db.prepare('SELECT COUNT(*) AS n FROM room_seen WHERE bot_id = ?').get(b.id) as { n: number }
    const sessions = store.db.prepare('SELECT COUNT(*) AS n FROM bot_sessions WHERE bot_id = ?').get(b.id) as {
      n: number
    }
    assert.equal(seen.n, 0)
    assert.equal(sessions.n, 0)
  })
})
