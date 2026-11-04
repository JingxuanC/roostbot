// 运行时审批申请与用户侧长期授权（M5-5.4；docs/design/ui.md §3.3、§12 待决 3）。
//
// 本文件只导出 handler，由 server.ts 接线：
//
//   POST   /api/internal/approvals      handleInternalCreateApproval  runtime token
//   GET    /api/internal/approvals/:id  handleInternalGetApproval     runtime token
//   GET    /api/approval-grants         handleListApprovalGrants      Bearer（owner/admin）
//   POST   /api/approval-grants         handleCreateApprovalGrant     Bearer（owner/admin）
//   DELETE /api/approval-grants/:id     handleRevokeApprovalGrant     Bearer（owner/admin）
//
// 单次 vs 长期：
//   * 沙箱里的工具执行前调用 POST /api/internal/approvals；命中未吊销 grant 直接放行，
//     否则落一条 pending 审批，再由用户通过 POST /api/approvals/:id 单次决策。
//   * 决策接口只做单次，绝不隐式写 approval_grants；长期授权只能在这里显式创建。
//
// 鉴权统一走 runtime-auth.ts：没有全局 token 且没有 rawStore = 404（不暴露内部接口），
// 有 rawStore 时每 workspace token 生效（401/403 见下），错误 token = 401。
// 用户侧 Bearer 由 server.authenticate 校验，权限用 store.listWorkspaces 的 role 判断。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { StoreError } from '../../../packages/store/src/index.ts'
import type { Approval, ApprovalGrant } from '../../../packages/store/src/approvals.ts'
import {
  createApproval,
  createApprovalGrant,
  findApprovalGrant,
  getApproval,
  getApprovalGrant,
  listApprovalGrants,
  revokeApprovalGrant,
} from '../../../packages/store/src/approvals.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import type { StorePort } from './port.ts'
import { authenticate, isPlainObject, readJsonBody, sendError, sendJson } from './server.ts'
import { authorizeRuntimeHttp, ensureRuntimeWorkspace } from './runtime-auth.ts'
import { approvalJson } from './bot-rooms-routes.ts'

export interface ApprovalsRouteContext {
  store: StorePort
  now: () => number
  /** 审批与授权表只在 SQLite 里；内存 port 下返回 503。 */
  rawStore?: Store
  runtimeToken?: string
}

type Ctx = ApprovalsRouteContext

// ---- 内部：沙箱工具执行前申请审批 --------------------------------------------

