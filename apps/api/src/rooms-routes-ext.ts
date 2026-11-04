// 房间用户侧 API 的 M4 扩展（docs/build/m4-contract.md §2、docs/design/rooms.md §4/§6/§8）。
//
//   POST   /api/rooms                扩参：memberBotIds / hostBotId / responder / notice / purpose
//   GET    /api/rooms/:id            房间 + members + 当前 round（轮次引擎未接入前固定 null）
//   PATCH  /api/rooms/:id            name / notice / responder / responderBot
//   DELETE /api/rooms/:id            删房间投影（members/rounds/seen/sessions）；events 不动
//   POST   /api/rooms/:id/members    {botIds:[]}
//   DELETE /api/rooms/:id/members/:botId
//
// 建群的硬规则（rooms.md §6）：≥2 个 Bot、成员同 workspace、host 必须是成员、
// responder 必须指向成员。没写 name 时按成员名生成（"研究员、评审员"）。
// 兼容：不带 memberBotIds 的 POST /api/rooms 仍是 v0 的「先建空房间」，现有前端与
// scripts/verify.sh 依赖这条路径。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { ROOM_LIMITS } from '../../../packages/contract/src/index.ts'
import type { RoomResponder } from '../../../packages/contract/src/index.ts'
import { StoreError } from '../../../packages/store/src/index.ts'
import {
  authenticate,
  isPlainObject,
  readJsonBody,
  readText,
  roomJson,
  sendError,
  sendJson,
} from './server.ts'
import type { StorePort } from './port.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { openKickoffRound } from './kickoff.ts'
import { requireWorkspaceRole, workspaceIdForRoom } from './members-routes.ts'

export interface RoomsExtContext {
  store: StorePort
  now: () => number
  /** 原始 SQLite store：kickoff 轮需要它；memory 模式下为 undefined。 */
  rawStore?: Store
}

