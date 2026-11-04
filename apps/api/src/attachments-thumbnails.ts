// 上传整理：EXIF 剥离 + 缩略图（docs/build/wave3.md §C、docs/design/artifacts.md §4）。
//
// 分工：
//   * `prepareUpload` 纯整理，不碰数据库、不碰内容存储：输入原始 bytes/mime，
//     输出「剥过 EXIF 的 bytes」+「可选缩略图」+「不可用原因」。
//     缩略图任何失败都只落到 `thumbUnavailable`，原图 bytes 一定可用。
//   * `persistThumbnail` 把缩略图字节写进内容存储，并按现有 schema 登记
//     `attachments` 行 + `artifact:<id>` 合成引用（缩略图不会 7 天后被 GC）。
//
// 缩略图永远存成独立内容对象（`artifacts.thumb_id` 指向它），原图字节不变；
// 原图与缩略图都是内容寻址的，重复上传同一张图不会多存一份。
//
// 零依赖：node:child_process / node:fs / node:os / node:path + packages/storage。

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_THUMBNAIL_MAX_EDGE,
  detectImageFormat,
  detectImageSize,
  normalizeMime,
  planThumbnail,
  prepareImage,
  renderThumbnail,
} from '../../../packages/storage/src/index.ts'
import type {
  ContentStore,
  ThumbnailPlan,
  ThumbnailRunner,
  ThumbnailRunnerResult,
  ThumbnailTools,
} from '../../../packages/storage/src/index.ts'
import { addAttachmentRef, putAttachment } from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'

/** 缩略图统一输出 JPEG（与 packages/storage 的 renderThumbnail 一致）。 */
export const THUMBNAIL_MIME = 'image/jpeg'

/** 单条外部命令的超时；超时按失败降级，不拖住上传。 */
const COMMAND_TIMEOUT_MS = 15_000
const MAX_REASON_CHARS = 300
const TEMP_PREFIX = 'roost-upload-'

export interface UploadThumbnail {
  bytes: Uint8Array
  mime: string
}

export interface PrepareUploadInput {
  bytes: Uint8Array
  mime: string
  /** 注入外部命令执行器（测试用）；默认 execFile sips / pdftoppm / magick。 */
  runner?: ThumbnailRunner
  /** 临时目录；不传则每次上传自建并从 tmpdir 清掉。 */
  workDir?: string
  /** 缩略图长边上限；默认 320（DEFAULT_THUMBNAIL_MAX_EDGE）。 */
  maxEdge?: number
  /** 工具可用性；不传则 PDF 现场探测 PATH。图片不依赖工具探测。 */
  tools?: ThumbnailTools
}

export interface PreparedUpload {
  /** 落盘用的原图字节（JPEG 已剥 EXIF；非 JPEG 原样）。 */
  bytes: Uint8Array
  /** JPEG 的 APP1（EXIF/XMP）确实被移除。 */
  strippedExif: boolean
  /** 可用缩略图；passthrough（已经够小）或失败时为 undefined。 */
  thumbnail?: UploadThumbnail
  /** 有值表示「想要缩略图但没拿到」；不影响原图上传。 */
  thumbUnavailable?: string
}

/**
 * 上传整理：
 *   1. 按真实文件头认图片（声明 mime 与字节冲突时以字节为准），JPEG 先剥 EXIF；
 *   2. 图片 / PDF 走 planThumbnail，只有 render 才真的执行命令；
 *   3. 任何缩略图失败只写 `thumbUnavailable`，不抛、不改原图。
 */
