// 内部轮次接口：runtime token 鉴权、assignments、advance 的错误码。

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import { createBot } from '../../../packages/store/src/bots.ts'
import { createRoomExt } from '../../../packages/store/src/rooms-ext.ts'
import { createWorkspace } from '../../../packages/store/src/workspaces.ts'
import { getRoom, sendMessage } from '../../../packages/store/src/rooms.ts'
import { openRoundForMessage } from '../src/round-orchestrator.ts'
import { handleInternalAdvance, handleInternalAssignments, handleInternalRound } from '../src/rounds-http.ts'

const TOKEN = 'rt_test_123'
const AT = 1_760_000_000_000

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-rounds-http-'))
  const store = openStore(join(dir, 'workspace.db'))
  const workspace = createWorkspace(store, { tenantId: 't', name: 'W', profileVersion: 'dev', createdAt: AT })
  const bot = createBot(store, { workspaceId: workspace.id, name: '研究员', model: 'deepseek-chat', createdBy: 'acc_1' })
  const created = createRoomExt(store, { workspaceId: workspace.id, memberBotIds: [bot.id], hostBotId: bot.id, responder: { kind: 'member', botId: bot.id }, createdBy: 'acc_1' })
  const room = getRoom(store, created.room.id)
  assert.ok(room !== null)
  const sent = sendMessage(store, { roomId: room.id, text: '看下盘面', actor: { kind: 'user', id: 'acc_1' } })
  const round = openRoundForMessage({ store, room, seq: sent.seq, text: '看下盘面', at: AT })
  assert.ok(round !== null)

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local')
    const ctx = { store, runtimeToken: TOKEN }
    const roomMatch = /^\/rooms\/([^/]+)\/assignments$/.exec(url.pathname)
    const roundMatch = /^\/rooms\/([^/]+)\/round$/.exec(url.pathname)
    const advanceMatch = /^\/rounds\/([^/]+)\/advance$/.exec(url.pathname)
    if (roomMatch !== null) return void handleInternalAssignments(ctx, req, res, decodeURIComponent(roomMatch[1]!))
    if (roundMatch !== null) return void handleInternalRound(ctx, req, res, decodeURIComponent(roundMatch[1]!))
    if (advanceMatch !== null) return void handleInternalAdvance(ctx, req, res, decodeURIComponent(advanceMatch[1]!))
    res.writeHead(404).end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    store,
    room,
    round,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('没有 runtime token：401', async () => {
  const ctx = await setup()
  try {
    const res = await fetch(`${ctx.base}/rooms/${ctx.room.id}/assignments`)
    assert.equal(res.status, 401)
  } finally {
    await ctx.close()
  }
})

test('assignments 返回本轮可投递的 slot', async () => {
  const ctx = await setup()
  try {
    const res = await fetch(`${ctx.base}/rooms/${ctx.room.id}/assignments`, { headers: { 'x-runtime-token': TOKEN } })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { assignments: Array<{ roundId: string; botId: string; prompt: string }> }
    assert.equal(body.assignments.length, 1)
    assert.equal(body.assignments[0].roundId, ctx.round.id)
    assert.match(body.assignments[0].prompt, /看下盘面/)
  } finally {
    await ctx.close()
  }
})

test('advance：posted 收轮；未知 round 404；坏 body 400', async () => {
  const ctx = await setup()
  try {
    const ok = await fetch(`${ctx.base}/rounds/${ctx.round.id}/advance`, {
      method: 'POST',
      headers: { 'x-runtime-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ slotIndex: 0, result: { kind: 'posted', text: '收到' } })
    })
    assert.equal(ok.status, 200)
    const outcome = (await ok.json()) as { round: { state: string }; next: number | null }
    assert.equal(outcome.round.state, 'done')
    assert.equal(outcome.next, null)

    const missing = await fetch(`${ctx.base}/rounds/rnd_missing/advance`, {
      method: 'POST',
      headers: { 'x-runtime-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ slotIndex: 0, result: { kind: 'passed' } })
    })
    assert.equal(missing.status, 404)

    const bad = await fetch(`${ctx.base}/rounds/${ctx.round.id}/advance`, {
      method: 'POST',
      headers: { 'x-runtime-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ slotIndex: 'x', result: {} })
    })
    assert.equal(bad.status, 400)
  } finally {
    await ctx.close()
  }
})