export async function handleInternalCreateApproval(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = authorizeRuntimeHttp(ctx, req, res)
  if (auth === null) return
  const store = ctx.rawStore
  if (store === undefined) {
    return sendError(res, 503, 'runtime.not_configured', 'approvals need the SQLite store')
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
  // workspace token 只能给自己的 workspace 申请审批。
  if (!ensureRuntimeWorkspace(auth, workspaceId, res)) return
  const kind = readId(body['kind'])
  if (kind === null) {
    return sendError(res, 400, 'invalid_body', 'kind is required (non-empty string)')
  }
  const requester = readId(body['requester'])
  if (requester === null) {
    return sendError(res, 400, 'invalid_body', 'requester is required (non-empty string)')
  }

  const requesterKind = body['requesterKind']
  if (requesterKind !== undefined && requesterKind !== null && requesterKind !== 'bot' && requesterKind !== 'user') {
    return sendError(res, 400, 'invalid_body', "requesterKind must be 'bot' or 'user' when present")
  }
  const action = readOptionalString(body['action'])
  if (action === INVALID) return sendError(res, 400, 'invalid_body', 'action must be a string when present')
  const target = readOptionalString(body['target'])
  if (target === INVALID) return sendError(res, 400, 'invalid_body', 'target must be a string when present')
  const consequence = readOptionalString(body['consequence'])
  if (consequence === INVALID) {
    return sendError(res, 400, 'invalid_body', 'consequence must be a string when present')
  }
  const payload = body['payload']
  if (payload !== undefined && payload !== null && !isPlainObject(payload)) {
    return sendError(res, 400, 'invalid_body', 'payload must be a JSON object when present')
  }

  try {
    // 1) 长期授权：workspace + kind + action + target 全等才放行，不做通配。
    const grant = findApprovalGrant(store, { workspaceId, kind, action, target })
    if (grant !== null) {
      sendJson(res, 200, { approval: null, granted: true })
      return
    }

    // 2) 没有授权：落一条 pending 审批，调用方轮询 GET /api/internal/approvals/:id。
    const approval = createApproval(store, {
      workspaceId,
      kind,
      requester,
      ...(requesterKind === 'bot' || requesterKind === 'user' ? { requesterKind } : {}),
      payload: isPlainObject(payload) ? payload : {},
      action,
      target,
      consequence,
      at: ctx.now(),
    })
    sendJson(res, 201, { approval: approvalJson(approval) })
  } catch (err) {
    sendApprovalFailure(res, err)
  }
}

export async function handleInternalGetApproval(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = authorizeRuntimeHttp(ctx, req, res)
  if (auth === null) return
  const store = ctx.rawStore
  if (store === undefined) {
    return sendError(res, 503, 'runtime.not_configured', 'approvals need the SQLite store')
  }

  const approvalId = internalApprovalIdFromPath(url.pathname)
  if (approvalId === null) return sendError(res, 404, 'not_found', 'malformed approval path')

  try {
    const approval = getApproval(store, approvalId)
    if (approval === null) {
      return sendError(res, 404, 'approval.not_found', `unknown approval ${approvalId}`)
    }
    // workspace token 不能轮询别的 workspace 的审批。
    if (!ensureRuntimeWorkspace(auth, approval.workspaceId, res)) return
    sendJson(res, 200, { approval: approvalJson(approval) })
  } catch (err) {
    sendApprovalFailure(res, err)
  }
}

// ---- 用户：长期授权（设置里显式打开）-----------------------------------------

export async function handleListApprovalGrants(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const store = ctx.rawStore
  if (store === undefined) {
    return sendError(res, 503, 'runtime.not_configured', 'approval grants need the SQLite store')
  }

  const workspaceId = readId(url.searchParams.get('workspaceId'))
  if (workspaceId === null) {
    return sendError(res, 400, 'invalid_body', 'workspaceId is required (non-empty string)')
  }
  if (!(await isWorkspaceAdmin(ctx, auth.session.accountId, workspaceId))) {
    return sendError(res, 403, 'forbidden', `workspace ${workspaceId} requires owner/admin role`)
  }

  try {
    sendJson(res, 200, { grants: listApprovalGrants(store, workspaceId).map(grantJson) })
  } catch (err) {
    sendApprovalFailure(res, err)
  }
}

export async function handleCreateApprovalGrant(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const store = ctx.rawStore
  if (store === undefined) {
    return sendError(res, 503, 'runtime.not_configured', 'approval grants need the SQLite store')
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
  const kind = readId(body['kind'])
  if (kind === null) {
    return sendError(res, 400, 'invalid_body', 'kind is required (non-empty string)')
  }
  const action = readOptionalString(body['action'])
  if (action === INVALID) return sendError(res, 400, 'invalid_body', 'action must be a string when present')
  const target = readOptionalString(body['target'])
  if (target === INVALID) return sendError(res, 400, 'invalid_body', 'target must be a string when present')

  if (!(await isWorkspaceAdmin(ctx, auth.session.accountId, workspaceId))) {
    return sendError(res, 403, 'forbidden', `workspace ${workspaceId} requires owner/admin role`)
  }

  try {
    const grant = createApprovalGrant(store, {
      workspaceId,
      kind,
      action,
      target,
      grantedBy: auth.session.accountId,
      at: ctx.now(),
    })
    sendJson(res, 201, { grant: grantJson(grant) })
  } catch (err) {
    sendApprovalFailure(res, err)
  }
}

export async function handleRevokeApprovalGrant(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const store = ctx.rawStore
  if (store === undefined) {
    return sendError(res, 503, 'runtime.not_configured', 'approval grants need the SQLite store')
  }

  const grantId = grantIdFromPath(url.pathname)
  if (grantId === null) return sendError(res, 404, 'not_found', 'malformed approval grant path')

  try {
    const grant = getApprovalGrant(store, grantId)
    if (grant === null) {
      return sendError(res, 404, 'approval_grant.not_found', `unknown approval grant ${grantId}`)
    }
    if (!(await isWorkspaceAdmin(ctx, auth.session.accountId, grant.workspaceId))) {
      return sendError(res, 403, 'forbidden', `workspace ${grant.workspaceId} requires owner/admin role`)
    }
    // 重复撤销幂等：已吊销也返回 204。
    revokeApprovalGrant(store, { id: grantId, at: ctx.now() })
    res.writeHead(204, { 'cache-control': 'no-store' })
    res.end()
  } catch (err) {
    sendApprovalFailure(res, err)
  }
}

// ---- 序列化与内部 ------------------------------------------------------------

export function grantJson(grant: ApprovalGrant): Record<string, unknown> {
  return {
    id: grant.id,
    workspaceId: grant.workspaceId,
    kind: grant.kind,
    action: grant.action,
    target: grant.target,
    grantedBy: grant.grantedBy,
    grantedAt: grant.grantedAt,
    revokedAt: grant.revokedAt,
  }
}

async function isWorkspaceAdmin(ctx: Ctx, accountId: string, workspaceId: string): Promise<boolean> {
  const workspaces = await ctx.store.listWorkspaces({ accountId })
  const workspace = workspaces.find((entry) => entry.id === workspaceId)
  return workspace !== undefined && (workspace.role === 'owner' || workspace.role === 'admin')
}

/** 读可选字符串；返回 INVALID 哨兵表示「给了但不是字符串」。 */
const INVALID = Symbol('invalid-optional-string')
function readOptionalString(value: unknown): string | null | typeof INVALID {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return INVALID
  const text = value.trim()
  return text === '' ? null : text
}

function readId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  if (id === '' || id.length > 200) return null
  return id
}

function internalApprovalIdFromPath(pathname: string): string | null {
  const match = /^\/api\/internal\/approvals\/([^/]+)$/.exec(pathname.replace(/\/+$/, ''))
  if (match === null) return null
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return null
  }
}

function grantIdFromPath(pathname: string): string | null {
  const match = /^\/api\/approval-grants\/([^/]+)$/.exec(pathname.replace(/\/+$/, ''))
  if (match === null) return null
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return null
  }
}

function sendApprovalFailure(res: ServerResponse, err: unknown): void {
  if (err instanceof StoreError) {
    switch (err.code) {
      case 'WORKSPACE_NOT_FOUND':
        return sendError(res, 404, 'workspace_not_found', err.message)
      case 'INVALID_INPUT':
        return sendError(res, 400, 'approval.invalid', err.message)
      default:
        break
    }
  }
  console.error('roost api: approval store failure', err)
  sendError(res, 500, 'internal_error', 'approval store failure')
}
