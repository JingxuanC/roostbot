// Bot 建群与审批的用户侧 / 内部路由（docs/build/m4-addendum.md §B）。
//
// 本文件只导出 handler，由 Lead 在 apps/api/src/server.ts 里接线（不改共享文件）：
//
//   POST /api/internal/bot-rooms   handleBotCreateRoom   runtime token；Bot 申请建群 → 202 {approval}
//   GET  /api/approvals            handleListApprovals   用户 Bearer；?workspaceId=&status=
//   POST /api/approvals/:id        handleDecideApproval  用户 Bearer；{decision} → 建房或拒绝
//
// 鉴权分两条路：
//   * Bot 侧走 runtime token（x-runtime-token 或 Authorization: Runtime <token>），
//     与 server.ts 的内部接口同一套语义（无全局 token 且无 rawStore = 404；
//     有 rawStore 时 workspace token 生效，跨 workspace = 403）；
//   * 用户侧走 Bearer 会话，审批必须落在该账号是成员的 workspace 里。
//
// 错误形状与现有 API 一致：{ok:false,error:{code,message}}，全部 no-store（sendError/sendJson 保证）。
// 审批落在 SQLite（approvals 表），所以这些 handler 需要 ctx.rawStore；内存 port 下返回 503。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { StoreError } from '../../../packages/store/src/index.ts'
import type { Approval } from '../../../packages/store/src/approvals.ts'
import { decideApproval, getApproval, listApprovals, storeErrorTag } from '../../../packages/store/src/approvals.ts'
import { listBots } from '../../../packages/store/src/bots.ts'
import type { ApprovalStatus } from '../../../packages/store/src/approvals.ts'
import {
  BOT_ROOM_APPROVAL_KIND,
  approveBotRoom,
  rejectBotRoom,
  requestBotRoom,
} from '../../../packages/store/src/bot-rooms.ts'
import type { RoomDetail } from '../../../packages/store/src/rooms-ext.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { authenticate, isPlainObject, readJsonBody, roomJson, sendError, sendJson } from './server.ts'
import { authorizeRuntimeHttp, ensureRuntimeWorkspace } from './runtime-auth.ts'
import type { RoomRecord, StorePort } from './port.ts'

export interface BotRoomsRouteContext {
  store: StorePort
  now: () => number
  /** 审批表只在 SQLite 里；内存 port 没有。 */
  rawStore?: Store
  runtimeToken?: string
}

type Ctx = BotRoomsRouteContext

// ---- 内部：Bot 申请建群 ------------------------------------------------------

export async function handleBotCreateRoom(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = authorizeRuntimeHttp(ctx, req, res)
  if (auth === null) return
  const store = ctx.rawStore
  if (store === undefined) {
    return sendError(res, 503, 'runtime.not_configured', 'bot room approvals need the SQLite store')
  }

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const body = parsed.value

  const workspaceId = readId(body['workspaceId'])
  if (workspaceId === null) {
    return sendError(res, 400, 'invalid_body', 'workspaceId is required (non-empty string)')
  }
  // workspace token 只能给自己的 workspace 申请建群。
  if (!ensureRuntimeWorkspace(auth, workspaceId, res)) return
  const botId = readId(body['botId'])
  if (botId === null) {
    return sendError(res, 400, 'invalid_body', 'botId is required (non-empty string)')
  }
  const memberBotIds = readBotIds(body['memberBotIds'])
  if (memberBotIds === null) {
    return sendError(res, 400, 'bot.room_members', 'memberBotIds is required (array of bot ids)')
  }
  if (body['name'] !== undefined && body['name'] !== null && typeof body['name'] !== 'string') {
    return sendError(res, 400, 'bot.room_invalid', 'name must be a string when present')
  }
  if (body['purpose'] !== undefined && body['purpose'] !== null && typeof body['purpose'] !== 'string') {
    return sendError(res, 400, 'bot.room_invalid', 'purpose must be a string when present')
  }

  try {
    const approval = requestBotRoom(store, {
      workspaceId,
      botId,
      memberBotIds,
      ...(typeof body['name'] === 'string' ? { name: body['name'] } : {}),
      ...(typeof body['purpose'] === 'string' ? { purpose: body['purpose'] } : {}),
      at: ctx.now(),
    })
    // 202：接受的是「申请」，房间还不存在。
    sendJson(res, 202, { approval: approvalJson(approval) })
  } catch (err) {
    sendApprovalFailure(res, err)
  }
}

