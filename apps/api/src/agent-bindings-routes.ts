// Room slot / agent binding control-plane API（docs/design/agent-runtimes.md §10–§11）。
//
//   GET    /api/rooms/:id/slots
//   POST   /api/rooms/:id/slots
//   GET    /api/rooms/:id/slots/:slotId
//   PATCH  /api/rooms/:id/slots/:slotId
//   DELETE /api/rooms/:id/slots/:slotId
//   POST   /api/rooms/:id/slots/:slotId/bindings
//   POST   /api/bindings/:id/close
//
// 所有路由都要 Bearer；读写都按 room 所属 workspace 的成员校验。Slot/Binding
// 只存在 SQLite store（memory port 没有这些表），因此 rawStore 缺失时 503。
// 写操作写 room 级事件（audience=room:<id>），供 SSE / 审计使用。
import type { IncomingMessage, ServerResponse } from 'node:http'

import { isAgentRuntimeKind } from '../../../packages/agent-runtime/src/index.ts'
import { getBot, getRoom, StoreError } from '../../../packages/store/src/index.ts'
import {
  BINDING_KINDS,
  BINDING_STATES,
  SLOT_STATUSES,
  closeBinding,
  closeRoomSlot,
  createBinding,
  createRoomSlot,
  getBinding,
  getRoomSlot,
  listAgentSessions,
  listBindings,
  listRoomSlots,
} from '../../../packages/store/src/agent-bindings.ts'
import { appendRoomSignal } from '../../../packages/store/src/room-log.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { authenticate, isPlainObject, readJsonBody, sendError, sendJson } from './server.ts'
import type { StorePort } from './port.ts'
import { requireWorkspaceRole, workspaceIdForRoom } from './members-routes.ts'

export interface AgentBindingsRouteContext {
  store: StorePort
  now: () => number
  /** Slot/Binding 表只在 SQLite store 里；memory 模式为 undefined。 */
  rawStore?: Store
}

const WRITE_ROLES = ['owner', 'admin'] as const
const READ_ROLES = ['owner', 'admin', 'member', 'viewer'] as const

interface RoomGate {
  store: Store
  workspaceId: string
}

// ---- collection -----------------------------------------------------------

export async function handleListRoomSlots(
  ctx: AgentBindingsRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const roomId = roomIdFromPath(url.pathname)
  if (roomId === null) return sendError(res, 404, 'not_found', 'malformed room slots path')
  const gate = requireRoomGate(ctx, res, roomId, auth.session.accountId, false)
  if (gate === null) return

  try {
    const slots = listRoomSlots(gate.store, { roomId })
    const bindings = listBindings(gate.store, { roomId })
    sendJson(res, 200, { slots, bindings })
  } catch (err) {
    sendAgentFailure(res, err)
  }
}

export async function handleCreateRoomSlot(
  ctx: AgentBindingsRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const roomId = roomIdFromPath(url.pathname)
  if (roomId === null) return sendError(res, 404, 'not_found', 'malformed room slots path')
  const gate = requireRoomGate(ctx, res, roomId, auth.session.accountId, true)
  if (gate === null) return

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  const body = parsed.value

  if (body['botId'] !== undefined && (typeof body['botId'] !== 'string' || body['botId'].trim() === '')) {
    return sendError(res, 400, 'agent_binding.invalid', 'botId must be a non-empty string')
  }
  if (body['runtimeKind'] !== undefined && !isAgentRuntimeKind(body['runtimeKind'])) {
    return sendError(res, 400, 'agent_binding.invalid', 'runtimeKind must be one of dsh|grok-build|claude-code|codex|hermes')
  }
  if (body['status'] !== undefined && (typeof body['status'] !== 'string' || !(SLOT_STATUSES as readonly string[]).includes(body['status']))) {
    return sendError(res, 400, 'agent_binding.invalid', `status must be one of ${SLOT_STATUSES.join('|')}`)
  }

  try {
    const slot = createRoomSlot(gate.store, {
      roomId,
      ...(body['botId'] === undefined ? {} : { botId: String(body['botId']).trim() }),
      ...(body['runtimeKind'] === undefined ? {} : { runtimeKind: body['runtimeKind'] }),
      ...(body['status'] === undefined ? {} : { status: body['status'] as (typeof SLOT_STATUSES)[number] }),
      createdAt: ctx.now(),
    })
    noteRoomEvent(gate.store, roomId, auth.session.accountId, 'agent.slot.created', slot.id, {
      slotId: slot.id,
      botId: slot.botId ?? null,
      runtimeKind: slot.runtimeKind ?? null,
      status: slot.status,
    })
    sendJson(res, 201, { slot })
  } catch (err) {
    sendAgentFailure(res, err)
  }
}

