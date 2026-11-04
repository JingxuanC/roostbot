// 内部轮次接口（runtime token）：assignments / advance / 当前轮。
// 单独成模块，server.ts 只加三个路由分支；测试可以不经过整个控制面。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { activeRound, getStopping, latestRound, setStopping } from '../../../packages/store/src/rounds.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { applyAdvance, assignmentsForRound } from './round-orchestrator.ts'

export interface RoundsHttpContext {
  store: Store
  runtimeToken?: string
  now?: () => number
}

function tokenFrom(req: IncomingMessage): string | null {
  const header = req.headers['x-runtime-token']
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value === 'string' && value !== '') return value
  return null
}

function authorized(ctx: RoundsHttpContext, req: IncomingMessage): boolean {
  if (ctx.runtimeToken === undefined || ctx.runtimeToken === '') return false
  return tokenFrom(req) === ctx.runtimeToken
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
  if (!authorized(ctx, req)) {
    fail(res, 401, 'unauthorized', 'runtime token required')
    return
  }
  try {
    send(res, 200, { assignments: assignmentsForRound(ctx.store, roomId) })
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
  if (!authorized(ctx, req)) {
    fail(res, 401, 'unauthorized', 'runtime token required')
    return
  }
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
  if (!authorized(ctx, req)) {
    fail(res, 401, 'unauthorized', 'runtime token required')
    return
  }
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
