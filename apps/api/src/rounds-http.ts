// 内部轮次接口（runtime token）：assignments / advance / 当前轮。
// 单独成模块，server.ts 只加三个路由分支；测试可以不经过整个控制面。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { activeRound, getRound, getStopping, latestRound, setStopping } from '../../../packages/store/src/rounds.ts'
import { getRoom } from '../../../packages/store/src/rooms.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { applyAdvance, assignmentsForRound } from './round-orchestrator.ts'
import { computerBoundBotIds } from './computer-jobs.ts'
import { authorizeRuntimeHttp, ensureRuntimeWorkspace } from './runtime-auth.ts'
import type { RuntimeRequestAuth } from './runtime-auth.ts'

export interface RoundsHttpContext {
  /** 轮次表所在的原始 SQLite store（同时充当 runtime token 的校验库）。 */
  store: Store
  /** 显式注入的原始 store；省略时复用 `store`（两者本来就是同一个库）。 */
  rawStore?: Store
  runtimeToken?: string
  now?: () => number
}

/** 统一鉴权：workspace token 的 workspaceId 用来校验 room/round 归属。 */
function authorize(ctx: RoundsHttpContext, req: IncomingMessage, res: ServerResponse): RuntimeRequestAuth | null {
  return authorizeRuntimeHttp({ ...ctx, rawStore: ctx.rawStore ?? ctx.store }, req, res)
}

/** 房间 → workspace；未知房间返回 null，交给原来的 404 路径。 */
function roomWorkspace(ctx: RoundsHttpContext, roomId: string): string | null {
  const room = getRoom(ctx.store, roomId)
  return room === null ? null : room.workspaceId
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { ok: false, error: { code, message } })
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return { __parseError: true }
  }
}

/** GET /api/internal/rooms/:id/assignments */
export async function handleInternalAssignments(
  ctx: RoundsHttpContext,
  req: IncomingMessage,
  res: ServerResponse,
  roomId: string
): Promise<void> {
  const auth = authorize(ctx, req, res)
  if (auth === null) return
  if (!ensureRuntimeWorkspace(auth, roomWorkspace(ctx, roomId), res)) return
  try {
    const workspaceId = roomWorkspace(ctx, roomId)
    const localBots = workspaceId === null ? new Set<string>() : computerBoundBotIds(ctx.store, workspaceId)
    send(res, 200, { assignments: assignmentsForRound(ctx.store, roomId).filter((assignment) => !localBots.has(assignment.botId)) })
  } catch (error) {
    fail(res, 404, 'room.not_found', error instanceof Error ? error.message : String(error))
  }
}

/** GET /api/internal/rooms/:id/round */
export async function handleInternalRound(
  ctx: RoundsHttpContext,
  req: IncomingMessage,
  res: ServerResponse,
  roomId: string
): Promise<void> {
  const auth = authorize(ctx, req, res)
  if (auth === null) return
  if (!ensureRuntimeWorkspace(auth, roomWorkspace(ctx, roomId), res)) return
  const round = activeRound(ctx.store, roomId) ?? latestRound(ctx.store, roomId)
  const stopping = round === null ? null : getStopping(ctx.store, round.id)
  send(res, 200, { round, stopping })
}

/** POST /api/internal/rounds/:id/advance */
export async function handleInternalAdvance(
  ctx: RoundsHttpContext,
  req: IncomingMessage,
  res: ServerResponse,
  roundId: string
): Promise<void> {
  const auth = authorize(ctx, req, res)
  if (auth === null) return
  const roundForToken = getRound(ctx.store, roundId)
  const targetWorkspace =
    roundForToken === null ? null : (getRoom(ctx.store, roundForToken.roomId)?.workspaceId ?? null)
  if (!ensureRuntimeWorkspace(auth, targetWorkspace, res)) return
  const body = await readJson(req)
  if (typeof body !== 'object' || body === null || (body as { __parseError?: boolean }).__parseError === true) {
    fail(res, 400, 'invalid_input', 'body must be JSON')
    return
  }
  const record = body as { slotIndex?: unknown; result?: unknown }
  if (typeof record.slotIndex !== 'number' || !Number.isInteger(record.slotIndex) || record.slotIndex < 0) {
    fail(res, 400, 'invalid_input', 'slotIndex must be a non-negative integer')
    return
  }
  if (typeof record.result !== 'object' || record.result === null || typeof (record.result as { kind?: unknown }).kind !== 'string') {
    fail(res, 400, 'invalid_input', 'result.kind must be a string')
    return
  }
  try {
    // 这一 slot 的停止请求已由 runtime 消费（advance missed），清掉避免跨轮误停。
    setStopping(ctx.store, roundId, null)
    const outcome = applyAdvance({
      store: ctx.store,
      roundId,
      slotIndex: record.slotIndex,
      result: record.result as never,
      ...(ctx.now === undefined ? {} : { now: ctx.now() })
    })
    send(res, 200, { round: outcome.round, next: outcome.next })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fail(res, message.includes('unknown round') ? 404 : 409, message.includes('unknown round') ? 'round.not_found' : 'round.conflict', message)
  }
}
