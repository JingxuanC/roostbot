// Agent Runtime slot/binding/session store（docs/design/agent-runtimes.md §10–§11）。
// 真临时 SQLite + 真实迁移，覆盖：迁移形状、slot 生命周期、单 active binding、
// 级联关闭和非法输入。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createBot, createRoom, createWorkspace } from '../src/index.ts'
import {
  BINDING_KINDS,
  BINDING_STATES,
  SESSION_STATUSES,
  SLOT_STATUSES,
  closeAgentSession,
  closeBinding,
  closeRoomSlot,
  createAgentSession,
  createBinding,
  createRoomSlot,
  getAgentSession,
  getBinding,
  getRoomSlot,
  listAgentSessions,
  listBindings,
  listRoomSlots,
} from '../src/agent-bindings.ts'
import { assertStoreError, withStore } from './helpers.ts'

const BASE = 1_760_000_000_000

function fixture(store: Parameters<typeof createWorkspace>[0]) {
  const workspace = createWorkspace(store, {
    tenantId: 'acc_rt',
    name: 'runtime-test',
    profileVersion: 'dev',
    createdAt: BASE,
  })
  const bot = createBot(store, {
    workspaceId: workspace.id,
    name: 'UZI研究官',
    model: 'deepseek-v3',
    createdBy: 'acc_rt',
    createdAt: BASE,
    runtimeKind: 'claude-code',
  })
  const room = createRoom(store, { workspaceId: workspace.id, name: '研究', createdAt: BASE })
  return { workspace, bot, room }
}

test('迁移 0024：bots 新列、三张表与索引都在', async () => {
  await withStore((store) => {
    const botColumns = store.db
      .prepare('PRAGMA table_info(bots)')
      .all()
      .map((row) => (row as { name: string }).name)
    for (const column of ['runtime_kind', 'runtime_config', 'credential_ref', 'capabilities']) {
      assert.ok(botColumns.includes(column), `missing bots.${column}`)
    }
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name)
    for (const table of ['room_slots', 'agent_bindings', 'agent_sessions']) {
      assert.ok(tables.includes(table), `missing table ${table}`)
    }
    const indexes = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
      .all()
      .map((row) => (row as { name: string }).name)
    for (const index of [
      'idx_room_slots_room_status',
      'idx_room_slots_bot',
      'idx_agent_bindings_slot_state',
      'idx_agent_bindings_room_state',
      'idx_agent_bindings_active_slot',
      'idx_agent_sessions_binding_status',
    ]) {
      assert.ok(indexes.includes(index), `missing index ${index}`)
    }
    const activeIndex = store.db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_agent_bindings_active_slot'")
      .get() as { sql: string }
    assert.match(activeIndex.sql, /UNIQUE/i, 'active binding partial unique index must be UNIQUE')
  })
})

test('slot：默认 open、可按房间/bot/status 过滤、close 幂等', async () => {
  await withStore((store) => {
    const { bot, room } = fixture(store)
    const slot = createRoomSlot(store, { roomId: room.id, botId: bot.id, runtimeKind: 'claude-code' })
    assert.equal(slot.status, 'open')
    assert.equal(slot.runtimeKind, 'claude-code')
    assert.equal(slot.botId, bot.id)
    assert.equal(getRoomSlot(store, slot.id)?.id, slot.id)
    assert.deepEqual(listRoomSlots(store, { roomId: room.id }).map((row) => row.id), [slot.id])
    assert.deepEqual(listRoomSlots(store, { botId: bot.id }).map((row) => row.id), [slot.id])
    assert.deepEqual(listRoomSlots(store, { status: 'open' }).map((row) => row.id), [slot.id])

    const closed = closeRoomSlot(store, slot.id, { now: BASE + 1000 })
    assert.equal(closed.status, 'closed')
    assert.equal(closed.updatedAt, BASE + 1000)
    assert.equal(closeRoomSlot(store, slot.id, { now: BASE + 2000 }).updatedAt, BASE + 1000)
    assert.equal(listRoomSlots(store, { status: 'open' }).length, 0)
  })
})

test('binding：一个 slot 同时只能有一个 active；close 后可建下一代', async () => {
  await withStore((store) => {
    const { bot, room } = fixture(store)
    const slot = createRoomSlot(store, { roomId: room.id, botId: bot.id, runtimeKind: 'dsh' })
    const first = createBinding(store, {
      slotId: slot.id,
      kind: 'embedded',
      runtimeKind: 'dsh',
      externalId: 'sess_native_1',
      createdAt: BASE,
    })
    assert.equal(first.kind, 'embedded')
    assert.equal(first.state, 'active')
    assert.equal(first.generation, 1)
    assert.equal(getRoomSlot(store, slot.id)?.status, 'bound')
    assert.equal(getBinding(store, first.id)?.id, first.id)
    assert.deepEqual(listBindings(store, { slotId: slot.id }).map((row) => row.id), [first.id])

    assert.throws(
      () => createBinding(store, { slotId: slot.id, kind: 'native', runtimeKind: 'dsh' }),
      /already has an active binding/,
    )

    const closed = closeBinding(store, first.id, { now: BASE + 5000 })
    assert.equal(closed.state, 'closed')
    assert.equal(closed.lastSeenAt, BASE + 5000)

    const second = createBinding(store, { slotId: slot.id, kind: 'native', runtimeKind: 'dsh', createdAt: BASE + 6000 })
    assert.equal(second.generation, 2)
    assert.equal(second.state, 'active')
    assert.deepEqual(
      listBindings(store, { slotId: slot.id, state: 'active' }).map((row) => row.id),
      [second.id],
    )
  })
})

