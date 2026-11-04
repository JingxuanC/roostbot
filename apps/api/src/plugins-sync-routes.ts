// 内部接口：沙箱启动前拉 profile 锁（TODO 4.3.4）。
// 设计：docs/design/plugin-marketplace.md §6 `POST /api/internal/plugins/sync`、§4 ④⑤。
//
// runtime token 鉴权，与 server.ts / bot-rooms-routes.ts 的内部接口同一套语义：
// 无全局 token 且无 rawStore = 404（不暴露接口存在），错 token = 401；workspace token
// 还必须带 x-roost-workspace-id 且等于自己的 workspace（否则 403）。
// M4 的锁 = 基线 profile 目录生成的空锁（见 ./profile-lock.ts）。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { loadBaselineProfileLock } from './profile-lock.ts'
import { sendError, sendJson } from './server.ts'
import { authorizeRuntimeHttp, ensureRuntimeWorkspace } from './runtime-auth.ts'
import type { Store } from '../../../packages/store/src/types.ts'

export interface PluginsSyncRouteContext {
  runtimeToken?: string
  /** 原始 SQLite store：有它才有每 workspace token。 */
  rawStore?: Store
  /** 测试可覆盖基线 profile 目录；默认 apps/runtime/profile。 */
  profileDir?: string
  now?: () => number
}

export async function handlePluginsSync(ctx: PluginsSyncRouteContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = authorizeRuntimeHttp(ctx, req, res)
  if (auth === null) return
  if (auth.workspaceId !== null) {
    // profile 锁本身不是租户数据，但 workspace token 必须声明自己是谁：
    // 缺失或伪造 workspace 头一律 403，避免一个沙箱替别的 workspace 拉锁。
    const declared = (req.headers['x-roost-workspace-id'] ?? '').toString().trim()
    if (!ensureRuntimeWorkspace(auth, declared === '' ? null : declared, res)) return
  }
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

