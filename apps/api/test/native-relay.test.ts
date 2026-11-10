// Native Relay PoC: an external session polls assignments for a native-bound Bot
// and advances the slot using the user's Bearer session.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pairDevice, startSqliteHarness } from './helpers.ts'

test('native binding can poll assignments and advance a round', async () => {
  const harness = await startSqliteHarness()
  try {
    const token = await pairDevice(harness)
    const workspace = await harness.call('POST', '/api/workspaces', { token, body: { name: 'native-relay' } })
    assert.equal(workspace.status, 201, workspace.text)
    const workspaceId = workspace.json.workspace.id as string

    const bot = await harness.call('POST', '/api/bots', {
      token,
      body: { workspaceId, name: 'NativeBot', model: 'deepseek-chat', runtimeKind: 'claude-code' },
    })
    assert.equal(bot.status, 201, bot.text)
    const botId = bot.json.bot.id as string

    const room = await harness.call('POST', '/api/rooms', { token, body: { workspaceId, name: 'NativeRoom' } })
    assert.equal(room.status, 201, room.text)
    const roomId = room.json.room.id as string

    const added = await harness.call('POST', `/api/rooms/${roomId}/members`, { token, body: { botIds: [botId] } })
    assert.equal(added.status, 200, added.text)

    const slot = await harness.call('POST', `/api/rooms/${roomId}/slots`, {
      token,
      body: { botId, runtimeKind: 'claude-code' },
    })
    assert.equal(slot.status, 201, slot.text)
    const slotId = slot.json.slot.id as string

    const binding = await harness.call('POST', `/api/rooms/${roomId}/slots/${slotId}/bindings`, {
      token,
      body: { kind: 'native', runtimeKind: 'claude-code', externalId: 'claude-desktop-test', state: 'active' },
    })
    assert.equal(binding.status, 201, binding.text)

    const message = await harness.call('POST', `/api/rooms/${roomId}/messages`, {
      token,
      body: { text: 'Native，请回复。' },
    })
    assert.equal(message.status, 201, message.text)

    const assignments = await harness.call('GET', `/api/native/assignments?roomId=${roomId}&botId=${botId}`, { token })
    assert.equal(assignments.status, 200, assignments.text)
    assert.equal(assignments.json.assignments.length, 1)
    const assignment = assignments.json.assignments[0]
    assert.equal(assignment.botId, botId)

    const advanced = await harness.call('POST', '/api/native/advance', {
      token,
      body: {
        roomId,
        roundId: assignment.roundId,
        botId,
        slotIndex: assignment.index,
        result: { kind: 'posted', text: '来自原生会话的回答' },
      },
    })
    assert.equal(advanced.status, 200, advanced.text)

    const messages = await harness.call('GET', `/api/rooms/${roomId}/messages`, { token })
    assert.equal(messages.status, 200)
    assert.ok(messages.json.messages.some((item: { text: string }) => item.text === '来自原生会话的回答'))
  } finally {
    await harness.close()
  }
})
