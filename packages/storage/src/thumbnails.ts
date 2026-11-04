// 缩略图规划与渲染（docs/design/artifacts.md §4 / §6）。
//
// 两步分开，方便在没有外部工具时也能单测：
//   1. planThumbnail 纯函数：按 mime + 已解析宽高决定 passthrough / render / unsupported；
//   2. renderThumbnail 注入 runner：真正执行命令，按 `sips` → `pdftoppm`（仅 PDF）→
//      `magick` 顺序尝试，成功返回 `{ok:true,bytes}`（从 workDir 读回），失败返回
//      `{ok:false,reason}`，永不抛。
//
// 工具探测只读 PATH（probeThumbnailTools）；planThumbnail 对 PDF 默认现场探测，
// 测试可传 tools 保持确定性。零依赖：node:fs / node:path / image.ts。

import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, delimiter, join } from 'node:path'

import { detectImageFormat, detectImageSize, stripJpegExif } from './image.ts'

/** 聊天内缩略图长边（artifacts.md §6）；登记用大图另见 image.ts 的 640。 */
export const DEFAULT_THUMBNAIL_MAX_EDGE = 320

export type ThumbnailMode = 'passthrough' | 'render' | 'unsupported'

export interface ThumbnailPlan {
  mode: ThumbnailMode
  reason?: string
}

/** 可用的外部命令；undefined 表示未知（不阻止规划，交给渲染阶段失败降级）。 */
export interface ThumbnailTools {
  sips?: boolean
  pdftoppm?: boolean
  magick?: boolean
}

export interface PlanThumbnailInput {
  mime: string
  bytes: Uint8Array
  maxEdge?: number
  /** 不传则 PDF 现场探测 PATH；图片不依赖工具探测。 */
  tools?: ThumbnailTools
}

export interface ThumbnailRunnerResult {
  code: number
  stdout?: string
  stderr?: string
}

export type ThumbnailRunner = (
  command: string,
  args: string[],
) => Promise<ThumbnailRunnerResult> | ThumbnailRunnerResult

export interface RenderThumbnailInput {
  bytes: Uint8Array
  mime: string
  runner: ThumbnailRunner
  workDir: string
  maxEdge?: number
}

export type RenderThumbnailResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: string }

export interface PrepareImageResult {
  bytes: Uint8Array
  /** JPEG 的 APP1（EXIF/XMP）确实被移除时为 true。 */
  strippedExif: boolean
}

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_REASON_CHARS = 300

/** 去掉参数、统一大小写；image/jpg 归一到 image/jpeg。 */
export function normalizeMime(mime: string): string {
  const base = (mime ?? '').split(';')[0]!.trim().toLowerCase()
  if (base === 'image/jpg') return 'image/jpeg'
  return base
}

function mimeFromBytes(bytes: Uint8Array): string {
  const format = detectImageFormat(bytes)
  if (format === 'png') return 'image/png'
  if (format === 'jpeg') return 'image/jpeg'
  if (format === 'gif') return 'image/gif'
  if (format === 'webp') return 'image/webp'
  return ''
}

function edgeOf(maxEdge: number | undefined): number {
  if (maxEdge === undefined || !Number.isFinite(maxEdge) || maxEdge <= 0) {
    return DEFAULT_THUMBNAIL_MAX_EDGE
  }
  return Math.max(16, Math.floor(maxEdge))
}

