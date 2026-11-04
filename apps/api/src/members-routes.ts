// workspace 成员与角色 API（docs/design/auth.md §5/§10、§13）。
//
//   GET    /api/workspaces/:id/members               Bearer（该 workspace 任意成员）
//   PATCH  /api/workspaces/:id/members/:accountId    Bearer（owner/admin）；{role}
//   DELETE /api/workspaces/:id/members/:accountId    Bearer（owner/admin）
//
// 邀请（POST /api/workspaces/:id/invites）留到 5.3.1；本文件只管理已有成员。
// 成员表在 SQLite store 里，memory port 没有：返回 503 runtime.not_configured。
//
// 角色规则：admin 不能授予/撤销 owner；最后一个 owner 不能降级或移除（409 workspace.last_owner）。
// 非成员访问成员列表返回 404，不泄漏 workspace 是否存在。
//
// 本文件同时给 bots-routes / rooms-routes-ext / server 的写接口提供角色校验小工具：
// rawStore 缺失（memory port）时跳过校验，保持 v0 行为；SQLite 模式下按 workspace_members 判定。

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  getBot as getBotInStore,
  getRoom as getRoomInStore,
  getWorkspaceRole,
  listWorkspaceMembers,
  removeWorkspaceMember,
  setWorkspaceMemberRole,
  MEMBER_ERROR_CODES,
  WORKSPACE_ROLES,
  StoreError,
  storeErrorTag,
} from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import {
  authenticate,
  isPlainObject,
  readJsonBody,
  sendError,
  sendJson,
} from './server.ts'
import type { StorePort, WorkspaceRole } from './port.ts'

export interface MembersRouteContext {
  store: StorePort
  now: () => number
  /** 成员表只在 SQLite store 里；memory port 为 undefined。 */
  rawStore?: Store
}

export async function handleListWorkspaceMembers(
  ctx: MembersRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })

  const store = ctx.rawStore
  if (store === undefined) {
    return sendError(res, 503, 'runtime.not_configured', '成员管理需要 SQLite 存储')
  }

  // 非成员 404：不暴露该 workspace 是否存在。
  const role = getWorkspaceRole(store, workspaceId, auth.session.accountId)
  if (role === null) {
    return sendError(res, 404, 'workspace_not_found', `account ${auth.session.accountId} is not a member of ${workspaceId}`)
  }

  sendJson(res, 200, { members: listWorkspaceMembers(store, workspaceId) })
}

export async function handleSetWorkspaceMemberRole(
  ctx: MembersRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
  accountId: string,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })

  const store = ctx.rawStore
  if (store === undefined) {
    return sendError(res, 503, 'runtime.not_configured', '成员管理需要 SQLite 存储')
  }

  const caller = getWorkspaceRole(store, workspaceId, auth.session.accountId)
  if (caller !== 'owner' && caller !== 'admin') {
    return sendError(res, 403, 'forbidden', '权限不足：只有 owner/admin 能修改成员角色')
  }

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }

  const role = parsed.value['role']
  if (typeof role !== 'string' || !(WORKSPACE_ROLES as readonly string[]).includes(role)) {
    return sendError(res, 400, 'workspace.invalid_role', `role 必须是 ${WORKSPACE_ROLES.join(' / ')} 之一`)
  }

  try {
    const member = setWorkspaceMemberRole(store, {
      workspaceId,
      accountId,
      role: role as WorkspaceRole,
      by: auth.session.accountId,
      at: ctx.now(),
    })
    sendJson(res, 200, { member })
  } catch (err) {
    sendMemberFailure(res, err)
  }
}

export async function handleRemoveWorkspaceMember(
  ctx: MembersRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
  accountId: string,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })

  const store = ctx.rawStore
  if (store === undefined) {
    return sendError(res, 503, 'runtime.not_configured', '成员管理需要 SQLite 存储')
  }

  const caller = getWorkspaceRole(store, workspaceId, auth.session.accountId)
  if (caller !== 'owner' && caller !== 'admin') {
    return sendError(res, 403, 'forbidden', '权限不足：只有 owner/admin 能移除成员')
  }

  try {
    removeWorkspaceMember(store, {
      workspaceId,
      accountId,
      by: auth.session.accountId,
      at: ctx.now(),
    })
    sendJson(res, 200, { ok: true })
  } catch (err) {
    sendMemberFailure(res, err)
  }
}

// ---- 其他写接口共用的角色校验 -------------------------------------------------

export type RoleGate =
  | { ok: true; role: WorkspaceRole }
  | { ok: false; status: number; code: string; message: string }

/**
 * 校验账号在 workspace 里的角色。
 * memory port（无 rawStore）没有成员表：跳过校验并当作 owner，保持 v0 行为。
 */
export function requireWorkspaceRole(
  ctx: { rawStore?: Store },
  workspaceId: string,
  accountId: string,
  allowed: readonly WorkspaceRole[],
): RoleGate {
  if (ctx.rawStore === undefined) return { ok: true, role: 'owner' }
  const role = getWorkspaceRole(ctx.rawStore, workspaceId, accountId)
  if (role === null) {
    return { ok: false, status: 403, code: 'forbidden', message: `账号 ${accountId} 不是这个 workspace 的成员` }
  }
  if (!allowed.includes(role)) {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      message: `权限不足：该操作需要 ${allowed.join('/')} 角色，当前角色是 ${role}`,
    }
  }
  return { ok: true, role }
}

/** 房间所属 workspace；memory port 或房间不存在时返回 null（交给 store 报 404）。 */
export function workspaceIdForRoom(ctx: { rawStore?: Store }, roomId: string): string | null {
  if (ctx.rawStore === undefined) return null
  return getRoomInStore(ctx.rawStore, roomId)?.workspaceId ?? null
}

/** Bot 所属 workspace（含软删）；memory port 或 Bot 不存在时返回 null。 */
export function workspaceIdForBot(ctx: { rawStore?: Store }, botId: string): string | null {
  if (ctx.rawStore === undefined) return null
  return getBotInStore(ctx.rawStore, botId, { includeDeleted: true })?.workspaceId ?? null
}

function sendMemberFailure(res: ServerResponse, err: unknown): void {
  const tag = storeErrorTag(err)
  if (tag === MEMBER_ERROR_CODES.lastOwner) {
    return sendError(res, 409, 'workspace.last_owner', 'workspace 至少要保留一个 owner')
  }
  if (tag === MEMBER_ERROR_CODES.notFound) {
    return sendError(res, 404, 'member_not_found', '找不到这个成员')
  }
  if (tag === MEMBER_ERROR_CODES.forbidden) {
    return sendError(res, 403, 'forbidden', '权限不足：只有 owner 能授予或撤销 owner')
  }
  if (err instanceof StoreError && err.code === 'FORBIDDEN') {
    return sendError(res, 403, 'forbidden', '权限不足：需要 owner/admin 角色')
  }
  if (err instanceof StoreError && err.code === 'INVALID_INPUT') {
    return sendError(res, 400, 'invalid_body', err.message)
  }
  console.error('roost api: workspace member store failure', err)
  sendError(res, 500, 'internal_error', '成员管理存储失败')
}