/** runtime token：Bot 侧读取本 workspace 的 Bot 名单（建团队时解析成员用）。 */
export async function handleInternalListBots(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = authorizeRuntimeHttp(ctx, req, res)
  if (auth === null) return
  const store = ctx.rawStore
  if (store === undefined) {
    return sendError(res, 503, 'runtime.not_configured', 'bot list needs the SQLite store')
  }
  const workspaceId = readId(url.searchParams.get('workspaceId'))
  if (workspaceId === null) {
    return sendError(res, 400, 'invalid_body', 'workspaceId is required (non-empty string)')
  }
  if (!ensureRuntimeWorkspace(auth, workspaceId, res)) return
  const bots = listBots(store, workspaceId).map((bot) => ({ id: bot.id, name: bot.name, role: bot.role }))
  sendJson(res, 200, { bots })
}

// ---- 用户：审批列表 ----------------------------------------------------------

export async function handleListApprovals(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const store = ctx.rawStore
  if (store === undefined) {
    return sendError(res, 503, 'runtime.not_configured', 'approvals need the SQLite store')
  }

  const url = new URL(req.url ?? '/', 'http://control-plane.local')
  const statusRaw = url.searchParams.get('status')
  let status: ApprovalStatus | undefined
  if (statusRaw !== null) {
    if (statusRaw !== 'pending' && statusRaw !== 'approved' && statusRaw !== 'rejected') {
      return sendError(res, 400, 'approval.invalid', 'status must be pending|approved|rejected')
    }
    status = statusRaw
  }

  const owned = await ctx.store.listWorkspaces({ accountId: auth.session.accountId })
  const ownedIds = new Set(owned.map((workspace) => workspace.id))

  const workspaceRaw = url.searchParams.get('workspaceId')
  if (workspaceRaw !== null) {
    const workspaceId = workspaceRaw.trim()
    if (workspaceId === '') return sendError(res, 400, 'invalid_body', 'workspaceId must not be empty')
    if (!ownedIds.has(workspaceId)) {
      return sendError(res, 403, 'forbidden', `account is not a member of workspace ${workspaceId}`)
    }
    try {
      sendJson(res, 200, { approvals: listApprovals(store, workspaceId, status).map(approvalJson) })
    } catch (err) {
      sendApprovalFailure(res, err)
    }
    return
  }

  // 省略 workspaceId = 该账号所有 workspace 的审批（「需要你」收件箱）。
  try {
    const merged: Approval[] = []
    for (const workspaceId of ownedIds) merged.push(...listApprovals(store, workspaceId, status))
    merged.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    sendJson(res, 200, { approvals: merged.map(approvalJson) })
  } catch (err) {
    sendApprovalFailure(res, err)
  }
}

// ---- 用户：批准 / 拒绝 -------------------------------------------------------

export async function handleDecideApproval(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const store = ctx.rawStore
  if (store === undefined) {
    return sendError(res, 503, 'runtime.not_configured', 'approvals need the SQLite store')
  }

  const approvalId = approvalIdFromPath(url.pathname)
  if (approvalId === null) return sendError(res, 404, 'not_found', 'malformed approval path')

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const decision = parsed.value['decision']
  if (decision !== 'approved' && decision !== 'rejected') {
    return sendError(res, 400, 'approval.invalid', 'decision must be "approved" or "rejected"')
  }

  let approval: Approval | null
  try {
    approval = getApproval(store, approvalId)
  } catch (err) {
    return sendApprovalFailure(res, err)
  }
  // 看不到的审批当作不存在（不跨 workspace 泄露 id）。
  const owned = await ctx.store.listWorkspaces({ accountId: auth.session.accountId })
  if (approval === null || !owned.some((workspace) => workspace.id === approval!.workspaceId)) {
    return sendError(res, 404, 'approval.not_found', `unknown approval ${approvalId}`)
  }

  try {
    // 建群审批有额外业务：批准要真的建房。其它 kind（沙箱工具申请等）只落决策；
    // 两条路径都经 decideApproval，approval.decided 恰好写一次。
    if (approval.kind === BOT_ROOM_APPROVAL_KIND && approval.requesterKind === 'bot') {
      if (decision === 'rejected') {
        const rejected = rejectBotRoom(store, { approvalId, by: auth.session.accountId, at: ctx.now() })
        return sendJson(res, 200, { approval: approvalJson(rejected) })
      }
      const result = approveBotRoom(store, { approvalId, by: auth.session.accountId, at: ctx.now() })
      // 契约：approved 时建房，返回 {room}；同时带上审批本身，前端不用再拉一次列表。
      sendJson(res, 200, { room: roomJson(roomRecordFromDetail(result.room)), approval: approvalJson(result.approval) })
      return
    }

    // 单次决策：绝不隐式创建长期授权。
    const decided = decideApproval(store, {
      id: approvalId,
      decision,
      by: auth.session.accountId,
      at: ctx.now(),
    })
    sendJson(res, 200, { approval: approvalJson(decided) })
  } catch (err) {
    sendApprovalFailure(res, err)
  }
}

