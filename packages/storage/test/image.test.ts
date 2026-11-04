import assert from 'node:assert/strict'
import test from 'node:test'

import { detectImageFormat, detectImageSize, generateThumbnail, stripJpegExif } from '../src/index.ts'

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
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])])
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

test('PNG/JPEG/GIF/WebP 宽高只读文件头', () => {
  assert.deepEqual(detectImageSize(png(1280, 720)), { width: 1280, height: 720, format: 'png' })
  assert.deepEqual(detectImageSize(gif(320, 200)), { width: 320, height: 200, format: 'gif' })
  assert.deepEqual(detectImageSize(jpeg(800, 600)), { width: 800, height: 600, format: 'jpeg' })
  assert.deepEqual(detectImageSize(webpVp8x(1024, 512)), { width: 1024, height: 512, format: 'webp' })

  assert.equal(detectImageFormat(png(1, 1)), 'png')
  assert.equal(detectImageFormat(new Uint8Array([1, 2, 3])), null)
  assert.equal(detectImageSize(new Uint8Array([1, 2, 3])), null)
  assert.equal(detectImageSize(png(1, 1).subarray(0, 20)), null)
})

test('JPEG 删除 APP1（EXIF），其余字节原样保留', () => {
  const original = jpeg(640, 480, true)
  const stripped = stripJpegExif(original)
  assert.equal(stripped.byteLength, original.byteLength - 18)
  // 只剩 SOI → SOF0 → SOS → EOI，不再有 APP1。
  assert.deepEqual([...stripped.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xc0])
  assert.equal(stripped.includes(Buffer.from('Exif', 'ascii')), false)
  assert.deepEqual(detectImageSize(stripped), { width: 640, height: 480, format: 'jpeg' })
  // 没有 EXIF 时内容不变。
  const plain = jpeg(640, 480, false)
  assert.deepEqual([...stripJpegExif(plain)], [...plain])
  // 非 JPEG 原样返回。
  const p = png(2, 2)
  assert.deepEqual([...stripJpegExif(p)], [...p])
})

test('缩略图缺失工具/坏输入都降级为 null，不抛错', async () => {
  assert.equal(await generateThumbnail(new Uint8Array([1, 2, 3]), 'image/png'), null)
  assert.equal(await generateThumbnail(png(10, 10), 'text/plain'), null)
  // 损坏的 PNG：即使有 sips/convert 也失败 → null。
  assert.equal(await generateThumbnail(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png'), null)
})
