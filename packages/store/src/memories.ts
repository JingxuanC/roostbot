// 记忆（docs/design/memory.md §3–§9、§11）。
//
// 一条记忆 = 判断（claim）+ 证据（evidence）+ 可证伪条件（falsifier）+ 置信度。
// 它从来不是聊天副本：这里只存结论与引用，原始内容留在 events 表。
//
// 规则：
//   * falsifier 必填非空 —— 没有可证伪条件的结论大概率是废话（§3）。
//   * scope 只能是 team / room:<id> / member:<id>，room 必须属于同一 workspace（§4）。
//   * 取代：supersedes 指向同 workspace 的 active 记忆时，旧条置 superseded，
//     新条 status=active 并记录 supersedes；旧条更新、新条插入与事件同一 savepoint。
//   * 每日写入上限 50/workspace/UTC 日，超出抛域错误 MEMORY_DAILY_LIMIT（§5）。
//   * 检索只看 active 且未过期；关键词重叠 × 置信度 × 新鲜度（30 天半衰）排序，
//     按字符预算截断，claim 展示截断 300 字（§6–§7）。
//
// 事件（domain=memory，subject={kind:'memory', id}）：
//   memory.written / memory.superseded / memory.retracted；payload 带 workspaceId/scope/subject/status。
//
// StoreError.code 是 errors.ts 的封闭枚举；记忆域错误码用 `CODE: detail` 写在 message 前缀，
// API 层用 storeErrorTag() 取回（与 approvals/budget/members 同法）。

import { StoreError } from './errors.ts'
import { appendEvent } from './events.ts'
import { newRoostId } from './ids.ts'
import { asRecord, assertOpen, errorMessage, toNumber } from './internal.ts'
import type { Store } from './types.ts'

