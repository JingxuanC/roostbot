// 附件与产物 HTTP 路由（docs/design/storage.md、docs/design/artifacts.md）。
//
// 安全边界：
//   * 浏览器永远拿不到真实路径：消息级路由做「消息存在 + 房间 workspace 成员 + 消息确实引用」
//     三重校验；任何一步失败都 404，不泄漏存在性。
//   * 签名读取只认 HMAC + 过期时间；token 由 LocalVolumeStore 签发。
//   * 响应统一 Cache-Control: private, no-store + X-Content-Type-Options: nosniff。
//
// 本仓库适配：消息身份是 events.seq，所以文件路由是 /api/messages/:seq/files/:artifactId。

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Store } from '../../../packages/store/src/types.ts'
import {
  MAX_ATTACHMENTS_PER_EVENT,
  MAX_AVATAR_BYTES,
  MAX_OBJECT_BYTES,
  detectImageSize,
} from '../../../packages/storage/src/index.ts'
import { LocalVolumeStore } from '../../../packages/storage/src/index.ts'
import {
  ATTACHMENT_RETENTION_MS,
  ARTIFACT_KINDS,
  appendEvent,
  deleteAttachmentRows,
  getArtifact,
  linkArtifact,
  listCollectableAttachments,
  putArtifact,
  putAttachment,
  recordAttachmentGc,
} from '../../../packages/store/src/index.ts'
import type { Artifact, ArtifactKind } from '../../../packages/store/src/index.ts'
import { persistThumbnail, prepareUpload } from './attachments-thumbnails.ts'
import type { StoredThumbnail } from './attachments-thumbnails.ts'
import { authorizeRuntimeHttp, ensureRuntimeWorkspace } from './runtime-auth.ts'
import type { RuntimeRequestAuth } from './runtime-auth.ts'
import { authenticate, sendError, sendJson } from './server.ts'
import type { AuthContext } from './server.ts'

export interface AttachmentsRuntime {
  content: LocalVolumeStore
  retentionMs: number
}

export interface AttachmentsRouteContext extends AuthContext {
  runtimeToken?: string
  attachments?: AttachmentsRuntime
}

/** 由 server.ts 在 rawStore 可用时创建一次（签名 secret 与时钟跟 server 一致）。 */
export function createAttachmentsRuntime(options: {
  rawStore: Store
  now: () => number
  root?: string
  signingSecret?: string
}): AttachmentsRuntime {
  return {
    content: new LocalVolumeStore({
      ...(options.root === undefined ? {} : { root: options.root }),
      ...(options.signingSecret === undefined ? {} : { signingSecret: options.signingSecret }),
      now: options.now,
    }),
    retentionMs: ATTACHMENT_RETENTION_MS,
  }
}

const ARTIFACT_ID_PATTERN = /^[0-9a-f]{32}$/
const MAX_NAME_LENGTH = 255
const SIGNED_URL_TTL_SECONDS = 300

interface RawBodyOk {
  ok: true
  bytes: Buffer
}
interface RawBodyError {
  ok: false
  status: number
  code: string
  message: string
}

/** 读原始 body；超限继续 drain 并稳定返回 413。 */
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<RawBodyOk | RawBodyError> {
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  try {
    for await (const chunk of req) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      size += buf.byteLength
      if (size > maxBytes) {
        tooLarge = true
        chunks.length = 0
        continue
      }
      if (!tooLarge) chunks.push(buf)
    }
  } catch {
    return { ok: false, status: 400, code: 'invalid_body', message: 'could not read request body' }
  }
  if (tooLarge || size > maxBytes) {
    return {
      ok: false,
      status: 413,
      code: 'payload_too_large',
      message: `request body exceeds ${maxBytes} bytes`,
    }
  }
  return { ok: true, bytes: Buffer.concat(chunks) }
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name]
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim()
  if (Array.isArray(value) && value.length > 0) return value[0] ?? null
  return null
}

