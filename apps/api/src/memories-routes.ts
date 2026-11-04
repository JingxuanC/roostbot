// 记忆控制面（M6-6.3；docs/design/memory.md §4–§7、§9）。
//
// 本文件只导出 handler，由 server.ts 接线：
//
//   POST   /api/internal/memories           handleInternalWriteMemory   runtime token
//   POST   /api/internal/memories/retrieve  handleInternalRetrieve      runtime token
//   POST   /api/internal/memories/reads     handleInternalRecordReads   runtime token
//   GET    /api/memories                    handleListMemories          Bearer（任意成员）
//   DELETE /api/memories/:id                handleDeleteMemory          Bearer（owner/admin）
//   GET    /api/memories/export             handleExportMemories        Bearer（owner/admin）
//
// 抽取器不在这里：runtime 侧用规则校验后调用内部写接口；本层只做输入形状、权限与错误映射。
// 记忆表只在 SQLite 里；内存 port（无 rawStore）一律 503 runtime.not_configured。
// runtime token 语义与其他内部接口一致：未配置 404，错误 token 401。

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  MEMORY_ERROR_CODES,
  StoreError,
  deleteMemory,
  exportMemories,
  getMemory,
  getWorkspaceRole,
  listMemories,
  recordReads,
  retrieve,
  storeErrorTag,
  writeMemory,
} from '../../../packages/store/src/index.ts'
import type { Memory, MemoryEvidence, MemoryKind, MemoryStatus } from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import type { SessionRecord, StorePort } from './port.ts'
import { authenticate, isPlainObject, readJsonBody, sendError, sendJson } from './server.ts'

export interface MemoriesRouteContext {
  store: StorePort
  now: () => number
  /** 记忆表只在 SQLite 里；内存 port 下返回 503。 */
  rawStore?: Store
  runtimeToken?: string
}

type Ctx = MemoriesRouteContext

const MAX_ID_CHARS = 200
const MAX_SCOPE_CHARS = 200
const MAX_SUBJECT_CHARS = 500
const MAX_CLAIM_CHARS = 2000
const MAX_FALSIFIER_CHARS = 2000
const MAX_REF_CHARS = 1000

// ---- 内部：抽取器写入 / 检索 / 读取记录 --------------------------------------

export async function handleInternalWriteMemory(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const store = requireRuntimeStore(ctx, req, res)
  if (store === null) return
  const body = await readObjectBody(req, res)
  if (body === null) return

  const workspaceId = readString(body['workspaceId'], MAX_ID_CHARS)
  if (workspaceId === null) return sendError(res, 400, 'invalid_body', 'workspaceId is required')
  const scope = readString(body['scope'], MAX_SCOPE_CHARS)
  if (scope === null) return sendError(res, 400, 'invalid_body', 'scope is required')
  const subject = readString(body['subject'], MAX_SUBJECT_CHARS)
  if (subject === null) return sendError(res, 400, 'invalid_body', 'subject is required')
  const claim = readString(body['claim'], MAX_CLAIM_CHARS)
  if (claim === null) return sendError(res, 400, 'invalid_body', 'claim is required')
  const falsifier = readString(body['falsifier'], MAX_FALSIFIER_CHARS)
  if (falsifier === null) {
    return sendError(res, 400, 'memory.invalid', 'falsifier is required (non-empty string)')
  }
  const kind = readKind(body['kind'])
  if (kind === null) {
    return sendError(res, 400, 'memory.invalid', 'kind must be conclusion|constraint|preference|fact')
  }
  const confidence = body['confidence']
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return sendError(res, 400, 'memory.invalid', 'confidence must be a number in [0, 1]')
  }
  const evidence = readEvidence(body['evidence'])
  if (evidence === INVALID) {
    return sendError(res, 400, 'invalid_body', 'evidence must be an array of {kind, ref}')
  }
  const supersedes = readOptionalString(body['supersedes'], MAX_ID_CHARS)
  if (supersedes === INVALID) {
    return sendError(res, 400, 'invalid_body', 'supersedes must be a memory id when present')
  }
  const expiresAt = readOptionalInteger(body['expiresAt'])
  if (expiresAt === INVALID) {
    return sendError(res, 400, 'invalid_body', 'expiresAt must be an integer >= 0 when present')
  }
  const by = readOptionalString(body['by'], MAX_ID_CHARS)
  if (by === INVALID) return sendError(res, 400, 'invalid_body', 'by must be a string when present')

  try {
    const memory = writeMemory(store, {
      workspaceId,
      scope,
      subject,
      claim,
      kind,
      confidence,
      falsifier,
      evidence,
      ...(supersedes === null ? {} : { supersedes }),
      ...(expiresAt === null ? {} : { expiresAt }),
      ...(by === null ? {} : { by }),
      at: ctx.now(),
    })
    sendJson(res, 201, { memory: memoryJson(memory) })
  } catch (err) {
    sendMemoryFailure(res, err)
  }
}