/** 契约里的 error code 是点号形式；这里把 store 的大写码翻译过去。 */
export async function handleCreateRoomExtended(
  ctx: RoomsExtContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const body = parsed.value

  // workspace 解析与 v0 一致：显式给就校验成员身份，否则用账号的第一个 workspace。
  const owned = await ctx.store.listWorkspaces({ accountId: auth.session.accountId })
  let workspaceId: string
  if (body['workspaceId'] !== undefined) {
    if (typeof body['workspaceId'] !== 'string' || body['workspaceId'].trim() === '') {
      return sendError(res, 400, 'invalid_body', 'workspaceId must be a non-empty string when present')
    }
    const requested = body['workspaceId'].trim()
    if (!owned.some((workspace) => workspace.id === requested)) {
      return sendError(res, 409, 'no_workspace', 'create a workspace before a room')
    }
    workspaceId = requested
  } else {
    const first = owned[0]
    if (first === undefined) return sendError(res, 409, 'no_workspace', 'create a workspace before a room')
    workspaceId = first.id
  }

  // 建房间：member 及以上；viewer 只读（auth.md §5）。
  const gate = requireWorkspaceRole(ctx, workspaceId, auth.session.accountId, ['owner', 'admin', 'member'])
  if (!gate.ok) return sendError(res, gate.status, gate.code, gate.message)

  // 没带 memberBotIds = v0 的空房间路径；显式带了就必须满足 M4 的建群规则。
  if (body['memberBotIds'] === undefined) {
    const name = readText(body['name'], ROOM_LIMITS.nameMax)
    if (name === null) {
      return sendError(res, 400, 'invalid_body', `body.name must be 1..${ROOM_LIMITS.nameMax} characters`)
    }
    try {
      const room = await ctx.store.createRoom({
        accountId: auth.session.accountId,
        workspaceId,
        name,
        now: ctx.now(),
      })
      // 建群后没有用户第一句：host 开场问“这个群要做什么”。
    if (ctx.rawStore !== undefined) {
      try {
        openKickoffRound(ctx.rawStore, room.id, ctx.now())
      } catch (error) {
        console.error('roost api: failed to open room kickoff', error)
      }
    }
    sendJson(res, 201, { room: roomJson(room) })
    } catch (err) {
      sendRoomFailure(res, err)
    }
    return
  }

  const memberBotIds = readBotIds(body['memberBotIds'])
  if (memberBotIds === null) {
    return sendError(res, 400, 'room.members', 'memberBotIds must be an array of bot ids')
  }
  if (memberBotIds.length < 2) {
    return sendError(res, 400, 'room.members', 'a room needs at least 2 bots (rooms.md §6)')
  }
  if (memberBotIds.length > ROOM_LIMITS.membersMax) {
    return sendError(res, 400, 'room.members', `a room holds at most ${ROOM_LIMITS.membersMax} bots`)
  }

  let hostBotId: string | undefined
  if (body['hostBotId'] !== undefined) {
    if (typeof body['hostBotId'] !== 'string' || body['hostBotId'].trim() === '') {
      return sendError(res, 400, 'room.members', 'hostBotId must be a non-empty string when present')
    }
    hostBotId = body['hostBotId'].trim()
    if (!memberBotIds.includes(hostBotId)) {
      return sendError(res, 400, 'room.members', `hostBotId ${hostBotId} is not one of memberBotIds`)
    }
  }

  let name: string | undefined
  if (body['name'] !== undefined) {
    // 设计文档：名称可空 → 按成员名生成。所以空串等同于没给。
    const rawName = typeof body['name'] === 'string' ? body['name'].trim() : null
    if (rawName !== '') {
      const parsedName = readText(body['name'], ROOM_LIMITS.nameMax)
      if (parsedName === null) {
        return sendError(res, 400, 'room.invalid', `name must be 1..${ROOM_LIMITS.nameMax} characters`)
      }
      name = parsedName
    }
  }

  const notice = readRoomText(body['notice'], ROOM_LIMITS.noticeMax)
  if (notice === INVALID) return sendError(res, 400, 'room.invalid', 'notice must be a string of at most 2000 characters')
  const purpose = readRoomText(body['purpose'], ROOM_LIMITS.noticeMax)
  if (purpose === INVALID) return sendError(res, 400, 'room.invalid', 'purpose must be a string of at most 2000 characters')

  let responder: RoomResponder | undefined
  if (body['responder'] !== undefined) {
    if (!isPlainObject(body['responder'])) {
      return sendError(res, 400, 'room.responder', 'responder must be an object')
    }
    responder = body['responder'] as RoomResponder
  }

  try {
    const room = await ctx.store.createRoomExt({
      accountId: auth.session.accountId,
      workspaceId,
      ...(name === undefined ? {} : { name }),
      ...(notice === undefined || notice === null ? {} : { notice }),
      ...(purpose === undefined || purpose === null ? {} : { purpose }),
      memberBotIds,
      ...(hostBotId === undefined ? {} : { hostBotId }),
      ...(responder === undefined ? {} : { responder }),
      now: ctx.now(),
    })
    // 建群后没有用户第一句：host 开场问“这个群要做什么”。
    if (ctx.rawStore !== undefined) {
      try {
        openKickoffRound(ctx.rawStore, room.id, ctx.now())
      } catch (error) {
        console.error('roost api: failed to open room kickoff', error)
      }
    }
    sendJson(res, 201, { room: roomJson(room) })
  } catch (err) {
    sendRoomFailure(res, err)
  }
}

export async function handleGetRoom(
  ctx: RoomsExtContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const roomId = roomIdFromPath(url.pathname)
  if (roomId === null) return sendError(res, 404, 'not_found', 'malformed room path')

  try {
    const room = await ctx.store.getRoom({ accountId: auth.session.accountId, roomId })
    if (room === null) return sendError(res, 404, 'room_not_found', `unknown room ${roomId}`)
    // 最近一轮（running 或已结束）；memory port 没有轮次时如实返回 null。
    const round = typeof ctx.store.getRoomRound === 'function' ? await ctx.store.getRoomRound(roomId) : null
    sendJson(res, 200, { room: roomJson(room), round })
  } catch (err) {
    sendRoomFailure(res, err)
  }
}

