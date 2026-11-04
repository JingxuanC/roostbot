// 内部接口鉴权的接线层：把 runtime-token.ts 的纯函数接到 node:http 的 req/res 上。
//
// 分工：
//   * `runtime-token.ts` 只知道「token + verifier → 授权结果」，不写响应；
//   * 这个模块负责 404（内部接口关闭）/ 401（token 缺失或无效）/ 403（跨 workspace）
//     三种 HTTP 语义，并给各 `*-routes.ts` 提供同一个入口，避免 14 份复制实现。
//
// 404 语义（ADR 0005，兼容旧部署）：
//   * 没配置控制面全局 token 且没有 rawStore（内存 port）→ 404。没有可校验的凭据，
//     等于功能关闭；404 而不是 401，避免暴露「这里有内部接口」。
//   * 有 rawStore 时即使全局 token 为空，每 workspace 短期 token 仍然可用 → 401/200。
//
// 403 语义（TODO E6 的验收标准）：授权结果带 workspaceId 时，请求只能落在该
// workspace。请求里伪造别的 workspaceId / roomId 一律 403 `forbidden_workspace`，
// 而不是静默按调用方给的 id 查库。

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Store } from '../../../packages/store/src/types.ts'
import {
  authorizeRuntimeRequest,
  storeRuntimeTokenVerifier,
  type AuthorizeRuntimeOptions,
  type RuntimeAuthGranted,
} from './runtime-token.ts'
import { sendError } from './server.ts'

/** 各路由上下文里与鉴权相关的字段（都允许缺省，方便直接构造 route ctx 测试）。 */
export interface RuntimeAuthContext {
  /** 控制面全局 token（旧部署兼容 / 管理员凭据）；空串或 undefined = 未配置。 */
  runtimeToken?: string
  /** 原始 SQLite store；有它才有每 workspace token。 */
  rawStore?: Store
  /** 注入时钟（测试用）；可以是函数或已取好的时间戳。 */
  now?: (() => number) | number
}

export interface RuntimeRequestAuth {
  /** 纯函数判定结果；`workspaceId === null` 表示全局管理员 token。 */
  granted: RuntimeAuthGranted
  /** 授权 token 所属的 workspace；null = 全局 token（不受 workspace 过滤限制）。 */
  workspaceId: string | null
}

export interface AuthorizeRuntimeHttpOptions {
  /** 覆盖 ctx.runtimeToken（marketplace 读 env 的旧语义用）。 */
  globalToken?: string
}

function resolveNow(ctx: RuntimeAuthContext): number | undefined {
  if (typeof ctx.now === 'function') return ctx.now()
  if (typeof ctx.now === 'number') return ctx.now
  return undefined
}

function verifierFor(ctx: RuntimeAuthContext) {
  return ctx.rawStore === undefined ? undefined : storeRuntimeTokenVerifier(ctx.rawStore)
}

/** 构造纯函数入参；也供需要自己判定（不写响应）的调用方复用。 */
export function runtimeAuthOptions(
  ctx: RuntimeAuthContext,
  options: AuthorizeRuntimeHttpOptions = {},
): AuthorizeRuntimeOptions {
  const globalToken = options.globalToken !== undefined ? options.globalToken : (ctx.runtimeToken ?? '')
  const verifier = verifierFor(ctx)
  const now = resolveNow(ctx)
  return {
    globalToken,
    ...(verifier === undefined ? {} : { store: verifier }),
    ...(now === undefined ? {} : { now }),
  }
}

/**
 * 内部接口统一入口：写 404/401 并返回 null，或返回授权结果。
 *
 * 注意 `req` 必须是 IncomingMessage（或至少带 headers 的对象）；token 从
 * `x-runtime-token` 或 `Authorization: Runtime <token>` 读。
 */
export function authorizeRuntimeHttp(
  ctx: RuntimeAuthContext,
  req: IncomingMessage,
  res: ServerResponse,
  options: AuthorizeRuntimeHttpOptions = {},
): RuntimeRequestAuth | null {
  const globalToken = options.globalToken !== undefined ? options.globalToken : (ctx.runtimeToken ?? '')
  const verifier = verifierFor(ctx)
  if (globalToken === '' && verifier === undefined) {
    sendError(res, 404, 'not_found', 'internal api is disabled')
    return null
  }

  const result = authorizeRuntimeRequest(runtimeAuthOptions(ctx, options), req)
  if (!result.ok) {
    sendError(res, 401, 'unauthenticated', 'runtime token required')
    return null
  }
  return { granted: result, workspaceId: result.workspaceId }
}

/**
 * 按授权结果校验目标 workspace 归属。全局 token 不受限；workspace token 只能命中
 * 自己。`workspaceId` 允许是 null（目标查不到）：workspace token 一律 403，全局
 * token 继续走原来的 404 路径。
 */
export function ensureRuntimeWorkspace(
  auth: RuntimeRequestAuth,
  workspaceId: string | null | undefined,
  res: ServerResponse,
): boolean {
  if (auth.workspaceId === null) return true
  if (typeof workspaceId === 'string' && workspaceId === auth.workspaceId) return true
  sendError(
    res,
    403,
    'forbidden_workspace',
    `runtime token is scoped to workspace ${auth.workspaceId}`,
  )
  return false
}
