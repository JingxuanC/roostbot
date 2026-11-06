// 附件/产物：内容寻址上传、消息级授权、Range、签名 token、GC。
//
// 用真实 SQLite + store-adapter + 临时附件目录；内存 store 只用来验 503 降级。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import { createMemoryStore } from '../src/memory-store.ts'
import { startServer } from '../src/server.ts'
import { createStorePort } from '../src/store-adapter.ts'
import { manualClock } from './helpers.ts'
import type { ManualClock } from './helpers.ts'

const RUNTIME_TOKEN = 'rt_attachments_0123456789'

function png(width = 640, height = 480): Buffer {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function jpegWithExif(): Buffer {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])])
  const app1 = Buffer.from([0xff, 0xe1, 0, 0])
  app1.writeUInt16BE(payload.byteLength + 2, 2)
  const sof = Buffer.alloc(19)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(600, 5)
  sof.writeUInt16BE(800, 7)
  sof[9] = 3
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1,
    payload,
    sof,
    Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]),
  ])
}

interface Ctx {
  base: string
  rawStore: ReturnType<typeof openStore>
  clock: ManualClock
  close: () => Promise<void>
}

async function withApi(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'roost-attachments-'))
  const rawStore = openStore(join(dir, 'workspace.db'))
  const clock = manualClock()
  const started = await startServer({
    store: createStorePort(rawStore),
    rawStore,
    runtimeToken: RUNTIME_TOKEN,
    attachmentsDir: join(dir, 'attachments'),
    signingSecret: 'test-signing-secret',
    now: clock.now,
    port: 0,
    host: '127.0.0.1',
  })
  try {
    await fn({ base: started.url, rawStore, clock, close: started.close })
  } finally {
    await started.close()
    rawStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
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

/** 配对（可选建 workspace），返回 token/workspaceId。 */
async function pair(base: string, accountId: string, withWorkspace: boolean): Promise<{ token: string; workspaceId: string }> {
  const codeRes = await post(base, '/api/pairing/code', { accountId })
  const { code } = (await codeRes.json()) as { code: string }
  const claimRes = await post(base, '/api/pairing/claim', { code })
  const { sessionToken } = (await claimRes.json()) as { sessionToken: string }
  if (!withWorkspace) return { token: sessionToken, workspaceId: '' }
  const wsRes = await post(base, '/api/workspaces', { name: '量化研究组' }, sessionToken)
  const { workspace } = (await wsRes.json()) as { workspace: { id: string } }
  return { token: sessionToken, workspaceId: workspace.id }
}

async function uploadArtifact(
  base: string,
  input: {
    workspaceId: string
    body: Buffer
    mime: string
    kind?: string
    name?: string
    messageSeq?: number
    producedBy?: string
  },
): Promise<Response> {
  const headers: Record<string, string> = {
    'x-runtime-token': RUNTIME_TOKEN,
    'x-workspace-id': input.workspaceId,
    'x-produced-by': input.producedBy ?? 'bot_chart',
    'x-artifact-kind': input.kind ?? 'image',
    'x-artifact-name': input.name ?? 'chart.png',
    'x-file-mime': input.mime,
    'content-type': 'application/octet-stream',
  }
  if (input.messageSeq !== undefined) headers['x-message-seq'] = String(input.messageSeq)
  return fetch(`${base}/api/internal/artifacts`, { method: 'POST', headers, body: input.body })
}

async function seedRoom(base: string, token: string, workspaceId: string): Promise<{ roomId: string; seq: number }> {
  const roomRes = await post(base, '/api/rooms', { workspaceId, name: '研究' }, token)
  const { room } = (await roomRes.json()) as { room: { id: string } }
  const msgRes = await post(base, `/api/rooms/${room.id}/messages`, { text: '看这张图' }, token)
  const { message } = (await msgRes.json()) as { message: { seq: number } }
  return { roomId: room.id, seq: message.seq }
}

test('内存 store：内部产物接口 503 runtime.not_configured', async () => {
  const store = createMemoryStore()
  const started = await startServer({ store, runtimeToken: RUNTIME_TOKEN, port: 0, host: '127.0.0.1' })
  try {
    const res = await fetch(`${started.url}/api/internal/artifacts`, {
      method: 'POST',
      headers: {
        'x-runtime-token': RUNTIME_TOKEN,
        'x-workspace-id': 'ws_x',
        'x-produced-by': 'bot_x',
        'x-artifact-kind': 'image',
        'x-artifact-name': 'x.png',
        'x-file-mime': 'image/png',
      },
      body: png(),
    })
    assert.equal(res.status, 503)
    const body = (await res.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'runtime.not_configured')
  } finally {
    await started.close()
  }
})

test('产物登记 → 消息附件 → 消息级授权 + Range + raw 下载', async () => {
  await withApi(async ({ base }) => {
    const owner = await pair(base, 'acc_owner', true)
    const other = await pair(base, 'acc_other', false)
    const { seq } = await seedRoom(base, owner.token, owner.workspaceId)
    const bytes = png(640, 480)

    const res = await uploadArtifact(base, {
      workspaceId: owner.workspaceId,
      body: bytes,
      mime: 'image/png',
      messageSeq: seq,
    })
    assert.equal(res.status, 201)
    const { artifact } = (await res.json()) as {
      artifact: { id: string; width: number; height: number; thumbId: string | null }
    }
    assert.match(artifact.id, /^[0-9a-f]{32}$/)
    assert.equal(artifact.width, 640)
    assert.equal(artifact.height, 480)

    // 房间消息带附件数组与受控 URL。
    const read = await fetch(`${base}/api/rooms/${(await roomIdOf(base, owner.token)).id}/messages`, {
      headers: { authorization: `Bearer ${owner.token}` },
    })
    const body = (await read.json()) as {
      messages: Array<{ seq: number; attachments: Array<{ artifactId: string; url: string; kind: string }> }>
    }
    const message = body.messages.find((item) => item.seq === seq)!
    assert.deepEqual(message.attachments.map((item) => [item.artifactId, item.kind]), [[artifact.id, 'image']])
    assert.match(message.attachments[0]!.url, new RegExp(`^/api/attachments/${artifact.id}\\?token=`))

    // `<img>` 不带 Authorization。签名地址本身就能读。
    const bare = await fetch(`${base}${message.attachments[0]!.url}`)
    assert.equal(bare.status, 200)
    assert.deepEqual([...new Uint8Array(await bare.arrayBuffer())], [...bytes])

    const url = `${base}/api/messages/${seq}/files/${artifact.id}`
    const file = await fetch(url, { headers: { authorization: `Bearer ${owner.token}` } })
    assert.equal(file.status, 200)
    assert.equal(file.headers.get('content-type'), 'image/png')
    assert.equal(file.headers.get('cache-control'), 'private, no-store')
    assert.equal(file.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [...bytes])

    const ranged = await fetch(url, { headers: { authorization: `Bearer ${owner.token}`, range: 'bytes=0-7' } })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers.get('content-range'), `bytes 0-7/${bytes.byteLength}`)
    assert.equal((await ranged.arrayBuffer()).byteLength, 8)

    const download = await fetch(`${url}?raw=1`, { headers: { authorization: `Bearer ${owner.token}` } })
    assert.equal(download.status, 200)
    assert.match(download.headers.get('content-disposition') ?? '', /^attachment;/)

    // 非 workspace 成员：404（不泄漏存在性）。
    const denied = await fetch(url, { headers: { authorization: `Bearer ${other.token}` } })
    assert.equal(denied.status, 404)

    // 未挂到这条消息的产物也 404。
    const orphan = await uploadArtifact(base, {
      workspaceId: owner.workspaceId,
      body: png(10, 10),
      mime: 'image/png',
    })
    const orphanId = ((await orphan.json()) as { artifact: { id: string } }).artifact.id
    const unlinked = await fetch(`${base}/api/messages/${seq}/files/${orphanId}`, {
      headers: { authorization: `Bearer ${owner.token}` },
    })
    assert.equal(unlinked.status, 404)
  })
})

