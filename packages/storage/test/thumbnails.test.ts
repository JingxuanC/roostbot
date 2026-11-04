// 缩略图：plan 的 render/passthrough/unsupported、命令选择与失败降级、EXIF 整理。
import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_THUMBNAIL_MAX_EDGE,
  planThumbnail,
  prepareImage,
  probeThumbnailTools,
  renderThumbnail,
} from '../src/thumbnails.ts'
import type { ThumbnailRunner } from '../src/thumbnails.ts'

function png(width: number, height: number): Uint8Array {
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

function gif(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(13)
  bytes.write('GIF89a', 0, 'ascii')
  bytes.writeUInt16LE(width, 6)
  bytes.writeUInt16LE(height, 8)
  return new Uint8Array(bytes)
}

/** SOI + APP1(Exif) + SOF0 + SOS + 熵数据 + EOI。 */
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

function webpVp8x(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(30)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(22, 4)
  bytes.write('WEBP', 8, 'ascii')
  bytes.write('VP8X', 12, 'ascii')
  bytes.writeUInt32LE(10, 16)
  bytes[20] = 0
  bytes.writeUIntLE(width - 1, 24, 3)
  bytes.writeUIntLE(height - 1, 27, 3)
  return new Uint8Array(bytes)
}

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'roost-thumb-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const THUMB = jpeg(8, 8, false)

test('planThumbnail：图片超过 maxEdge → render，默认长边 320', () => {
  assert.equal(DEFAULT_THUMBNAIL_MAX_EDGE, 320)
  assert.deepEqual(planThumbnail({ mime: 'image/png', bytes: png(640, 480) }), { mode: 'render' })
  assert.deepEqual(planThumbnail({ mime: 'image/jpeg', bytes: jpeg(1024, 768) }), { mode: 'render' })
  assert.deepEqual(planThumbnail({ mime: 'image/webp', bytes: webpVp8x(800, 600) }), { mode: 'render' })
  assert.deepEqual(planThumbnail({ mime: 'image/gif', bytes: gif(640, 100) }), { mode: 'render' })
})

test('planThumbnail：边界 320 直接 passthrough，321 才 render', () => {
  assert.deepEqual(planThumbnail({ mime: 'image/png', bytes: png(320, 200) }), {
    mode: 'passthrough',
    reason: 'within_max_edge',
  })
  assert.deepEqual(planThumbnail({ mime: 'image/png', bytes: png(320, 320) }), {
    mode: 'passthrough',
    reason: 'within_max_edge',
  })
  assert.deepEqual(planThumbnail({ mime: 'image/png', bytes: png(321, 320) }), { mode: 'render' })
  assert.deepEqual(planThumbnail({ mime: 'image/jpeg', bytes: jpeg(300, 301) }), {
    mode: 'passthrough',
    reason: 'within_max_edge',
  })
})

test('planThumbnail：mime 带参数/大写、image/jpg 归一到 jpeg', () => {
  assert.deepEqual(planThumbnail({ mime: 'IMAGE/JPEG; charset=binary', bytes: jpeg(800, 600) }), {
    mode: 'render',
  })
  assert.deepEqual(planThumbnail({ mime: 'image/jpg', bytes: jpeg(100, 100) }), {
    mode: 'passthrough',
    reason: 'within_max_edge',
  })
})

test('planThumbnail：非图片 mime / 坏文件头 → unsupported', () => {
  assert.deepEqual(planThumbnail({ mime: 'application/zip', bytes: png(10, 10) }), {
    mode: 'unsupported',
    reason: 'unsupported mime: application/zip',
  })
  assert.deepEqual(planThumbnail({ mime: 'image/svg+xml', bytes: png(10, 10) }), {
    mode: 'unsupported',
    reason: 'unsupported mime: image/svg+xml',
  })
  assert.deepEqual(planThumbnail({ mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) }), {
    mode: 'unsupported',
    reason: 'unreadable image header',
  })
})

test('planThumbnail：PDF 需要 pdftoppm，缺失时 unsupported', () => {
  const bytes = new Uint8Array(Buffer.from('%PDF-1.7\n'))
  assert.deepEqual(planThumbnail({ mime: 'application/pdf', bytes, tools: { pdftoppm: true } }), {
    mode: 'render',
    reason: 'pdf_first_page',
  })
  assert.deepEqual(planThumbnail({ mime: 'application/pdf', bytes, tools: { pdftoppm: false } }), {
    mode: 'unsupported',
    reason: 'pdftoppm not available for pdf thumbnails',
  })
})