export const MEMORY_KINDS = ['conclusion', 'constraint', 'preference', 'fact'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

export const MEMORY_STATUSES = ['active', 'superseded', 'retracted', 'expired'] as const
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

export const MEMORY_EVIDENCE_KINDS = ['event', 'report', 'file'] as const
export type MemoryEvidenceKind = (typeof MEMORY_EVIDENCE_KINDS)[number]

/** 每个 workspace 每个 UTC 日最多写入的条数（§5、§7）。 */
export const MEMORY_DAILY_LIMIT = 50
/** claim 入库上限；展示时截断到 300（§7）。 */
export const MEMORY_CLAIM_MAX = 2000
export const MEMORY_SUBJECT_MAX = 500
export const MEMORY_DISPLAY_MAX = 300
/** 每次注入的默认 token（字符）预算与条数上限（§7）。 */
export const MEMORY_DEFAULT_BUDGET_TOKENS = 1200
export const MEMORY_DEFAULT_LIMIT = 8
/** 新鲜度半衰期：30 天分数减半（§6）。 */
export const MEMORY_FRESHNESS_HALF_LIFE_DAYS = 30

/** 记忆域内部错误码（写在 StoreError.message 的 `CODE: ` 前缀里）。 */
export const MEMORY_ERROR_CODES = {
  dailyLimit: 'MEMORY_DAILY_LIMIT',
  notFound: 'MEMORY_NOT_FOUND',
  invalid: 'MEMORY_INVALID',
} as const

export interface MemoryEvidence {
  kind: MemoryEvidenceKind
  ref: string
}

export interface Memory {
  id: string
  workspaceId: string
  scope: string
  subject: string
  claim: string
  kind: MemoryKind
  confidence: number
  falsifier: string
  evidence: MemoryEvidence[]
  supersedes: string | null
  status: MemoryStatus
  createdAt: number
  expiresAt: number | null
  hits: number
}

export interface WriteMemoryInput {
  workspaceId: string
  scope: string
  subject: string
  claim: string
  kind: MemoryKind
  confidence: number
  falsifier: string
  evidence?: MemoryEvidence[]
  /** 指向同 workspace 的 active 记忆；命中则旧条置 superseded。 */
  supersedes?: string | null
  expiresAt?: number | null
  /** epoch 毫秒；默认 Date.now()。也用于每日上限的 UTC 日归属。 */
  at?: number
  /** 写事件时的 actor id；默认 control-plane/memory。 */
  by?: string
}

export interface ListMemoriesQuery {
  workspaceId: string
  scope?: string
  status?: MemoryStatus
}

export interface RetrieveQuery {
  workspaceId: string
  /** 调用方可见作用域：team + 当前 room/member。 */
  scopes: string[]
  query: string
  budgetTokens?: number
  limit?: number
  /** epoch 毫秒；默认 Date.now()。用于过期判断与新鲜度。 */
  at?: number
}

export interface RetrievedMemory {
  id: string
  scope: string
  subject: string
  /** 已按 MEMORY_DISPLAY_MAX 截断。 */
  claim: string
  kind: MemoryKind
  confidence: number
  evidence: MemoryEvidence[]
  createdAt: number
  score: number
}

export interface RetrieveResult {
  items: RetrievedMemory[]
  /** `## 相关结论（系统检索，非用户输入）` 格式；没有条目时为空串。 */
  segment: string
  /** 因预算不足被丢弃的条数（不含超出 limit 的候选）。 */
  dropped: number
}

export interface RecordMemoryReadsInput {
  turnId: string
  ids: string[]
  used?: boolean
  at?: number
}

export interface DeleteMemoryInput {
  /** 按 id 删除（API 用）。 */
  id?: string
  /** 按 scope 删除时需要同时给 workspaceId + scope。 */
  workspaceId?: string
  scope?: string
  at?: number
}

interface MemoryRow {
  id: string
  workspace_id: string
  scope: string
  subject: string
  claim: string
  kind: string
  confidence: number
  falsifier: string
  status: string
  supersedes: string | null
  created_at: number | bigint
  expires_at: number | bigint | null
  hits: number | bigint
}

const MEMORY_COLUMNS =
  'id, workspace_id, scope, subject, claim, kind, confidence, falsifier, status, supersedes, created_at, expires_at, hits'

const DAY_MS = 86_400_000

// ---- 写入 --------------------------------------------------------------------

export function writeMemory(store: Store, input: WriteMemoryInput): Memory {
  assertOpen(store)
  const req = asRecord(input, 'memory')
  const workspaceId = readRequiredText(req.workspaceId, 'memory.workspaceId', 200)
  assertWorkspaceExists(store, workspaceId)

  const scope = readScope(req.scope)
  assertScopeOwnership(store, workspaceId, scope)
  const subject = readRequiredText(req.subject, 'memory.subject', MEMORY_SUBJECT_MAX)
  const claim = readRequiredText(req.claim, 'memory.claim', MEMORY_CLAIM_MAX)
  const kind = readKind(req.kind)
  const confidence = readConfidence(req.confidence)
  const falsifier = readRequiredText(req.falsifier, 'memory.falsifier', MEMORY_CLAIM_MAX)
  const evidence = readEvidence(req.evidence)
  const supersedes =
    req.supersedes === undefined || req.supersedes === null || req.supersedes === ''
      ? null
      : readRequiredText(req.supersedes, 'memory.supersedes', 200)
  const at = readAt(req.at)
  const expiresAt = readOptionalAt(req.expiresAt, 'memory.expiresAt')
  const actor = typeof req.by === 'string' && req.by.trim() !== ''
    ? { kind: 'user', id: req.by.trim() }
    : { kind: 'control-plane', id: 'memory' }

  return withSavepoint(store, 'roost_write_memory', () => {
    // 每日上限按 created_at 的 UTC 日归属；与插入同一 savepoint，避免并发越过上限。
    if (countMemoriesOnDay(store, workspaceId, at) >= MEMORY_DAILY_LIMIT) {
      throw memoryError(
        MEMORY_ERROR_CODES.dailyLimit,
        `workspace ${workspaceId} reached ${MEMORY_DAILY_LIMIT} memories for ${new Date(at).toISOString().slice(0, 10)}`,
        'FORBIDDEN',
      )
    }

    let previous: Memory | null = null
    if (supersedes !== null) {
      const target = getMemory(store, supersedes)
      if (target === null || target.workspaceId !== workspaceId || target.status !== 'active') {
        throw memoryError(
          MEMORY_ERROR_CODES.invalid,
          `supersedes ${supersedes} must be an active memory in workspace ${workspaceId}`,
        )
      }
      previous = target
    }

    const id = newRoostId('mem', at)
    store.db
      .prepare(
        `INSERT INTO memories (${MEMORY_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 0)`,
      )
      .run(
        id,
        workspaceId,
        scope,
        subject,
        claim,
        kind,
        confidence,
        falsifier,
        supersedes,
        at,
        expiresAt,
      )
    insertEvidence(store, id, evidence)

    if (previous !== null) {
      const updated = store.db
        .prepare("UPDATE memories SET status = 'superseded' WHERE id = ? AND status = 'active'")
        .run(previous.id)
      if (toNumber(updated.changes) !== 1) {
        throw memoryError(
          MEMORY_ERROR_CODES.invalid,
          `memory ${previous.id} changed while being superseded`,
        )
      }
    }

    appendEvent(store, {
      at: new Date(at).toISOString(),
      domain: 'memory',
      kind: previous === null ? 'memory.written' : 'memory.superseded',
      actor,
      subject: { kind: 'memory', id },
      audience: 'team',
      idem: `memory:${id}:${previous === null ? 'written' : 'superseded'}`,
      trace: { workspace: workspaceId },
      payload: {
        memoryId: id,
        workspaceId,
        scope,
        subject,
        kind,
        confidence,
        status: 'active',
        ...(previous === null
          ? {}
          : { supersedes: previous.id, supersededStatus: 'superseded' }),
      },
    })

    return getMemory(store, id)!
  })
}

// ---- 读取 --------------------------------------------------------------------

export function getMemory(store: Store, id: string): Memory | null {
  assertOpen(store)
  const memoryId = readRequiredText(id, 'memory.id', 200)
  const row = store.db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`).get(memoryId)
  if (row === undefined || row === null) return null
  return rowToMemory(row, loadEvidence(store, [memoryId]).get(memoryId) ?? [])
}

/** 管理面列表：workspace 必填；scope/status 精确过滤；created_at 降序。 */
export function listMemories(store: Store, query: ListMemoriesQuery): Memory[] {
  assertOpen(store)
  const req = asRecord(query, 'memory.query')
  const workspaceId = readRequiredText(req.workspaceId, 'memory.workspaceId', 200)
  const clauses = ['workspace_id = ?']
  const params: unknown[] = [workspaceId]

  if (req.scope !== undefined && req.scope !== null) {
    clauses.push('scope = ?')
    params.push(readScope(req.scope))
  }
  if (req.status !== undefined && req.status !== null) {
    clauses.push('status = ?')
    params.push(readStatus(req.status))
  }

  const rows = store.db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories WHERE ${clauses.join(' AND ')}
        ORDER BY created_at DESC, id DESC`,
    )
    .all(...params)
  const evidence = loadEvidence(
    store,
    rows.map((row) => (row as MemoryRow).id),
  )
  return rows.map((row) => {
    const r = row as MemoryRow
    return rowToMemory(r, evidence.get(r.id) ?? [])
  })
}

