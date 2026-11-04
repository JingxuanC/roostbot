// Bot 建群（docs/build/m4-addendum.md §B、docs/design/rooms.md §6）。
//
// 覆盖：只写审批不建房、pending 去重、审批后建房（成员/host/created_by_kind=bot）、
// 重复批准幂等、拒绝不建、拒绝后不能再批、每日配额、跨 workspace 与成员数校验。

import assert from 'node:assert/strict'
import test from 'node:test'

import { createBot, getBot } from '../src/bots.ts'
import { createWorkspace } from '../src/workspaces.ts'
import { listApprovals, storeErrorTag } from '../src/approvals.ts'
import {
  BOT_ROOM_DAILY_LIMIT,
  approveBotRoom,
  countBotRoomsToday,
  rejectBotRoom,
  requestBotRoom,
  startOfLocalDay,
} from '../src/bot-rooms.ts'
import type { Store } from '../src/types.ts'
import { assertStoreError, withStore } from './helpers.ts'

const AT = new Date(2026, 10, 4, 12, 0, 0).getTime()

interface Fixture {
  wsA: string
  wsB: string
  bots: string[]
  foreignBot: string
}

/** wsA 里 13 个 Bot（够测成员上限），wsB 里 1 个（跨租户用）。 */
function setup(store: Store): Fixture {
  const wsA = createWorkspace(store, {
    tenantId: 'acc_a',
    name: '工作区 A',
    profileVersion: 'dev',
    createdAt: AT,
  })
  const wsB = createWorkspace(store, {
    tenantId: 'acc_b',
    name: '工作区 B',
    profileVersion: 'dev',
    createdAt: AT,
  })
  const bots = Array.from({ length: 13 }, (_, index) =>
    createBot(store, {
      workspaceId: wsA.id,
      name: `Bot${String(index + 1).padStart(2, '0')}`,
      model: 'deepseek-official',
      createdBy: 'user_1',
      createdAt: AT,
    }).id,
  )
  const foreignBot = createBot(store, {
    workspaceId: wsB.id,
    name: 'Foreign',
    model: 'deepseek-official',
    createdBy: 'user_1',
    createdAt: AT,
  }).id
  return { wsA: wsA.id, wsB: wsB.id, bots, foreignBot }
}

function roomCount(store: Store, workspaceId: string): number {
  const row = store.db
    .prepare('SELECT COUNT(*) AS n FROM rooms WHERE workspace_id = ?')
    .get(workspaceId) as { n: number | bigint }
  return Number(row.n)
}

function roomRow(store: Store, roomId: string): Record<string, unknown> | undefined {
  return store.db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) as
    | Record<string, unknown>
    | undefined
}

test('requestBotRoom 只写 pending 审批，不建房', async () => {
  await withStore((store) => {
    const fx = setup(store)
    const approval = requestBotRoom(store, {
      workspaceId: fx.wsA,
      botId: fx.bots[0]!,
      name: '早盘研究组',
      purpose: '盘前异动',
      memberBotIds: [fx.bots[0]!, fx.bots[1]!],
      at: AT,
    })

    assert.equal(approval.status, 'pending')
    assert.equal(approval.kind, 'create_room')
    assert.equal(approval.requester, fx.bots[0])
    assert.equal(approval.requesterKind, 'bot')
    assert.deepEqual(approval.payload.memberBotIds, [fx.bots[0], fx.bots[1]])
    assert.equal(approval.payload.name, '早盘研究组')
    assert.equal(approval.payload.purpose, '盘前异动')
    assert.equal(roomCount(store, fx.wsA), 0, '审批通过前不应有房间')
    assert.equal(listApprovals(store, fx.wsA, 'pending').length, 1)
  })
})