test('planThumbnail：自定义 maxEdge 决定是否 render', () => {
  assert.deepEqual(planThumbnail({ mime: 'image/png', bytes: png(640, 480), maxEdge: 1000 }), {
    mode: 'passthrough',
    reason: 'within_max_edge',
  })
  assert.deepEqual(planThumbnail({ mime: 'image/png', bytes: png(640, 480), maxEdge: 100 }), {
    mode: 'render',
  })
})

test('renderThumbnail：sips 成功，产物从 workDir 读回并清理', async (t) => {
  const root = tempDir(t)
  const workDir = join(root, 'nested', 'work')
  const commands: string[][] = []
  let inputSeen: Uint8Array | null = null

  const runner: ThumbnailRunner = async (command, args) => {
    commands.push([command, ...args])
    const out = args[args.indexOf('--out') + 1]!
    inputSeen = new Uint8Array(readFileSync(args[args.indexOf('--out') - 1]!))
    writeFileSync(out, THUMB)
    return { code: 0 }
  }

  const source = png(640, 480)
  const result = await renderThumbnail({ bytes: source, mime: 'image/png', runner, workDir })

  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(new Uint8Array(result.bytes), THUMB)
  assert.deepEqual(inputSeen, source)
  assert.equal(commands.length, 1)
  assert.equal(commands[0]![0], 'sips')
  assert.deepEqual(commands[0]!.slice(1, 6), ['-Z', '320', '-s', 'format', 'jpeg'])
  assert.equal(commands[0]![6]!.endsWith('.png'), true)
  assert.equal(commands[0]![7], '--out')
  assert.equal(commands[0]![8]!.endsWith('.jpg'), true)
  assert.equal(commands[0]![6]!.startsWith(workDir), true)
  // 成功返回后临时输入/输出都应清掉。
  assert.deepEqual(readdirSync(workDir), [])
})

test('renderThumbnail：sips 非零退出 → 降级 magick', async (t) => {
  const workDir = tempDir(t)
  const commands: string[] = []

  const runner: ThumbnailRunner = async (command, args) => {
    commands.push(command)
    if (command === 'sips') return { code: 1, stderr: 'sips: unsupported' }
    writeFileSync(args.at(-1)!, THUMB)
    return { code: 0 }
  }

  const result = await renderThumbnail({ bytes: png(640, 480), mime: 'image/png', runner, workDir })
  assert.equal(result.ok, true)
  assert.deepEqual(commands, ['sips', 'magick'])
  assert.deepEqual(readdirSync(workDir), [])
})

test('renderThumbnail：命令全失败返回 ok:false，不抛', async (t) => {
  const workDir = tempDir(t)
  const runner: ThumbnailRunner = async () => ({ code: 127, stderr: 'not found' })

  const result = await renderThumbnail({ bytes: png(640, 480), mime: 'image/png', runner, workDir })
  assert.equal(result.ok, false)
  if (result.ok === false) {
    assert.match(result.reason, /no thumbnailer produced output/)
    assert.match(result.reason, /sips exited 127/)
    assert.match(result.reason, /magick exited 127/)
  }
  assert.deepEqual(readdirSync(workDir), [])
})

test('renderThumbnail：runner 抛异常也降级，不冒泡', async (t) => {
  const workDir = tempDir(t)
  const commands: string[] = []
  const runner: ThumbnailRunner = async (command, args) => {
    commands.push(command)
    if (command === 'sips') throw new Error('spawn sips ENOENT')
    writeFileSync(args.at(-1)!, THUMB)
    return { code: 0 }
  }

  const result = await renderThumbnail({ bytes: jpeg(640, 480), mime: 'image/jpeg', runner, workDir })
  assert.equal(result.ok, true)
  assert.deepEqual(commands, ['sips', 'magick'])
})

test('renderThumbnail：命令 exit 0 但没产物 → 继续尝试下一个', async (t) => {
  const workDir = tempDir(t)
  const commands: string[] = []
  const runner: ThumbnailRunner = async (command, args) => {
    commands.push(command)
    if (command === 'magick') writeFileSync(args.at(-1)!, THUMB)
    return { code: 0 }
  }

  const result = await renderThumbnail({ bytes: webpVp8x(800, 600), mime: 'image/webp', runner, workDir })
  assert.equal(result.ok, true)
  assert.deepEqual(commands, ['sips', 'magick'])
})