function positiveIntHeader(req: IncomingMessage, name: string): number | null | undefined {
  const raw = header(req, name)
  if (raw === null) return undefined
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function requireRuntimeAuth(
  ctx: AttachmentsRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
): RuntimeRequestAuth | null {
  const auth = authorizeRuntimeHttp(ctx, req, res)
  if (auth === null) return null
  if (ctx.rawStore === undefined || ctx.attachments === undefined) {
    sendError(res, 503, 'runtime.not_configured', 'content storage needs the SQLite store')
    return null
  }
  return auth
}

function cleanMime(value: string | null): string {
  if (value === null) return 'application/octet-stream'
  const mime = value.split(';')[0]!.trim().toLowerCase()
  return mime === '' || mime.length > 120 ? 'application/octet-stream' : mime
}

function readName(value: string | null): string | null {
  if (value === null) return null
  const name = value.trim()
  if (name === '' || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) return null
  return name
}

function readKind(value: string | null): ArtifactKind | null {
  if (value === null) return null
  return (ARTIFACT_KINDS as readonly string[]).includes(value) ? (value as ArtifactKind) : null
}

function artifactJson(artifact: Artifact): Record<string, unknown> {
  return {
    id: artifact.id,
    workspaceId: artifact.workspaceId,
    kind: artifact.kind,
    mime: artifact.mime,
    name: artifact.name,
    size: artifact.size,
    width: artifact.width,
    height: artifact.height,
    thumbId: artifact.thumbId,
    producedBy: artifact.producedBy,
    createdAt: artifact.createdAt,
  }
}

/**
 * 上传响应里的缩略图描述；null 表示这次没有可用缩略图（不代表上传失败）。
 * artifactId 是内容对象 id，与 `artifacts.thumb_id` / 消息附件里的 `thumbId` 同值。
 */
function thumbnailJson(thumb: StoredThumbnail | null): Record<string, unknown> | null {
  if (thumb === null) return null
  return { artifactId: thumb.artifactId, mime: thumb.mime, width: thumb.width, height: thumb.height }
}

/** POST /api/internal/artifacts —— runtime 以 raw body 登记产物。 */
export async function handleInternalArtifactUpload(
  ctx: AttachmentsRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = requireRuntimeAuth(ctx, req, res)
  if (auth === null) return
  const store = ctx.rawStore!
  const runtime = ctx.attachments!

  const workspaceId = header(req, 'x-workspace-id')
  const producedBy = header(req, 'x-produced-by')
  const kind = readKind(header(req, 'x-artifact-kind'))
  const name = readName(header(req, 'x-artifact-name'))
  const mime = cleanMime(header(req, 'x-file-mime'))
  const messageSeq = positiveIntHeader(req, 'x-message-seq')

  // 还没读 body 就拒绝：先把请求体 drain 掉，避免污染 keep-alive 连接。
  const fail = (status: number, code: string, message: string): void => {
    req.resume()
    sendError(res, status, code, message)
  }

  if (workspaceId === null) return fail(400, 'invalid_body', 'x-workspace-id is required')
  // workspace token 只能往自己的 workspace 登记产物。
  if (!ensureRuntimeWorkspace(auth, workspaceId, res)) {
    req.resume()
    return
  }
  if (producedBy === null || producedBy.length > 128) {
    return fail(400, 'invalid_body', 'x-produced-by is required')
  }
  if (kind === null) {
    return fail(400, 'invalid_body', `x-artifact-kind must be one of ${ARTIFACT_KINDS.join('|')}`)
  }
  if (name === null) return fail(400, 'invalid_body', 'x-artifact-name is required')
  if (messageSeq === null) return fail(400, 'invalid_body', 'x-message-seq must be a positive integer')

  const workspace = store.db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId)
  if (workspace === undefined || workspace === null) {
    return fail(404, 'workspace_not_found', `unknown workspace ${workspaceId}`)
  }

  let position = 0
  if (messageSeq !== undefined) {
    const message = store.db
      .prepare("SELECT seq, subject_json FROM events WHERE seq = ? AND domain = 'chat' AND kind = 'chat.message'")
      .get(messageSeq) as { seq: number | bigint; subject_json: string | null } | undefined
    const subject = parseSubject(message?.subject_json ?? null)
    if (message === undefined || message === null || subject.kind !== 'room') {
      return fail(400, 'invalid_body', `message seq ${messageSeq} is not a chat.message in a room`)
    }
    const room = store.db
      .prepare('SELECT workspace_id FROM rooms WHERE id = ?')
      .get(subject.id) as { workspace_id: string } | undefined
    if (room === undefined || room === null || room.workspace_id !== workspaceId) {
      return fail(400, 'invalid_body', 'message does not belong to x-workspace-id')
    }
    const count = store.db
      .prepare('SELECT COUNT(*) AS n FROM message_attachments WHERE message_seq = ?')
      .get(messageSeq) as { n: number | bigint }
    position = Number(count.n)
    if (position >= MAX_ATTACHMENTS_PER_EVENT) {
      return fail(400, 'attachment.limit', `a message can reference at most ${MAX_ATTACHMENTS_PER_EVENT} artifacts`)
    }
  }

  const contentLength = header(req, 'content-length')
  if (contentLength !== null && Number(contentLength) > MAX_OBJECT_BYTES) {
    req.resume()
    return sendError(res, 413, 'payload_too_large', `artifact exceeds ${MAX_OBJECT_BYTES} bytes`)
  }
  const body = await readRawBody(req, MAX_OBJECT_BYTES)
  if (!body.ok) return sendError(res, body.status, body.code, body.message)
  if (body.bytes.byteLength === 0) return sendError(res, 400, 'invalid_body', 'artifact body is empty')

  try {
    // 原图先整理（JPEG 剥 EXIF），缩略图另行尽力生成；缩略图失败不阻断上传。
    const upload = await prepareUpload({ bytes: body.bytes, mime })
    const imageSize = detectImageSize(upload.bytes)
    const stored = await runtime.content.put(upload.bytes, {
      mime,
      owner: producedBy,
      audience: 'team',
    })
    putAttachment(store, {
      id: stored.id,
      workspaceId,
      sha256: stored.sha256,
      size: stored.size,
      mime,
      owner: producedBy,
      audience: 'team',
      createdAt: ctx.now(),
    })

    // 缩略图存成独立内容对象（artifacts.thumb_id 指向它），并写合成引用避免被 GC。
    let thumbUnavailable = upload.thumbUnavailable
    let thumbnail: StoredThumbnail | null = null
    if (upload.thumbnail !== undefined) {
      thumbnail = await persistThumbnail({
        store,
        content: runtime.content,
        thumbnail: upload.thumbnail,
        workspaceId,
        owner: producedBy,
        createdAt: ctx.now(),
        audience: 'team',
        ownerArtifactId: stored.id,
      })
      if (thumbnail === null) thumbUnavailable ??= 'thumbnail could not be stored'
    }
    const thumbId = thumbnail === null ? null : thumbnail.artifactId

    const artifact = putArtifact(store, {
      id: stored.id,
      workspaceId,
      kind,
      mime,
      name,
      size: stored.size,
      width: imageSize?.width ?? null,
      height: imageSize?.height ?? null,
      thumbId,
      producedBy,
      createdAt: ctx.now(),
    })

    if (messageSeq !== undefined) linkArtifact(store, messageSeq, stored.id, position)

    appendEvent(store, {
      domain: 'artifact',
      kind: 'artifact.published',
      actor: { kind: 'bot', id: producedBy },
      subject: { kind: 'artifact', id: stored.id },
      audience: 'team',
      payload: {
        artifact: stored.id,
        kind,
        name,
        size: stored.size,
        mime,
        thumb: thumbId,
        ...(messageSeq === undefined ? {} : { messageSeq }),
      },
    })

    sendJson(res, 201, {
      artifact: artifactJson(artifact),
      thumbnail: thumbnailJson(thumbnail),
      ...(thumbUnavailable === undefined ? {} : { thumbUnavailable }),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('roost api: artifact upload failed', err)
    sendError(res, 500, 'internal_error', `artifact upload failed: ${message}`)
  }
}

/** POST /api/attachments —— 用户上传头像/临时附件（Bearer 鉴权）。 */
export async function handleUploadAttachment(
  ctx: AttachmentsRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message)
  if (ctx.rawStore === undefined || ctx.attachments === undefined) {
    return sendError(res, 503, 'runtime.not_configured', 'content storage needs the SQLite store')
  }

  const workspaceId = header(req, 'x-workspace-id')
  if (workspaceId !== null) {
    const member = ctx.rawStore.db
      .prepare('SELECT 1 AS ok FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(workspaceId, auth.session.accountId)
    if (member === undefined || member === null) {
      return sendError(res, 403, 'forbidden', 'not a member of this workspace')
    }
  }

  const contentLength = header(req, 'content-length')
  if (contentLength !== null && Number(contentLength) > MAX_AVATAR_BYTES) {
    req.resume()
    return sendError(res, 413, 'payload_too_large', `attachment exceeds ${MAX_AVATAR_BYTES} bytes`)
  }
  const body = await readRawBody(req, MAX_AVATAR_BYTES)
  if (!body.ok) return sendError(res, body.status, body.code, body.message)
  if (body.bytes.byteLength === 0) return sendError(res, 400, 'invalid_body', 'attachment body is empty')

  const mime = cleanMime(header(req, 'x-file-mime') ?? req.headers['content-type'] ?? null)
  try {
    const upload = await prepareUpload({ bytes: body.bytes, mime })
    const stored = await ctx.attachments.content.put(upload.bytes, {
      mime,
      owner: auth.session.accountId,
      audience: 'team',
    })
    const attachment = putAttachment(ctx.rawStore, {
      id: stored.id,
      workspaceId: workspaceId ?? '',
      sha256: stored.sha256,
      size: stored.size,
      mime,
      owner: auth.session.accountId,
      audience: 'team',
      createdAt: ctx.now(),
    })
    // 头像/临时附件没有 artifact 行，缩略图只作为独立内容对象登记（无产物引用）。
    let thumbnail: StoredThumbnail | null = null
    if (upload.thumbnail !== undefined) {
      thumbnail = await persistThumbnail({
        store: ctx.rawStore,
        content: ctx.attachments.content,
        thumbnail: upload.thumbnail,
        workspaceId: workspaceId ?? '',
        owner: auth.session.accountId,
        createdAt: ctx.now(),
        audience: 'team',
      })
    }
    const url = await ctx.attachments.content.signRead(stored.id, SIGNED_URL_TTL_SECONDS)
    sendJson(res, 201, {
      attachment: {
        id: attachment.id,
        sha256: attachment.sha256,
        size: attachment.size,
        mime: attachment.mime,
        owner: attachment.owner,
        audience: attachment.audience,
        createdAt: attachment.createdAt,
        url,
      },
      thumbnail: thumbnailJson(thumbnail),
      ...(upload.thumbUnavailable === undefined ? {} : { thumbUnavailable: upload.thumbUnavailable }),
    })
  } catch (err) {
    console.error('roost api: attachment upload failed', err)
    sendError(res, 500, 'internal_error', 'attachment upload failed')
  }
}

function parseSubject(raw: string | null): { kind?: string; id?: string } {
  if (raw === null) return {}
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown; id?: unknown }
    if (parsed === null || typeof parsed !== 'object') return {}
    return {
      ...(typeof parsed.kind === 'string' ? { kind: parsed.kind } : {}),
      ...(typeof parsed.id === 'string' ? { id: parsed.id } : {}),
    }
  } catch {
    return {}
  }
}

