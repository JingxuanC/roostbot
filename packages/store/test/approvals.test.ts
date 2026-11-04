// 审批存储（docs/build/m4-addendum.md §B）。
//
// 覆盖：创建/列表/过滤、pending → approved|rejected 单边状态机、重复决定幂等、
// 相反决定不翻案、跨 workspace 隔离、坏 payload 自愈、域错误码。

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APPROVAL_ERROR_CODES,
  createApproval,
  decideApproval,
  getApproval,
  hasPendingApproval,
  listApprovals,
  storeErrorTag,
} from '../src/approvals.ts'
import { createWorkspace } from '../src/workspaces.ts'
import type { Store } from '../src/types.ts'
import { assertStoreError, withStore } from './helpers.ts'

/** 本地时间中午：避开「今天 00:00」在 UTC/本地时区边界上的抖动。 */
const AT = new Date(2026, 10, 4, 12, 0, 0).getTime()

function setup(store: Store): { wsA: string; wsB: string } {
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
  return { wsA: wsA.id, wsB: wsB.id }
}

test('createApproval 落 pending；list 按 workspace 与 status 过滤', async () => {
  await withStore((store) => {
    const { wsA, wsB } = setup(store)
    const created = createApproval(store, {
      workspaceId: wsA,
      kind: 'create_room',
      requester: 'bot_1',
      payload: { workspaceId: wsA, botId: 'bot_1', memberBotIds: ['bot_1', 'bot_2'] },
      at: AT,
    })

    assert.equal(created.status, 'pending')
    assert.equal(created.requesterKind, 'bot')
    assert.equal(created.decidedAt, null)
    assert.equal(created.decidedBy, null)
    assert.deepEqual(created.payload.memberBotIds, ['bot_1', 'bot_2'])

    assert.deepEqual(listApprovals(store, wsA), [created])
    assert.deepEqual(listApprovals(store, wsA, 'pending'), [created])
    assert.deepEqual(listApprovals(store, wsA, 'approved'), [])
    assert.deepEqual(listApprovals(store, wsB), [])
    assert.deepEqual(getApproval(store, created.id), created)
  })
})

test('decideApproval：pending → approved，写 decided_at/by；同决定幂等', async () => {
  await withStore((store) => {
    const { wsA } = setup(store)
    const created = createApproval(store, {
      workspaceId: wsA,
      kind: 'create_room',
      requester: 'bot_1',
      payload: { botId: 'bot_1' },
      at: AT,
    })

    const approved = decideApproval(store, {
      id: created.id,
      decision: 'approved',
      by: 'user_1',
      at: AT + 1_000,
    })
    assert.equal(approved.status, 'approved')
    assert.equal(approved.decidedAt, AT + 1_000)
    assert.equal(approved.decidedBy, 'user_1')

    // 重复批准：幂等，不覆盖审计时间/人。
    const again = decideApproval(store, { id: created.id, decision: 'approved', by: 'user_2', at: AT + 9_000 })
    assert.equal(again.status, 'approved')
    assert.equal(again.decidedAt, AT + 1_000)
    assert.equal(again.decidedBy, 'user_1')

    // 相反决定：不翻案，原样返回当前行。
    const flipped = decideApproval(store, { id: created.id, decision: 'rejected', by: 'user_2', at: AT + 9_000 })
    assert.equal(flipped.status, 'approved')
    assert.equal(flipped.decidedBy, 'user_1')
    assert.equal(flipped.decidedAt, AT + 1_000)
  })
})

test('decideApproval：拒绝后再批准也不翻案', async () => {
  await withStore((store) => {
    const { wsA } = setup(store)
    const created = createApproval(store, {
      workspaceId: wsA,
      kind: 'create_room',
      requester: 'bot_1',
      payload: {},
      at: AT,
    })

    const rejected = decideApproval(store, { id: created.id, decision: 'rejected', by: 'user_1', at: AT + 5 })
    assert.equal(rejected.status, 'rejected')
    assert.equal(rejected.decidedBy, 'user_1')

    const approved = decideApproval(store, { id: created.id, decision: 'approved', by: 'user_2', at: AT + 10 })
    assert.equal(approved.status, 'rejected')
    assert.equal(approved.decidedBy, 'user_1')
  })
})