export async function handlePatchRoom(
  ctx: RoomsExtContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const roomId = roomIdFromPath(url.pathname)
  if (roomId === null) return sendError(res, 404, 'not_found', 'malformed room path')
  if (!authorizeRoomWrite(ctx, res, roomId, auth.session.accountId)) return

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const body = parsed.value

  let name: string | undefined
  if (body['name'] !== undefined) {
    const parsedName = readText(body['name'], ROOM_LIMITS.nameMax)
    if (parsedName === null) {
      return sendError(res, 400, 'room.invalid', `name must be 1..${ROOM_LIMITS.nameMax} characters`)
    }
    name = parsedName
  }

  let notice: string | null | undefined
  if (body['notice'] !== undefined) {
    if (body['notice'] === null) {
      notice = null
    } else if (typeof body['notice'] === 'string') {
      const text = body['notice'].trim()
      if (text.length > ROOM_LIMITS.noticeMax) {
        return sendError(res, 400, 'room.invalid', `notice must be at most ${ROOM_LIMITS.noticeMax} characters`)
      }
      notice = text === '' ? null : text
    } else {
      return sendError(res, 400, 'room.invalid', 'notice must be a string or null')
    }
  }

  let responder: RoomResponder | undefined
  if (body['responder'] !== undefined) {
    if (!isPlainObject(body['responder'])) {
      return sendError(res, 400, 'room.responder', 'responder must be an object')
    }
    responder = body['responder'] as RoomResponder
  } else if (body['responderBot'] !== undefined) {
    if (typeof body['responderBot'] !== 'string' || body['responderBot'].trim() === '') {
      return sendError(res, 400, 'room.responder', 'responderBot must be a non-empty bot id')
    }
    responder = { kind: 'member', botId: body['responderBot'].trim() }
  }

  if (name === undefined && notice === undefined && responder === undefined) {
    return sendError(res, 400, 'room.invalid', 'nothing to update')
  }

  try {
    const room = await ctx.store.updateRoom({
      accountId: auth.session.accountId,
      roomId,
      ...(name === undefined ? {} : { name }),
      ...(notice === undefined ? {} : { notice }),
      ...(responder === undefined ? {} : { responder }),
    })
    sendJson(res, 200, { room: roomJson(room) })
  } catch (err) {
    sendRoomFailure(res, err)
  }
}

export async function handleDeleteRoom(
  ctx: RoomsExtContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const roomId = roomIdFromPath(url.pathname)
  if (roomId === null) return sendError(res, 404, 'not_found', 'malformed room path')
  if (!authorizeRoomWrite(ctx, res, roomId, auth.session.accountId)) return

  try {
    // 删除语义在 store 层：rooms/members/rounds/seen/sessions 投影行清掉，
    // 正在跑的轮次先标 stopped；events 是 append-only 事实源，不动。
    await ctx.store.deleteRoom({ accountId: auth.session.accountId, roomId, now: ctx.now() })
    sendJson(res, 200, { ok: true })
  } catch (err) {
    sendRoomFailure(res, err)
  }
}

export async function handleAddRoomMembers(
  ctx: RoomsExtContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const roomId = roomMemberCollectionPath(url.pathname)
  if (roomId === null) return sendError(res, 404, 'not_found', 'malformed room members path')
  if (!authorizeRoomWrite(ctx, res, roomId, auth.session.accountId)) return

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }

  const botIds = readBotIds(parsed.value['botIds'])
  if (botIds === null || botIds.length === 0) {
    return sendError(res, 400, 'room.members', 'botIds must be a non-empty array of bot ids')
  }
  if (botIds.length > ROOM_LIMITS.membersMax) {
    return sendError(res, 400, 'room.members', `a room holds at most ${ROOM_LIMITS.membersMax} bots`)
  }

  try {
    const room = await ctx.store.addRoomMembers({
      accountId: auth.session.accountId,
      roomId,
      botIds,
    })
    sendJson(res, 200, { room: roomJson(room) })
  } catch (err) {
    sendRoomFailure(res, err)
  }
}