// ---- item -----------------------------------------------------------------

export async function handleGetRoomSlot(
  ctx: AgentBindingsRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const target = slotPathFromUrl(url.pathname)
  if (target === null) return sendError(res, 404, 'not_found', 'malformed slot path')
  const gate = requireRoomGate(ctx, res, target.roomId, auth.session.accountId, false)
  if (gate === null) return
  const slot = getRoomSlot(gate.store, target.slotId)
  if (slot === null || slot.roomId !== target.roomId) return sendError(res, 404, 'slot_not_found', 'unknown slot')
  const bindings = listBindings(gate.store, { slotId: slot.id })
  const sessions = bindings.flatMap((binding) => listAgentSessions(gate.store, { bindingId: binding.id }))
  sendJson(res, 200, { slot, bindings, sessions })
}

export async function handlePatchRoomSlot(
  ctx: AgentBindingsRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const target = slotPathFromUrl(url.pathname)
  if (target === null) return sendError(res, 404, 'not_found', 'malformed slot path')
  const gate = requireRoomGate(ctx, res, target.roomId, auth.session.accountId, true)
  if (gate === null) return
  const slot = getRoomSlot(gate.store, target.slotId)
  if (slot === null || slot.roomId !== target.roomId) return sendError(res, 404, 'slot_not_found', 'unknown slot')

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  const body = parsed.value

  let botId: string | null | undefined
  if (body['botId'] !== undefined) {
    if (body['botId'] === null) botId = null
    else if (typeof body['botId'] === 'string' && body['botId'].trim() !== '') botId = body['botId'].trim()
    else return sendError(res, 400, 'agent_binding.invalid', 'botId must be a non-empty string or null')
  }
  let runtimeKind: string | null | undefined
  if (body['runtimeKind'] !== undefined) {
    if (body['runtimeKind'] === null) runtimeKind = null
    else if (isAgentRuntimeKind(body['runtimeKind'])) runtimeKind = body['runtimeKind']
    else return sendError(res, 400, 'agent_binding.invalid', 'runtimeKind must be one of dsh|grok-build|claude-code|codex|hermes')
  }
  let status: string | undefined
  if (body['status'] !== undefined) {
    if (typeof body['status'] !== 'string' || !(SLOT_STATUSES as readonly string[]).includes(body['status'])) {
      return sendError(res, 400, 'agent_binding.invalid', `status must be one of ${SLOT_STATUSES.join('|')}`)
    }
    status = body['status']
  }
  if (botId === undefined && runtimeKind === undefined && status === undefined) {
    return sendError(res, 400, 'agent_binding.invalid', 'nothing to update')
  }

  try {
    if (status === 'closed') {
      const closed = closeRoomSlot(gate.store, slot.id, { now: ctx.now() })
      noteRoomEvent(gate.store, slot.roomId, auth.session.accountId, 'agent.slot.closed', closed.id, {
        slotId: closed.id,
        botId: closed.botId ?? null,
      })
      return sendJson(res, 200, { slot: closed })
    }
    if (botId !== undefined && botId !== null) {
      const bot = getBot(gate.store, botId)
      const room = getRoom(gate.store, target.roomId)
      if (bot === null) return sendError(res, 404, 'bot_not_found', `unknown bot ${botId}`)
      if (room !== null && bot.workspaceId !== room.workspaceId) {
        return sendError(res, 400, 'agent_binding.invalid', 'slot bot and room must belong to the same workspace')
      }
    }
    const now = ctx.now()
    gate.store.db
      .prepare('UPDATE room_slots SET bot_id = ?, runtime_kind = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(
        botId === undefined ? slot.botId ?? null : botId,
        runtimeKind === undefined ? slot.runtimeKind ?? null : runtimeKind,
        status ?? slot.status,
        now,
        slot.id,
      )
    const updated = getRoomSlot(gate.store, slot.id)
    noteRoomEvent(gate.store, target.roomId, auth.session.accountId, 'agent.slot.updated', slot.id, {
      slotId: slot.id,
      botId: updated?.botId ?? null,
      runtimeKind: updated?.runtimeKind ?? null,
      status: updated?.status ?? null,
    })
    sendJson(res, 200, { slot: updated })
  } catch (err) {
    sendAgentFailure(res, err)
  }
}

