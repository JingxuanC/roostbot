// Room slot / agent binding API（docs/design/agent-runtimes.md §10–§11）。
// 真 SQLite + store-adapter + 真 HTTP；覆盖鉴权/room 归属、slot CRUD、单 active
// binding（409）、close 幂等、room 事件落库。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readRoomEvents } from '../../../packages/store/src/index.ts'
import { pairDevice, startSqliteHarness } from './helpers.ts'
import type { Harness } from './helpers.ts'

interface Setup {
  harness: Harness
  token: string
  workspaceId: string
  botId: string
  roomId: string
}

async function pairAs(harness: Harness, accountId: string): Promise<string> {
  const code = await harness.call('POST', '/api/pairing/code', { body: { accountId } })
  assert.equal(code.status, 200, code.text)
  const claim = await harness.call('POST', '/api/pairing/claim', { body: { code: code.json.code } })
  assert.equal(claim.status, 200, claim.text)
  return claim.json.sessionToken as string
}

async function setup(): Promise<Setup> {
  const harness = await startSqliteHarness()
  const token = await pairDevice(harness)
  const workspace = await harness.call('POST', '/api/workspaces', { token, body: { name: 'runtime-api' } })
  assert.equal(workspace.status, 201, workspace.text)
  const workspaceId = workspace.json.workspace.id as string
  const bot = await harness.call('POST', '/api/bots', {
    token,
    body: { workspaceId, name: 'UZI研究官', model: 'deepseek-v3', runtimeKind: 'claude-code' },
  })
  assert.equal(bot.status, 201, bot.text)
  const room = await harness.call('POST', '/api/rooms', { token, body: { workspaceId, name: '运行时房间' } })
  assert.equal(room.status, 201, room.text)
  return { harness, token, workspaceId, botId: bot.json.bot.id as string, roomId: room.json.room.id as string }
}

test('slots/bindings API 都要 Bearer；非房间成员 403；未知房间 404', async () => {
  const ctx = await setup()
  try {
    const noAuth = await ctx.harness.call('GET', `/api/rooms/${ctx.roomId}/slots`)
    assert.equal(noAuth.status, 401)

    const outsiderToken = await pairAs(ctx.harness, 'acc_runtime_outsider')
    const outsider = await ctx.harness.call('GET', `/api/rooms/${ctx.roomId}/slots`, { token: outsiderToken })
    assert.equal(outsider.status, 403)
    assert.equal(outsider.json.error.code, 'forbidden')

    const missing = await ctx.harness.call('GET', '/api/rooms/rm_missing/slots', { token: ctx.token })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.code, 'room_not_found')
  } finally {
    await ctx.harness.close()
  }
})

test('slot CRUD：创建/列表/详情/PATCH/DELETE；closed 仍可读', async () => {
  const ctx = await setup()
  try {
    const created = await ctx.harness.call('POST', `/api/rooms/${ctx.roomId}/slots`, {
      token: ctx.token,
      body: { botId: ctx.botId, runtimeKind: 'claude-code' },
    })
    assert.equal(created.status, 201, created.text)
    const slot = created.json.slot as { id: string; botId: string; runtimeKind: string; status: string }
    assert.equal(slot.status, 'open')
    assert.equal(slot.runtimeKind, 'claude-code')
    assert.equal(slot.botId, ctx.botId)

    const listed = await ctx.harness.call('GET', `/api/rooms/${ctx.roomId}/slots`, { token: ctx.token })
    assert.equal(listed.status, 200)
    assert.equal(listed.json.slots.length, 1)
    assert.deepEqual(listed.json.bindings, [])

    const detail = await ctx.harness.call('GET', `/api/rooms/${ctx.roomId}/slots/${slot.id}`, { token: ctx.token })
    assert.equal(detail.status, 200)
    assert.equal(detail.json.slot.id, slot.id)
    assert.deepEqual(detail.json.bindings, [])
    assert.deepEqual(detail.json.sessions, [])

    const patched = await ctx.harness.call('PATCH', `/api/rooms/${ctx.roomId}/slots/${slot.id}`, {
      token: ctx.token,
      body: { runtimeKind: 'codex', status: 'bound' },
    })
    assert.equal(patched.status, 200, patched.text)
    assert.equal(patched.json.slot.runtimeKind, 'codex')
    assert.equal(patched.json.slot.status, 'bound')

    const deleted = await ctx.harness.call('DELETE', `/api/rooms/${ctx.roomId}/slots/${slot.id}`, { token: ctx.token })
    assert.equal(deleted.status, 200)
    assert.equal(deleted.json.slot.status, 'closed')

    const after = await ctx.harness.call('GET', `/api/rooms/${ctx.roomId}/slots/${slot.id}`, { token: ctx.token })
    assert.equal(after.status, 200)
    assert.equal(after.json.slot.status, 'closed')
  } finally {
    await ctx.harness.close()
  }
})