export async function prepareUpload(input: PrepareUploadInput): Promise<PreparedUpload> {
  const mime = processingMime(input.mime, input.bytes)
  const image = prepareImage({ bytes: input.bytes, mime })
  const base: PreparedUpload = { bytes: image.bytes, strippedExif: image.strippedExif }

  const wantsThumbnail = mime.startsWith('image/') || mime === 'application/pdf'
  if (!wantsThumbnail) return base

  let plan: ThumbnailPlan
  try {
    plan = planThumbnail({
      mime,
      bytes: image.bytes,
      ...(input.maxEdge === undefined ? {} : { maxEdge: input.maxEdge }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
    })
  } catch (err) {
    return { ...base, thumbUnavailable: truncateReason(messageOf(err)) }
  }

  if (plan.mode === 'passthrough') return base
  if (plan.mode === 'unsupported') {
    return {
      ...base,
      thumbUnavailable: truncateReason(plan.reason ?? `thumbnail unsupported for ${mime}`),
    }
  }

  let ownedDir: string | null = null
  let workDir = input.workDir
  try {
    if (workDir === undefined) {
      ownedDir = mkdtempSync(join(tmpdir(), TEMP_PREFIX))
      workDir = ownedDir
    }
    const rendered = await renderThumbnail({
      bytes: image.bytes,
      mime,
      runner: input.runner ?? defaultThumbnailRunner,
      workDir,
      ...(input.maxEdge === undefined ? {} : { maxEdge: input.maxEdge }),
    })
    if (!rendered.ok) {
      return { ...base, thumbUnavailable: truncateReason(rendered.reason) }
    }
    // renderThumbnail 对 JPEG 输入的临时输入/输出同路径：命令 exit 0 却没写文件时，
    // 读回的就是原图本身。缩略图必须真的是一张「不超过长边上限」的图才算数。
    const edge = thumbnailEdge(input.maxEdge)
    if (!isUsableThumbnail(rendered.bytes, edge)) {
      return {
        ...base,
        thumbUnavailable: `thumbnailer produced no usable image within ${edge}px`,
      }
    }
    return { ...base, thumbnail: { bytes: rendered.bytes, mime: THUMBNAIL_MIME } }
  } catch (err) {
    // renderThumbnail 承诺不抛；这里兜住 runner/mkdtemp 的意外，保持「原图优先」。
    return { ...base, thumbUnavailable: truncateReason(messageOf(err)) }
  } finally {
    if (ownedDir !== null) {
      try {
        rmSync(ownedDir, { recursive: true, force: true })
      } catch {
        // 临时目录清理失败不影响上传。
      }
    }
  }
}

export interface StoredThumbnail {
  /** 内容寻址对象 id；同时写进 `artifacts.thumb_id`。 */
  artifactId: string
  mime: string
  width: number | null
  height: number | null
}

export interface PersistThumbnailInput {
  store: Store
  content: ContentStore
  thumbnail: UploadThumbnail
  workspaceId: string
  owner: string
  createdAt: number
  audience?: string
  /** 缩略图服务的产物 id：写 `artifact:<id>` 引用，避免被 GC 掉。 */
  ownerArtifactId?: string
}

/**
 * 缩略图登记：内容存储 put → `attachments` 行 → 合成引用。
 * 任何一步失败返回 null（缩略图是增强项，绝不影响原图上传）。
 */
export async function persistThumbnail(input: PersistThumbnailInput): Promise<StoredThumbnail | null> {
  const audience = input.audience ?? 'team'
  try {
    const stored = await input.content.put(input.thumbnail.bytes, {
      mime: input.thumbnail.mime,
      owner: input.owner,
      audience,
    })
    putAttachment(input.store, {
      id: stored.id,
      workspaceId: input.workspaceId,
      sha256: stored.sha256,
      size: stored.size,
      mime: input.thumbnail.mime,
      owner: input.owner,
      audience,
      createdAt: input.createdAt,
    })
    if (input.ownerArtifactId !== undefined) {
      addAttachmentRef(input.store, stored.id, `artifact:${input.ownerArtifactId}`)
    }
    const size = detectImageSize(input.thumbnail.bytes)
    return {
      artifactId: stored.id,
      mime: input.thumbnail.mime,
      width: size?.width ?? null,
      height: size?.height ?? null,
    }
  } catch (err) {
    console.error('roost api: thumbnail persist failed', err)
    return null
  }
}

interface ExecFileFailure {
  code?: unknown
  message?: string
}

/** 默认 runner：execFile，超时/非零/缺失都折算成 `{code}`，交给 renderThumbnail 降级。 */
export const defaultThumbnailRunner: ThumbnailRunner = (command, args) =>
  new Promise<ThumbnailRunnerResult>((resolvePromise) => {
    execFile(
      command,
      args,
      { timeout: COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolvePromise({ code: 0, stdout, stderr })
          return
        }
        const failure = error as ExecFileFailure
        const raw = failure.code
        const code = typeof raw === 'number' && Number.isFinite(raw) ? raw : 1
        resolvePromise({
          code,
          stdout,
          stderr: typeof stderr === 'string' && stderr !== '' ? stderr : (failure.message ?? ''),
        })
      },
    )
  })

/**
 * 实际处理用的 mime：文件头能认出图片就以字节为准（声明 mime 是用户输入，不可信）。
 * 这样 JPEG 假报 image/png / text/plain / octet-stream 都不会漏剥 EXIF；
 * 认不出图片时保持声明的 mime（PDF、HTML、CSV…）。
 */
function processingMime(mime: string, bytes: Uint8Array): string {
  const detected = detectImageFormat(bytes)
  if (detected !== null) return `image/${detected}`
  return normalizeMime(mime)
}

/** 与 planThumbnail/renderThumbnail 的 edgeOf 保持一致。 */
function thumbnailEdge(maxEdge: number | undefined): number {
  if (maxEdge === undefined || !Number.isFinite(maxEdge) || maxEdge <= 0) {
    return DEFAULT_THUMBNAIL_MAX_EDGE
  }
  return Math.max(16, Math.floor(maxEdge))
}

/** 缩略图必须可解析、且长边不超过上限（否则视为没生成）。 */
function isUsableThumbnail(bytes: Uint8Array, edge: number): boolean {
  if (bytes.byteLength === 0) return false
  const size = detectImageSize(bytes)
  if (size === null) return false
  return Math.max(size.width, size.height) <= edge
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function truncateReason(text: string): string {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS)}…` : text
}