function truncateReason(text: string): string {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS)}…` : text
}

/**
 * 规划缩略图处理方式：
 *   * png/jpeg/gif/webp 且任一边 > maxEdge → render；
 *   * 已经够小 → passthrough(reason='within_max_edge')；
 *   * PDF → 有 pdftoppm 才 render，否则 unsupported；
 *   * 其他 mime / 坏文件头 → unsupported。
 */
export function planThumbnail(input: PlanThumbnailInput): ThumbnailPlan {
  const mime = normalizeMime(input.mime) || mimeFromBytes(input.bytes)
  const edge = edgeOf(input.maxEdge)

  if (mime === 'application/pdf') {
    const tools = input.tools ?? probeThumbnailTools()
    if (tools.pdftoppm === false) {
      return { mode: 'unsupported', reason: 'pdftoppm not available for pdf thumbnails' }
    }
    return { mode: 'render', reason: 'pdf_first_page' }
  }

  if (!IMAGE_MIMES.has(mime)) {
    return {
      mode: 'unsupported',
      reason: truncateReason(`unsupported mime: ${mime === '' ? 'unknown' : mime}`),
    }
  }

  const size = detectImageSize(input.bytes)
  if (size === null) {
    return { mode: 'unsupported', reason: 'unreadable image header' }
  }
  if (size.width <= edge && size.height <= edge) {
    return { mode: 'passthrough', reason: 'within_max_edge' }
  }
  return { mode: 'render' }
}

/** 读 PATH 判断命令是否存在（只查可执行位；不执行命令）。 */
export function probeThumbnailTools(
  env: Record<string, string | undefined> = process.env,
): ThumbnailTools {
  const dirs = (env['PATH'] ?? '').split(delimiter).filter((dir) => dir !== '')
  const has = (name: string): boolean => {
    for (const dir of dirs) {
      try {
        accessSync(join(dir, name), constants.X_OK)
        return true
      } catch {
        // 继续看下一个目录。
      }
    }
    return false
  }
  return { sips: has('sips'), pdftoppm: has('pdftoppm'), magick: has('magick') }
}

interface ThumbnailCandidate {
  command: string
  args: string[]
  outputs: string[]
  /** pdftoppm 的页码会随 PDF 页数补零（-1 / -01 / -001），按前缀兜底扫描。 */
  pagePrefix?: string
}

/**
 * 尽力渲染 JPEG 缩略图。输入先写进 workDir，命令成功且产物非空才算成功；
 * 某个命令缺失/非零/无产物就换下一个，全部失败返回 ok:false。
 */
export async function renderThumbnail(input: RenderThumbnailInput): Promise<RenderThumbnailResult> {
  const mime = normalizeMime(input.mime) || mimeFromBytes(input.bytes)
  const edge = edgeOf(input.maxEdge)
  const isPdf = mime === 'application/pdf'
  if (!isPdf && !IMAGE_MIMES.has(mime)) {
    return { ok: false, reason: `unsupported mime: ${mime === '' ? 'unknown' : mime}` }
  }
  if (input.bytes.byteLength === 0) {
    return { ok: false, reason: 'empty input' }
  }

  const token = `${process.pid.toString(36)}-${Date.now().toString(36)}-${counter()}`
  const filePrefix = `roost-thumb-${token}`
  const inputPath = join(input.workDir, `${filePrefix}.${isPdf ? 'pdf' : extensionFor(input.bytes)}`)
  const outputPath = join(input.workDir, `${filePrefix}.jpg`)
  const pagePrefix = join(input.workDir, `${filePrefix}-page`)

  try {
    mkdirSync(input.workDir, { recursive: true })
    writeFileSync(inputPath, input.bytes)
  } catch {
    return { ok: false, reason: 'workDir is not writable' }
  }

  const candidates: ThumbnailCandidate[] = [
    {
      command: 'sips',
      args: ['-Z', String(edge), '-s', 'format', 'jpeg', inputPath, '--out', outputPath],
      outputs: [outputPath],
    },
  ]
  if (isPdf) {
    candidates.push({
      command: 'pdftoppm',
      args: ['-jpeg', '-scale-to', String(edge), inputPath, pagePrefix],
      outputs: [`${pagePrefix}-1.jpg`, `${pagePrefix}-01.jpg`],
      pagePrefix,
    })
  }
  candidates.push({
    command: 'magick',
    args: [inputPath, '-resize', `${edge}x${edge}>`, '-quality', '82', outputPath],
    outputs: [outputPath],
  })

  const failures: string[] = []
  try {
    for (const candidate of candidates) {
      let result: ThumbnailRunnerResult
      try {
        result = await input.runner(candidate.command, candidate.args)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failures.push(`${candidate.command} failed: ${message}`)
        continue
      }
      if (!result || result.code !== 0) {
        failures.push(`${candidate.command} exited ${result ? result.code : 'unknown'}`)
        continue
      }
      let found = false
      for (const path of candidate.outputs) {
        const bytes = safeRead(path)
        if (bytes !== null && bytes.byteLength > 0) {
          return { ok: true, bytes }
        }
        if (bytes !== null) found = true
      }
      if (candidate.pagePrefix !== undefined) {
        const pageBytes = readFirstPrefixed(input.workDir, basename(candidate.pagePrefix))
        if (pageBytes !== null) return { ok: true, bytes: pageBytes }
      }
      failures.push(
        found ? `${candidate.command} produced an empty file` : `${candidate.command} produced no output`,
      )
    }
  } finally {
    cleanupPrefixed(input.workDir, filePrefix)
  }

  return {
    ok: false,
    reason: truncateReason(`no thumbnailer produced output (${failures.join('; ')})`),
  }
}

/**
 * 登记前的图片整理：JPEG 调 stripJpegExif 去掉 APP1（GPS/设备信息），其余类型原样。
 * 返回新 bytes，不修改入参。
 */
export function prepareImage(input: { bytes: Uint8Array; mime: string }): PrepareImageResult {
  const mime = normalizeMime(input.mime) || mimeFromBytes(input.bytes)
  if (mime !== 'image/jpeg') {
    return { bytes: input.bytes, strippedExif: false }
  }
  const stripped = stripJpegExif(input.bytes)
  return { bytes: stripped, strippedExif: stripped.byteLength !== input.bytes.byteLength }
}

function extensionFor(bytes: Uint8Array): string {
  const format = detectImageFormat(bytes)
  if (format === 'png') return 'png'
  if (format === 'gif') return 'gif'
  if (format === 'webp') return 'webp'
  return 'jpg'
}

let counterValue = 0
function counter(): number {
  counterValue = (counterValue + 1) % 1_000_000
  return counterValue
}

function safeRead(path: string): Uint8Array | null {
  try {
    const buffer = readFileSync(path)
    return buffer.byteLength === 0 ? null : new Uint8Array(buffer)
  } catch {
    return null
  }
}

function safeRemove(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // 清理失败不影响结果。
  }
}

/** 读目录里第一个以 prefix 开头的 jpg（pdftoppm 页码补零时用）。 */
function readFirstPrefixed(dir: string, prefix: string): Uint8Array | null {
  try {
    const names = readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.jpg'))
      .sort()
    for (const name of names) {
      const bytes = safeRead(join(dir, name))
      if (bytes !== null && bytes.byteLength > 0) return bytes
    }
  } catch {
    // 读不了目录按失败处理。
  }
  return null
}

/** 删除本次渲染产生的全部临时文件（输入 + 输出，含 pdftoppm 的多页产物）。 */
function cleanupPrefixed(dir: string, prefix: string): void {
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(prefix)) safeRemove(join(dir, name))
    }
  } catch {
    // 临时目录清理失败不影响缩略图本身。
  }
}
