// 上传整理（EXIF 剥离 + 缩略图降级）与产物/附件上传接线（wave3 §C）。
//
// 分两层测：
//   * prepareUpload / persistThumbnail 用 fake runner + 真实 SQLite/本地卷，行为确定；
//   * 两个上传端点走真实 HTTP，只断言「原图仍成功、响应新字段形状、落盘字节已剥 EXIF」，
//     不对环境里有没有 sips/pdftoppm 做假设。

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { getAttachment, openStore } from '../../../packages/store/src/index.ts'
import { LocalVolumeStore, objectPath } from '../../../packages/storage/src/index.ts'
import type { ContentStore, ThumbnailRunner } from '../../../packages/storage/src/index.ts'
import { persistThumbnail, prepareUpload } from '../src/attachments-thumbnails.ts'
import { startServer } from '../src/server.ts'
import { createStorePort } from '../src/store-adapter.ts'
import { manualClock } from './helpers.ts'
import type { ManualClock } from './helpers.ts'

const RUNTIME_TOKEN = 'rt_attachments_thumbnails_0123456789'

// ---- fixtures ---------------------------------------------------------------

function png(width = 640, height = 480): Uint8Array {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  bytes[24] = 8
  bytes[25] = 6
  return new Uint8Array(bytes)
}

/** SOI + APP1(Exif) + SOF + SOS + 熵数据 + EOI；APP1 共 18 字节。 */
function jpeg(width: number, height: number, exif = true): Uint8Array {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])]
  if (exif) {
    const payload = Buffer.concat([
      Buffer.from('Exif\0\0', 'binary'),
      Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    ])
    const header = Buffer.from([0xff, 0xe1, 0, 0])
    header.writeUInt16BE(payload.byteLength + 2, 2)
    parts.push(header, payload)
  }
  const sof = Buffer.alloc(19)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  sof[9] = 3
  parts.push(sof)
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9]))
  return new Uint8Array(Buffer.concat(parts))
}

const EXIF_SEGMENT_BYTES = 18
const THUMB = jpeg(8, 8, false)

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'roost-upload-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 假 runner：只有指定命令成功，按 renderThumbnail 约定的输出路径写文件。 */
function fakeRunner(options: {
  writes?: Uint8Array
  succeedOn?: string
  seen?: string[]
  onCall?: (command: string, args: string[]) => void
}): ThumbnailRunner {
  const succeedOn = options.succeedOn ?? 'sips'
  return async (command, args) => {
    options.seen?.push(command)
    options.onCall?.(command, args)
    if (command !== succeedOn) return { code: 1, stderr: `${command}: forced failure` }
    const target = command === 'pdftoppm' ? `${args.at(-1)!}-1.jpg` : args.at(-1)!
    if (options.writes !== undefined) writeFileSync(target, Buffer.from(options.writes))
    return { code: 0 }
  }
}

// ---- prepareUpload ---------------------------------------------------------

test('prepareUpload：JPEG 剥 EXIF，缩略图失败只降级', async () => {
  const original = jpeg(800, 600, true)
  const seen: string[] = []
  const result = await prepareUpload({
    bytes: original,
    mime: 'image/jpeg',
    runner: fakeRunner({ seen, succeedOn: '__no_such_tool__' }),
  })

  assert.equal(result.strippedExif, true)
  assert.equal(result.bytes.byteLength, original.byteLength - EXIF_SEGMENT_BYTES)
  assert.equal(Buffer.from(result.bytes).includes(Buffer.from('Exif', 'ascii')), false)
  assert.equal(result.thumbnail, undefined)
  assert.match(result.thumbUnavailable ?? '', /no thumbnailer produced output/)
  // sips → magick 都试过，但没有抛出、没有动原图。
  assert.deepEqual(seen, ['sips', 'magick'])
  assert.equal(original.byteLength, jpeg(800, 600, true).byteLength)
})

