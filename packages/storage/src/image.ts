// 图片整理纯函数（docs/design/artifacts.md §4「登记时的整理」）。
//
// 零依赖：
//   * 只读文件头解析 PNG / JPEG / GIF / WebP 的宽高；
//   * JPEG 删除 APP1 段（EXIF/XMP），其余字节原样保留；
//   * 缩略图尽力而为：macOS 用 sips，Linux 用 ImageMagick convert；缺失或失败返回 null。
//
// PDF 首页缩略图需要 PDF 渲染器，v0 不引入依赖，留待后续（见 docs/design/artifacts.md §11）。

import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp'

export interface ImageSize {
  width: number
  height: number
  format: ImageFormat
}

/** 缩略图长边上限（artifacts.md §4）。 */
export const THUMB_LONG_EDGE = 640

function be16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function be32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  )
}

function le16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) & 0xffff
}

function le24(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16)) & 0xffffff
}

function le32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  )
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i] ?? 0)
  return out
}

/** 识别图片格式；只看文件头，不读整张图。 */
export function detectImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.byteLength >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') return 'png'
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.byteLength >= 6 && (ascii(bytes, 0, 3) === 'GIF')) return 'gif'
  if (bytes.byteLength >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp'
  return null
}

/** 解析图片宽高；格式不认识或文件头不完整返回 null。 */
export function detectImageSize(bytes: Uint8Array): ImageSize | null {
  const format = detectImageFormat(bytes)
  if (format === null) return null
  if (format === 'png') return pngSize(bytes)
  if (format === 'gif') return gifSize(bytes)
  if (format === 'jpeg') return jpegSize(bytes)
  return webpSize(bytes)
}

function pngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.byteLength < 24) return null
  if (ascii(bytes, 12, 4) !== 'IHDR') return null
  return { width: be32(bytes, 16), height: be32(bytes, 20), format: 'png' }
}

function gifSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.byteLength < 10) return null
  return { width: le16(bytes, 6), height: le16(bytes, 8), format: 'gif' }
}

/** SOF 标记（C0-C3, C5-C7, C9-CB, CD-CF）：携带帧宽高。 */
function isSofMarker(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  )
}

function jpegSize(bytes: Uint8Array): ImageSize | null {
  let i = 2
  const len = bytes.byteLength
  while (i + 3 < len) {
    if (bytes[i] !== 0xff) return null
    let m = i + 1
    while (m < len && bytes[m] === 0xff) m += 1
    if (m >= len) return null
    const marker = bytes[m]!
    // 无长度的独立标记。
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i = m + 1
      continue
    }
    if (marker === 0xda) return null // 到了扫描数据还没见到 SOF
    if (m + 2 >= len) return null
    const segmentLength = be16(bytes, m + 1)
    if (segmentLength < 2) return null
    if (isSofMarker(marker)) {
      if (m + 7 >= len) return null
      // 段结构：FF C0 len(2) precision(1) height(2) width(2) ...
      return { width: be16(bytes, m + 6), height: be16(bytes, m + 4), format: 'jpeg' }
    }
    // 段长包含自身的两个字节；下一段从 marker 后两位开始算。
    i = m + 1 + segmentLength
  }
  return null
}

function webpSize(bytes: Uint8Array): ImageSize | null {
  let offset = 12
  const len = bytes.byteLength
  while (offset + 8 <= len) {
    const fourcc = ascii(bytes, offset, 4)
    const size = le32(bytes, offset + 4)
    const data = offset + 8
    if (data + size > len) return null
    if (fourcc === 'VP8 ') {
      if (size < 10) return null
      // 3 字节 frame tag + 3 字节起始码 9D 01 2A，然后是 14 位宽高。
      if (bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) return null
      return {
        width: le16(bytes, data + 6) & 0x3fff,
        height: le16(bytes, data + 8) & 0x3fff,
        format: 'webp',
      }
    }
    if (fourcc === 'VP8L') {
      if (size < 5 || bytes[data] !== 0x2f) return null
      const bits = le32(bytes, data + 1)
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
        format: 'webp',
      }
    }
    if (fourcc === 'VP8X') {
      if (size < 10) return null
      return {
        width: le24(bytes, data + 4) + 1,
        height: le24(bytes, data + 7) + 1,
        format: 'webp',
      }
    }
    // chunk 按 2 字节对齐。
    offset = data + size + (size % 2)
  }
  return null
}