test('slot close 级联关闭 active binding 与 embedded session', async () => {
  await withStore((store) => {
    const { bot, room } = fixture(store)
    const slot = createRoomSlot(store, { roomId: room.id, botId: bot.id })
    const binding = createBinding(store, { slotId: slot.id, kind: 'embedded', runtimeKind: 'codex' })
    const session = createAgentSession(store, {
      bindingId: binding.id,
      workdir: '/tmp/uzi-work',
      pid: 4242,
      status: 'running',
      startedAt: BASE,
    })
    assert.equal(session.status, 'running')
    assert.equal(session.pid, 4242)
    assert.equal(getAgentSession(store, session.id)?.id, session.id)
    assert.deepEqual(listAgentSessions(store, { bindingId: binding.id }).map((row) => row.id), [session.id])

    closeRoomSlot(store, slot.id, { now: BASE + 9000 })
    assert.equal(getRoomSlot(store, slot.id)?.status, 'closed')
    assert.equal(getBinding(store, binding.id)?.state, 'closed')
    const closedSession = getAgentSession(store, session.id)
    assert.equal(closedSession?.status, 'closed')
    assert.equal(closedSession?.endedAt, BASE + 9000)
  })
})

test('session：只允许 embedded active binding；closeAgentSession 可显式 failed', async () => {
  await withStore((store) => {
    const { bot, room } = fixture(store)
    const embeddedSlot = createRoomSlot(store, { roomId: room.id, botId: bot.id })
    const embedded = createBinding(store, { slotId: embeddedSlot.id, kind: 'embedded', runtimeKind: 'hermes' })
    const session = createAgentSession(store, { bindingId: embedded.id, workdir: '/tmp/w' })
    assert.equal(session.status, 'starting')
    const failed = closeAgentSession(store, session.id, { status: 'failed', now: BASE + 1000 })
    assert.equal(failed.status, 'failed')
    assert.equal(failed.endedAt, BASE + 1000)
    assert.equal(closeAgentSession(store, session.id).status, 'failed')

    const nativeSlot = createRoomSlot(store, { roomId: room.id, botId: bot.id })
    const native = createBinding(store, { slotId: nativeSlot.id, kind: 'native', runtimeKind: 'claude-code' })
    assertStoreError(() => createAgentSession(store, { bindingId: native.id, workdir: '/tmp/w' }), 'INVALID_INPUT')
  })
})

test('validation：未知 slot/bot/room、非法 runtime/kind/status、room 不一致都拒绝', async () => {
  await withStore((store) => {
    const { bot, room } = fixture(store)
    const workspace2 = createWorkspace(store, {
      tenantId: 'acc_other',
      name: 'other',
      profileVersion: 'dev',
      createdAt: BASE,
    })
    const otherRoom = createRoom(store, { workspaceId: workspace2.id, name: 'other', createdAt: BASE })

    assertStoreError(() => createRoomSlot(store, { roomId: 'rm_missing' }), 'ROOM_NOT_FOUND')
    assertStoreError(() => createRoomSlot(store, { roomId: room.id, botId: 'bot_missing' }), 'BOT_NOT_FOUND')
    assertStoreError(
      () => createRoomSlot(store, { roomId: otherRoom.id, botId: bot.id }),
      'INVALID_INPUT',
    )
    assertStoreError(
      () => createRoomSlot(store, { roomId: room.id, runtimeKind: 'not-a-runtime' as never }),
      'INVALID_INPUT',
    )
    assertStoreError(() => createRoomSlot(store, { roomId: room.id, status: 'bogus' as never }), 'INVALID_INPUT')

    const slot = createRoomSlot(store, { roomId: room.id })
    assertStoreError(
      () => createBinding(store, { slotId: 'slot_missing', kind: 'native', runtimeKind: 'dsh' }),
      'ROOM_NOT_FOUND',
    )
    assertStoreError(
      () => createBinding(store, { slotId: slot.id, kind: 'bogus' as never, runtimeKind: 'dsh' }),
      'INVALID_INPUT',
    )
    assertStoreError(
      () => createBinding(store, { slotId: slot.id, kind: 'native', runtimeKind: 'bogus' as never }),
      'INVALID_INPUT',
    )
    assertStoreError(
      () => createBinding(store, { slotId: slot.id, kind: 'native', runtimeKind: 'dsh', roomId: otherRoom.id }),
      'INVALID_INPUT',
    )
    const binding = createBinding(store, { slotId: slot.id, kind: 'native', runtimeKind: 'dsh' })
    assertStoreError(() => closeBinding(store, 'bind_missing'), 'INVALID_INPUT')
    assertStoreError(
      () => closeAgentSession(store, 'sess_missing'),
      'INVALID_INPUT',
    )
    closeBinding(store, binding.id)
    assert.equal(closeBinding(store, binding.id).state, 'closed') // close 幂等
  })
})

test('常量与设计一致', () => {
  assert.deepEqual([...SLOT_STATUSES], ['open', 'bound', 'closed'])
  assert.deepEqual([...BINDING_KINDS], ['native', 'embedded'])
  assert.deepEqual([...BINDING_STATES], ['active', 'closed', 'interrupted', 'failed'])
  assert.deepEqual([...SESSION_STATUSES], ['starting', 'running', 'exited', 'failed', 'closed'])
})