export async function handleInternalRetrieve(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const store = requireRuntimeStore(ctx, req, res)
  if (store === null) return
  const body = await readObjectBody(req, res)
  if (body === null) return

  const workspaceId = readString(body['workspaceId'], MAX_ID_CHARS)
  if (workspaceId === null) return sendError(res, 400, 'invalid_body', 'workspaceId is required')
  const scopes = readStringArray(body['scopes'], MAX_SCOPE_CHARS)
  if (scopes === null) return sendError(res, 400, 'invalid_body', 'scopes must be an array of scope strings')
  if (typeof body['query'] !== 'string') {
    return sendError(res, 400, 'invalid_body', 'query must be a string')
  }
  const budgetTokens = readOptionalInteger(body['budgetTokens'])
  if (budgetTokens === INVALID) {
    return sendError(res, 400, 'invalid_body', 'budgetTokens must be an integer >= 0 when present')
  }
  const limit = readOptionalInteger(body['limit'])
  if (limit === INVALID) return sendError(res, 400, 'invalid_body', 'limit must be an integer >= 0 when present')

  try {
    const result = retrieve(store, {
      workspaceId,
      scopes,
      query: body['query'],
      ...(budgetTokens === null ? {} : { budgetTokens }),
      ...(limit === null ? {} : { limit }),
      at: ctx.now(),
    })
    sendJson(res, 200, { items: result.items, segment: result.segment, dropped: result.dropped })
  } catch (err) {
    sendMemoryFailure(res, err)
  }
}

export async function handleInternalRecordReads(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const store = requireRuntimeStore(ctx, req, res)
  if (store === null) return
  const body = await readObjectBody(req, res)
  if (body === null) return

  const turnId = readString(body['turnId'], MAX_ID_CHARS)
  if (turnId === null) return sendError(res, 400, 'invalid_body', 'turnId is required')
  const ids = readStringArray(body['ids'], MAX_ID_CHARS)
  if (ids === null) return sendError(res, 400, 'invalid_body', 'ids must be an array of memory ids')
  if (body['used'] !== undefined && typeof body['used'] !== 'boolean') {
    return sendError(res, 400, 'invalid_body', 'used must be a boolean when present')
  }

  try {
    recordReads(store, {
      turnId,
      ids,
      used: body['used'] === true,
      at: ctx.now(),
    })
    res.writeHead(204, { 'cache-control': 'no-store' })
    res.end()
  } catch (err) {
    sendMemoryFailure(res, err)
  }
}

// ---- 用户：列表 / 删除 / 导出 ------------------------------------------------