test('prepareUpload：命令 exit 0 却没写产物时，不把原图当成缩略图', async (t) => {
  // renderThumbnail 对 JPEG 输入的临时输入/输出同路径；命令假成功时读回的就是原图。
  const workDir = tempDir(t)
  const original = jpeg(800, 600, true)
  const result = await prepareUpload({
    bytes: original,
    mime: 'image/jpeg',
    workDir,
    runner: async () => ({ code: 0 }),
  })

  assert.equal(result.thumbnail, undefined)
  assert.match(result.thumbUnavailable ?? '', /no usable image within 320px/)
  assert.equal(Buffer.from(result.bytes).byteLength, original.byteLength - EXIF_SEGMENT_BYTES)
  assert.deepEqual(readdirSync(workDir), [], '临时文件仍要清理')
})

test('prepareUpload：PNG 超过长边 → runner 写出 JPEG 缩略图，临时文件清理干净', async (t) => {
  const workDir = tempDir(t)
  const seen: string[] = []
  const result = await prepareUpload({
    bytes: png(640, 480),
    mime: 'image/png',
    workDir,
    runner: fakeRunner({ writes: THUMB, seen }),
  })

  assert.equal(result.strippedExif, false)
  assert.ok(result.thumbnail !== undefined, '应该拿到缩略图')
  assert.equal(result.thumbnail.mime, 'image/jpeg')
  assert.deepEqual([...result.thumbnail.bytes], [...THUMB])
  assert.equal(result.thumbUnavailable, undefined)
  assert.deepEqual(seen, ['sips'])
  assert.deepEqual(readdirSync(workDir), [], '输入/输出临时文件应被清理')
})

test('prepareUpload：runner 抛异常也降级，原图字节不变', async () => {
  const source = png(640, 480)
  const result = await prepareUpload({
    bytes: source,
    mime: 'image/png',
    runner: async () => {
      throw new Error('spawn sips ENOENT')
    },
  })

  assert.equal(result.bytes, source, '非 JPEG 原样返回同一个 buffer')
  assert.equal(result.strippedExif, false)
  assert.equal(result.thumbnail, undefined)
  assert.match(result.thumbUnavailable ?? '', /spawn sips ENOENT/)
})

test('prepareUpload：非图片原样返回，不执行任何命令', async () => {
  const bytes = new Uint8Array(Buffer.from('{"hello":"world"}'))
  let calls = 0
  const result = await prepareUpload({
    bytes,
    mime: 'application/json',
    runner: async () => {
      calls += 1
      return { code: 0 }
    },
  })

  assert.equal(result.bytes, bytes)
  assert.equal(result.strippedExif, false)
  assert.equal('thumbnail' in result, false)
  assert.equal('thumbUnavailable' in result, false)
  assert.equal(calls, 0)
})

test('prepareUpload：PDF 没有 pdftoppm → thumbUnavailable，不执行命令', async () => {
  const bytes = new Uint8Array(Buffer.from('%PDF-1.7\n%fake\n'))
  let calls = 0
  const result = await prepareUpload({
    bytes,
    mime: 'application/pdf',
    tools: { pdftoppm: false },
    runner: async () => {
      calls += 1
      return { code: 0 }
    },
  })

  assert.match(result.thumbUnavailable ?? '', /pdftoppm not available for pdf thumbnails/)
  assert.equal(result.thumbnail, undefined)
  assert.equal(calls, 0)
  assert.deepEqual([...result.bytes], [...bytes])
})

test('prepareUpload：PDF 有 pdftoppm → 读回首帧缩略图', async (t) => {
  const workDir = tempDir(t)
  const seen: string[] = []
  const result = await prepareUpload({
    bytes: new Uint8Array(Buffer.from('%PDF-1.7\n%fake\n')),
    mime: 'application/pdf',
    tools: { pdftoppm: true },
    workDir,
    runner: fakeRunner({ writes: THUMB, succeedOn: 'pdftoppm', seen }),
  })

  // sips 先失败，pdftoppm 接住（renderThumbnail 的命令顺序）。
  assert.deepEqual(seen, ['sips', 'pdftoppm'])
  assert.ok(result.thumbnail !== undefined)
  assert.deepEqual([...result.thumbnail.bytes], [...THUMB])
  assert.equal(result.thumbUnavailable, undefined)
  assert.deepEqual(readdirSync(workDir), [])
})