/**
 * 删除 JPEG 的 APP1 段（EXIF/XMP）。非 JPEG 原样返回；解析异常也原样返回，
 * 避免为了隐私处理把一张好好的图弄坏。
 */
export function stripJpegExif(bytes: Uint8Array): Uint8Array {
  if (detectImageFormat(bytes) !== 'jpeg') return bytes
  const parts: Uint8Array[] = [bytes.subarray(0, 2)]
  const len = bytes.byteLength
  let i = 2

  while (i < len) {
    if (bytes[i] !== 0xff) {
      parts.push(bytes.subarray(i))
      break
    }
    const start = i
    let m = i + 1
    while (m < len && bytes[m] === 0xff) m += 1
    if (m >= len) {
      parts.push(bytes.subarray(start))
      break
    }
    const marker = bytes[m]!

    // SOS 之后是熵编码数据，原样保留到结尾。
    if (marker === 0xda) {
      parts.push(bytes.subarray(start))
      break
    }
    if (marker === 0xd9) {
      parts.push(bytes.subarray(start, m + 1))
      break
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.subarray(start, m + 1))
      i = m + 1
      continue
    }
    if (m + 2 >= len) {
      parts.push(bytes.subarray(start))
      break
    }
    const segmentLength = be16(bytes, m + 1)
    const end = m + 1 + segmentLength
    if (segmentLength < 2 || end > len) {
      parts.push(bytes.subarray(start))
      break
    }
    if (marker !== 0xe1) parts.push(bytes.subarray(start, end))
    i = end
  }

  return concat(parts)
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function extensionFor(bytes: Uint8Array, mime: string): string {
  const format = detectImageFormat(bytes)
  if (format === 'png') return 'png'
  if (format === 'gif') return 'gif'
  if (format === 'webp') return 'webp'
  if (format === 'jpeg') return 'jpg'
  if (mime.includes('png')) return 'png'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('webp')) return 'webp'
  return 'jpg'
}

function run(command: string, args: string[], timeoutMs = 15_000): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error) => {
      if (error) reject(error)
      else resolvePromise()
    })
  })
}

/**
 * 尽力生成 ≤640 长边的 JPEG 缩略图。
 * 没有 sips / convert、输入不是图片、或工具执行失败都返回 null（调用方降级为 thumbId=null）。
 */
export async function generateThumbnail(
  bytes: Uint8Array,
  mime: string,
  longEdge: number = THUMB_LONG_EDGE,
): Promise<Uint8Array | null> {
  if (!mime.startsWith('image/') || detectImageFormat(bytes) === null) return null
  const edge = Math.max(16, Math.floor(longEdge))
  const dir = mkdtempSync(join(tmpdir(), 'roost-thumb-'))
  const input = join(dir, `input.${extensionFor(bytes, mime)}`)
  const output = join(dir, 'thumb.jpg')
  try {
    writeFileSync(input, bytes)
    const attempts: Array<[string, string[]]> = [
      ['sips', ['-Z', String(edge), '-s', 'format', 'jpeg', input, '--out', output]],
      ['convert', [input, '-resize', `${edge}x${edge}>`, '-quality', '82', output]],
    ]
    for (const [command, args] of attempts) {
      try {
        await run(command, args)
        const thumb = readFileSync(output)
        if (thumb.byteLength > 0) return new Uint8Array(thumb)
      } catch {
        // 换下一个工具；都失败就返回 null。
      }
    }
    return null
  } catch {
    return null
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 临时目录清理失败不影响缩略图本身。
    }
  }
}