test('消息图片签名 URL：不带 Bearer 可读，别的 workspace 拿不到 token', async () => {
  await withApi(async ({ base, clock }) => {
    const owner = await pair(base, 'acc_img_a', true)
    const stranger = await pair(base, 'acc_img_b', true)
    const { roomId, seq } = await seedRoom(base, owner.token, owner.workspaceId)
    const bytes = png(24, 24)
    const uploaded = await uploadArtifact(base, {
      workspaceId: owner.workspaceId,
      body: bytes,
      mime: 'image/png',
      messageSeq: seq,
    })
    const artifactId = ((await uploaded.json()) as { artifact: { id: string } }).artifact.id
    const otherUpload = await uploadArtifact(base, {
      workspaceId: stranger.workspaceId,
      body: png(8, 8),
      mime: 'image/png',
    })
    const otherId = ((await otherUpload.json()) as { artifact: { id: string } }).artifact.id

    const read = await fetch(`${base}/api/rooms/${roomId}/messages`, {
      headers: { authorization: `Bearer ${owner.token}` },
    })
    assert.equal(read.status, 200)
    const body = (await read.json()) as {
      messages: Array<{ seq: number; attachments: Array<{ url: string }> }>
    }
    const url = body.messages.find((item) => item.seq === seq)?.attachments[0]?.url ?? ''
    assert.match(url, new RegExp(`^/api/attachments/${artifactId}\\?token=`))
    const open = await fetch(`${base}${url}`)
    assert.equal(open.status, 200)
    assert.deepEqual([...new Uint8Array(await open.arrayBuffer())], [...bytes])

    const stolen = await fetch(`${base}/api/rooms/${roomId}/messages`, {
      headers: { authorization: `Bearer ${stranger.token}` },
    })
    assert.notEqual(stolen.status, 200)
    const stolenText = await stolen.text()
    assert.equal(stolenText.includes(url.slice(url.indexOf('token='))), false)

    const unsigned = await fetch(`${base}/api/messages/${seq}/files/${artifactId}`)
    assert.equal(unsigned.status, 401)
    const strangerFile = await fetch(`${base}/api/messages/${seq}/files/${artifactId}`, {
      headers: { authorization: `Bearer ${stranger.token}` },
    })
    assert.equal(strangerFile.status, 404)

    const swapped = url.replace(artifactId, otherId)
    const crossed = await fetch(`${base}${swapped}`)
    assert.equal(crossed.status, 403)

    clock.advance(121_000)
    const expired = await fetch(`${base}${url}`)
    assert.equal(expired.status, 403)
  })
})

