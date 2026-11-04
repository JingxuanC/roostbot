// workspace 成员与角色 API（docs/design/auth.md §5/§10；M5-5.3.3）。
//
// 覆盖：成员列表可见性、admin 改角色、admin 不能授予 owner、最后 owner 409、
// 角色变更/移除事件恰好一次、Bot/房间/消息的角色强制、memory port 503。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore, readEvents } from '../../../packages/store/src/index.ts'
import { createStorePort } from '../src/store-adapter.ts'
import { hashSessionToken, startServer } from '../src/server.ts'
import { pairDevice, startHarness } from './helpers.ts'

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)

const OWNER = 'acc_owner'
const ADMIN = 'acc_admin'
const MEMBER = 'acc_member'
const VIEWER = 'acc_viewer'
const STRANGER = 'acc_stranger'

/** 64 位小写 hex（会话 token 的格式要求）。 */
const TOKEN = {
  owner: '0'.repeat(64),
  admin: '1'.repeat(64),
  member: '2'.repeat(64),
  viewer: '3'.repeat(64),
  stranger: '4'.repeat(64),
}

interface Fixture {
  base: string
  store: ReturnType<typeof openStore>
  workspaceId: string
  call: (method: string, path: string, options?: { body?: unknown; token?: string }) => Promise<ApiResult>
  close: () => Promise<void>
}

interface ApiResult {
  status: number
  json: any
}