test('同一个 Bot 已有 pending 请求时幂等返回它（不重复排审批）', async () => {
  await withStore((store) => {
    const fx = setup(store)
    const first = requestBotRoom(store, {
      workspaceId: fx.wsA,
      botId: fx.bots[0]!,
      name: '第一个名字',
      memberBotIds: [fx.bots[0]!, fx.bots[1]!],
      at: AT,
    })
    const second = requestBotRoom(store, {
      workspaceId: fx.wsA,
      botId: fx.bots[0]!,
      name: '第二个名字',
      memberBotIds: [fx.bots[0]!, fx.bots[2]!],
      at: AT + 1_000,
    })

    assert.equal(second.id, first.id)
    assert.equal(second.payload.name, '第一个名字')
    assert.equal(listApprovals(store, fx.wsA).length, 1)
    assert.equal(roomCount(store, fx.wsA), 0)
  })
})

test('approveBotRoom 建房：成员、host、created_by_kind=bot、审批落 approved', async () => {
  await withStore((store) => {
    const fx = setup(store)
    const requested = requestBotRoom(store, {
      workspaceId: fx.wsA,
      botId: fx.bots[0]!,
      name: '研究小组',
      purpose: '跟踪持仓',
      memberBotIds: [fx.bots[0]!, fx.bots[1]!, fx.bots[2]!],
      at: AT,
    })

    const result = approveBotRoom(store, { approvalId: requested.id, by: 'user_1', at: AT + 500 })

    assert.equal(result.room.room.workspaceId, fx.wsA)
    assert.equal(result.room.room.name, '研究小组')
    assert.equal(result.room.extras.hostBotId, fx.bots[0])
    assert.equal(result.room.extras.createdByKind, 'bot')
    assert.equal(result.room.extras.createdBy, fx.bots[0])
    assert.equal(result.room.extras.purpose, '跟踪持仓')
    assert.equal(result.room.members[0]?.role, 'host', 'host 排在最前')
    assert.equal(result.room.members[0]?.botId, fx.bots[0])
    assert.deepEqual(
      result.room.members.map((member) => member.botId).sort(),
      [fx.bots[0]!, fx.bots[1]!, fx.bots[2]!].sort(),
    )
    assert.deepEqual(
      result.room.members.filter((member) => member.role === 'member').map((member) => member.role),
      ['member', 'member'],
    )
    assert.equal(result.room.room.createdAt, AT + 500)

    const row = roomRow(store, result.room.room.id)
    assert.equal(row?.['created_by_kind'], 'bot')
    assert.equal(row?.['created_by'], fx.bots[0])
    assert.equal(row?.['host_bot_id'], fx.bots[0])

    assert.equal(result.approval.status, 'approved')
    assert.equal(result.approval.decidedBy, 'user_1')
    assert.equal(result.approval.payload.roomId, result.room.room.id)
    assert.equal(roomCount(store, fx.wsA), 1)
  })
})

test('重复 approve 幂等：返回同一个房间，不建第二个', async () => {
  await withStore((store) => {
    const fx = setup(store)
    const requested = requestBotRoom(store, {
      workspaceId: fx.wsA,
      botId: fx.bots[0]!,
      memberBotIds: [fx.bots[0]!, fx.bots[1]!],
      at: AT,
    })

    const first = approveBotRoom(store, { approvalId: requested.id, by: 'user_1', at: AT + 500 })
    const second = approveBotRoom(store, { approvalId: requested.id, by: 'user_2', at: AT + 9_000 })

    assert.equal(second.room.room.id, first.room.room.id)
    assert.equal(second.approval.decidedAt, AT + 500, '重复批准不改审计时间')
    assert.equal(second.approval.decidedBy, 'user_1')
    assert.equal(roomCount(store, fx.wsA), 1)
  })
})