/** GET /api/messages/:seq/files/:artifactId —— 消息级授权。失败一律 404。 */
export async function handleServeMessageFile(
  ctx: AttachmentsRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  seqText: string,
  artifactIdText: string,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message)

  const notFound = (): void => sendError(res, 404, 'not_found', 'file not found')
  if (ctx.rawStore === undefined || ctx.attachments === undefined) return notFound()
  if (!/^\d+$/.test(seqText)) return notFound()
  const messageSeq = Number(seqText)
  if (!Number.isSafeInteger(messageSeq) || messageSeq <= 0) return notFound()

  let artifactId: string
  try {
    artifactId = decodeURIComponent(artifactIdText)
  } catch {
    return notFound()
  }
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) return notFound()

  const store = ctx.rawStore
  const message = store.db
    .prepare("SELECT seq, subject_json FROM events WHERE seq = ? AND domain = 'chat' AND kind = 'chat.message'")
    .get(messageSeq) as { seq: number | bigint; subject_json: string | null } | undefined
  const subject = parseSubject(message?.subject_json ?? null)
  if (message === undefined || message === null || subject.kind !== 'room' || subject.id === undefined) {
    return notFound()
  }

  const room = store.db
    .prepare('SELECT workspace_id FROM rooms WHERE id = ?')
    .get(subject.id) as { workspace_id: string } | undefined
  if (room === undefined || room === null) return notFound()

  const member = store.db
    .prepare('SELECT 1 AS ok FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(room.workspace_id, auth.session.accountId)
  if (member === undefined || member === null) return notFound()

  const linked = store.db
    .prepare('SELECT 1 AS ok FROM message_attachments WHERE message_seq = ? AND artifact_id = ?')
    .get(messageSeq, artifactId)
  if (linked === undefined || linked === null) return notFound()

  const artifact = getArtifact(store, artifactId)
  if (artifact === null) return notFound()

  const got = await ctx.attachments.content.get(artifact.id)
  if (got === null) return notFound()

  serveBytes(req, res, got.bytes, artifact.mime, artifact.name, url.searchParams.get('raw') === '1')
}

