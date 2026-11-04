// kickoff：触发条件、prompt 文案、只 host 开场、重复调用不重复开轮。
// 真 SQLite，不经过 HTTP。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { Room, RoomMember } from '../../../packages/contract/src/index.ts'
import { createBot } from '../../../packages/store/src/bots.ts'
import { createDmRoom } from '../../../packages/store/src/dm.ts'
import { StoreError } from '../../../packages/store/src/errors.ts'
import { createRoom, sendMessage } from '../../../packages/store/src/rooms.ts'
import { createRoomExt, getRoomDetail } from '../../../packages/store/src/rooms-ext.ts'
import { listRounds, saveRound } from '../../../packages/store/src/rounds.ts'
import { openStore } from '../../../packages/store/src/store.ts'
import { createWorkspace } from '../../../packages/store/src/workspaces.ts'
import {
  dmKickoffPrompt,
  isDmRoom,
  isKickoffDue,
  kickoffPromptFor,
  kickoffSlots,
  openKickoffRound,
  type KickoffRoom,
} from '../src/kickoff.ts'

const AT = 1_760_000_000_000

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-kickoff-'))
  const store = openStore(join(dir, 'workspace.db'))
  const workspace = createWorkspace(store, {
    tenantId: 'acc_1',
    name: '研究',
    profileVersion: 'dev',
    createdAt: AT,
  })
  const host = createBot(store, {
    workspaceId: workspace.id,
    name: '研究员',
    role: '选股',
    model: 'deepseek-chat',
    createdBy: 'acc_1',
    createdAt: AT,
  })
  const peer = createBot(store, {
    workspaceId: workspace.id,
    name: '评审员',
    role: '风控',
    model: 'deepseek-chat',
    createdBy: 'acc_1',
    createdAt: AT,
  })
  return { dir, store, workspace, host, peer }
}

function cleanup(ctx: { dir: string; store: ReturnType<typeof openStore> }) {
  ctx.store.close()
  rmSync(ctx.dir, { recursive: true, force: true })
}

function groupRoom(
  ctx: ReturnType<typeof setup>,
  options: { members?: string[]; hostBotId?: string } = {},
): KickoffRoom {
  const detail = createRoomExt(ctx.store, {
    workspaceId: ctx.workspace.id,
    name: '盘前小组',
    memberBotIds: options.members ?? [ctx.host.id, ctx.peer.id],
    hostBotId: options.hostBotId ?? ctx.host.id,
    createdBy: 'acc_1',
    createdAt: AT,
  })
  return toContractRoom(detail)
}

function toContractRoom(detail: NonNullable<ReturnType<typeof getRoomDetail>>): KickoffRoom {
  const { room, extras, members } = detail
  return {
    id: room.id,
    workspaceId: room.workspaceId,
    name: room.name,
    ...(extras.notice === null ? {} : { notice: extras.notice }),
    replyMode: room.replyMode as Room['replyMode'],
    responder: extras.responder,
    ...(extras.hostBotId === null ? {} : { hostBotId: extras.hostBotId }),
    ...(extras.purpose === null ? {} : { purpose: extras.purpose }),
    createdByKind: extras.createdByKind,
    createdBy: extras.createdBy ?? 'acc_1',
    createdAt: room.createdAt,
    members,
  }
}

function dmRoom(ctx: ReturnType<typeof setup>): { room: KickoffRoom; bot: ReturnType<typeof createBot> } {
  const bot = ctx.host
  const dm = createDmRoom(ctx.store, { workspaceId: ctx.workspace.id, botId: bot.id, createdBy: 'acc_1', at: AT })
  const member: RoomMember = { botId: bot.id, role: 'host', name: bot.name }
  return {
    bot,
    room: {
      id: dm.id,
      workspaceId: dm.workspaceId,
      name: dm.name,
      replyMode: 'admin',
      responder: { kind: 'member', botId: bot.id },
      hostBotId: bot.id,
      createdByKind: 'user',
      createdBy: 'acc_1',
      createdAt: dm.createdAt,
      members: [member],
      dm: true,
    },
  }
}

test('isKickoffDue：没有用户/系统消息才触发，Bot 消息不算“说过话”', () => {
  const ctx = setup()
  try {
    const group = groupRoom(ctx)
    assert.equal(isKickoffDue(group, []), true)
    assert.equal(isKickoffDue(group, [{ actor: { kind: 'bot' } }]), true, 'Bot 自己的开场不吞掉 kickoff')
    assert.equal(isKickoffDue(group, [{ actor: { kind: 'user' } }]), false)
    assert.equal(isKickoffDue(group, [{ actor: { kind: 'system' } }]), false)
    assert.equal(isKickoffDue(group, [{ actor: { kind: 'user' } }, { actor: { kind: 'bot' } }]), false)

    const { room: dm } = dmRoom(ctx)
    assert.equal(isDmRoom(dm), true)
    assert.equal(isKickoffDue(dm, []), true)
    assert.equal(isKickoffDue(dm, [{ actor: { kind: 'user' } }]), false)

    assert.equal(isKickoffDue(null as unknown as KickoffRoom, []), false)
    assert.equal(isKickoffDue(group, undefined), true)
  } finally {
    cleanup(ctx)
  }
})