// ---- 序列化 ------------------------------------------------------------------

export function approvalJson(approval: Approval): Record<string, unknown> {
  return {
    id: approval.id,
    workspaceId: approval.workspaceId,
    kind: approval.kind,
    requester: approval.requester,
    requesterKind: approval.requesterKind,
    payload: approval.payload,
    status: approval.status,
    createdAt: approval.createdAt,
    decidedAt: approval.decidedAt,
    decidedBy: approval.decidedBy,
    action: approval.action,
    target: approval.target,
    consequence: approval.consequence,
  }
}

/** RoomDetail → 端口形状，复用 server.ts 的 roomJson（与其它房间接口同一份字段）。 */
function roomRecordFromDetail(detail: RoomDetail): RoomRecord {
  const notice = detail.extras.notice ?? detail.room.notice
  return {
    id: detail.room.id,
    workspaceId: detail.room.workspaceId,
    name: detail.room.name,
    ...(notice === null ? {} : { notice }),
    replyMode: detail.room.replyMode as RoomRecord['replyMode'],
    createdAt: detail.room.createdAt,
    responder: { ...detail.extras.responder },
    ...(detail.extras.hostBotId === null ? {} : { hostBotId: detail.extras.hostBotId }),
    ...(detail.extras.purpose === null ? {} : { purpose: detail.extras.purpose }),
    createdByKind: detail.extras.createdByKind,
    ...(detail.extras.createdBy === null ? {} : { createdBy: detail.extras.createdBy }),
    members: detail.members.map((member) => ({ ...member })),
  }
}

// ---- 内部 --------------------------------------------------------------------

function approvalIdFromPath(pathname: string): string | null {
  const match = /^\/api\/approvals\/([^/]+)$/.exec(pathname.replace(/\/+$/, ''))
  if (match === null) return null
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return null
  }
}

function readId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  if (id === '' || id.length > 200) return null
  return id
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

/** 域错误码（approvals.ts 写在 message 前缀里）优先映射，其次退回 StoreError.code。 */
function sendApprovalFailure(res: ServerResponse, err: unknown): void {
  if (err instanceof StoreError) {
    switch (storeErrorTag(err)) {
      case 'BOT_ROOM_QUOTA':
        return sendError(res, 429, 'bot.room_quota', err.message)
      case 'BOT_ROOM_CROSS_WORKSPACE':
        return sendError(res, 403, 'bot.room_workspace', err.message)
      case 'BOT_ROOM_MEMBERS':
        return sendError(res, 400, 'bot.room_members', err.message)
      case 'BOT_ROOM_INVALID':
        return sendError(res, 400, 'bot.room_invalid', err.message)
      case 'BOT_ROOM_BOT_NOT_FOUND':
        return sendError(res, 404, 'bot.not_found', err.message)
      case 'APPROVAL_NOT_FOUND':
        return sendError(res, 404, 'approval.not_found', err.message)
      case 'APPROVAL_CONFLICT':
        return sendError(res, 409, 'approval.decided', err.message)
      case 'APPROVAL_INVALID':
        return sendError(res, 400, 'approval.invalid', err.message)
      default:
        break
    }
    switch (err.code) {
      case 'WORKSPACE_NOT_FOUND':
        return sendError(res, 404, 'workspace_not_found', err.message)
      case 'BOT_NOT_FOUND':
        return sendError(res, 404, 'bot.not_found', err.message)
      case 'FORBIDDEN':
        return sendError(res, 403, 'forbidden', err.message)
      case 'INVALID_ROOM':
        return sendError(res, 400, 'room.invalid', err.message)
      case 'ROOM_MEMBERS_INVALID':
      case 'ROOM_HOST_CONFLICT':
        return sendError(res, 400, 'room.members', err.message)
      case 'ROOM_RESPONDER_INVALID':
        return sendError(res, 400, 'room.responder', err.message)
      default:
        break
    }
  }
  console.error('roost api: approval store failure', err)
  sendError(res, 500, 'internal_error', 'approval store failure')
}
