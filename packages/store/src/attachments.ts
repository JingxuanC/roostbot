// 附件与产物（docs/design/storage.md §5、docs/design/artifacts.md §8）。
//
// 本仓库的消息身份是 events.seq（rooms.ts 文件头），所以 message_attachments 用
// message_seq INTEGER，不引入新的 message_id。
//
// 引用计数：
//   * attachment_refs 是事实来源，ref_count 是同事务维护的缓存；
//   * 同 (attachment_id, event_id) 重复登记幂等，不再加计数；
//   * linkArtifact 往 attachment_refs 写 `msg:<seq>`，让被消息引用的产物免于 GC。
//
// GC：
//   * 只取 ref_count = 0 且 created_at 超过保留期的行；
//   * 删除数据库行由本模块做，blob 由调用方删除（它才知道内容存储在哪）；
//   * 每次删除写一条 attachment.gc 事件留审计。

import { StoreError } from './errors.ts'
import { appendEvent } from './events.ts'
import {
  asInteger,
  asNonEmptyString,
  asOptionalInteger,
  asOptionalString,
  asRecord,
  assertOpen,
  toNumber,
} from './internal.ts'
import type { Store } from './types.ts'

/** 默认保留期：7 天（storage.md §5 / artifacts.md §9）。 */
export const ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export const ARTIFACT_KINDS = ['image', 'pdf', 'html', 'table', 'code', 'page'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

export interface Attachment {
  id: string
  workspaceId: string
  sha256: string
  size: number
  mime: string
  owner: string
  audience: string
  refCount: number
  createdAt: number
}

export interface PutAttachmentInput {
  id: string
  workspaceId: string
  sha256: string
  size: number
  mime: string
  owner: string
  audience?: string
  createdAt?: number
}

export interface Artifact {
  id: string
  workspaceId: string
  kind: ArtifactKind
  mime: string
  name: string
  size: number
  width: number | null
  height: number | null
  thumbId: string | null
  producedBy: string
  runId: string | null
  createdAt: number
}

export interface PutArtifactInput {
  id: string
  workspaceId: string
  kind: ArtifactKind
  mime: string
  name: string
  size: number
  width?: number | null
  height?: number | null
  thumbId?: string | null
  producedBy: string
  runId?: string | null
  createdAt?: number
}

/** messageJson 需要的形状：消息 + 产物的展示字段 + 受控 URL。 */
export interface MessageAttachment {
  messageSeq: number
  artifactId: string
  position: number
  kind: ArtifactKind
  name: string
  size: number
  mime: string
  thumbId: string | null
  url: string
}

interface AttachmentRow {
  id: string
  workspace_id: string
  sha256: string
  size: number | bigint
  mime: string
  owner: string
  audience: string
  ref_count: number | bigint
  created_at: number | bigint
}

interface ArtifactRow {
  id: string
  workspace_id: string
  kind: string
  mime: string
  name: string
  size: number | bigint
  width: number | bigint | null
  height: number | bigint | null
  thumb_id: string | null
  produced_by: string
  run_id: string | null
  created_at: number | bigint
}

const ATTACHMENT_COLUMNS = 'id, workspace_id, sha256, size, mime, owner, audience, ref_count, created_at'
const ARTIFACT_COLUMNS =
  'id, workspace_id, kind, mime, name, size, width, height, thumb_id, produced_by, run_id, created_at'

/** 登记一个内容对象。同 id 已存在时直接返回已有行（内容寻址幂等）。 */
export function putAttachment(store: Store, input: PutAttachmentInput): Attachment {
  assertOpen(store)
  const req = asRecord(input, 'attachment')
  const id = asNonEmptyString(req.id, 'attachment.id')
  // 头像/临时附件不一定属于某个 workspace；列是 NOT NULL，允许空串表达「账号级」。
  if (typeof req.workspaceId !== 'string') {
    throw new StoreError('INVALID_INPUT', 'attachment.workspaceId must be a string')
  }
  const workspaceId = req.workspaceId
  const sha256 = asNonEmptyString(req.sha256, 'attachment.sha256')
  const size = asInteger(req.size, 'attachment.size', 0)
  const mime = asNonEmptyString(req.mime, 'attachment.mime')
  const owner = asNonEmptyString(req.owner, 'attachment.owner')
  const audience = asOptionalString(req.audience, 'attachment.audience') ?? 'team'
  const createdAt =
    req.createdAt === undefined || req.createdAt === null
      ? Date.now()
      : asInteger(req.createdAt, 'attachment.createdAt', 0)

  store.db
    .prepare(
      `INSERT OR IGNORE INTO attachments (${ATTACHMENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(id, workspaceId, sha256, size, mime, owner, audience, createdAt)

  const row = store.db.prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE id = ?`).get(id)
  if (row === undefined || row === null) {
    throw new StoreError('INVALID_INPUT', `failed to register attachment ${id}`)
  }
  return rowToAttachment(row)
}

export function getAttachment(store: Store, id: string): Attachment | null {
  assertOpen(store)
  if (typeof id !== 'string' || id === '') return null
  const row = store.db.prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE id = ?`).get(id)
  return row === undefined || row === null ? null : rowToAttachment(row)
}

/**
 * 登记一次引用；同 (attachmentId, eventId) 重复调用幂等。
 * ref_count 与 attachment_refs 在同一个 savepoint 里更新。
 */
export function addAttachmentRef(
  store: Store,
  attachmentId: string,
  eventId: string,
): { added: boolean; refCount: number } {
  assertOpen(store)
  const id = asNonEmptyString(attachmentId, 'attachmentId')
  const event = asNonEmptyString(eventId, 'eventId')

  return withSavepoint(store, 'roost_add_attachment_ref', () => {
    const exists = store.db.prepare('SELECT 1 AS ok FROM attachments WHERE id = ?').get(id)
    if (exists === undefined || exists === null) {
      throw new StoreError('INVALID_INPUT', `unknown attachment ${id}`)
    }
    const inserted = store.db
      .prepare('INSERT OR IGNORE INTO attachment_refs (attachment_id, event_id) VALUES (?, ?)')
      .run(id, event)
    const added = toNumber(inserted.changes) > 0
    if (added) {
      store.db.prepare('UPDATE attachments SET ref_count = ref_count + 1 WHERE id = ?').run(id)
    }
    const row = store.db.prepare('SELECT ref_count FROM attachments WHERE id = ?').get(id) as
      | { ref_count: number | bigint }
      | undefined
    return { added, refCount: row === undefined ? 0 : toNumber(row.ref_count) }
  })
}

export function removeAttachmentRef(store: Store, attachmentId: string, eventId: string): boolean {
  assertOpen(store)
  const id = asNonEmptyString(attachmentId, 'attachmentId')
  const event = asNonEmptyString(eventId, 'eventId')
  return withSavepoint(store, 'roost_remove_attachment_ref', () => {
    const deleted = store.db
      .prepare('DELETE FROM attachment_refs WHERE attachment_id = ? AND event_id = ?')
      .run(id, event)
    const removed = toNumber(deleted.changes) > 0
    if (removed) {
      store.db
        .prepare('UPDATE attachments SET ref_count = MAX(0, ref_count - 1) WHERE id = ?')
        .run(id)
    }
    return removed
  })
}

/** 登记产物行；同 id 幂等（重复登记返回已有行）。 */
export function putArtifact(store: Store, input: PutArtifactInput): Artifact {
  assertOpen(store)
  const req = asRecord(input, 'artifact')
  const id = asNonEmptyString(req.id, 'artifact.id')
  const workspaceId = asNonEmptyString(req.workspaceId, 'artifact.workspaceId')
  const kind = asArtifactKind(req.kind)
  const mime = asNonEmptyString(req.mime, 'artifact.mime')
  const name = asNonEmptyString(req.name, 'artifact.name')
  const size = asInteger(req.size, 'artifact.size', 0)
  const width = asOptionalInteger(req.width, 'artifact.width', 0)
  const height = asOptionalInteger(req.height, 'artifact.height', 0)
  const thumbId = asOptionalString(req.thumbId, 'artifact.thumbId')
  const producedBy = asNonEmptyString(req.producedBy, 'artifact.producedBy')
  const runId = asOptionalString(req.runId, 'artifact.runId')
  const createdAt =
    req.createdAt === undefined || req.createdAt === null
      ? Date.now()
      : asInteger(req.createdAt, 'artifact.createdAt', 0)

  store.db
    .prepare(
      `INSERT OR IGNORE INTO artifacts (${ARTIFACT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, workspaceId, kind, mime, name, size, width, height, thumbId, producedBy, runId, createdAt)

  const artifact = getArtifact(store, id)
  if (artifact === null) throw new StoreError('INVALID_INPUT', `failed to register artifact ${id}`)
  return artifact
}

export function getArtifact(store: Store, id: string): Artifact | null {
  assertOpen(store)
  if (typeof id !== 'string' || id === '') return null
  const row = store.db.prepare(`SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?`).get(id)
  return row === undefined || row === null ? null : rowToArtifact(row)
}

/**
 * 把产物挂到消息上。position 用于稳定排序；同 (messageSeq, artifactId) 幂等。
 * 同时登记一条 `msg:<seq>` 引用，使产物不会被 GC。
 */
export function linkArtifact(
  store: Store,
  messageSeq: number,
  artifactId: string,
  position: number,
): void {
  assertOpen(store)
  const seq = asInteger(messageSeq, 'messageSeq', 1)
  const id = asNonEmptyString(artifactId, 'artifactId')
  const pos = asInteger(position, 'position', 0)

  if (getArtifact(store, id) === null) {
    throw new StoreError('INVALID_INPUT', `unknown artifact ${id}`)
  }

  withSavepoint(store, 'roost_link_artifact', () => {
    const inserted = store.db
      .prepare('INSERT OR IGNORE INTO message_attachments (message_seq, artifact_id, position) VALUES (?, ?, ?)')
      .run(seq, id, pos)
    if (toNumber(inserted.changes) > 0) {
      addAttachmentRef(store, id, `msg:${seq}`)
    }
  })
}

export function unlinkArtifact(store: Store, messageSeq: number, artifactId: string): boolean {
  assertOpen(store)
  const seq = asInteger(messageSeq, 'messageSeq', 1)
  const id = asNonEmptyString(artifactId, 'artifactId')
  return withSavepoint(store, 'roost_unlink_artifact', () => {
    const deleted = store.db
      .prepare('DELETE FROM message_attachments WHERE message_seq = ? AND artifact_id = ?')
      .run(seq, id)
    const removed = toNumber(deleted.changes) > 0
    if (removed) removeAttachmentRef(store, id, `msg:${seq}`)
    return removed
  })
}

export function listArtifactsByMessage(store: Store, messageSeq: number): Artifact[] {
  assertOpen(store)
  const seq = asInteger(messageSeq, 'messageSeq', 1)
  const rows = store.db
    .prepare(
      `SELECT a.${ARTIFACT_COLUMNS.split(', ').join(', a.')}
         FROM message_attachments m JOIN artifacts a ON a.id = m.artifact_id
        WHERE m.message_seq = ?
        ORDER BY m.position, a.id`,
    )
    .all(seq)
  return rows.map(rowToArtifact)
}

/**
 * 批量读多条消息的附件（messageJson 用，避免 N+1）。
 * 返回顺序按 message_seq、position。
 */
export function listMessageAttachments(store: Store, messageSeqs: number[]): MessageAttachment[] {
  assertOpen(store)
  const seqs = messageSeqs
    .filter((seq) => Number.isSafeInteger(seq) && seq > 0)
    .map((seq) => Math.floor(seq))
  if (seqs.length === 0) return []

  const placeholders = seqs.map(() => '?').join(', ')
  const rows = store.db
    .prepare(
      `SELECT m.message_seq, m.artifact_id, m.position,
              a.kind, a.name, a.size, a.mime, a.thumb_id
         FROM message_attachments m JOIN artifacts a ON a.id = m.artifact_id
        WHERE m.message_seq IN (${placeholders})
        ORDER BY m.message_seq, m.position, m.artifact_id`,
    )
    .all(...seqs) as Array<{
    message_seq: number | bigint
    artifact_id: string
    position: number | bigint
    kind: string
    name: string
    size: number | bigint
    mime: string
    thumb_id: string | null
  }>

  return rows.map((row) => {
    const messageSeq = toNumber(row.message_seq)
    return {
      messageSeq,
      artifactId: row.artifact_id,
      position: toNumber(row.position),
      kind: asArtifactKind(row.kind),
      name: row.name,
      size: toNumber(row.size),
      mime: row.mime,
      thumbId: row.thumb_id,
      url: `/api/messages/${messageSeq}/files/${row.artifact_id}`,
    }
  })
}

/** ref_count = 0 且超过保留期的附件（blob 由调用方删除）。 */
export function listCollectableAttachments(
  store: Store,
  options: { now?: number; retentionMs?: number } = {},
): Attachment[] {
  assertOpen(store)
  const now = options.now ?? Date.now()
  const retentionMs = options.retentionMs ?? ATTACHMENT_RETENTION_MS
  if (!Number.isInteger(retentionMs) || retentionMs < 0) {
    throw new StoreError('INVALID_INPUT', 'retentionMs must be a non-negative integer')
  }
  const rows = store.db
    .prepare(
      `SELECT ${ATTACHMENT_COLUMNS} FROM attachments
        WHERE ref_count = 0 AND created_at < ?
        ORDER BY created_at, id`,
    )
    .all(now - retentionMs)
  return rows.map(rowToAttachment)
}

/** 删除数据库行（附件 + 引用）；返回被删的行，调用方据此删 blob 并写审计事件。 */
export function deleteAttachmentRows(store: Store, ids: string[]): Attachment[] {
  assertOpen(store)
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))]
  if (unique.length === 0) return []

  return withSavepoint(store, 'roost_delete_attachment_rows', () => {
    const deleted: Attachment[] = []
    const select = store.db.prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE id = ?`)
    const removeRefs = store.db.prepare('DELETE FROM attachment_refs WHERE attachment_id = ?')
    const removeRow = store.db.prepare('DELETE FROM attachments WHERE id = ?')
    for (const id of unique) {
      const row = select.get(id)
      if (row === undefined || row === null) continue
      const attachment = rowToAttachment(row)
      // 兜底：有引用就永不删（storage.md §9「GC 误删」）。
      if (attachment.refCount > 0) continue
      removeRefs.run(id)
      removeRow.run(id)
      deleted.push(attachment)
    }
    return deleted
  })
}

/** 写一条 attachment.gc 审计事件（events.md 信封）。 */
export function recordAttachmentGc(
  store: Store,
  input: { attachment: Attachment; at?: number; actorId?: string },
): void {
  assertOpen(store)
  const attachment = input.attachment
  appendEvent(store, {
    domain: 'attachment',
    kind: 'attachment.gc',
    actor: { kind: 'system', id: input.actorId ?? 'gc' },
    subject: { kind: 'attachment', id: attachment.id },
    audience: attachment.audience,
    at: new Date(input.at ?? Date.now()).toISOString(),
    payload: {
      attachment: attachment.id,
      workspaceId: attachment.workspaceId,
      size: attachment.size,
      mime: attachment.mime,
    },
  })
}

function withSavepoint<T>(store: Store, name: string, fn: () => T): T {
  store.db.exec(`SAVEPOINT ${name}`)
  try {
    const value = fn()
    store.db.exec(`RELEASE ${name}`)
    return value
  } catch (err) {
    try {
      store.db.exec(`ROLLBACK TO ${name}`)
      store.db.exec(`RELEASE ${name}`)
    } catch {
      // 原始错误更重要。
    }
    throw err
  }
}

function asArtifactKind(value: unknown): ArtifactKind {
  if (typeof value === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(value)) {
    return value as ArtifactKind
  }
  throw new StoreError('INVALID_INPUT', `artifact.kind must be one of ${ARTIFACT_KINDS.join('|')}`)
}

function rowToAttachment(row: unknown): Attachment {
  const r = row as AttachmentRow
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    sha256: r.sha256,
    size: toNumber(r.size),
    mime: r.mime,
    owner: r.owner,
    audience: r.audience,
    refCount: toNumber(r.ref_count),
    createdAt: toNumber(r.created_at),
  }
}

function rowToArtifact(row: unknown): Artifact {
  const r = row as ArtifactRow
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: asArtifactKind(r.kind),
    mime: r.mime,
    name: r.name,
    size: toNumber(r.size),
    width: r.width === null ? null : toNumber(r.width),
    height: r.height === null ? null : toNumber(r.height),
    thumbId: r.thumb_id,
    producedBy: r.produced_by,
    runId: r.run_id,
    createdAt: toNumber(r.created_at),
  }
}
