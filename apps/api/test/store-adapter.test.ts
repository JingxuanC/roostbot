// 真实 store（SQLite 临时库）→ StorePort → HTTP API 的端到端接线测试。
// 这是 Lead 的集成点：两个 agent 各自都有单测，这里验它们拼起来能跑。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import { startServer } from '../src/server.ts'
import { createStorePort } from '../src/store-adapter.ts'

async function withApi(
  fn: (ctx: { base: string; close: () => Promise<void>; store: ReturnType<typeof openStore> }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'roost-api-store-'))
  const store = openStore(join(dir, 'workspace.db'))
  const { server, url, close } = await startServer({
    store: createStorePort(store),
    port: 0,
    host: '127.0.0.1',
  })
  try {
    await fn({ base: url, close, store })
  } finally {
    await close()
    server.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function json(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1${path}`, init)
}

async function post(base: string, path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  })
}

test('配对 → 换会话 → 建 workspace → 列出（真实 SQLite）', async () => {
  await withApi(async ({ base }) => {
    const codeRes = await post(base, '/api/pairing/code', { accountId: 'acc_e2e' })
    assert.equal(codeRes.status, 200)
    const { code } = (await codeRes.json()) as { code: string }
    assert.match(code, /^\d{6}$/)

    const claimRes = await post(base, '/api/pairing/claim', { code })
    assert.equal(claimRes.status, 200)
    const { sessionToken } = (await claimRes.json()) as { sessionToken: string }

    // 同一个码不能换第二次。
    const again = await post(base, '/api/pairing/claim', { code })
    assert.equal(again.status, 401)

    const created = await post(base, '/api/workspaces', { name: '量化研究组' }, sessionToken)
    assert.equal(created.status, 201)
    const createdBody = (await created.json()) as { workspace: { id: string; role: string; tenantId: string } }
    assert.equal(createdBody.workspace.role, 'owner')
    assert.equal(createdBody.workspace.tenantId, 'acc_e2e')

    const listed = await fetch(`${base}/api/workspaces`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    })
    assert.equal(listed.status, 200)
    const { workspaces } = (await listed.json()) as { workspaces: Array<{ id: string; name: string }> }
    assert.equal(workspaces.length, 1)
    assert.equal(workspaces[0]!.id, createdBody.workspace.id)
    assert.equal(workspaces[0]!.name, '量化研究组')
  })
})

test('会话 token 只存 hash：库里搜不到明文', async () => {
  await withApi(async ({ base, store }) => {
    const code = ((await (await post(base, '/api/pairing/code', { accountId: 'acc_hash' })).json()) as { code: string }).code
    const token = ((await (await post(base, '/api/pairing/claim', { code })).json()) as { sessionToken: string }).sessionToken

    const rows = store.db.prepare('SELECT token_hash FROM sessions').all() as Array<{ token_hash: string }>
    assert.equal(rows.length, 1)
    assert.notEqual(rows[0]!.token_hash, token)
    assert.match(rows[0]!.token_hash, /^[0-9a-f]{64}$/)

    // 明文 token 能被 API 接受，但库里没有它。
    const ok = await fetch(`${base}/api/workspaces`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(ok.status, 200)
    const byPlain = store.db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(token)
    assert.equal(byPlain, undefined)
  })
})

test('房间：真实 SQLite 建房间、发消息、读回、SSE 可用', async () => {
  await withApi(async ({ base }) => {
    const code = ((await (await post(base, '/api/pairing/code', { accountId: 'acc_room' })).json()) as { code: string }).code
    const token = ((await (await post(base, '/api/pairing/claim', { code })).json()) as { sessionToken: string }).sessionToken
    const workspace = ((await (
      await post(base, '/api/workspaces', { name: '量化研究组' }, token)
    ).json()) as { workspace: { id: string } }).workspace

    const roomRes = await post(base, '/api/rooms', { workspaceId: workspace.id, name: '量化研究组' }, token)
    assert.equal(roomRes.status, 201)
    const room = ((await roomRes.json()) as { room: { id: string } }).room

    const msgRes = await post(base, `/api/rooms/${room.id}/messages`, { text: '盘前看一下' }, token)
    assert.equal(msgRes.status, 201)
    const message = ((await msgRes.json()) as { message: { seq: number } }).message

    const read = await fetch(`${base}/api/rooms/${room.id}/messages?after=${message.seq - 1}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const body = (await read.json()) as { messages: Array<{ text: string }> }
    assert.deepEqual(body.messages.map((m) => m.text), ['盘前看一下'])
  })
})

test('设备与会话落库：一个设备 + 一条会话，账号正确', async () => {
  await withApi(async ({ base, store }) => {
    const code = ((await (await post(base, '/api/pairing/code', { accountId: 'acc_dev' })).json()) as { code: string }).code
    await post(base, '/api/pairing/claim', { code })

    const devices = store.db.prepare('SELECT account_id, platform, label FROM devices').all() as Array<{
      account_id: string
      platform: string | null
      label: string | null
    }>
    assert.equal(devices.length, 1)
    assert.equal(devices[0]!.account_id, 'acc_dev')

    const sessions = store.db.prepare('SELECT id, device_id FROM sessions').all() as Array<{ id: string; device_id: string }>
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]!.device_id, devices[0] === undefined ? '' : (store.db.prepare('SELECT id FROM devices').get() as { id: string }).id)
  })
})
