// 房间 M4 API：建群规则、成员、host、responder、GET 详情（真 SQLite adapter）。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import { startServer } from '../src/server.ts'
import { createStorePort } from '../src/store-adapter.ts'

interface Ctx {
  base: string
  store: ReturnType<typeof openStore>
  close: () => Promise<void>
}

async function withApi(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'roost-api-rooms-'))
  const store = openStore(join(dir, 'workspace.db'))
  const { url, close } = await startServer({
    store: createStorePort(store),
    port: 0,
    host: '127.0.0.1'
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

async function pairWithWorkspace(
  base: string,
  accountId = 'acc_rooms_ext',
  name = '量化研究组',
): Promise<{ token: string; workspaceId: string }> {
  const codeRes = await call(base, 'POST', '/api/pairing/code', { body: { accountId } })
  const { code } = (await codeRes.json()) as { code: string }
  const claimRes = await call(base, 'POST', '/api/pairing/claim', { body: { code } })
  const token = ((await claimRes.json()) as { sessionToken: string }).sessionToken
  const wsRes = await call(base, 'POST', '/api/workspaces', { token, body: { name } })
  const workspaceId = ((await wsRes.json()) as { workspace: { id: string } }).workspace.id
  return { token, workspaceId }
}

async function createBot(base: string, token: string, workspaceId: string, name: string): Promise<string> {
  const res = await call(base, 'POST', '/api/bots', {
    token,
    body: { workspaceId, name, model: 'deepseek-v3' },
  })
  const text = await res.text()
  assert.equal(res.status, 201, `create bot failed: ${text}`)
  return (JSON.parse(text) as { bot: { id: string } }).bot.id
}

interface RoomBody {
  room: {
    id: string
    name: string
    members: Array<{ botId: string; role: string; name?: string }>
    responder: { kind: string; botId?: string }
    hostBotId?: string
    notice?: string
    purpose?: string
    replyMode: string
  }
}

test('建群：≥2 个 Bot、自动命名、host/responder/notice/purpose；GET 列表与详情带 members', async () => {
  await withApi(async ({ base }) => {
    const { token, workspaceId } = await pairWithWorkspace(base)
    const a = await createBot(base, token, workspaceId, '研究员')
    const b = await createBot(base, token, workspaceId, '评审员')

    const created = await call(base, 'POST', '/api/rooms', {
      token,
      body: {
        workspaceId,
        memberBotIds: [a, b],
        hostBotId: a,
        notice: '先说结论。',
        purpose: '盘前讨论',
      },
    })
    const createdText = await created.text()
    assert.equal(created.status, 201, createdText)
    const room = (JSON.parse(createdText) as RoomBody).room
    assert.equal(room.name, '研究员、评审员')
    assert.equal(room.members.length, 2)
    assert.deepEqual(
      room.members.map((member) => [member.name, member.role]),
      [
        ['研究员', 'host'],
        ['评审员', 'member'],
      ],
    )
    assert.deepEqual(room.responder, { kind: 'member', botId: a })
    assert.equal(room.hostBotId, a)
    assert.equal(room.notice, '先说结论。')
    assert.equal(room.purpose, '盘前讨论')
    assert.equal(created.headers.get('cache-control'), 'no-store')

    const listed = await call(base, 'GET', `/api/rooms?workspaceId=${workspaceId}`, { token })
    const listBody = (await listed.json()) as { rooms: RoomBody['room'][] }
    assert.equal(listBody.rooms.length, 1)
    assert.equal(listBody.rooms[0]!.id, room.id)
    assert.equal(listBody.rooms[0]!.members.length, 2)

    const detail = await call(base, 'GET', `/api/rooms/${room.id}`, { token })
    assert.equal(detail.status, 200)
    const detailBody = (await detail.json()) as { room: RoomBody['room']; round: unknown }
    assert.equal(detailBody.room.members.length, 2)
    assert.deepEqual(detailBody.room.responder, { kind: 'member', botId: a })
    assert.equal(detailBody.round, null)

    const missing = await call(base, 'GET', '/api/rooms/rm_missing', { token })
    assert.equal(missing.status, 404)
    assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'room_not_found')
  })
})

test('建群：1 个 Bot / 空成员数组 / 跨 workspace 成员都被拒', async () => {
  await withApi(async ({ base }) => {
    const first = await pairWithWorkspace(base)
    const second = await pairWithWorkspace(base, 'acc_rooms_ext', '另一个组')
    const a = await createBot(base, first.token, first.workspaceId, 'A')
    const b = await createBot(base, first.token, first.workspaceId, 'B')
    const foreign = await createBot(base, second.token, second.workspaceId, '外组')

    const one = await call(base, 'POST', '/api/rooms', {
      token: first.token,
      body: { workspaceId: first.workspaceId, memberBotIds: [a] },
    })
    assert.equal(one.status, 400)
    assert.equal(((await one.json()) as { error: { code: string } }).error.code, 'room.members')

    const empty = await call(base, 'POST', '/api/rooms', {
      token: first.token,
      body: { workspaceId: first.workspaceId, memberBotIds: [] },
    })
    assert.equal(empty.status, 400)
    assert.equal(((await empty.json()) as { error: { code: string } }).error.code, 'room.members')

    const cross = await call(base, 'POST', '/api/rooms', {
      token: first.token,
      body: { workspaceId: first.workspaceId, memberBotIds: [a, foreign] },
    })
    assert.equal(cross.status, 400)
    assert.equal(((await cross.json()) as { error: { code: string } }).error.code, 'room.members')

    // host 不在成员里也是 room.members。
    const badHost = await call(base, 'POST', '/api/rooms', {
      token: first.token,
      body: { workspaceId: first.workspaceId, memberBotIds: [a, b], hostBotId: foreign },
    })
    assert.equal(badHost.status, 400)
    assert.equal(((await badHost.json()) as { error: { code: string } }).error.code, 'room.members')
  })
})

test('PATCH：name/notice/responder；responder 指向非成员 → room.responder', async () => {
  await withApi(async ({ base }) => {
    const { token, workspaceId } = await pairWithWorkspace(base)
    const a = await createBot(base, token, workspaceId, 'A')
    const b = await createBot(base, token, workspaceId, 'B')
    const outsider = await createBot(base, token, workspaceId, 'C')

    const room = (await (
      await call(base, 'POST', '/api/rooms', { token, body: { workspaceId, memberBotIds: [a, b] } })
    ).json() as RoomBody).room

    const patched = await call(base, 'PATCH', `/api/rooms/${room.id}`, {
      token,
      body: { name: '盘前小组', notice: '新公告', responder: { kind: 'everyone' } },
    })
    assert.equal(patched.status, 200)
    const patchedRoom = ((await patched.json()) as RoomBody).room
    assert.equal(patchedRoom.name, '盘前小组')
    assert.equal(patchedRoom.notice, '新公告')
    assert.deepEqual(patchedRoom.responder, { kind: 'everyone' })
    assert.equal(patchedRoom.replyMode, 'everyone')

    const bad = await call(base, 'PATCH', `/api/rooms/${room.id}`, {
      token,
      body: { responderBot: outsider },
    })
    assert.equal(bad.status, 400)
    assert.equal(((await bad.json()) as { error: { code: string } }).error.code, 'room.responder')

    const byBot = await call(base, 'PATCH', `/api/rooms/${room.id}`, {
      token,
      body: { responderBot: b },
    })
    assert.equal(byBot.status, 200)
    assert.deepEqual(((await byBot.json()) as RoomBody).room.responder, { kind: 'member', botId: b })

    // notice 可以清空。
    const cleared = await call(base, 'PATCH', `/api/rooms/${room.id}`, { token, body: { notice: null } })
    assert.equal(cleared.status, 200)
    assert.equal(((await cleared.json()) as RoomBody).room.notice, undefined)
  })
})

test('成员增删：POST members 加人；DELETE 移除 host 后自动换 host', async () => {
  await withApi(async ({ base }) => {
    const { token, workspaceId } = await pairWithWorkspace(base)
    const a = await createBot(base, token, workspaceId, 'A')
    const b = await createBot(base, token, workspaceId, 'B')
    const c = await createBot(base, token, workspaceId, 'C')

    const room = (await (
      await call(base, 'POST', '/api/rooms', { token, body: { workspaceId, memberBotIds: [a, b] } })
    ).json() as RoomBody).room

    const added = await call(base, 'POST', `/api/rooms/${room.id}/members`, { token, body: { botIds: [c] } })
    assert.equal(added.status, 200)
    assert.equal(((await added.json()) as RoomBody).room.members.length, 3)

    const removed = await call(base, 'DELETE', `/api/rooms/${room.id}/members/${a}`, { token })
    assert.equal(removed.status, 200)
    const after = ((await removed.json()) as RoomBody).room
    assert.deepEqual(after.members.map((member) => member.botId).sort(), [b, c].sort())
    assert.equal(after.members.find((member) => member.botId === b)?.role, 'host')
    assert.equal(after.hostBotId, b)

    const notMember = await call(base, 'DELETE', `/api/rooms/${room.id}/members/${a}`, { token })
    assert.equal(notMember.status, 404)
    assert.equal(((await notMember.json()) as { error: { code: string } }).error.code, 'room.members')
  })
})

test('兼容：不带 memberBotIds 的 POST /api/rooms 仍是空房间（v0 路径）', async () => {
  await withApi(async ({ base }) => {
    const { token, workspaceId } = await pairWithWorkspace(base)
    const res = await call(base, 'POST', '/api/rooms', { token, body: { workspaceId, name: '老房间' } })
    assert.equal(res.status, 201)
    const room = ((await res.json()) as RoomBody).room
    assert.equal(room.name, '老房间')
    assert.deepEqual(room.members, [])
    assert.deepEqual(room.responder, { kind: 'mentions' })
  })
})

test('写操作 Origin 校验 + 跨账号读不到房间', async () => {
  await withApi(async ({ base }) => {
    const mine = await pairWithWorkspace(base, 'acc_mine')
    const a = await createBot(base, mine.token, mine.workspaceId, 'A')
    const b = await createBot(base, mine.token, mine.workspaceId, 'B')
    const room = (await (
      await call(base, 'POST', '/api/rooms', {
        token: mine.token,
        body: { workspaceId: mine.workspaceId, memberBotIds: [a, b] },
      })
    ).json() as RoomBody).room

    const evil = await call(base, 'PATCH', `/api/rooms/${room.id}`, {
      token: mine.token,
      headers: { origin: 'http://evil.example' },
      body: { name: '改名' },
    })
    assert.equal(evil.status, 403)
    assert.equal(((await evil.json()) as { error: { code: string } }).error.code, 'forbidden_origin')

    const other = await pairWithWorkspace(base, 'acc_other', '另一个组')
    const peek = await call(base, 'GET', `/api/rooms/${room.id}`, { token: other.token })
    assert.equal(peek.status, 404)
    assert.equal(((await peek.json()) as { error: { code: string } }).error.code, 'room_not_found')
  })
})