async function withApi(fn: (fx: Fixture) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'roost-members-api-'))
  const store = openStore(join(dir, 'workspace.db'))
  const port = createStorePort(store)
  let started: Awaited<ReturnType<typeof startServer>> | null = null

  try {
    const workspace = await port.createWorkspace({ accountId: OWNER, name: '成员工作区', now: NOW })
    const insertMember = store.db.prepare(
      'INSERT INTO workspace_members (workspace_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    insertMember.run(workspace.id, ADMIN, 'admin', OWNER, NOW + 1)
    insertMember.run(workspace.id, MEMBER, 'member', OWNER, NOW + 2)
    insertMember.run(workspace.id, VIEWER, 'viewer', OWNER, NOW + 3)

    const accounts: Array<[string, string]> = [
      [OWNER, TOKEN.owner],
      [ADMIN, TOKEN.admin],
      [MEMBER, TOKEN.member],
      [VIEWER, TOKEN.viewer],
      [STRANGER, TOKEN.stranger],
    ]
    for (const [accountId, token] of accounts) {
      await port.createSession({
        accountId,
        tokenHash: hashSessionToken(token),
        now: NOW,
        expiresAt: NOW + 60 * 60 * 1000,
      })
    }

    started = await startServer({ store: port, rawStore: store, now: () => NOW, port: 0, host: '127.0.0.1' })
    const baseUrl = started.url

    async function call(
      method: string,
      path: string,
      options: { body?: unknown; token?: string } = {},
    ): Promise<ApiResult> {
      const headers: Record<string, string> = {}
      if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`
      let body: string | undefined
      if (options.body !== undefined) {
        headers['content-type'] = 'application/json'
        body = JSON.stringify(options.body)
      }
      const init: RequestInit = { method, headers }
      if (body !== undefined) init.body = body
      const response = await fetch(`${baseUrl}${path}`, init)
      const text = await response.text()
      return { status: response.status, json: text === '' ? null : JSON.parse(text) }
    }

    await fn({
      base: baseUrl,
      store,
      workspaceId: workspace.id,
      call,
      close: async () => {
        await started!.close()
        store.close()
        rmSync(dir, { recursive: true, force: true })
      },
    })
  } finally {
    // fn 正常结束时 close 已经跑过；异常路径兜底。
    if (started !== null) {
      try {
        await started.close()
      } catch {
        // ignore
      }
    }
    if (!store.closed) store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function authEvents(store: Fixture['store'], kind: string) {
  return readEvents(store, { domain: 'auth' }).filter((event) => event.kind === kind)
}

test('任意成员可看成员列表（含 viewer）；非成员 404', async () => {
  await withApi(async (fx) => {
    const asViewer = await fx.call('GET', `/api/workspaces/${fx.workspaceId}/members`, { token: TOKEN.viewer })
    assert.equal(asViewer.status, 200)
    assert.deepEqual(
      asViewer.json.members.map((member: { accountId: string; role: string }) => [member.accountId, member.role]),
      [
        [OWNER, 'owner'],
        [ADMIN, 'admin'],
        [MEMBER, 'member'],
        [VIEWER, 'viewer'],
      ],
    )

    const asStranger = await fx.call('GET', `/api/workspaces/${fx.workspaceId}/members`, { token: TOKEN.stranger })
    assert.equal(asStranger.status, 404)
    assert.equal(asStranger.json.error.code, 'workspace_not_found')
    assert.equal(asStranger.json.members, undefined)
  })
})

test('admin 可以改成员角色，并只写一次 auth.role.changed', async () => {
  await withApi(async (fx) => {
    const res = await fx.call('PATCH', `/api/workspaces/${fx.workspaceId}/members/${VIEWER}`, {
      token: TOKEN.admin,
      body: { role: 'member' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.member.accountId, VIEWER)
    assert.equal(res.json.member.role, 'member')

    const events = authEvents(fx.store, 'auth.role.changed')
    assert.equal(events.length, 1)
    assert.deepEqual(events[0]!.actor, { kind: 'user', id: ADMIN })
    assert.deepEqual(events[0]!.subject, { kind: 'member', id: VIEWER })
    assert.deepEqual(events[0]!.payload, { workspaceId: fx.workspaceId, from: 'viewer', to: 'member' })
  })
})

test('admin 不能授予 owner；owner 可以；非法角色 400', async () => {
  await withApi(async (fx) => {
    const denied = await fx.call('PATCH', `/api/workspaces/${fx.workspaceId}/members/${MEMBER}`, {
      token: TOKEN.admin,
      body: { role: 'owner' },
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.json.error.code, 'forbidden')

    const byOwner = await fx.call('PATCH', `/api/workspaces/${fx.workspaceId}/members/${ADMIN}`, {
      token: TOKEN.owner,
      body: { role: 'owner' },
    })
    assert.equal(byOwner.status, 200)
    assert.equal(byOwner.json.member.role, 'owner')

    const invalid = await fx.call('PATCH', `/api/workspaces/${fx.workspaceId}/members/${MEMBER}`, {
      token: TOKEN.owner,
      body: { role: 'superuser' },
    })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.json.error.code, 'workspace.invalid_role')

    // admin 现在已经是 owner，之前被拒的变更没有落库。
    assert.equal(
      (await fx.call('GET', `/api/workspaces/${fx.workspaceId}/members`, { token: TOKEN.member })).json.members
        .find((member: { accountId: string }) => member.accountId === MEMBER).role,
      'member',
    )
  })
})

test('最后一个 owner 不能降级或移除（409 workspace.last_owner）', async () => {
  await withApi(async (fx) => {
    const demote = await fx.call('PATCH', `/api/workspaces/${fx.workspaceId}/members/${OWNER}`, {
      token: TOKEN.owner,
      body: { role: 'member' },
    })
    assert.equal(demote.status, 409)
    assert.equal(demote.json.error.code, 'workspace.last_owner')

    const remove = await fx.call('DELETE', `/api/workspaces/${fx.workspaceId}/members/${OWNER}`, {
      token: TOKEN.owner,
    })
    assert.equal(remove.status, 409)
    assert.equal(remove.json.error.code, 'workspace.last_owner')

    assert.equal(authEvents(fx.store, 'auth.role.changed').length, 0)
    assert.equal(authEvents(fx.store, 'auth.member.removed').length, 0)
  })
})

test('移除成员：200 + 一次 auth.member.removed；非管理员 403', async () => {
  await withApi(async (fx) => {
    const denied = await fx.call('DELETE', `/api/workspaces/${fx.workspaceId}/members/${VIEWER}`, {
      token: TOKEN.member,
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.json.error.code, 'forbidden')

    const removed = await fx.call('DELETE', `/api/workspaces/${fx.workspaceId}/members/${VIEWER}`, {
      token: TOKEN.admin,
    })
    assert.equal(removed.status, 200)
    assert.deepEqual(removed.json, { ok: true })

    const events = authEvents(fx.store, 'auth.member.removed')
    assert.equal(events.length, 1)
    assert.deepEqual(events[0]!.payload, { workspaceId: fx.workspaceId, role: 'viewer' })

    const members = await fx.call('GET', `/api/workspaces/${fx.workspaceId}/members`, { token: TOKEN.owner })
    assert.equal(
      members.json.members.some((member: { accountId: string }) => member.accountId === VIEWER),
      false,
    )
  })
})

test('发消息：viewer 403；member 可以', async () => {
  await withApi(async (fx) => {
    const roomRes = await fx.call('POST', '/api/rooms', {
      token: TOKEN.owner,
      body: { workspaceId: fx.workspaceId, name: '角色测试房' },
    })
    assert.equal(roomRes.status, 201)
    const roomId = roomRes.json.room.id as string

    const viewerSend = await fx.call('POST', `/api/rooms/${roomId}/messages`, {
      token: TOKEN.viewer,
      body: { text: '我只读' },
    })
    assert.equal(viewerSend.status, 403)
    assert.equal(viewerSend.json.error.code, 'forbidden')

    const memberSend = await fx.call('POST', `/api/rooms/${roomId}/messages`, {
      token: TOKEN.member,
      body: { text: '我可以说话' },
    })
    assert.equal(memberSend.status, 201)
  })
})

test('Bot 写操作：member 403；房间设置：member 403、admin 200', async () => {
  await withApi(async (fx) => {
    const created = await fx.call('POST', '/api/bots', {
      token: TOKEN.owner,
      body: { workspaceId: fx.workspaceId, name: '研究员', model: 'deepseek-v3' },
    })
    assert.equal(created.status, 201)
    const botId = created.json.bot.id as string

    const botPatch = await fx.call('PATCH', `/api/bots/${botId}`, {
      token: TOKEN.member,
      body: { role: '改我' },
    })
    assert.equal(botPatch.status, 403)
    assert.equal(botPatch.json.error.code, 'forbidden')

    const roomRes = await fx.call('POST', '/api/rooms', {
      token: TOKEN.owner,
      body: { workspaceId: fx.workspaceId, name: '设置测试房' },
    })
    const roomId = roomRes.json.room.id as string

    const memberPatch = await fx.call('PATCH', `/api/rooms/${roomId}`, {
      token: TOKEN.member,
      body: { notice: 'member 不能改' },
    })
    assert.equal(memberPatch.status, 403)
    assert.equal(memberPatch.json.error.code, 'forbidden')

    const adminPatch = await fx.call('PATCH', `/api/rooms/${roomId}`, {
      token: TOKEN.admin,
      body: { notice: 'admin 可以改' },
    })
    assert.equal(adminPatch.status, 200)
    assert.equal(adminPatch.json.room.notice, 'admin 可以改')
  })
})

test('memory port（无 rawStore）返回 503 runtime.not_configured', async () => {
  const harness = await startHarness()
  try {
    const token = await pairDevice(harness)
    const list = await harness.call('GET', '/api/workspaces/ws_any/members', { token })
    assert.equal(list.status, 503)
    assert.equal(list.json.error.code, 'runtime.not_configured')

    const patch = await harness.call('PATCH', '/api/workspaces/ws_any/members/acc_x', {
      token,
      body: { role: 'admin' },
    })
    assert.equal(patch.status, 503)
    assert.equal(patch.json.error.code, 'runtime.not_configured')

    const remove = await harness.call('DELETE', '/api/workspaces/ws_any/members/acc_x', { token })
    assert.equal(remove.status, 503)
    assert.equal(remove.json.error.code, 'runtime.not_configured')
  } finally {
    await harness.close()
  }
})