export async function handleDeleteRoomSlot(
  ctx: AgentBindingsRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const target = slotPathFromUrl(url.pathname)
  if (target === null) return sendError(res, 404, 'not_found', 'malformed slot path')
  const gate = requireRoomGate(ctx, res, target.roomId, auth.session.accountId, true)
  if (gate === null) return
  const slot = getRoomSlot(gate.store, target.slotId)
  if (slot === null || slot.roomId !== target.roomId) return sendError(res, 404, 'slot_not_found', 'unknown slot')
  try {
    const closed = closeRoomSlot(gate.store, slot.id, { now: ctx.now() })
    noteRoomEvent(gate.store, target.roomId, auth.session.accountId, 'agent.slot.closed', slot.id, {
      slotId: slot.id,
    })
    sendJson(res, 200, { ok: true, slot: closed })
  } catch (err) {
    sendAgentFailure(res, err)
  }
}

// ---- bindings -------------------------------------------------------------

export async function handleCreateAgentBinding(
  ctx: AgentBindingsRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const target = bindingCreatePathFromUrl(url.pathname)
  if (target === null) return sendError(res, 404, 'not_found', 'malformed binding path')
  const gate = requireRoomGate(ctx, res, target.roomId, auth.session.accountId, true)
  if (gate === null) return
  const slot = getRoomSlot(gate.store, target.slotId)
  if (slot === null || slot.roomId !== target.roomId) return sendError(res, 404, 'slot_not_found', 'unknown slot')

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  const body = parsed.value

  if (typeof body['kind'] !== 'string' || !(BINDING_KINDS as readonly string[]).includes(body['kind'])) {
    return sendError(res, 400, 'agent_binding.invalid', `kind must be one of ${BINDING_KINDS.join('|')}`)
  }
  if (!isAgentRuntimeKind(body['runtimeKind'])) {
    return sendError(res, 400, 'agent_binding.invalid', 'runtimeKind must be one of dsh|grok-build|claude-code|codex|hermes')
  }
  if (body['state'] !== undefined && (typeof body['state'] !== 'string' || !(BINDING_STATES as readonly string[]).includes(body['state']))) {
    return sendError(res, 400, 'agent_binding.invalid', `state must be one of ${BINDING_STATES.join('|')}`)
  }
  const externalId =
    body['externalId'] === undefined ? undefined : typeof body['externalId'] === 'string' ? body['externalId'] : null
  if (externalId === null) return sendError(res, 400, 'agent_binding.invalid', 'externalId must be a string')

  let bindingBotId: string | undefined
  if (body['botId'] !== undefined) {
    if (typeof body['botId'] !== 'string' || body['botId'].trim() === '') {
      return sendError(res, 400, 'agent_binding.invalid', 'botId must be a non-empty string')
    }
    bindingBotId = body['botId'].trim()
    const bot = getBot(gate.store, bindingBotId)
    if (bot === null) return sendError(res, 404, 'bot_not_found', `unknown bot ${bindingBotId}`)
    if (bot.workspaceId !== gate.workspaceId) {
      return sendError(res, 400, 'agent_binding.invalid', 'binding bot and room must belong to the same workspace')
    }
  }

  try {
    const binding = createBinding(gate.store, {
      slotId: slot.id,
      roomId: target.roomId,
      ...(bindingBotId === undefined ? {} : { botId: bindingBotId }),
      kind: body['kind'] as (typeof BINDING_KINDS)[number],
      runtimeKind: body['runtimeKind'],
      ...(externalId === undefined ? {} : { externalId }),
      ...(body['state'] === undefined ? {} : { state: body['state'] as (typeof BINDING_STATES)[number] }),
      createdAt: ctx.now(),
    })
    noteRoomEvent(gate.store, target.roomId, auth.session.accountId, 'agent.binding.created', binding.id, {
      bindingId: binding.id,
      slotId: binding.slotId,
      kind: binding.kind,
      runtimeKind: binding.runtimeKind,
      generation: binding.generation,
    })
    sendJson(res, 201, { binding })
  } catch (err) {
    if (err instanceof StoreError && err.code === 'INVALID_INPUT' && /active binding/.test(err.message)) {
      return sendError(res, 409, 'binding.active_exists', 'slot already has an active binding')
    }
    sendAgentFailure(res, err)
  }
}

