import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import { createStorePort } from '../src/store-adapter.ts'
import { startServer } from '../src/server.ts'

async function pair(base: string, accountId: string): Promise<{ token: string; workspaceId: string }> {
  const code = ((await (await fetch(`${base}/api/pairing/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId }),
  })).json()) as { code: string }).code
  const token = ((await (await fetch(`${base}/api/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })).json()) as { sessionToken: string }).sessionToken
  const workspace = ((await (await fetch(`${base}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: accountId }),
  })).json()) as { workspace: { id: string } }).workspace
  return { token, workspaceId: workspace.id }
}

test('CRUD：默认 Asia/Shanghai；别的租户 403；静默运行不发消息', async () => {
  const rawStore = openStore(':memory:')
  const started = await startServer({
    store: createStorePort(rawStore),
    rawStore,
    port: 0,
    host: '127.0.0.1',
    runtimeToken: 'rt_routines_0123456789',
    routineRunner: async () => ({ text: null }),
  })
  try {
    const owner = await pair(started.url, 'acc_routine_owner')
    const stranger = await pair(started.url, 'acc_routine_stranger')
    const auth = { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' }
    const bot = ((await (await fetch(`${started.url}/api/bots`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ workspaceId: owner.workspaceId, name: '数据官', model: 'deepseek-v3' }),
    })).json()) as { bot: { id: string } }).bot
    const peer = ((await (await fetch(`${started.url}/api/bots`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ workspaceId: owner.workspaceId, name: '风控官', model: 'deepseek-v3' }),
    })).json()) as { bot: { id: string } }).bot
    const room = ((await (await fetch(`${started.url}/api/rooms`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ workspaceId: owner.workspaceId, name: '研究', memberBotIds: [bot.id, peer.id], hostBotId: bot.id }),
    })).json()) as { room: { id: string } }).room

    const created = await fetch(`${started.url}/api/workspaces/${owner.workspaceId}/routines`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: '盘前', cron: 'daily 09:00', prompt: '只报告异动', botId: bot.id, roomId: room.id }),
    })
    assert.equal(created.status, 201, await created.clone().text())
    const routine = ((await created.json()) as { routine: { id: string; timezone: string } }).routine
    assert.equal(routine.timezone, 'Asia/Shanghai')

    const denied = await fetch(`${started.url}/api/workspaces/${owner.workspaceId}/routines`, {
      headers: { authorization: `Bearer ${stranger.token}` },
    })
    assert.equal(denied.status, 403)

    const ran = await fetch(`${started.url}/api/routines/${routine.id}/run`, { method: 'POST', headers: auth, body: '{}' })
    assert.equal(ran.status, 202, await ran.clone().text())
    const runBody = (await ran.json()) as { run: { status: string } }
    assert.equal(runBody.run.status, 'silent')

    const messages = await fetch(`${started.url}/api/rooms/${room.id}/messages`, { headers: { authorization: `Bearer ${owner.token}` } })
    const body = (await messages.json()) as { messages: Array<{ text: string }> }
    assert.ok(!body.messages.some((message) => message.text === '只报告异动'))
  } finally {
    await started.close()
    rawStore.close()
  }
})