export async function handleListMemories(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  const store = requireStore(ctx, res)
  if (store === null) return

  const workspaceId = readString(url.searchParams.get('workspaceId'), MAX_ID_CHARS)
  if (workspaceId === null) return sendError(res, 400, 'invalid_body', 'workspaceId is required')
  // 非成员一律 404，不泄露 workspace 是否存在（memory.md §4）。
  if (getWorkspaceRole(store, workspaceId, auth.accountId) === null) {
    return sendError(res, 404, 'workspace_not_found', `unknown workspace ${workspaceId}`)
  }

  const scope = readOptionalString(url.searchParams.get('scope'), MAX_SCOPE_CHARS)
  if (scope === INVALID) return sendError(res, 400, 'invalid_body', 'scope must be a string when present')
  const status = readStatus(url.searchParams.get('status'))
  if (status === INVALID) {
    return sendError(res, 400, 'memory.invalid', 'status must be active|superseded|retracted|expired when present')
  }

  try {
    const memories = listMemories(store, {
      workspaceId,
      ...(scope === null ? {} : { scope }),
      ...(status === null ? {} : { status }),
    })
    sendJson(res, 200, { memories: memories.map(memoryJson) })
  } catch (err) {
    sendMemoryFailure(res, err)
  }
}

export async function handleDeleteMemory(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  const store = requireStore(ctx, res)
  if (store === null) return

  const memoryId = memoryIdFromPath(url.pathname)
  if (memoryId === null) return sendError(res, 404, 'not_found', 'malformed memory path')

  try {
    const memory = getMemory(store, memoryId)
    if (memory === null) {
      return sendError(res, 404, 'memory.not_found', `unknown memory ${memoryId}`)
    }
    const role = getWorkspaceRole(store, memory.workspaceId, auth.accountId)
    if (role === null) {
      return sendError(res, 404, 'workspace_not_found', `unknown workspace ${memory.workspaceId}`)
    }
    if (role !== 'owner' && role !== 'admin') {
      return sendError(res, 403, 'forbidden', `workspace ${memory.workspaceId} requires owner/admin role`)
    }
    deleteMemory(store, { id: memoryId, at: ctx.now() })
    res.writeHead(204, { 'cache-control': 'no-store' })
    res.end()
  } catch (err) {
    sendMemoryFailure(res, err)
  }
}

export async function handleExportMemories(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  const store = requireStore(ctx, res)
  if (store === null) return

  const workspaceId = readString(url.searchParams.get('workspaceId'), MAX_ID_CHARS)
  if (workspaceId === null) return sendError(res, 400, 'invalid_body', 'workspaceId is required')
  const role = getWorkspaceRole(store, workspaceId, auth.accountId)
  if (role === null) return sendError(res, 404, 'workspace_not_found', `unknown workspace ${workspaceId}`)
  if (role !== 'owner' && role !== 'admin') {
    return sendError(res, 403, 'forbidden', `workspace ${workspaceId} requires owner/admin role`)
  }

  try {
    sendJson(res, 200, { memories: exportMemories(store, workspaceId).map(memoryJson) })
  } catch (err) {
    sendMemoryFailure(res, err)
  }
}

// ---- 序列化与内部 ------------------------------------------------------------

export function memoryJson(memory: Memory): Record<string, unknown> {
  return {
    id: memory.id,
    workspaceId: memory.workspaceId,
    scope: memory.scope,
    subject: memory.subject,
    claim: memory.claim,
    kind: memory.kind,
    confidence: memory.confidence,
    falsifier: memory.falsifier,
    evidence: memory.evidence.map((entry) => ({ kind: entry.kind, ref: entry.ref })),
    supersedes: memory.supersedes,
    status: memory.status,
    createdAt: memory.createdAt,
    expiresAt: memory.expiresAt,
    hits: memory.hits,
  }
}

function runtimeTokenFrom(req: IncomingMessage): string | null {
  const header = (req.headers['x-runtime-token'] ?? '').toString()
  if (header !== '') return header
  const auth = (req.headers.authorization ?? '').trim()
  const match = /^Runtime[ ]+(\S+)$/.exec(auth)
  return match === null ? null : match[1]!
}

function authorizeRuntime(ctx: Ctx, req: IncomingMessage, res: ServerResponse): boolean {
  if (ctx.runtimeToken === undefined || ctx.runtimeToken === '') {
    sendError(res, 404, 'not_found', 'internal api is disabled')
    return false
  }
  const token = runtimeTokenFrom(req)
  if (token === null || token !== ctx.runtimeToken) {
    sendError(res, 401, 'unauthenticated', 'runtime token required')
    return false
  }
  return true
}