test('rejectBotRoom 不建房；拒绝后不能再批准', async () => {
  await withStore((store) => {
    const fx = setup(store)
    const requested = requestBotRoom(store, {
      workspaceId: fx.wsA,
      botId: fx.bots[0]!,
      memberBotIds: [fx.bots[0]!, fx.bots[1]!],
      at: AT,
    })

    const rejected = rejectBotRoom(store, { approvalId: requested.id, by: 'user_1', at: AT + 100 })
    assert.equal(rejected.status, 'rejected')
    assert.equal(rejected.decidedBy, 'user_1')
    assert.equal(roomCount(store, fx.wsA), 0)

    // 重复拒绝：幂等。
    const again = rejectBotRoom(store, { approvalId: requested.id, by: 'user_2', at: AT + 200 })
    assert.equal(again.status, 'rejected')
    assert.equal(again.decidedBy, 'user_1')

    assertStoreError(
      () => approveBotRoom(store, { approvalId: requested.id, by: 'user_1', at: AT + 300 }),
      'INVALID_INPUT',
    )
    try {
      approveBotRoom(store, { approvalId: requested.id, by: 'user_1', at: AT + 300 })
    } catch (err) {
      assert.equal(storeErrorTag(err), 'APPROVAL_CONFLICT')
    }
    assert.equal(roomCount(store, fx.wsA), 0)
  })
})

test('每日配额：第 4 个请求抛 BOT_ROOM_QUOTA（room 数与审批数都对得上）', async () => {
  await withStore((store) => {
    const fx = setup(store)
    for (let index = 0; index < BOT_ROOM_DAILY_LIMIT; index += 1) {
      const requested = requestBotRoom(store, {
        workspaceId: fx.wsA,
        botId: fx.bots[0]!,
        name: `房间 ${index + 1}`,
        memberBotIds: [fx.bots[0]!, fx.bots[1]!],
        at: AT + index * 1_000,
      })
      approveBotRoom(store, { approvalId: requested.id, by: 'user_1', at: AT + index * 1_000 + 1 })
    }
    assert.equal(countBotRoomsToday(store, fx.bots[0]!, AT + 10_000), BOT_ROOM_DAILY_LIMIT)
    assert.equal(roomCount(store, fx.wsA), BOT_ROOM_DAILY_LIMIT)

    try {
      requestBotRoom(store, {
        workspaceId: fx.wsA,
        botId: fx.bots[0]!,
        name: '第 4 个',
        memberBotIds: [fx.bots[0]!, fx.bots[1]!],
        at: AT + 20_000,
      })
      assert.fail('expected BOT_ROOM_QUOTA')
    } catch (err) {
      assert.equal(storeErrorTag(err), 'BOT_ROOM_QUOTA')
      assert.match((err as Error).message, /limit 3/)
    }

    // 换一个 Bot：配额是按 Bot 算的，不受影响。
    requestBotRoom(store, {
      workspaceId: fx.wsA,
      botId: fx.bots[1]!,
      memberBotIds: [fx.bots[1]!, fx.bots[2]!],
      at: AT + 20_000,
    })

    // 昨天建的房间不算今天：把 created_at 拨到昨天，配额应释放。
    store.db
      .prepare("UPDATE rooms SET created_at = ? WHERE created_by_kind = 'bot' AND created_by = ?")
      .run(startOfLocalDay(AT) - 1, fx.bots[0]!)
    assert.equal(countBotRoomsToday(store, fx.bots[0]!, AT), 0)
  })
})

test('跨 workspace：发起 Bot 和成员 Bot 都拒绝', async () => {
  await withStore((store) => {
    const fx = setup(store)

    // 发起 Bot 在 wsB，却申请在 wsA 建群。
    try {
      requestBotRoom(store, {
        workspaceId: fx.wsA,
        botId: fx.foreignBot,
        memberBotIds: [fx.foreignBot, fx.bots[0]!],
        at: AT,
      })
      assert.fail('expected BOT_ROOM_CROSS_WORKSPACE')
    } catch (err) {
      assert.equal(storeErrorTag(err), 'BOT_ROOM_CROSS_WORKSPACE')
    }

    // 成员里有 wsB 的 Bot。
    try {
      requestBotRoom(store, {
        workspaceId: fx.wsA,
        botId: fx.bots[0]!,
        memberBotIds: [fx.bots[0]!, fx.foreignBot],
        at: AT,
      })
      assert.fail('expected BOT_ROOM_MEMBERS')
    } catch (err) {
      assert.equal(storeErrorTag(err), 'BOT_ROOM_MEMBERS')
    }

    assert.equal(roomCount(store, fx.wsA), 0)
    assert.equal(listApprovals(store, fx.wsA).length, 0)
  })
})