test('DM prompt：一句话自我介绍 + 问用户希望你做什么', () => {
  const ctx = setup()
  try {
    const { room, bot } = dmRoom(ctx)
    const member = room.members[0]!
    const prompt = kickoffPromptFor(room, member)

    assert.match(prompt, /介绍自己/)
    assert.match(prompt, /希望你做什么/)
    assert.match(prompt, new RegExp(bot.name))
    assert.match(prompt, /私聊/)
    assert.doesNotMatch(prompt, /这个群刚建好/)
    assert.equal(dmKickoffPrompt(room, member), prompt)
  } finally {
    cleanup(ctx)
  }
})

test('群 prompt：复用 buildKickoffPrompt，问“这个群要做什么”而不是私聊文案', () => {
  const ctx = setup()
  try {
    const room = groupRoom(ctx)
    const host = room.members.find((member) => member.role === 'host')!
    const prompt = kickoffPromptFor(room, host)

    assert.match(prompt, /这个群刚建好/)
    assert.match(prompt, /做什么/)
    assert.match(prompt, /host/)
    assert.doesNotMatch(prompt, /私聊/)
    assert.match(prompt, /不要回复 \[PASS\]/)
  } finally {
    cleanup(ctx)
  }
})

test('群 kickoff 只开 host 一个 slot，重复调用返回同一轮', () => {
  const ctx = setup()
  try {
    const room = groupRoom(ctx)
    assert.deepEqual(kickoffSlots(room).map((slot) => slot.botId), [ctx.host.id])
    assert.deepEqual(kickoffSlots({ ...room, hostBotId: undefined, members: [] }), [])

    const round = openKickoffRound(ctx.store, room.id, AT)
    assert.ok(round !== null)
    assert.equal(round.state, 'running')
    assert.equal(round.startSeq, 0, '没有消息时开场轮从 0 开始')
    assert.equal(round.slots.length, 1)
    assert.deepEqual(round.slots.map((slot) => slot.botId), [ctx.host.id])
    assert.equal(round.slots[0]?.status, 'waiting')

    const again = openKickoffRound(ctx.store, room.id, AT + 1_000)
    assert.ok(again !== null)
    assert.equal(again.id, round.id)
    assert.equal(listRounds(ctx.store, room.id).length, 1, '不能重复开轮')
  } finally {
    cleanup(ctx)
  }
})

test('kickoff 轮结束后再调用仍返回那一轮，不重新开场', () => {
  const ctx = setup()
  try {
    const room = groupRoom(ctx)
    const round = openKickoffRound(ctx.store, room.id, AT)
    assert.ok(round !== null)

    saveRound(ctx.store, { ...round, state: 'done', slots: [{ ...round.slots[0]!, status: 'posted' }], endedAt: AT + 5 })
    const again = openKickoffRound(ctx.store, room.id, AT + 10_000)
    assert.ok(again !== null)
    assert.equal(again.id, round.id)
    assert.equal(again.state, 'done')
    assert.equal(listRounds(ctx.store, room.id).length, 1)
  } finally {
    cleanup(ctx)
  }
})

test('DM kickoff 只开那个 Bot 的 slot', () => {
  const ctx = setup()
  try {
    const { room, bot } = dmRoom(ctx)
    const round = openKickoffRound(ctx.store, room.id, AT)
    assert.ok(round !== null)
    assert.deepEqual(round.slots.map((slot) => slot.botId), [bot.id])
    assert.equal(round.slots[0]?.name, bot.name)
  } finally {
    cleanup(ctx)
  }
})

test('日志里已有 Bot 消息时，开场轮从该消息的 seq 之后开始', () => {
  const ctx = setup()
  try {
    const room = groupRoom(ctx)
    const sent = sendMessage(ctx.store, {
      roomId: room.id,
      text: '我先占个位',
      actor: { kind: 'bot', id: ctx.host.id },
      at: AT,
    })
    assert.equal(isKickoffDue(room, [{ actor: { kind: 'bot' } }]), true)

    const round = openKickoffRound(ctx.store, room.id, AT + 1_000)
    assert.ok(round !== null)
    assert.equal(round.startSeq, sent.seq)
  } finally {
    cleanup(ctx)
  }
})

test('没有成员的房间不开场；未知房间抛 ROOM_NOT_FOUND', () => {
  const ctx = setup()
  try {
    const empty = createRoom(ctx.store, { workspaceId: ctx.workspace.id, name: '空房间', createdAt: AT })
    assert.equal(openKickoffRound(ctx.store, empty.id, AT), null)

    assert.throws(
      () => openKickoffRound(ctx.store, 'rm_missing', AT),
      (err: unknown) => {
        assert.ok(err instanceof StoreError)
        assert.equal(err.code, 'ROOM_NOT_FOUND')
        return true
      },
    )
  } finally {
    cleanup(ctx)
  }
})