export async function handleCloseAgentBinding(
  ctx: AgentBindingsRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const bindingId = bindingCloseIdFromPath(url.pathname)
  if (bindingId === null) return sendError(res, 404, 'not_found', 'malformed binding close path')
  const store = ctx.rawStore
  if (store === undefined) return sendError(res, 503, 'runtime.not_configured', 'slot/binding store requires SQLite')
  const binding = getBinding(store, bindingId)
  if (binding === null) return sendError(res, 404, 'binding_not_found', 'unknown binding')
  const gate = requireRoomGate(ctx, res, binding.roomId, auth.session.accountId, true)
  if (gate === null) return

  let state: 'closed' | 'interrupted' | 'failed' = 'closed'
  const parsed = await readOptionalJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (isPlainObject(parsed.value) && parsed.value['state'] !== undefined) {
    const raw = parsed.value['state']
    if (raw !== 'closed' && raw !== 'interrupted' && raw !== 'failed') {
      return sendError(res, 400, 'agent_binding.invalid', 'state must be closed|interrupted|failed')
    }
    state = raw
  }
  try {
    const closed = closeBinding(gate.store, binding.id, { now: ctx.now(), state })
    noteRoomEvent(gate.store, binding.roomId, auth.session.accountId, 'agent.binding.closed', binding.id, {
      bindingId: binding.id,
      slotId: binding.slotId,
      state: closed.state,
    })
    sendJson(res, 200, { binding: closed })
  } catch (err) {
    sendAgentFailure(res, err)
  }
}

// ---- internals ------------------------------------------------------------

async function readOptionalJsonBody(
  req: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; code: string; message: string }> {
  const length = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(length) && length === 0) return { ok: true, value: {} }
  return readJsonBody(req)
}

function roomIdFromPath(pathname: string): string | null {
  const match = /^\/api\/rooms\/([^/]+)\/slots$/.exec(pathname)
  return match === null ? null : decode(match[1]!)
}

function slotPathFromUrl(pathname: string): { roomId: string; slotId: string } | null {
  const match = /^\/api\/rooms\/([^/]+)\/slots\/([^/]+)$/.exec(pathname)
  if (match === null) return null
  const roomId = decode(match[1]!)
  const slotId = decode(match[2]!)
  return roomId === null || slotId === null ? null : { roomId, slotId }
}

function bindingCreatePathFromUrl(pathname: string): { roomId: string; slotId: string } | null {
  const match = /^\/api\/rooms\/([^/]+)\/slots\/([^/]+)\/bindings$/.exec(pathname)
  if (match === null) return null
  const roomId = decode(match[1]!)
  const slotId = decode(match[2]!)
  return roomId === null || slotId === null ? null : { roomId, slotId }
}

function bindingCloseIdFromPath(pathname: string): string | null {
  const match = /^\/api\/bindings\/([^/]+)\/close$/.exec(pathname)
  return match === null ? null : decode(match[1]!)
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/** 房间必须存在，账号必须是其 workspace 成员；写操作还要求 owner/admin。 */
function requireRoomGate(
  ctx: AgentBindingsRouteContext,
  res: ServerResponse,
  roomId: string,
  accountId: string,
  write: boolean,
): RoomGate | null {
  const store = ctx.rawStore
  if (store === undefined) {
    sendError(res, 503, 'runtime.not_configured', 'slot/binding store requires SQLite')
    return null
  }
  const workspaceId = workspaceIdForRoom(ctx, roomId)
  if (workspaceId === null) {
    sendError(res, 404, 'room_not_found', `unknown room ${roomId}`)
    return null
  }
  const gate = requireWorkspaceRole(ctx, workspaceId, accountId, write ? WRITE_ROLES : READ_ROLES)
  if (!gate.ok) {
    sendError(res, gate.status, gate.code, gate.message)
    return null
  }
  return { store, workspaceId }
}

/** 写 room 级事件；SSE / 审计用。事件失败不能抹掉已经成功的 slot 变更。 */
function noteRoomEvent(
  store: Store,
  roomId: string,
  accountId: string,
  kind: string,
  id: string,
  payload: Record<string, unknown>,
): void {
  try {
    appendRoomSignal(store, {
      roomId,
      domain: 'agent',
      kind,
      actor: { kind: 'user', id: accountId },
      idem: `${kind}:${id}:${Date.now()}`,
      payload,
    })
  } catch (error) {
    console.error('roost api: failed to append agent runtime room event', error)
  }
}

function sendAgentFailure(res: ServerResponse, err: unknown): void {
  if (err instanceof StoreError) {
    switch (err.code) {
      case 'ROOM_NOT_FOUND':
        return sendError(res, 404, 'room_not_found', err.message)
      case 'BOT_NOT_FOUND':
        return sendError(res, 404, 'bot_not_found', err.message)
      case 'INVALID_INPUT':
        return sendError(res, 400, 'agent_binding.invalid', err.message)
      case 'FORBIDDEN':
        return sendError(res, 403, 'forbidden', err.message)
      default:
        break
    }
  }
  console.error('roost api: agent binding store failure', err)
  sendError(res, 500, 'internal_error', 'agent binding store failure')
}