export async function handleRemoveRoomMember(
  ctx: RoomsExtContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const target = roomMemberItemPath(url.pathname)
  if (target === null) return sendError(res, 404, 'not_found', 'malformed room member path')
  if (!authorizeRoomWrite(ctx, res, target.roomId, auth.session.accountId)) return

  try {
    const room = await ctx.store.removeRoomMember({
      accountId: auth.session.accountId,
      roomId: target.roomId,
      botId: target.botId,
    })
    sendJson(res, 200, { room: roomJson(room) })
  } catch (err) {
    sendRoomFailure(res, err)
  }
}

// ---- 内部 --------------------------------------------------------------------

const INVALID = Symbol('invalid')

function roomIdFromPath(pathname: string): string | null {
  const match = /^\/api\/rooms\/([^/]+)$/.exec(pathname.replace(/\/+$/, ''))
  if (match === null) return null
  return decode(match[1]!)
}

function roomMemberCollectionPath(pathname: string): string | null {
  const match = /^\/api\/rooms\/([^/]+)\/members$/.exec(pathname.replace(/\/+$/, ''))
  if (match === null) return null
  return decode(match[1]!)
}

function roomMemberItemPath(pathname: string): { roomId: string; botId: string } | null {
  const match = /^\/api\/rooms\/([^/]+)\/members\/([^/]+)$/.exec(pathname.replace(/\/+$/, ''))
  if (match === null) return null
  const roomId = decode(match[1]!)
  const botId = decode(match[2]!)
  return roomId === null || botId === null ? null : { roomId, botId }
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/** undefined = 没给；null = 空串（清空）；INVALID = 格式不对。 */
function readRoomText(value: unknown, max: number): string | null | undefined | typeof INVALID {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') return INVALID
  const text = value.trim()
  if (text === '') return null
  if (text.length > max) return INVALID
  return text
}

function readBotIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') return null
    const id = item.trim()
    if (!out.includes(id)) out.push(id)
  }
  return out
}

/**
 * 房间设置/删除/成员增删：owner/admin（auth.md §5）。
 * 房间不存在或 memory port 没有成员表时放行，交给 store 报 404 / 保持 v0 行为。
 */
function authorizeRoomWrite(
  ctx: RoomsExtContext,
  res: ServerResponse,
  roomId: string,
  accountId: string,
): boolean {
  const workspaceId = workspaceIdForRoom(ctx, roomId)
  if (workspaceId === null) return true
  const gate = requireWorkspaceRole(ctx, workspaceId, accountId, ['owner', 'admin'])
  if (!gate.ok) {
    sendError(res, gate.status, gate.code, gate.message)
    return false
  }
  return true
}

function sendRoomFailure(res: ServerResponse, err: unknown): void {
  if (err instanceof StoreError) {
    switch (err.code) {
      case 'INVALID_ROOM':
        return sendError(res, 400, 'room.invalid', err.message)
      case 'ROOM_NOT_FOUND':
        return sendError(res, 404, 'room_not_found', err.message)
      case 'INVALID_ROOM_MEMBER':
      case 'ROOM_MEMBERS_INVALID':
      case 'ROOM_HOST_CONFLICT':
        return sendError(res, 400, 'room.members', err.message)
      case 'ROOM_MEMBER_NOT_FOUND':
        return sendError(res, 404, 'room.members', err.message)
      case 'ROOM_RESPONDER_INVALID':
        return sendError(res, 400, 'room.responder', err.message)
      case 'WORKSPACE_NOT_FOUND':
        return sendError(res, 404, 'workspace_not_found', err.message)
      case 'FORBIDDEN':
        return sendError(res, 403, 'forbidden', err.message)
      default:
        break
    }
  }
  // memory port 抛的是普通 Error；与 server.ts 的 sendStoreFailure 同一套口径。
  const message = err instanceof Error ? err.message : String(err)
  if (/unknown room/i.test(message)) return sendError(res, 404, 'room_not_found', message)
  if (/not a member|forbidden/i.test(message)) return sendError(res, 403, 'forbidden', message)
  console.error('roost api: room store failure', err)
  sendError(res, 500, 'internal_error', 'room store failure')
}