/** GET /api/attachments/:id?token= —— 签名读取（HMAC + 过期）。 */
export async function handleServeSignedAttachment(
  ctx: AttachmentsRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  idText: string,
): Promise<void> {
  if (ctx.attachments === undefined) {
    return sendError(res, 404, 'not_found', 'content storage is not configured')
  }
  let id: string
  try {
    id = decodeURIComponent(idText)
  } catch {
    return sendError(res, 404, 'not_found', 'file not found')
  }
  const token = url.searchParams.get('token') ?? ''
  if (!ARTIFACT_ID_PATTERN.test(id) || !ctx.attachments.content.verifyReadToken(id, token, ctx.now())) {
    return sendError(res, 403, 'attachment.token_invalid', 'invalid or expired attachment token')
  }
  const got = await ctx.attachments.content.get(id)
  if (got === null) return sendError(res, 404, 'not_found', 'file not found')
  serveBytes(req, res, got.bytes, got.meta.mime, id, url.searchParams.get('raw') === '1')
}

/** POST /api/internal/attachments/gc —— 删除 ref_count=0 且超保留期的对象。 */
export async function handleInternalAttachmentGc(
  ctx: AttachmentsRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = requireRuntimeAuth(ctx, req, res)
  if (auth === null) return
  const store = ctx.rawStore!
  const runtime = ctx.attachments!
  const now = ctx.now()

  let deleted = 0
  let bytes = 0
  try {
    // GC 是全库扫描；workspace token 只清理自己 workspace 的过期附件。
    const candidates = listCollectableAttachments(store, { now, retentionMs: runtime.retentionMs })
      .filter((candidate) => auth.workspaceId === null || candidate.workspaceId === auth.workspaceId)
    for (const candidate of candidates) {
      const removed = deleteAttachmentRows(store, [candidate.id])
      if (removed.length === 0) continue
      await runtime.content.delete(candidate.id)
      recordAttachmentGc(store, { attachment: candidate, at: now })
      deleted += removed.length
      bytes += candidate.size
    }
    sendJson(res, 200, { deleted, bytes })
  } catch (err) {
    console.error('roost api: attachment gc failed', err)
    sendError(res, 500, 'internal_error', 'attachment gc failed')
  }
}