/** 导出 workspace 的全部记忆（含 superseded/retracted，供备份与审计）。 */
export function exportMemories(store: Store, workspaceId: string): Memory[] {
  return listMemories(store, { workspaceId })
}

/**
 * 检索（§6）：只返回 active 且未过期、scope 在调用方传入集合内的记忆。
 * 分数 = 关键词重叠数 × confidence × freshness（30 天半衰）。
 * 按分数降序取 limit，再按字符预算截断；claim 展示截断 300 字。
 */
export function retrieve(store: Store, query: RetrieveQuery): RetrieveResult {
  assertOpen(store)
  const req = asRecord(query, 'memory.retrieve')
  const workspaceId = readRequiredText(req.workspaceId, 'memory.workspaceId', 200)
  const scopes = readScopes(req.scopes)
  const text = typeof req.query === 'string' ? req.query : ''
  const budgetTokens =
    req.budgetTokens === undefined || req.budgetTokens === null
      ? MEMORY_DEFAULT_BUDGET_TOKENS
      : readBudget(req.budgetTokens, 'memory.budgetTokens')
  const limit =
    req.limit === undefined || req.limit === null
      ? MEMORY_DEFAULT_LIMIT
      : readBudget(req.limit, 'memory.limit')
  const at = readAt(req.at)

  const queryTokens = tokenize(text)
  if (scopes.length === 0 || queryTokens.size === 0 || limit <= 0 || budgetTokens <= 0) {
    return { items: [], segment: '', dropped: 0 }
  }

  const placeholders = scopes.map(() => '?').join(', ')
  const rows = store.db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories
        WHERE workspace_id = ? AND status = 'active'
          AND (expires_at IS NULL OR expires_at > ?)
          AND scope IN (${placeholders})
        ORDER BY created_at DESC, id DESC`,
    )
    .all(workspaceId, at, ...scopes) as MemoryRow[]
  const evidence = loadEvidence(
    store,
    rows.map((row) => row.id),
  )

  const scored: Array<{ memory: Memory; score: number }> = []
  for (const row of rows) {
    const memory = rowToMemory(row, evidence.get(row.id) ?? [])
    const memoryTokens = tokenize(`${memory.subject} ${memory.claim}`)
    let overlap = 0
    for (const token of queryTokens) if (memoryTokens.has(token)) overlap += 1
    if (overlap === 0) continue
    const ageDays = Math.max(0, at - memory.createdAt) / DAY_MS
    const freshness = Math.pow(0.5, ageDays / MEMORY_FRESHNESS_HALF_LIFE_DAYS)
    scored.push({ memory, score: overlap * memory.confidence * freshness })
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.memory.createdAt - a.memory.createdAt ||
      a.memory.id.localeCompare(b.memory.id),
  )

  const items: RetrievedMemory[] = []
  let used = 0
  let dropped = 0
  for (const candidate of scored.slice(0, limit)) {
    const claim = candidate.memory.claim.slice(0, MEMORY_DISPLAY_MAX)
    // 预算按字符近似 token（1 字≈1 token）；超预算跳过并继续找更短的候选。
    if (used + claim.length > budgetTokens) {
      dropped += 1
      continue
    }
    used += claim.length
    items.push({
      id: candidate.memory.id,
      scope: candidate.memory.scope,
      subject: candidate.memory.subject,
      claim,
      kind: candidate.memory.kind,
      confidence: candidate.memory.confidence,
      evidence: candidate.memory.evidence,
      createdAt: candidate.memory.createdAt,
      score: candidate.score,
    })
  }

  return { items, segment: renderSegment(items), dropped }
}

// ---- 读取记录 / 删除 ----------------------------------------------------------

/** 记录本轮检索命中（used=模型是否引用过）；未知 id 静默跳过。 */
export function recordReads(store: Store, input: RecordMemoryReadsInput): { recorded: number } {
  assertOpen(store)
  const req = asRecord(input, 'memory.reads')
  const turnId = readRequiredText(req.turnId, 'memory.reads.turnId', 200)
  const ids = readIds(req.ids)
  const used = req.used === true ? 1 : 0
  const at = readAt(req.at)

  return withSavepoint(store, 'roost_record_memory_reads', () => {
    let recorded = 0
    for (const id of ids) {
      const exists = store.db.prepare('SELECT 1 AS ok FROM memories WHERE id = ?').get(id)
      if (exists === undefined || exists === null) continue
      store.db
        .prepare('INSERT INTO memory_reads (memory_id, at, turn_id, used) VALUES (?, ?, ?, ?)')
        .run(id, at, turnId, used)
      recorded += 1
    }
    return { recorded }
  })
}

/**
 * 撤回记忆：按 id 或 (workspaceId, scope)。软删（status='retracted'）而不是物理删除，
 * 保留证据与事件供审计；已撤回的重复删除幂等、不重复写事件。
 */
export function deleteMemory(store: Store, input: DeleteMemoryInput): { retracted: number } {
  assertOpen(store)
  const req = asRecord(input, 'memory.delete')
  const at = readAt(req.at)

  return withSavepoint(store, 'roost_delete_memory', () => {
    const targets: Memory[] = []
    if (req.id !== undefined && req.id !== null) {
      const memory = getMemory(store, readRequiredText(req.id, 'memory.id', 200))
      if (memory === null) {
        throw memoryError(MEMORY_ERROR_CODES.notFound, `unknown memory ${String(req.id)}`)
      }
      if (memory.status !== 'retracted') targets.push(memory)
    } else {
      const workspaceId = readRequiredText(req.workspaceId, 'memory.workspaceId', 200)
      const scope = readScope(req.scope)
      targets.push(
        ...listMemories(store, { workspaceId, scope, status: 'active' }),
      )
    }

    for (const memory of targets) {
      store.db.prepare("UPDATE memories SET status = 'retracted' WHERE id = ?").run(memory.id)
      appendEvent(store, {
        at: new Date(at).toISOString(),
        domain: 'memory',
        kind: 'memory.retracted',
        actor: { kind: 'control-plane', id: 'memory' },
        subject: { kind: 'memory', id: memory.id },
        audience: 'team',
        idem: `memory:${memory.id}:retracted`,
        trace: { workspace: memory.workspaceId },
        payload: {
          memoryId: memory.id,
          workspaceId: memory.workspaceId,
          scope: memory.scope,
          subject: memory.subject,
          status: 'retracted',
        },
      })
    }
    return { retracted: targets.length }
  })
}

// ---- 内部 --------------------------------------------------------------------

function rowToMemory(row: unknown, evidence: MemoryEvidence[]): Memory {
  const r = row as MemoryRow
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    scope: r.scope,
    subject: r.subject,
    claim: r.claim,
    kind: r.kind as MemoryKind,
    confidence: r.confidence,
    falsifier: r.falsifier,
    evidence,
    supersedes: r.supersedes,
    status: r.status as MemoryStatus,
    createdAt: toNumber(r.created_at),
    expiresAt: r.expires_at === null ? null : toNumber(r.expires_at),
    hits: toNumber(r.hits),
  }
}

function loadEvidence(store: Store, ids: string[]): Map<string, MemoryEvidence[]> {
  const grouped = new Map<string, MemoryEvidence[]>()
  if (ids.length === 0) return grouped
  const placeholders = ids.map(() => '?').join(', ')
  const rows = store.db
    .prepare(`SELECT memory_id, kind, ref FROM memory_evidence WHERE memory_id IN (${placeholders})`)
    .all(...ids) as Array<{ memory_id: string; kind: string; ref: string }>
  for (const row of rows) {
    const list = grouped.get(row.memory_id) ?? []
    list.push({ kind: row.kind as MemoryEvidenceKind, ref: row.ref })
    grouped.set(row.memory_id, list)
  }
  return grouped
}

function insertEvidence(store: Store, memoryId: string, evidence: MemoryEvidence[]): void {
  const insert = store.db.prepare('INSERT INTO memory_evidence (memory_id, kind, ref) VALUES (?, ?, ?)')
  for (const item of evidence) insert.run(memoryId, item.kind, item.ref)
}

function countMemoriesOnDay(store: Store, workspaceId: string, at: number): number {
  const dayStart = Math.floor(at / DAY_MS) * DAY_MS
  const row = store.db
    .prepare('SELECT COUNT(*) AS n FROM memories WHERE workspace_id = ? AND created_at >= ? AND created_at < ?')
    .get(workspaceId, dayStart, dayStart + DAY_MS) as { n: number | bigint } | undefined
  return row === undefined || row === null ? 0 : toNumber(row.n)
}

function assertWorkspaceExists(store: Store, workspaceId: string): void {
  const workspace = store.db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId)
  if (workspace === undefined || workspace === null) {
    throw new StoreError('WORKSPACE_NOT_FOUND', `unknown workspace ${workspaceId}`)
  }
}

function assertScopeOwnership(store: Store, workspaceId: string, scope: string): void {
  if (!scope.startsWith('room:')) return
  const roomId = scope.slice('room:'.length)
  const room = store.db.prepare('SELECT id FROM rooms WHERE id = ? AND workspace_id = ?').get(roomId, workspaceId)
  if (room === undefined || room === null) {
    throw memoryError(
      MEMORY_ERROR_CODES.invalid,
      `room ${roomId} does not belong to workspace ${workspaceId}`,
    )
  }
}

function readScope(value: unknown): string {
  if (typeof value !== 'string') {
    throw memoryError(MEMORY_ERROR_CODES.invalid, 'memory.scope must be a string')
  }
  const scope = value.trim()
  if (scope === 'team') return scope
  const match = /^(room|member):(.+)$/.exec(scope)
  if (match === null) {
    throw memoryError(MEMORY_ERROR_CODES.invalid, 'memory.scope must be team, room:<id>, or member:<id>')
  }
  const id = match[2]!.trim()
  if (id === '' || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw memoryError(MEMORY_ERROR_CODES.invalid, 'memory.scope id must be 1..200 safe characters')
  }
  return `${match[1]}:${id}`
}

function readScopes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw memoryError(MEMORY_ERROR_CODES.invalid, 'memory.scopes must be an array of scope strings')
  }
  const unique = new Set<string>()
  for (const entry of value) unique.add(readScope(entry))
  return [...unique]
}

function readKind(value: unknown): MemoryKind {
  if (typeof value !== 'string' || !(MEMORY_KINDS as readonly string[]).includes(value)) {
    throw memoryError(MEMORY_ERROR_CODES.invalid, `memory.kind must be one of ${MEMORY_KINDS.join(', ')}`)
  }
  return value as MemoryKind
}

function readStatus(value: unknown): MemoryStatus {
  if (typeof value !== 'string' || !(MEMORY_STATUSES as readonly string[]).includes(value)) {
    throw memoryError(MEMORY_ERROR_CODES.invalid, `memory.status must be one of ${MEMORY_STATUSES.join(', ')}`)
  }
  return value as MemoryStatus
}

function readConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw memoryError(MEMORY_ERROR_CODES.invalid, 'memory.confidence must be a number in [0, 1]')
  }
  return value
}

function readEvidence(value: unknown): MemoryEvidence[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw memoryError(MEMORY_ERROR_CODES.invalid, 'memory.evidence must be an array')
  }
  return value.map((entry) => {
    const record = asRecord(entry, 'memory.evidence', 'INVALID_INPUT')
    const kind = record.kind
    if (typeof kind !== 'string' || !(MEMORY_EVIDENCE_KINDS as readonly string[]).includes(kind)) {
      throw memoryError(
        MEMORY_ERROR_CODES.invalid,
        `memory.evidence.kind must be one of ${MEMORY_EVIDENCE_KINDS.join(', ')}`,
      )
    }
    return {
      kind: kind as MemoryEvidenceKind,
      ref: readRequiredText(record.ref, 'memory.evidence.ref', 1000),
    }
  })
}

function readIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw memoryError(MEMORY_ERROR_CODES.invalid, 'memory.ids must be an array of memory ids')
  }
  const ids = new Set<string>()
  for (const entry of value) ids.add(readRequiredText(entry, 'memory.ids[]', 200))
  return [...ids]
}

function readRequiredText(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== 'string') {
    throw memoryError(MEMORY_ERROR_CODES.invalid, `${label} must be a string`)
  }
  const text = value.trim()
  if (text === '') throw memoryError(MEMORY_ERROR_CODES.invalid, `${label} must not be empty`)
  if (text.length > maxChars) {
    throw memoryError(MEMORY_ERROR_CODES.invalid, `${label} must be at most ${maxChars} characters`)
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw memoryError(MEMORY_ERROR_CODES.invalid, `${label} must not contain control characters`)
  }
  return text
}

function readBudget(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw memoryError(MEMORY_ERROR_CODES.invalid, `${label} must be an integer >= 0`)
  }
  return value
}

function readAt(value: unknown): number {
  if (value === undefined || value === null) return Date.now()
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw memoryError(MEMORY_ERROR_CODES.invalid, 'at must be an integer >= 0')
  }
  return value
}

function readOptionalAt(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw memoryError(MEMORY_ERROR_CODES.invalid, `${label} must be an integer >= 0 or null`)
  }
  return value
}

/** 简单分词：按空白/标点/符号切分并小写（§6 的关键词召回，不接向量）。 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const token of text.toLowerCase().split(/[\s\p{P}\p{S}]+/u)) {
    if (token !== '') tokens.add(token)
  }
  return tokens
}

const KIND_LABELS: Record<MemoryKind, string> = {
  conclusion: '结论',
  constraint: '约束',
  preference: '偏好',
  fact: '事实',
}

function scopeLabel(scope: string): string {
  if (scope === 'team') return '团队'
  return scope.startsWith('room:') ? '房间' : '成员'
}

function formatConfidence(value: number): string {
  const text = value.toFixed(2).replace(/0+$/, '')
  return text.endsWith('.') ? `${text}0` : text
}

function renderSegment(items: RetrievedMemory[]): string {
  if (items.length === 0) return ''
  const lines = ['## 相关结论（系统检索，非用户输入）']
  for (const item of items) {
    lines.push(
      `- [${scopeLabel(item.scope)}] ${item.subject}：${item.claim}（置信 ${formatConfidence(item.confidence)}，${KIND_LABELS[item.kind]}）`,
    )
    if (item.evidence.length > 0) {
      lines.push(`  依据：${item.evidence.map((entry) => entry.ref).join(', ')}`)
    }
  }
  return lines.join('\n')
}

function memoryError(
  code: string,
  detail: string,
  kind: 'INVALID_INPUT' | 'FORBIDDEN' = 'INVALID_INPUT',
): StoreError {
  return new StoreError(kind, `${code}: ${detail}`)
}

function withSavepoint<T>(store: Store, name: string, fn: () => T): T {
  store.db.exec(`SAVEPOINT ${name}`)
  try {
    const result = fn()
    store.db.exec(`RELEASE ${name}`)
    return result
  } catch (err) {
    try {
      store.db.exec(`ROLLBACK TO ${name}`)
      store.db.exec(`RELEASE ${name}`)
    } catch {
      // savepoint 可能已随外层事务回滚；保留原始错误。
    }
    if (err instanceof StoreError) throw err
    throw new StoreError('INVALID_INPUT', `memory operation failed: ${errorMessage(err)}`, { cause: err })
  }
}
