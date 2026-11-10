// Native Relay PoC (docs/design/agent-runtimes.md §5.1).
//
// An external agent session (Claude Code / Codex / Grok Build running on the
// user's own machine) binds to a room Bot as a native binding, polls the same
// RoundAssignments the embedded room-agent receives, and advances the slot with
// its answer. No model credentials enter Roost.
//
// Auth is the user's Bearer session: the external process runs on the user's
// machine. A binding must already exist and be active/native.

import type { IncomingMessage, ServerResponse } from 'node:http'

import { getBot, getRoom, StoreError } from '../../../packages/store/src/index.ts'
import { listBindings } from '../../../packages/store/src/agent-bindings.ts'
import { activeRound, getRound } from '../../../packages/store/src/rounds.ts'
import type { SlotResult } from '../../../packages/contract/src/index.ts'
import { applyAdvance, assignmentsForRound } from './round-orchestrator.ts'
import { requireWorkspaceRole, workspaceIdForRoom } from './members-routes.ts'
import { authenticate, isPlainObject, readJsonBody, sendError, sendJson } from './server.ts'
import type { StorePort } from './port.ts'
import type { Store } from '../../../packages/store/src/types.ts'

export interface NativeRelayContext {
  store: StorePort
  now: () => number
  rawStore?: Store
}

async function gate(ctx: NativeRelayContext, req: IncomingMessage, res: ServerResponse, roomId: string) {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
    return null
  }
  if (ctx.rawStore === undefined) {
    sendError(res, 503, 'native.not_configured', 'native relay needs the SQLite store')
    return null
  }
  const room = getRoom(ctx.rawStore, roomId)
  if (room === null) {
    sendError(res, 404, 'not_found', 'unknown room')
    return null
  }
  const workspaceId = workspaceIdForRoom(ctx, roomId)
  if (workspaceId === null) {
    sendError(res, 404, 'not_found', 'unknown room workspace')
    return null
  }
  const role = requireWorkspaceRole(ctx, workspaceId, auth.session.accountId, ['owner', 'admin', 'member'])
  if (!role.ok) {
    sendError(res, role.status, role.code, role.message)
    return null
  }
  return { store: ctx.rawStore, accountId: auth.session.accountId, room }
}

function activeNativeBinding(store: Store, roomId: string, botId: string): boolean {
  return listBindings(store, { roomId, botId, state: 'active' }).some((binding) => binding.kind === 'native')
}

/** GET /api/native/assignments?roomId=&botId=  (user Bearer) */
export async function handleNativeAssignments(
  ctx: NativeRelayContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const roomId = String(url.searchParams.get('roomId') ?? '').trim()
  const botId = String(url.searchParams.get('botId') ?? '').trim()
  if (roomId === '' || botId === '') return sendError(res, 400, 'invalid_request', 'roomId and botId are required')
  const gateResult = await gate(ctx, req, res, roomId)
  if (gateResult === null) return
  const bot = getBot(gateResult.store, botId)
  if (bot === null || bot.workspaceId !== gateResult.room.workspaceId) {
    return sendError(res, 404, 'bot_not_found', 'unknown bot in this room workspace')
  }
  if (!activeNativeBinding(gateResult.store, roomId, botId)) {
    return sendError(res, 403, 'native.not_bound', 'create an active native binding for this Bot first')
  }
  try {
    const round = activeRound(gateResult.store, roomId)
    if (round === null) return sendJson(res, 200, { round: null, assignments: [] })
    const assignments = assignmentsForRound(gateResult.store, roomId).filter((assignment) => assignment.botId === botId)
    sendJson(res, 200, { round: { id: round.id, state: round.state }, assignments })
  } catch (error) {
    sendError(res, 500, 'native.failed', error instanceof Error ? error.message : String(error))
  }
}

/** POST /api/native/advance  {roomId, roundId, slotIndex, result}  (user Bearer) */
export async function handleNativeAdvance(
  ctx: NativeRelayContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  const body = parsed.value
  const roomId = typeof body['roomId'] === 'string' ? body['roomId'].trim() : ''
  const roundId = typeof body['roundId'] === 'string' ? body['roundId'].trim() : ''
  const botId = typeof body['botId'] === 'string' ? body['botId'].trim() : ''
  const slotIndex = typeof body['slotIndex'] === 'number' ? Math.trunc(body['slotIndex']) : -1
  const result = body['result']
  if (roomId === '' || roundId === '' || botId === '' || slotIndex < 0) {
    return sendError(res, 400, 'invalid_request', 'roomId, roundId, botId and slotIndex are required')
  }
  if (!isPlainObject(result) || typeof result['kind'] !== 'string') {
    return sendError(res, 400, 'invalid_body', 'result must be a SlotResult object')
  }
  if (result['kind'] === 'posted' && (typeof result['text'] !== 'string' || result['text'].trim() === '')) {
    return sendError(res, 400, 'invalid_body', 'posted result needs non-empty text')
  }
  const gateResult = await gate(ctx, req, res, roomId)
  if (gateResult === null) return
  if (!activeNativeBinding(gateResult.store, roomId, botId)) {
    return sendError(res, 403, 'native.not_bound', 'create an active native binding for this Bot first')
  }
  try {
    const round = getRound(gateResult.store, roundId)
    if (round === null || round.roomId !== roomId) return sendError(res, 404, 'round_not_found', 'unknown round in this room')
    if (round.slots[slotIndex]?.botId !== botId) return sendError(res, 403, 'native.slot_mismatch', 'this slot belongs to another Bot')
    const advanced = applyAdvance({
      store: gateResult.store,
      roundId,
      slotIndex,
      result: result as SlotResult,
      now: ctx.now(),
    })
    sendJson(res, 200, { round: advanced.round, next: advanced.next })
  } catch (error) {
    if (error instanceof StoreError) return sendError(res, 400, 'native.invalid', error.message)
    sendError(res, 500, 'native.failed', error instanceof Error ? error.message : String(error))
  }
}