function requireRuntimeStore(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Store | null {
  if (!authorizeRuntime(ctx, req, res)) return null
  return requireStore(ctx, res)
}

function requireStore(ctx: Ctx, res: ServerResponse): Store | null {
  if (ctx.rawStore !== undefined) return ctx.rawStore
  sendError(res, 503, 'runtime.not_configured', 'memories need the SQLite store')
  return null
}

async function requireAuth(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<SessionRecord | null> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
    return null
  }
  return auth.session
}

async function readObjectBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  const parsed = await readJsonBody(req)
  if (!parsed.ok) {
    sendError(res, parsed.status, parsed.code, parsed.message)
    return null
  }
  if (!isPlainObject(parsed.value)) {
    sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
    return null
  }
  return parsed.value
}

const INVALID = Symbol('invalid')
type Invalid = typeof INVALID

function readString(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' || text.length > maxChars ? null : text
}

function readOptionalString(value: unknown, maxChars: number): string | null | Invalid {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return INVALID
  const text = value.trim()
  if (text === '') return null
  return text.length > maxChars ? INVALID : text
}

function readOptionalInteger(value: unknown): number | null | Invalid {
  if (value === undefined || value === null) return null
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : INVALID
}

function readStringArray(value: unknown, maxChars: number): string[] | null {
  if (!Array.isArray(value)) return null
  const result: string[] = []
  for (const entry of value) {
    const text = readString(entry, maxChars)
    if (text === null) return null
    result.push(text)
  }
  return result
}

function readKind(value: unknown): MemoryKind | null {
  return value === 'conclusion' || value === 'constraint' || value === 'preference' || value === 'fact'
    ? value
    : null
}

function readStatus(value: string | null): MemoryStatus | null | Invalid {
  if (value === null) return null
  return value === 'active' || value === 'superseded' || value === 'retracted' || value === 'expired'
    ? value
    : INVALID
}

function readEvidence(value: unknown): MemoryEvidence[] | Invalid {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return INVALID
  const evidence: MemoryEvidence[] = []
  for (const entry of value) {
    if (!isPlainObject(entry)) return INVALID
    const kind = entry['kind']
    if (kind !== 'event' && kind !== 'report' && kind !== 'file') return INVALID
    const ref = readString(entry['ref'], MAX_REF_CHARS)
    if (ref === null) return INVALID
    evidence.push({ kind, ref })
  }
  return evidence
}

function memoryIdFromPath(pathname: string): string | null {
  const match = /^\/api\/memories\/([^/]+)$/.exec(pathname.replace(/\/+$/, ''))
  if (match === null) return null
  try {
    return readString(decodeURIComponent(match[1]!), MAX_ID_CHARS)
  } catch {
    return null
  }
}

function sendMemoryFailure(res: ServerResponse, err: unknown): void {
  const tag = storeErrorTag(err)
  if (tag === MEMORY_ERROR_CODES.dailyLimit) {
    return sendError(res, 429, 'memory.daily_limit', err instanceof Error ? err.message : 'daily memory limit reached')
  }
  if (tag === MEMORY_ERROR_CODES.notFound) {
    return sendError(res, 404, 'memory.not_found', err instanceof Error ? err.message : 'memory not found')
  }
  if (tag === MEMORY_ERROR_CODES.invalid) {
    return sendError(res, 400, 'memory.invalid', err instanceof Error ? err.message : 'invalid memory')
  }
  if (err instanceof StoreError) {
    if (err.code === 'WORKSPACE_NOT_FOUND') return sendError(res, 404, 'workspace_not_found', err.message)
    if (err.code === 'INVALID_INPUT') return sendError(res, 400, 'memory.invalid', err.message)
    if (err.code === 'FORBIDDEN') return sendError(res, 403, 'forbidden', err.message)
  }
  console.error('roost api: memory store failure', err)
  sendError(res, 500, 'internal_error', 'memory store failure')
}