test('prepareUpload：已经够小的图 passthrough，不生成也不报不可用', async () => {
  let calls = 0
  const result = await prepareUpload({
    bytes: png(320, 200),
    mime: 'image/png',
    runner: async () => {
      calls += 1
      return { code: 0 }
    },
  })

  assert.equal('thumbnail' in result, false)
  assert.equal('thumbUnavailable' in result, false)
  assert.equal(calls, 0)
})

test('prepareUpload：octet-stream 上传的 JPEG 也剥 EXIF（声明 mime 不可信）', async () => {
  const original = jpeg(640, 480, true)
  const result = await prepareUpload({
    bytes: original,
    mime: 'application/octet-stream',
    runner: async () => ({ code: 1 }),
  })

  assert.equal(result.strippedExif, true)
  assert.equal(result.bytes.byteLength, original.byteLength - EXIF_SEGMENT_BYTES)
  assert.equal(result.thumbnail, undefined)
  assert.ok(result.thumbUnavailable !== undefined)
})

// ---- persistThumbnail ------------------------------------------------------

test('persistThumbnail：写内容存储 + attachments 行 + artifact 引用', async (t) => {
  const dir = tempDir(t)
  const store = openStore(join(dir, 'workspace.db'))
  t.after(() => store.close())
  const content = new LocalVolumeStore({ root: join(dir, 'attachments') })

  const thumb = await persistThumbnail({
    store,
    content,
    thumbnail: { bytes: THUMB, mime: 'image/jpeg' },
    workspaceId: 'ws_thumb',
    owner: 'bot_chart',
    createdAt: 1_700_000_000_000,
    ownerArtifactId: 'a'.repeat(32),
  })

  assert.ok(thumb !== null)
  assert.match(thumb.artifactId, /^[0-9a-f]{32}$/)
  assert.equal(thumb.mime, 'image/jpeg')
  assert.equal(thumb.width, 8)
  assert.equal(thumb.height, 8)

  const attachment = getAttachment(store, thumb.artifactId)
  assert.ok(attachment !== null)
  assert.equal(attachment.mime, 'image/jpeg')
  assert.equal(attachment.refCount, 1, '被产物引用，免于 GC')

  const got = await content.get(thumb.artifactId)
  assert.ok(got !== null)
  assert.deepEqual([...got.bytes], [...THUMB])
})

test('persistThumbnail：存储失败返回 null，不抛', async (t) => {
  const dir = tempDir(t)
  const store = openStore(join(dir, 'workspace.db'))
  t.after(() => store.close())
  const failing = {
    put: async () => {
      throw new Error('disk full')
    },
    get: async () => null,
    head: async () => null,
    delete: async () => false,
    signRead: async () => '',
  } as unknown as ContentStore

  const originalError = console.error
  console.error = () => {}
  try {
    const thumb = await persistThumbnail({
      store,
      content: failing,
      thumbnail: { bytes: THUMB, mime: 'image/jpeg' },
      workspaceId: 'ws_thumb',
      owner: 'bot_chart',
      createdAt: 1_700_000_000_000,
    })
    assert.equal(thumb, null)
  } finally {
    console.error = originalError
  }
})

// ---- 上传端点接线 ----------------------------------------------------------

interface Ctx {
  base: string
  root: string
  clock: ManualClock
  close: () => Promise<void>
}

async function withApi(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'roost-thumb-routes-'))
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
    await fn({ base: started.url, root: dir, clock, close: started.close })
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

async function pair(
  base: string,
  accountId: string,
): Promise<{ token: string; workspaceId: string }> {
  const codeRes = await post(base, '/api/pairing/code', { accountId })
  const { code } = (await codeRes.json()) as { code: string }
  const claimRes = await post(base, '/api/pairing/claim', { code })
  const { sessionToken } = (await claimRes.json()) as { sessionToken: string }
  const wsRes = await post(base, '/api/workspaces', { name: '缩略图测试' }, sessionToken)
  const { workspace } = (await wsRes.json()) as { workspace: { id: string } }
  return { token: sessionToken, workspaceId: workspace.id }
}

async function uploadArtifact(
  base: string,
  input: { workspaceId: string; body: Uint8Array; mime: string; name?: string },
): Promise<Response> {
  return fetch(`${base}/api/internal/artifacts`, {
    method: 'POST',
    headers: {
      'x-runtime-token': RUNTIME_TOKEN,
      'x-workspace-id': input.workspaceId,
      'x-produced-by': 'bot_chart',
      'x-artifact-kind': 'image',
      'x-artifact-name': input.name ?? 'chart.jpg',
      'x-file-mime': input.mime,
      'content-type': 'application/octet-stream',
    },
    body: input.body,
  })
}