test('成员校验：少于 2、超过 12、不含发起 Bot、未知 Bot 都拒绝', async () => {
  await withStore((store) => {
    const fx = setup(store)

    assertStoreError(
      () => requestBotRoom(store, { workspaceId: fx.wsA, botId: fx.bots[0]!, memberBotIds: [fx.bots[0]!], at: AT }),
      'ROOM_MEMBERS_INVALID',
    )
    assertStoreError(
      () =>
        requestBotRoom(store, {
          workspaceId: fx.wsA,
          botId: fx.bots[0]!,
          memberBotIds: fx.bots.slice(0, 13),
          at: AT,
        }),
      'ROOM_MEMBERS_INVALID',
    )
    assertStoreError(
      () =>
        requestBotRoom(store, {
          workspaceId: fx.wsA,
          botId: fx.bots[0]!,
          memberBotIds: [fx.bots[1]!, fx.bots[2]!],
          at: AT,
        }),
      'ROOM_MEMBERS_INVALID',
    )
    assertStoreError(
      () =>
        requestBotRoom(store, {
          workspaceId: fx.wsA,
          botId: 'bot_missing',
          memberBotIds: ['bot_missing', fx.bots[1]!],
          at: AT,
        }),
      'BOT_NOT_FOUND',
    )
  })
})

test('approveBotRoom 遇到未知 / 非建群审批都拒绝', async () => {
  await withStore((store) => {
    const fx = setup(store)
    assertStoreError(
      () => approveBotRoom(store, { approvalId: 'apr_missing', by: 'user_1', at: AT }),
      'INVALID_INPUT',
    )

    // 直接插一条别的 kind：approve 只能处理 create_room。
    const foreign = requestBotRoom(store, {
      workspaceId: fx.wsA,
      botId: fx.bots[0]!,
      memberBotIds: [fx.bots[0]!, fx.bots[1]!],
      at: AT,
    })
    store.db.prepare("UPDATE approvals SET kind = 'other' WHERE id = ?").run(foreign.id)
    try {
      approveBotRoom(store, { approvalId: foreign.id, by: 'user_1', at: AT })
      assert.fail('expected APPROVAL_INVALID')
    } catch (err) {
      assert.equal(storeErrorTag(err), 'APPROVAL_INVALID')
    }
    assert.equal(roomCount(store, fx.wsA), 0)
  })
})

test('建房失败时审批保持 pending（可重试）', async () => {
  await withStore((store) => {
    const fx = setup(store)
    const requested = requestBotRoom(store, {
      workspaceId: fx.wsA,
      botId: fx.bots[0]!,
      memberBotIds: [fx.bots[0]!, fx.bots[1]!],
      at: AT,
    })
    // 模拟成员 Bot 在批准前被删：createRoomExt 会抛，审批不能被标 approved。
    store.db.prepare('DELETE FROM bots WHERE id = ?').run(fx.bots[1]!)
    assertStoreError(() => approveBotRoom(store, { approvalId: requested.id, by: 'user_1', at: AT }), 'ROOM_MEMBERS_INVALID')

    const approval = listApprovals(store, fx.wsA, 'pending')[0]
    assert.equal(approval?.id, requested.id)
    assert.equal(approval?.status, 'pending')
    assert.equal(roomCount(store, fx.wsA), 0)
    assert.equal(getBot(store, fx.bots[1]!) === null, true)
  })
})
