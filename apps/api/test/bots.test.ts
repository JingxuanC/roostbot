// Bot 用户侧 API：真 SQLite（store-adapter）+ 真 HTTP。
// 覆盖：鉴权、模型必填、非法名、重名、PATCH、软删（DELETE）、恢复（POST /:id/restore）、
// 删除后不能进房、bot.* 事件落库、Origin、no-store。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { BOT_SOFT_DELETE_WINDOW_MS, openStore, readEvents } from '../../../packages/store/src/index.ts'
import { startServer } from '../src/server.ts'
import { createStorePort } from '../src/store-adapter.ts'

interface Ctx {
  base: string
  store: ReturnType<typeof openStore>
  close: () => Promise<void>
}

async function withApi(fn: (ctx: Ctx) => Promise<void>, options: { now?: () => number; rawStore?: boolean } = {}): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'roost-api-bots-'))
  const store = openStore(join(dir, 'workspace.db'))
  const { url, close } = await startServer({
    store: createStorePort(store),
    ...(options.rawStore === true ? { rawStore: store } : {}),
    port: 0,
    host: '127.0.0.1',
    ...(options.now === undefined ? {} : { now: options.now })
  })
  try {
    await fn({ base: url, store, close })
  } finally {
    await close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function call(
  base: string,
  method: string,
  path: string,
  options: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  return fetch(`${base}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
}

async function pair(base: string, accountId = 'acc_bots'): Promise<string> {
  const codeRes = await call(base, 'POST', '/api/pairing/code', { body: { accountId } })
  const { code } = (await codeRes.json()) as { code: string }
  const claimRes = await call(base, 'POST', '/api/pairing/claim', { body: { code } })
  return ((await claimRes.json()) as { sessionToken: string }).sessionToken
}

async function pairWithWorkspace(base: string, accountId = 'acc_bots'): Promise<{ token: string; workspaceId: string }> {
  const token = await pair(base, accountId)
  const res = await call(base, 'POST', '/api/workspaces', { token, body: { name: '量化研究组' } })
  const { workspace } = (await res.json()) as { workspace: { id: string } }
  return { token, workspaceId: workspace.id }
}

async function createBot(
  base: string,
  token: string,
  workspaceId: string,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; name: string; model: string; provider: string; status: string }> {
  const res = await call(base, 'POST', '/api/bots', {
    token,
    body: { workspaceId, name, model: 'deepseek-v3', ...extra },
  })
  const text = await res.text()
  assert.equal(res.status, 201, `create bot failed: ${res.status} ${text}`)
  return (JSON.parse(text) as { bot: { id: string; name: string; model: string; provider: string; status: string } }).bot
}

test('Bot 接口都要 Bearer 会话', async () => {
  await withApi(async ({ base }) => {
    for (const [method, path] of [
      ['GET', '/api/bots'],
      ['POST', '/api/bots'],
      ['GET', '/api/bots/bot_x'],
      ['PATCH', '/api/bots/bot_x'],
      ['DELETE', '/api/bots/bot_x'],
      ['POST', '/api/bots/bot_x/restore'],
    ] as const) {
      const res = await call(base, method, path, method === 'GET' ? {} : { body: {} })
      assert.equal(res.status, 401, `${method} ${path}`)
    }
  })
})

test('创建 Bot：默认值、列表、详情', async () => {
  await withApi(async ({ base }) => {
    const { token, workspaceId } = await pairWithWorkspace(base)
    const bot = await createBot(base, token, workspaceId, '研究员', { role: '数据', persona: '谨慎。' })
    assert.equal(bot.name, '研究员')
    assert.equal(bot.model, 'deepseek-v3')
    assert.equal(bot.provider, 'deepseek-official')
    assert.equal(bot.status, 'active')

    const listed = await call(base, 'GET', `/api/bots?workspaceId=${workspaceId}`, { token })
    assert.equal(listed.status, 200)
    const listBody = (await listed.json()) as { bots: Array<{ id: string; name: string }> }
    assert.deepEqual(listBody.bots.map((row) => row.name), ['研究员'])
    assert.equal(listed.headers.get('cache-control'), 'no-store')

    const detail = await call(base, 'GET', `/api/bots/${bot.id}`, { token })
    assert.equal(detail.status, 200)
    const detailBody = (await detail.json()) as { bot: { id: string; role: string; persona: string } }
    assert.equal(detailBody.bot.id, bot.id)
    assert.equal(detailBody.bot.role, '数据')

    const missing = await call(base, 'GET', '/api/bots/bot_missing', { token })
    assert.equal(missing.status, 404)
    assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'bot.not_found')
  })
})

test('创建 Bot：模型必填 → bot.no_model；非法名 → bot.invalid；重名 → bot.name_taken', async () => {
  await withApi(async ({ base }) => {
    const { token, workspaceId } = await pairWithWorkspace(base)

    const noModel = await call(base, 'POST', '/api/bots', { token, body: { workspaceId, name: '没有模型' } })
    assert.equal(noModel.status, 400)
    assert.equal(((await noModel.json()) as { error: { code: string } }).error.code, 'bot.no_model')

    for (const name of ['', 'x'.repeat(41), 'a/b']) {
      const res = await call(base, 'POST', '/api/bots', {
        token,
        body: { workspaceId, name, model: 'deepseek-v3' },
      })
      assert.equal(res.status, 400, `name ${JSON.stringify(name)}`)
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'bot.invalid')
    }

    await createBot(base, token, workspaceId, '研究员')
    const duplicate = await call(base, 'POST', '/api/bots', {
      token,
      body: { workspaceId, name: '研究员', model: 'deepseek-v3' },
    })
    assert.equal(duplicate.status, 409)
    assert.equal(((await duplicate.json()) as { error: { code: string } }).error.code, 'bot.name_taken')
  })
})

test('PATCH：人设变化写 bot_versions；改名冲突；非法审批值', async () => {
  await withApi(async ({ base, store }) => {
    const { token, workspaceId } = await pairWithWorkspace(base)
    const a = await createBot(base, token, workspaceId, 'A', { persona: '旧人设' })
    const b = await createBot(base, token, workspaceId, 'B')

    const patched = await call(base, 'PATCH', `/api/bots/${a.id}`, {
      token,
      body: { persona: '新人设', role: '研究' },
    })
    assert.equal(patched.status, 200)
    assert.equal(((await patched.json()) as { bot: { persona: string; role: string } }).bot.persona, '新人设')

    const versions = store.db
      .prepare('SELECT value, actor FROM bot_versions WHERE bot_id = ? ORDER BY created_at, id')
      .all(a.id) as Array<{ value: string; actor: string }>
    assert.deepEqual(versions.map((row) => row.value), ['旧人设', '新人设'])
    assert.equal(versions[1]!.actor, 'acc_bots')

    const conflict = await call(base, 'PATCH', `/api/bots/${b.id}`, { token, body: { name: 'A' } })
    assert.equal(conflict.status, 409)
    assert.equal(((await conflict.json()) as { error: { code: string } }).error.code, 'bot.name_taken')

    const badApproval = await call(base, 'PATCH', `/api/bots/${b.id}`, { token, body: { approval: 'nope' } })
    assert.equal(badApproval.status, 400)
    assert.equal(((await badApproval.json()) as { error: { code: string } }).error.code, 'bot.invalid')
  })
})

test('DELETE 是软删：404、名字仍占用、退出房间、不能进房、事件落库；restore 恢复', async () => {
  await withApi(async ({ base, store }) => {
    const { token, workspaceId } = await pairWithWorkspace(base)
    const a = await createBot(base, token, workspaceId, 'A')
    const b = await createBot(base, token, workspaceId, 'B')
    const doomed = await createBot(base, token, workspaceId, '要删的')

    // 先把它拉进一个房间，删除时应该自动退出。
    const roomRes = await call(base, 'POST', '/api/rooms', {
      token,
      body: { workspaceId, memberBotIds: [a.id, doomed.id], hostBotId: a.id },
    })
    assert.equal(roomRes.status, 201)
    const room = ((await roomRes.json()) as { room: { id: string } }).room

    const deleted = await call(base, 'DELETE', `/api/bots/${doomed.id}`, { token })
    assert.equal(deleted.status, 200)
    assert.deepEqual(await deleted.json(), { ok: true })

    // 软删后详情 404、列表不含。
    const gone = await call(base, 'GET', `/api/bots/${doomed.id}`, { token })
    assert.equal(gone.status, 404)
    const listed = await call(base, 'GET', `/api/bots?workspaceId=${workspaceId}`, { token })
    assert.deepEqual(
      ((await listed.json()) as { bots: Array<{ name: string }> }).bots.map((row) => row.name),
      ['A', 'B'],
    )

    // 软删期间名字仍被占用（恢复窗口内身份完整保留）。
    const reuse = await call(base, 'POST', '/api/bots', {
      token,
      body: { workspaceId, name: '要删的', model: 'deepseek-v3' },
    })
    assert.equal(reuse.status, 409)
    assert.equal(((await reuse.json()) as { error: { code: string } }).error.code, 'bot.name_taken')

    // 房间成员里已没有它；也不能再被拉进房间。
    const roomDetail = await call(base, 'GET', `/api/rooms/${room.id}`, { token })
    const members = ((await roomDetail.json()) as { room: { members: Array<{ botId: string }> } }).room.members
    assert.deepEqual(members.map((member) => member.botId), [a.id])
    const add = await call(base, 'POST', `/api/rooms/${room.id}/members`, { token, body: { botIds: [doomed.id] } })
    assert.equal(add.status, 400)
    assert.equal(((await add.json()) as { error: { code: string } }).error.code, 'room.members')

    // 事件落库：bot.created ×3、bot.removed_from_room（房间级）、bot.deleted（workspace 级）。
    const botEvents = readEvents(store, { domain: 'bot' })
    assert.deepEqual(
      botEvents.map((event) => event.kind),
      ['bot.created', 'bot.created', 'bot.created', 'bot.removed_from_room', 'bot.deleted'],
    )
    const removed = botEvents.find((event) => event.kind === 'bot.removed_from_room')
    assert.equal(removed?.audience, `room:${room.id}`)
    assert.deepEqual(removed?.subject, { kind: 'bot', id: doomed.id })
    const deletedEvent = botEvents.find((event) => event.kind === 'bot.deleted')
    assert.equal(deletedEvent?.audience, 'team')
    assert.deepEqual(deletedEvent?.subject, { kind: 'bot', id: doomed.id })

    // 7 天内恢复：200，详情可读，可以重新进房，写 bot.restored。
    const restored = await call(base, 'POST', `/api/bots/${doomed.id}/restore`, { token, body: {} })
    assert.equal(restored.status, 200)
    assert.equal(((await restored.json()) as { bot: { id: string; name: string } }).bot.name, '要删的')

    const back = await call(base, 'GET', `/api/bots/${doomed.id}`, { token })
    assert.equal(back.status, 200)

    const readd = await call(base, 'POST', `/api/rooms/${room.id}/members`, { token, body: { botIds: [doomed.id] } })
    assert.equal(readd.status, 200)

    const kinds = readEvents(store, { domain: 'bot' }).map((event) => event.kind)
    assert.ok(kinds.includes('bot.restored'), `expected bot.restored in ${kinds.join(',')}`)

    // 不存在的 Bot restore → 404。
    const missing = await call(base, 'POST', '/api/bots/bot_missing/restore', { token, body: {} })
    assert.equal(missing.status, 404)
    assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'bot.not_found')
  })
})

test('恢复窗口：软删超过 7 天 restore → 409 bot.restore_expired', async () => {
  const BASE = 1_760_000_000_000
  let now = BASE
  await withApi(
    async ({ base }) => {
      const { token, workspaceId } = await pairWithWorkspace(base)
      const bot = await createBot(base, token, workspaceId, '救不回来的')

      await call(base, 'DELETE', `/api/bots/${bot.id}`, { token })

      // 恰好 7 天：仍可恢复。
      now = BASE + BOT_SOFT_DELETE_WINDOW_MS
      const edge = await call(base, 'POST', `/api/bots/${bot.id}/restore`, { token, body: {} })
      assert.equal(edge.status, 200)

      // 再删一次并越过窗口：409。
      await call(base, 'DELETE', `/api/bots/${bot.id}`, { token })
      now = BASE + BOT_SOFT_DELETE_WINDOW_MS * 2 + 1
      const expired = await call(base, 'POST', `/api/bots/${bot.id}/restore`, { token, body: {} })
      assert.equal(expired.status, 409)
      assert.equal(((await expired.json()) as { error: { code: string } }).error.code, 'bot.restore_expired')
    },
    { now: () => now },
  )
})

test('写操作 Origin 校验：非回环 Origin 被拒；响应都是 no-store', async () => {
  await withApi(async ({ base }) => {
    const { token, workspaceId } = await pairWithWorkspace(base)

    const evil = await call(base, 'POST', '/api/bots', {
      token,
      headers: { origin: 'http://evil.example' },
      body: { workspaceId, name: '坏的', model: 'deepseek-v3' },
    })
    assert.equal(evil.status, 403)
    assert.equal(((await evil.json()) as { error: { code: string } }).error.code, 'forbidden_origin')

    const loopback = await call(base, 'POST', '/api/bots', {
      token,
      headers: { origin: 'http://127.0.0.1:8787' },
      body: { workspaceId, name: '好的', model: 'deepseek-v3' },
    })
    assert.equal(loopback.status, 201)
    assert.equal(loopback.headers.get('cache-control'), 'no-store')
  })
})

test('跨账号不能读别人的 Bot（当作不存在）', async () => {
  await withApi(async ({ base }) => {
    const mine = await pairWithWorkspace(base, 'acc_mine')
    const other = await pairWithWorkspace(base, 'acc_other')
    const bot = await createBot(base, mine.token, mine.workspaceId, '私有 Bot')

    const res = await call(base, 'GET', `/api/bots/${bot.id}`, { token: other.token })
    assert.equal(res.status, 404)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'bot.not_found')

    const list = await call(base, 'GET', '/api/bots', { token: other.token })
    assert.deepEqual(((await list.json()) as { bots: unknown[] }).bots, [])
  })
})

test('POST /api/bots/:id/dm 返回可复用的私聊房间', async () => {
  await withApi(async ({ base }) => {
    const { token, workspaceId } = await pairWithWorkspace(base)
    const bot = await createBot(base, token, workspaceId, '私聊对象')
    const first = await call(base, 'POST', `/api/bots/${bot.id}/dm`, { token, body: {} })
    const firstText = await first.text()
    assert.equal(first.status, 200, firstText)
    const firstBody = JSON.parse(firstText) as { room: { id: string; dm: boolean; members: Array<{ botId: string }> } }
    assert.equal(firstBody.room.dm, true)
    assert.equal(firstBody.room.members[0]?.botId, bot.id)

    const second = await call(base, 'POST', `/api/bots/${bot.id}/dm`, { token, body: {} })
    assert.equal(second.status, 200)
    const secondBody = (await second.json()) as { room: { id: string } }
    assert.equal(secondBody.room.id, firstBody.room.id)
  }, { rawStore: true })
})