// ---- Range 与响应 -----------------------------------------------------------

interface ByteRange {
  start: number
  end: number
}

/** 只支持单个区间；返回 null 表示忽略 Range，返回 'invalid' 表示 416。 */
function parseRange(raw: string | undefined, size: number): ByteRange | null | 'invalid' {
  if (raw === undefined || raw === '') return null
  if (!raw.startsWith('bytes=')) return null
  const spec = raw.slice('bytes='.length).trim()
  if (spec === '' || spec.includes(',')) return 'invalid'
  const match = /^(\d*)-(\d*)$/.exec(spec)
  if (match === null) return 'invalid'
  const startText = match[1] ?? ''
  const endText = match[2] ?? ''
  if (startText === '' && endText === '') return 'invalid'

  if (startText === '') {
    const suffix = Number(endText)
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(startText)
  if (!Number.isSafeInteger(start) || start >= size) return 'invalid'
  if (endText === '') return { start, end: size - 1 }
  const end = Number(endText)
  if (!Number.isSafeInteger(end) || end < start) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const safe = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function serveBytes(
  req: IncomingMessage,
  res: ServerResponse,
  bytes: Uint8Array,
  mime: string,
  name: string,
  download: boolean,
): void {
  const size = bytes.byteLength
  const range = parseRange(req.headers.range, size)
  const headers: Record<string, string> = {
    'content-type': mime,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
    'content-disposition': contentDisposition(download ? 'attachment' : 'inline', name),
  }
  // HTML/SVG 是脚本：即使被直接打开，也只允许沙箱执行。
  if (mime === 'text/html' || mime === 'image/svg+xml') {
    headers['content-security-policy'] = 'sandbox; default-src none'
  }

  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}`, 'content-length': '0' })
    res.end()
    return
  }

  if (range === null) {
    res.writeHead(200, { ...headers, 'content-length': String(size) })
    res.end(size === 0 ? undefined : Buffer.from(bytes.buffer, bytes.byteOffset, size))
    return
  }

  const chunk = bytes.subarray(range.start, range.end + 1)
  res.writeHead(206, {
    ...headers,
    'content-range': `bytes ${range.start}-${range.end}/${size}`,
    'content-length': String(chunk.byteLength),
  })
  res.end(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
}
