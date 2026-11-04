// 轮次编排：真 SQLite，不经过 HTTP。
// 覆盖：开轮、成员 slot、assignments 的 sessionId/prompt、@ 调用加 slot、[PASS]、收轮。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import { createBot } from '../../../packages/store/src/bots.ts'
import { createRoomExt } from '../../../packages/store/src/rooms-ext.ts'
import { createWorkspace } from '../../../packages/store/src/workspaces.ts'
import { getRoom, readMessages, sendMessage } from '../../../packages/store/src/rooms.ts'
import { applyAdvance, assignmentsForRound, openRoundForMessage, sessionIdForMember } from '../src/round-orchestrator.ts'

const AT = 1_760_000_000_000

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-round-'))
  const store = openStore(join(dir, 'workspace.db'))
  const workspace = createWorkspace(store, { tenantId: 'tenant_1', name: '研究', profileVersion: 'dev', createdAt: AT })
  const host = createBot(store, { workspaceId: workspace.id, name: '研究员', role: '选股', model: 'deepseek-chat', createdBy: 'acc_1' })
  const peer = createBot(store, { workspaceId: workspace.id, name: '评审员', role: '风控', model: 'deepseek-chat', createdBy: 'acc_1' })
  return { dir, store, workspace, host, peer }
}

function room(store: ReturnType<typeof openStore>, input: Parameters<typeof createRoomExt>[1]) {
  return createRoomExt(store, input)
}

function cleanup(ctx: { dir: string; store: ReturnType<typeof openStore> }) {
  ctx.store.close()
  rmSync(ctx.dir, { recursive: true, force: true })
}

test('member 模式：开轮只有一个 slot，assignments 带确定性 sessionId', () => {
  const ctx = setup()
  try {
    const created = room(ctx.store, {
      workspaceId: ctx.workspace.id,
      memberBotIds: [ctx.host.id, ctx.peer.id],
      hostBotId: ctx.host.id,
      responder: { kind: 'member', botId: ctx.host.id },
      createdBy: 'acc_1'
    })
    const base = getRoom(ctx.store, created.room.id)
    assert.ok(base !== null)
    const sent = sendMessage(ctx.store, { roomId: created.room.id, text: '今天看什么', actor: { kind: 'user', id: 'acc_1' } })
    const round = openRoundForMessage({ store: ctx.store, room: base, seq: sent.seq, text: '今天看什么', at: AT })
    assert.ok(round !== null)
    assert.equal(round.slots.length, 1)
    assert.equal(round.slots[0].botId, ctx.host.id)

    const assignments = assignmentsForRound(ctx.store, created.room.id)
    assert.equal(assignments.length, 1)
    assert.equal(assignments[0].index, 0)
    assert.equal(assignments[0].sessionId, sessionIdForMember(ctx.store, created.room.id, ctx.host.id))
    assert.match(assignments[0].prompt, /研究员/)
    assert.match(assignments[0].prompt, /今天看什么/)
  } finally {
    cleanup(ctx)
  }
})

test('everyone 模式：host 先，两人都进 slot', () => {
  const ctx = setup()
  try {
    const created = room(ctx.store, {
      workspaceId: ctx.workspace.id,
      memberBotIds: [ctx.peer.id, ctx.host.id],
      hostBotId: ctx.host.id,
      responder: { kind: 'everyone' },
      createdBy: 'acc_1'
    })
    const base = getRoom(ctx.store, created.room.id)
    assert.ok(base !== null)
    const sent = sendMessage(ctx.store, { roomId: created.room.id, text: '开始', actor: { kind: 'user', id: 'acc_1' } })
    const round = openRoundForMessage({ store: ctx.store, room: base, seq: sent.seq, text: '开始', at: AT })
    assert.ok(round !== null)
    assert.deepEqual(round.slots.map((slot) => slot.botId), [ctx.host.id, ctx.peer.id])
  } finally {
    cleanup(ctx)
  }
})

