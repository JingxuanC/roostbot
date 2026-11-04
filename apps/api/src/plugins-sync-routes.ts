// 内部接口：沙箱启动前拉 profile 锁（TODO 4.3.4）。
// 设计：docs/design/plugin-marketplace.md §6 `POST /api/internal/plugins/sync`、§4 ④⑤。
//
// runtime token 鉴权，与 server.ts / bot-rooms-routes.ts 的内部接口同一套语义：
// 未配置 = 404（不暴露接口存在），错 token = 401。
// M4 的锁 = 基线 profile 目录生成的空锁（见 ./profile-lock.ts）。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { loadBaselineProfileLock } from './profile-lock.ts'
import { sendError, sendJson } from './server.ts'

export interface PluginsSyncRouteContext {
  runtimeToken?: string
  /** 测试可覆盖基线 profile 目录；默认 apps/runtime/profile。 */
  profileDir?: string
  now?: () => number
}

export async function handlePluginsSync(ctx: PluginsSyncRouteContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorizeRuntime(ctx, req, res)) return
  try {
    const lock = await loadBaselineProfileLock({
      ...(ctx.profileDir === undefined ? {} : { profileDir: ctx.profileDir }),
      ...(ctx.now === undefined ? {} : { now: ctx.now })
    })
    sendJson(res, 200, { lock })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error('roost api: profile lock build failed', error)
    sendError(res, 500, 'profile.lock_unavailable', detail)
  }
}

function runtimeTokenFrom(req: IncomingMessage): string | null {
  const header = (req.headers['x-runtime-token'] ?? '').toString()
  if (header !== '') return header
  const auth = (req.headers.authorization ?? '').trim()
  const match = /^Runtime[ ]+(\S+)$/.exec(auth)
  return match === null ? null : match[1]!
}

function authorizeRuntime(ctx: PluginsSyncRouteContext, req: IncomingMessage, res: ServerResponse): boolean {
  if (ctx.runtimeToken === undefined || ctx.runtimeToken === '') {
    sendError(res, 404, 'not_found', 'internal api is disabled')
    return false
  }
  const token = runtimeTokenFrom(req)
  if (token === null || token !== ctx.runtimeToken) {
    sendError(res, 401, 'unauthenticated', 'runtime token required')
    return false
  }
  return true
}
