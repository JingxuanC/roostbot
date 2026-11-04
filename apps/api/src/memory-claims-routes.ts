// 记忆 claims 的内部入口（6.3.2 / 6.3.6）：房间回合结束后由 runtime 调用。
//
//   POST /api/internal/memory/claims   {workspaceId, text, alreadyToday?} → 抽取并写入
//   POST /api/internal/memory/cleanup  {workspaceId, falsifiedOlderThanMs?, keepRecent?} → 清理被否证
//
// 抽取器与清理计划在 @roost/memory（纯函数）；这里只做鉴权、store 读写与错误映射。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { extractClaims, planCleanup } from '../../../packages/memory/src/index.ts'
import { MEMORY_DAILY_LIMIT, deleteMemory, listMemories, writeMemory } from '../../../packages/store/src/memories.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { authorizeRuntimeHttp, ensureRuntimeWorkspace } from './runtime-auth.ts'
import type { RuntimeRequestAuth } from './runtime-auth.ts'

export interface MemoryClaimsContext {
  store: Store
  /** 原始 store；省略时复用 `store`（memory claims 本来就只接真库）。 */
  rawStore?: Store
  runtimeToken?: string
  now?: () => number
}

function authorize(ctx: MemoryClaimsContext, req: IncomingMessage, res: ServerResponse): RuntimeRequestAuth | null {
  return authorizeRuntimeHttp({ ...ctx, rawStore: ctx.rawStore ?? ctx.store }, req, res)
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 今天（UTC）已经写入的记忆条数：用来把 dailyCap 传给抽取器。 */
function todayCount(store: Store, workspaceId: string, now: number): number {
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000
  return listMemories(store, { workspaceId }).filter((memory) => memory.createdAt >= dayStart).length
}

export async function handleMemoryClaims(ctx: MemoryClaimsContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = authorize(ctx, req, res)
  if (auth === null) return
  const body = await readJson(req)
  if (body === null) return send(res, 400, { ok: false, error: { code: 'invalid_body', message: 'body must be a JSON object' } })
  const workspaceId = typeof body['workspaceId'] === 'string' ? body['workspaceId'].trim() : ''
  const text = typeof body['text'] === 'string' ? body['text'] : ''
  if (workspaceId === '' || text.trim() === '') {
    return send(res, 400, { ok: false, error: { code: 'invalid_body', message: 'workspaceId and text are required' } })
  }
  // workspace token 只能给自己 workspace 写记忆。
  if (!ensureRuntimeWorkspace(auth, workspaceId, res)) return
  const now = ctx.now?.() ?? Date.now()
  const alreadyToday = typeof body['alreadyToday'] === 'number' ? body['alreadyToday'] : todayCount(ctx.store, workspaceId, now)
  const extracted = extractClaims({ text, now, dailyCap: MEMORY_DAILY_LIMIT, alreadyToday })
  const accepted: string[] = []
  const failed: Array<{ reason: string; detail: string }> = []
  for (const claim of extracted.claims) {
    try {
      const memory = writeMemory(ctx.store, {
        workspaceId,
        scope: 'team',
        subject: claim.subject,
        claim: `${claim.predicate} ${claim.object}`.trim(),
        kind: 'conclusion',
        confidence: claim.confidence,
        falsifier: claim.falsifier,
        evidence: [{ kind: 'event', ref: claim.sourceQuote }],
        at: claim.at,
        by: 'runtime/memory'
      })
      accepted.push(memory.id)
    } catch (error) {
      failed.push({ reason: 'write_failed', detail: error instanceof Error ? error.message : String(error) })
    }
  }
  send(res, 200, { ok: true, accepted, rejected: extracted.rejected, failed })
}

export async function handleMemoryCleanup(ctx: MemoryClaimsContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = authorize(ctx, req, res)
  if (auth === null) return
  const body = await readJson(req)
  if (body === null) return send(res, 400, { ok: false, error: { code: 'invalid_body', message: 'body must be a JSON object' } })
  const workspaceId = typeof body['workspaceId'] === 'string' ? body['workspaceId'].trim() : ''
  if (workspaceId === '') return send(res, 400, { ok: false, error: { code: 'invalid_body', message: 'workspaceId is required' } })
  // workspace token 只能清理自己 workspace 的记忆。
  if (!ensureRuntimeWorkspace(auth, workspaceId, res)) return
  const now = ctx.now?.() ?? Date.now()
  // store 目前没有 falsified_at 列：用「retracted 之后的过期」近似（planCleanup 只清带 falsifiedAt 的条目）。
  const memories = listMemories(ctx.store, { workspaceId }).map((memory) => ({
    id: memory.id,
    status: memory.status,
    createdAt: memory.createdAt,
    ...(memory.status === 'retracted' && memory.expiresAt !== null ? { falsifiedAt: memory.expiresAt } : {})
  }))
  const plan = planCleanup({
    claims: memories,
    now,
    ...(typeof body['falsifiedOlderThanMs'] === 'number' ? { falsifiedOlderThanMs: body['falsifiedOlderThanMs'] } : {}),
    ...(typeof body['keepRecent'] === 'number' ? { keepRecent: body['keepRecent'] } : {})
  })
  const removed: string[] = []
  for (const id of plan.remove) {
    try {
      deleteMemory(ctx.store, { id, at: now })
      removed.push(id)
    } catch {
      // 单条删除失败不影响其它条目。
    }
  }
  send(res, 200, { ok: true, plan, removed })
}