test('renderThumbnail：PDF 在 sips 失败后走 pdftoppm，读回 -1.jpg', async (t) => {
  const workDir = tempDir(t)
  const commands: string[][] = []
  let pdfArgs: string[] = []

  const runner: ThumbnailRunner = async (command, args) => {
    commands.push([command, ...args])
    if (command === 'sips') return { code: 1 }
    if (command === 'pdftoppm') {
      pdfArgs = args
      writeFileSync(`${args.at(-1)!}-1.jpg`, THUMB)
      return { code: 0 }
    }
    return { code: 1 }
  }

  const result = await renderThumbnail({
    bytes: new Uint8Array(Buffer.from('%PDF-1.7\n')),
    mime: 'application/pdf',
    runner,
    workDir,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(commands.map((entry) => entry[0]), ['sips', 'pdftoppm'])
  assert.deepEqual(pdfArgs.slice(0, 3), ['-jpeg', '-scale-to', '320'])
  assert.equal(pdfArgs[3]!.endsWith('.pdf'), true)
  assert.equal(pdfArgs[4]!.endsWith('-page'), true)
})

test('renderThumbnail：pdftoppm 页码补零（-001.jpg）也能读回', async (t) => {
  const workDir = tempDir(t)
  const runner: ThumbnailRunner = async (command, args) => {
    if (command === 'sips') return { code: 1 }
    if (command === 'pdftoppm') {
      writeFileSync(`${args.at(-1)!}-001.jpg`, THUMB)
      return { code: 0 }
    }
    return { code: 1 }
  }

  const result = await renderThumbnail({
    bytes: new Uint8Array(Buffer.from('%PDF-1.7\n')),
    mime: 'application/pdf',
    runner,
    workDir,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(readdirSync(workDir), [])
})

test('renderThumbnail：不支持的 mime / 空输入直接失败，不调用 runner', async (t) => {
  const workDir = tempDir(t)
  const commands: string[] = []
  const runner: ThumbnailRunner = async (command) => {
    commands.push(command)
    return { code: 0 }
  }

  const unsupported = await renderThumbnail({
    bytes: new Uint8Array([1, 2, 3]),
    mime: 'application/zip',
    runner,
    workDir,
  })
  assert.equal(unsupported.ok, false)
  assert.match(unsupported.ok === false ? unsupported.reason : '', /unsupported mime: application\/zip/)

  const empty = await renderThumbnail({ bytes: new Uint8Array(), mime: 'image/png', runner, workDir })
  assert.equal(empty.ok, false)
  assert.match(empty.ok === false ? empty.reason : '', /empty input/)
  assert.deepEqual(commands, [])
})

test('prepareImage：JPEG 剥 APP1，返回 strippedExif', () => {
  const original = jpeg(640, 480, true)
  const prepared = prepareImage({ bytes: original, mime: 'image/jpeg' })
  assert.equal(prepared.strippedExif, true)
  assert.equal(prepared.bytes.byteLength, original.byteLength - 18)
  assert.equal(prepared.bytes.includes(Buffer.from('Exif', 'ascii')), false)
  // 入参不被修改。
  assert.equal(original.byteLength, jpeg(640, 480, true).byteLength)

  const clean = jpeg(640, 480, false)
  const untouched = prepareImage({ bytes: clean, mime: 'image/jpeg' })
  assert.equal(untouched.strippedExif, false)
  assert.equal(untouched.bytes.byteLength, clean.byteLength)
})

test('prepareImage：非 JPEG 原样返回，strippedExif=false', () => {
  const source = png(100, 100)
  const prepared = prepareImage({ bytes: source, mime: 'image/png' })
  assert.equal(prepared.strippedExif, false)
  assert.equal(prepared.bytes, source)
})

test('probeThumbnailTools：只按 PATH 判断可执行文件', (t) => {
  const dir = tempDir(t)
  writeFileSync(join(dir, 'sips'), '')
  chmodSync(join(dir, 'sips'), 0o755)
  assert.deepEqual(probeThumbnailTools({ PATH: dir }), {
    sips: true,
    pdftoppm: false,
    magick: false,
  })
  assert.deepEqual(probeThumbnailTools({ PATH: '' }), {
    sips: false,
    pdftoppm: false,
    magick: false,
  })
})

test('renderThumbnail：workDir 不存在时自动创建', async (t) => {
  const root = tempDir(t)
  const workDir = join(root, 'a', 'b', 'c')
  mkdirSync(root, { recursive: true })
  const runner: ThumbnailRunner = async (_command, args) => {
    writeFileSync(args.at(-1)!, THUMB)
    return { code: 0 }
  }
  const result = await renderThumbnail({ bytes: png(640, 480), mime: 'image/png', runner, workDir })
  assert.equal(result.ok, true)
})