test('binding 生命周期：一个 active、409 冲突、close 幂等、下一代 generation', async () => {
  const ctx = await setup()
  try {
    const slotRes = await ctx.harness.call('POST', `/api/rooms/${ctx.roomId}/slots`, {
      token: ctx.token,
      body: { botId: ctx.botId },
    })
    const slotId = slotRes.json.slot.id as string

    const created = await ctx.harness.call('POST', `/api/rooms/${ctx.roomId}/slots/${slotId}/bindings`, {
      token: ctx.token,
      body: { kind: 'embedded', runtimeKind: 'dsh', externalId: 'dsh_session_1' },
    })
    assert.equal(created.status, 201, created.text)
    const binding = created.json.binding as { id: string; state: string; generation: number; kind: string }
    assert.equal(binding.state, 'active')
    assert.equal(binding.kind, 'embedded')
    assert.equal(binding.generation, 1)

    const conflict = await ctx.harness.call('POST', `/api/rooms/${ctx.roomId}/slots/${slotId}/bindings`, {
      token: ctx.token,
      body: { kind: 'native', runtimeKind: 'dsh' },
    })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.json.error.code, 'binding.active_exists')

    const detail = await ctx.harness.call('GET', `/api/rooms/${ctx.roomId}/slots/${slotId}`, { token: ctx.token })
    assert.equal(detail.status, 200)
    assert.equal(detail.json.bindings.length, 1)
    assert.equal(detail.json.slot.status, 'bound')

    const closed = await ctx.harness.call('POST', `/api/bindings/${binding.id}/close`, {
      token: ctx.token,
      body: { state: 'closed' },
    })
    assert.equal(closed.status, 200, closed.text)
    assert.equal(closed.json.binding.state, 'closed')

    const closedAgain = await ctx.harness.call('POST', `/api/bindings/${binding.id}/close`, { token: ctx.token })
    assert.equal(closedAgain.status, 200)
    assert.equal(closedAgain.json.binding.state, 'closed')

    const second = await ctx.harness.call('POST', `/api/rooms/${ctx.roomId}/slots/${slotId}/bindings`, {
      token: ctx.token,
      body: { kind: 'native', runtimeKind: 'claude-code' },
    })
    assert.equal(second.status, 201, second.text)
    assert.equal(second.json.binding.generation, 2)
  } finally {
    await ctx.harness.close()
  }
})

test('非法输入：runtimeKind/kind/status、未知 slot/binding、跨账号 close', async () => {
  const ctx = await setup()
  try {
    const badRuntime = await ctx.harness.call('POST', `/api/rooms/${ctx.roomId}/slots`, {
      token: ctx.token,
      body: { runtimeKind: 'bogus' },
    })
    assert.equal(badRuntime.status, 400)
    assert.equal(badRuntime.json.error.code, 'agent_binding.invalid')

    const slotRes = await ctx.harness.call('POST', `/api/rooms/${ctx.roomId}/slots`, { token: ctx.token, body: {} })
    const slotId = slotRes.json.slot.id as string

    for (const body of [{ kind: 'bogus', runtimeKind: 'dsh' }, { kind: 'native', runtimeKind: 'bogus' }]) {
      const response = await ctx.harness.call('POST', `/api/rooms/${ctx.roomId}/slots/${slotId}/bindings`, {
        token: ctx.token,
        body,
      })
      assert.equal(response.status, 400, response.text)
      assert.equal(response.json.error.code, 'agent_binding.invalid')
    }

    const missingSlot = await ctx.harness.call('GET', `/api/rooms/${ctx.roomId}/slots/slot_missing`, { token: ctx.token })
    assert.equal(missingSlot.status, 404)
    assert.equal(missingSlot.json.error.code, 'slot_not_found')

    const missingClose = await ctx.harness.call('POST', '/api/bindings/bind_missing/close', {
      token: ctx.token,
      body: {},
    })
    assert.equal(missingClose.status, 404)
    assert.equal(missingClose.json.error.code, 'binding_not_found')

    const created = await ctx.harness.call('POST', `/api/rooms/${ctx.roomId}/slots/${slotId}/bindings`, {
      token: ctx.token,
      body: { kind: 'native', runtimeKind: 'dsh' },
    })
    const outsider = await pairAs(ctx.harness, 'acc_runtime_outsider')
    const denied = await ctx.harness.call('POST', `/api/bindings/${created.json.binding.id}/close`, {
      token: outsider,
      body: {},
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.json.error.code, 'forbidden')
  } finally {
    await ctx.harness.close()
  }
})

test('slot/binding 变更写 room 级 agent 事件', async () => {
  const ctx = await setup()
  try {
    const slotRes = await ctx.harness.call('POST', `/api/rooms/${ctx.roomId}/slots`, {
      token: ctx.token,
      body: { botId: ctx.botId },
    })
    const slotId = slotRes.json.slot.id as string
    const bindingRes = await ctx.harness.call('POST', `/api/rooms/${ctx.roomId}/slots/${slotId}/bindings`, {
      token: ctx.token,
      body: { kind: 'embedded', runtimeKind: 'dsh' },
    })
    const bindingId = bindingRes.json.binding.id as string
    await ctx.harness.call('POST', `/api/bindings/${bindingId}/close`, { token: ctx.token, body: {} })

    const store = ctx.harness.rawStore
    assert.ok(store)
    const events = readRoomEvents(store, { roomId: ctx.roomId })
    const kinds = events.map((event) => event.kind)
    assert.ok(kinds.includes('agent.slot.created'), `missing slot event: ${kinds.join(',')}`)
    assert.ok(kinds.includes('agent.binding.created'), `missing binding event: ${kinds.join(',')}`)
    assert.ok(kinds.includes('agent.binding.closed'), `missing close event: ${kinds.join(',')}`)
    const slotEvent = events.find((event) => event.kind === 'agent.slot.created')
    assert.equal(slotEvent?.audience, `room:${ctx.roomId}`)
    assert.equal(slotEvent?.domain, 'agent')
  } finally {
    await ctx.harness.close()
  }
})
