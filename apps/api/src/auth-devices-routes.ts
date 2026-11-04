// 设备与会话 API（docs/design/auth.md §10）：
//
//   GET    /api/devices        当前账号的全部设备会话 + isCurrent
//   DELETE /api/devices/:id    吊销该账号的一条会话（id 是 GET 返回的会话 id）
//
// 鉴权一律走 Bearer 会话；写操作由 server.ts 的路由入口统一做 Origin 校验。
// 设备/会话列表与吊销事件都落在 SQLite（rawStore），内存 port 下这两个接口返回 503
// —— 与 bot-rooms-routes.ts 的处理一致，避免假装成功（CONVENTIONS.md 第 6 条）。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { appendEvent } from '../../../packages/store/src/events.ts'
import {
  findSessionById,
  listSessionsByAccount,
  revokeSession,
} from '../../../packages/store/src/sessions.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import type { SessionRecord, StorePort } from './port.ts'
import { authenticate, sendError, sendJson } from './server.ts'

/** 这两个 handler 只需要鉴权上下文 + 原始 SQLite store。 */
export interface AuthDevicesContext {
  store: StorePort
  now: () => number
  rawStore?: Store
}

function sessionJson(row: ReturnType<typeof listSessionsByAccount>[number], current: SessionRecord): Record<string, unknown> {
  const json: Record<string, unknown> = {
    id: row.id,
    label: row.label,
    platform: row.platform,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt ?? row.deviceRevokedAt,
    isCurrent: row.id === current.id,
  }
  // lastSeenAt「若有」才返回，避免前端把 null 当时间渲染。
  if (row.lastSeenAt !== null) json.lastSeenAt = row.lastSeenAt
  return json
}

export async function handleListDevices(
  ctx: AuthDevicesContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
    return
  }
  if (ctx.rawStore === undefined) {
    sendError(res, 503, 'devices_unavailable', 'device listing needs the SQLite store')
    return
  }
  const rows = listSessionsByAccount(ctx.rawStore, auth.session.accountId)
  sendJson(res, 200, { devices: rows.map((row) => sessionJson(row, auth.session)) })
}

export async function handleRevokeDevice(
  ctx: AuthDevicesContext,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
    return
  }
  if (ctx.rawStore === undefined) {
    sendError(res, 503, 'devices_unavailable', 'device revocation needs the SQLite store')
    return
  }

  const session = findSessionById(ctx.rawStore, sessionId)
  // 不属于当前账号的会话一律当不存在，避免跨账号探测。
  if (session === null || session.accountId !== auth.session.accountId) {
    sendError(res, 404, 'device_not_found', `unknown device session ${sessionId}`)
    return
  }

  if (session.revokedAt === null) {
    const at = ctx.now()
    revokeSession(ctx.rawStore, session.id, at)
    // events.md §3：domain.kind；吊销事实进事件日志，设备列表只是投影。
    appendEvent(ctx.rawStore, {
      at: new Date(at).toISOString(),
      domain: 'auth',
      kind: 'auth.session.revoked',
      actor: { kind: 'user', id: auth.session.accountId },
      subject: { kind: 'session', id: session.id },
      payload: { deviceId: session.deviceId, self: session.id === auth.session.id },
    })
  }

  // 已吊销也返回 204：DELETE 是幂等的。
  if (res.writableEnded) return
  res.writeHead(204, { 'cache-control': 'no-store' })
  res.end()
}