/** 测试里拿 roomId：列表房间即可。 */
async function roomIdOf(base: string, token: string): Promise<{ id: string }> {
  const res = await fetch(`${base}/api/rooms`, { headers: { authorization: `Bearer ${token}` } })
  const body = (await res.json()) as { rooms: Array<{ id: string }> }
  return body.rooms[0]!
}

test('JPEG 上传剥 EXIF，宽高来自文件头', async () => {
  await withApi(async ({ base }) => {
    const owner = await pair(base, 'acc_exif', true)
    const original = jpegWithExif()
    const res = await uploadArtifact(base, {
      workspaceId: owner.workspaceId,
      body: original,
      mime: 'image/jpeg',
      name: 'photo.jpg',
    })
    assert.equal(res.status, 201)
    const { artifact } = (await res.json()) as {
      artifact: { id: string; size: number; width: number; height: number }
    }
    assert.equal(artifact.width, 800)
    assert.equal(artifact.height, 600)
    assert.equal(artifact.size, original.byteLength - 18, 'APP1 段被删除')

    const badToken = await fetch(`${base}/api/attachments/${artifact.id}?token=bad`)
    assert.equal(badToken.status, 403)
  })
})

test('用户上传 → 签名 URL：篡改 403、过期 403', async () => {
  await withApi(async ({ base, clock }) => {
    const owner = await pair(base, 'acc_signed', true)
    const bytes = png(32, 32)
    const res = await fetch(`${base}/api/attachments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${owner.token}`,
        'content-type': 'image/png',
        'x-file-mime': 'image/png',
      },
      body: bytes,
    })
    assert.equal(res.status, 201)
    const { attachment } = (await res.json()) as { attachment: { id: string; url: string; owner: string } }
    assert.equal(attachment.owner, 'acc_signed')
    assert.match(attachment.url, /^\/api\/attachments\/[0-9a-f]{32}\?token=/)

    const ok = await fetch(`${base}${attachment.url}`)
    assert.equal(ok.status, 200)
    assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [...bytes])

    const tampered = attachment.url.replace(/token=(\d+)\./, (_m, exp: string) => `token=${exp}f.`)
    const bad = await fetch(`${base}${tampered}`)
    assert.equal(bad.status, 403)

    // 签名 TTL 300 秒；时钟前进后过期。
    clock.advance(301_000)
    const expired = await fetch(`${base}${attachment.url}`)
    assert.equal(expired.status, 403)
  })
})

test('GC：超 7 天且无引用才删，有引用的产物仍可读', async () => {
  await withApi(async ({ base, clock }) => {
    const owner = await pair(base, 'acc_gc', true)
    const { seq } = await seedRoom(base, owner.token, owner.workspaceId)

    const linked = await uploadArtifact(base, {
      workspaceId: owner.workspaceId,
      body: png(64, 64),
      mime: 'image/png',
      messageSeq: seq,
    })
    const linkedId = ((await linked.json()) as { artifact: { id: string } }).artifact.id

    const orphan = await fetch(`${base}/api/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}`, 'x-file-mime': 'image/png' },
      body: png(8, 8),
    })
    assert.equal(orphan.status, 201)

    clock.advance(8 * 24 * 60 * 60 * 1000)
    const gc = await fetch(`${base}/api/internal/attachments/gc`, {
      method: 'POST',
      headers: { 'x-runtime-token': RUNTIME_TOKEN },
    })
    assert.equal(gc.status, 200)
    const result = (await gc.json()) as { deleted: number; bytes: number }
    assert.ok(result.deleted >= 1)
    assert.ok(result.bytes > 0)

    // 再次 GC 没有更多可删（引用计数>0 的产物永远保留）。
    const again = await fetch(`${base}/api/internal/attachments/gc`, {
      method: 'POST',
      headers: { 'x-runtime-token': RUNTIME_TOKEN },
    })
    assert.deepEqual(await again.json(), { deleted: 0, bytes: 0 })

    // 被消息引用的产物仍能通过消息级路由读到。
    const file = await fetch(`${base}/api/messages/${seq}/files/${linkedId}`, {
      headers: { authorization: `Bearer ${owner.token}` },
    })
    assert.equal(file.status, 200)
  })
})