test('产物上传：落盘字节已剥 EXIF，响应新增 thumbnail 字段', async () => {
  await withApi(async ({ base, root }) => {
    const owner = await pair(base, 'acc_thumb_artifact')
    const original = jpeg(800, 600, true)
    const res = await uploadArtifact(base, {
      workspaceId: owner.workspaceId,
      body: original,
      mime: 'image/jpeg',
      name: 'photo.jpg',
    })
    assert.equal(res.status, 201)

    const body = (await res.json()) as {
      artifact: { id: string; size: number; width: number; height: number; thumbId: string | null }
      thumbnail: { artifactId: string; mime: string } | null
      thumbUnavailable?: string
    }
    assert.equal(body.artifact.size, original.byteLength - EXIF_SEGMENT_BYTES)
    assert.equal(body.artifact.width, 800)
    assert.equal(body.artifact.height, 600)
    assert.ok('thumbnail' in body, '响应必须带 thumbnail 字段（可以是 null）')

    if (body.thumbnail === null) {
      // 环境里没有可用缩略图工具：降级原因必须可见，且产物仍成功。
      assert.equal(typeof body.thumbUnavailable, 'string')
      assert.equal(body.artifact.thumbId, null)
    } else {
      assert.match(body.thumbnail.artifactId, /^[0-9a-f]{32}$/)
      assert.equal(body.thumbnail.mime, 'image/jpeg')
      assert.equal(body.artifact.thumbId, body.thumbnail.artifactId)
    }

    // 内容存储里躺的是剥过 EXIF 的原图。
    const blob = readFileSync(join(root, 'attachments', objectPath(body.artifact.id), 'blob'))
    assert.equal(blob.byteLength, original.byteLength - EXIF_SEGMENT_BYTES)
    assert.equal(blob.includes(Buffer.from('Exif', 'ascii')), false)
  })
})

test('产物上传：非图片（HTML）不受缩略图影响，宽高为 null', async () => {
  await withApi(async ({ base }) => {
    const owner = await pair(base, 'acc_thumb_html')
    const html = new Uint8Array(Buffer.from('<html><body>报告</body></html>'))
    const res = await fetch(`${base}/api/internal/artifacts`, {
      method: 'POST',
      headers: {
        'x-runtime-token': RUNTIME_TOKEN,
        'x-workspace-id': owner.workspaceId,
        'x-produced-by': 'bot_report',
        'x-artifact-kind': 'html',
        'x-artifact-name': 'report.html',
        'x-file-mime': 'text/html',
        'content-type': 'application/octet-stream',
      },
      body: html,
    })
    assert.equal(res.status, 201)
    const body = (await res.json()) as {
      artifact: { size: number; width: number | null; height: number | null; thumbId: string | null }
      thumbnail: unknown
      thumbUnavailable?: string
    }
    assert.equal(body.artifact.size, html.byteLength)
    assert.equal(body.artifact.width, null)
    assert.equal(body.artifact.height, null)
    assert.equal(body.artifact.thumbId, null)
    assert.equal(body.thumbnail, null)
    assert.equal('thumbUnavailable' in body, false)
  })
})

test('用户上传：小图 passthrough 时 thumbnail=null，响应字段齐全', async () => {
  await withApi(async ({ base }) => {
    const owner = await pair(base, 'acc_thumb_user')
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

    const body = (await res.json()) as {
      attachment: { id: string; size: number; url: string }
      thumbnail: unknown
      thumbUnavailable?: string
    }
    assert.equal(body.attachment.size, bytes.byteLength)
    assert.match(body.attachment.url, /^\/api\/attachments\/[0-9a-f]{32}\?token=/)
    assert.equal(body.thumbnail, null)
    assert.equal('thumbUnavailable' in body, false)

    // 原图仍可签名读取。
    const file = await fetch(`${base}${body.attachment.url}`)
    assert.equal(file.status, 200)
    assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [...bytes])
  })
})
