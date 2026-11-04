// 模型代理路由（budget.md §2、§6；wave2 §B）。
//
// Lead 的接线：proxy 实例由 server.ts 构造（createModelProxy + store.recordUsage），
// workspace 由会话/路径/运行时头解析后经 workspaceIdFrom 注入。本函数只做三件事：
//   1. 非 POST 直接交给 proxy（由 proxy 统一回 405，保持单一出口）；
//   2. 解析 workspaceId，缺失时 400 workspace_required（token 账必须能落到工作区）；
//   3. 把 workspaceId 挂到 req 上，再交给 proxy 转发上游。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { setProxyWorkspace } from '../../../packages/budget/src/proxy.ts'
import type { ModelProxyHandler } from '../../../packages/budget/src/proxy.ts'
import { sendError } from './server.ts'

export interface ModelProxyRouteContext {
  /** createModelProxy(...) 的返回值。 */
  proxy: ModelProxyHandler
  /** 本次调用归属的 workspace；返回 null 时拒绝（无法记账）。 */
  workspaceIdFrom: (req: IncomingMessage) => string | null
}

export async function handleModelProxy(
  ctx: ModelProxyRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    await ctx.proxy(req, res)
    return
  }

  let workspaceId: string | null
  try {
    workspaceId = normalizeId(ctx.workspaceIdFrom(req))
  } catch {
    sendError(res, 500, 'internal_error', 'could not resolve workspace for model proxy')
    return
  }
  if (workspaceId === null) {
    sendError(res, 400, 'workspace_required', 'workspaceId is required for model metering')
    return
  }

  setProxyWorkspace(req, workspaceId)
  await ctx.proxy(req, res)
}

function normalizeId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id === '' ? null : id
}