test('hasPendingApproval 只看 pending，且按 workspace + requester 隔离', async () => {
  await withStore((store) => {
    const { wsA, wsB } = setup(store)
    const created = createApproval(store, {
      workspaceId: wsA,
      kind: 'create_room',
      requester: 'bot_1',
      payload: {},
      at: AT,
    })

    assert.equal(hasPendingApproval(store, wsA, 'bot_1'), true)
    assert.equal(hasPendingApproval(store, wsA, 'bot_2'), false)
    assert.equal(hasPendingApproval(store, wsB, 'bot_1'), false)

    decideApproval(store, { id: created.id, decision: 'approved', by: 'user_1', at: AT + 1 })
    assert.equal(hasPendingApproval(store, wsA, 'bot_1'), false)
  })
})

test('未知审批、非法决定、非法 status 都抛 INVALID_INPUT（域码在 message 里）', async () => {
  await withStore((store) => {
    const { wsA } = setup(store)

    assertStoreError(
      () => decideApproval(store, { id: 'apr_missing', decision: 'approved', by: 'user_1' }),
      'INVALID_INPUT',
    )
    try {
      decideApproval(store, { id: 'apr_missing', decision: 'approved', by: 'user_1' })
    } catch (err) {
      assert.equal(storeErrorTag(err), APPROVAL_ERROR_CODES.notFound)
    }

    const created = createApproval(store, {
      workspaceId: wsA,
      kind: 'create_room',
      requester: 'bot_1',
      payload: {},
      at: AT,
    })
    assertStoreError(
      () => decideApproval(store, { id: created.id, decision: 'pending' as never, by: 'user_1' }),
      'INVALID_INPUT',
    )
    assertStoreError(() => listApprovals(store, wsA, 'bogus' as never), 'INVALID_INPUT')
    assertStoreError(
      () => createApproval(store, { workspaceId: wsA, kind: 'create_room', requester: 'bot_1', payload: [] as never }),
      'INVALID_INPUT',
    )
    assertStoreError(
      () =>
        createApproval(store, {
          workspaceId: 'ws_missing',
          kind: 'create_room',
          requester: 'bot_1',
          payload: {},
        }),
      'WORKSPACE_NOT_FOUND',
    )
  })
})

test('坏 payload_json 读成 {}，不抛错', async () => {
  await withStore((store) => {
    const { wsA } = setup(store)
    const created = createApproval(store, {
      workspaceId: wsA,
      kind: 'create_room',
      requester: 'bot_1',
      payload: { a: 1 },
      at: AT,
    })
    store.db.prepare('UPDATE approvals SET payload_json = ? WHERE id = ?').run('{not json', created.id)
    assert.deepEqual(getApproval(store, created.id)?.payload, {})
  })
})

test('listApprovals 按 created_at 升序，跨 workspace 不串', async () => {
  await withStore((store) => {
    const { wsA, wsB } = setup(store)
    const late = createApproval(store, {
      workspaceId: wsA,
      kind: 'create_room',
      requester: 'bot_2',
      payload: {},
      at: AT + 2_000,
    })
    const early = createApproval(store, {
      workspaceId: wsA,
      kind: 'create_room',
      requester: 'bot_1',
      payload: {},
      at: AT + 1_000,
    })
    const other = createApproval(store, {
      workspaceId: wsB,
      kind: 'create_room',
      requester: 'bot_1',
      payload: {},
      at: AT,
    })

    assert.deepEqual(
      listApprovals(store, wsA).map((approval) => approval.id),
      [early.id, late.id],
    )
    assert.deepEqual(listApprovals(store, wsB).map((approval) => approval.id), [other.id])
  })
})