test('posted 里的 @ 调用插入新 slot；[PASS] 记 passed；最后收轮', () => {
  const ctx = setup()
  try {
    const created = room(ctx.store, {
      workspaceId: ctx.workspace.id,
      memberBotIds: [ctx.host.id, ctx.peer.id],
      hostBotId: ctx.host.id,
      responder: { kind: 'member', botId: ctx.host.id },
      createdBy: 'acc_1'
    })
    const base = getRoom(ctx.store, created.room.id)
    assert.ok(base !== null)
    const sent = sendMessage(ctx.store, { roomId: created.room.id, text: '请评审员看一下', actor: { kind: 'user', id: 'acc_1' } })
    const round = openRoundForMessage({ store: ctx.store, room: base, seq: sent.seq, text: '请评审员看一下', at: AT })
    assert.ok(round !== null)

    // host 回复并 @ 评审员
    const first = applyAdvance({ store: ctx.store, roundId: round.id, slotIndex: 0, result: { kind: 'posted', text: '@评审员 你看下这个' } })
    assert.equal(first.next, 1)
    assert.equal(first.round.slots.length, 2)
    assert.equal(first.round.slots[1].botId, ctx.peer.id)

    // 评审员 [PASS]
    const second = applyAdvance({ store: ctx.store, roundId: round.id, slotIndex: 1, result: { kind: 'passed' } })
    assert.equal(second.next, null)
    assert.equal(second.round.state, 'done')
    assert.equal(second.round.slots[1].status, 'passed')
  } finally {
    cleanup(ctx)
  }
})

test('没有成员时不开轮', () => {
  const ctx = setup()
  try {
    const created = room(ctx.store, { workspaceId: ctx.workspace.id, name: '空房间', createdBy: 'acc_1' })
    const base = getRoom(ctx.store, created.room.id)
    assert.ok(base !== null)
    const sent = sendMessage(ctx.store, { roomId: created.room.id, text: '在吗', actor: { kind: 'user', id: 'acc_1' } })
    assert.equal(openRoundForMessage({ store: ctx.store, room: base, seq: sent.seq, text: '在吗', at: AT }), null)
  } finally {
    cleanup(ctx)
  }
})

test('晚到结果：轮次已收，轮距 ≤10 时仍回群且幂等（4.2.16）', () => {
  const ctx = setup()
  try {
    const created = room(ctx.store, {
      workspaceId: ctx.workspace.id,
      memberBotIds: [ctx.host.id, ctx.peer.id],
      hostBotId: ctx.host.id,
      responder: { kind: 'member', botId: ctx.host.id },
      createdBy: 'acc_1'
    })
    const base = getRoom(ctx.store, created.room.id)
    assert.ok(base !== null)
    const first = sendMessage(ctx.store, { roomId: created.room.id, text: '第一轮', actor: { kind: 'user', id: 'acc_1' } })
    const round1 = openRoundForMessage({ store: ctx.store, room: base, seq: first.seq, text: '第一轮', at: AT })
    assert.ok(round1 !== null)
    applyAdvance({ store: ctx.store, roundId: round1.id, slotIndex: 0, result: { kind: 'posted', text: '第一轮答复' }, now: AT + 1 })

    // 新的一轮已经开了，旧轮的结果晚到。
    const second = sendMessage(ctx.store, { roomId: created.room.id, text: '第二轮', actor: { kind: 'user', id: 'acc_1' } })
    const round2 = openRoundForMessage({ store: ctx.store, room: base, seq: second.seq, text: '第二轮', at: AT + 2 })
    assert.ok(round2 !== null)

    const outcome = applyAdvance({ store: ctx.store, roundId: round1.id, slotIndex: 0, result: { kind: 'posted', text: '晚到答复' }, now: AT + 3 })
    assert.equal(outcome.next, null)
    const texts = readMessages(ctx.store, { roomId: created.room.id, limit: 50 }).map((message) => message.text)
    assert.equal(texts.filter((text) => text === '晚到答复').length, 1)

    // 重投同一 slot：idem 去重，不重复回群。
    applyAdvance({ store: ctx.store, roundId: round1.id, slotIndex: 0, result: { kind: 'posted', text: '晚到答复' }, now: AT + 4 })
    const after = readMessages(ctx.store, { roomId: created.room.id, limit: 50 }).map((message) => message.text)
    assert.equal(after.filter((text) => text === '晚到答复').length, 1)
  } finally {
    cleanup(ctx)
  }
})
