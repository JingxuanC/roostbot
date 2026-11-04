// DSH Web 反代与插件面板清单（ADR 0004；plugin-marketplace.md §3 C 级、§12）。
//
//   GET|HEAD|POST|PUT|PATCH|DELETE /w/:workspaceId/dsh/*   反代到 127.0.0.1:<DSH_WEB_PORT>
//   POST                           /w/:workspaceId/dsh/session  签发短时 cookie
//   GET                            /api/workspaces/:id/panels     已启用插件声明的面板
//   GET                            /api/workspaces/:id/dsh/status 面板容器探活
//
// 独立源（ADR 0004）：
//   控制面在第二个监听端口（ServerOptions.dshProxyPort）只伺服上面这组 /w/.../dsh 路由。
//   cookie 不区分端口，所以主端口签发的会话 cookie 对同 host 的反代端口同样有效；iframe 用
//   `allow-scripts allow-same-origin` 时保留的是反代端口自己的源，与主控制面（另一个端口）
//   仍是跨源，插件代码碰不到主控制面的 DOM/storage。反代端口不重复主控制面的 Origin 校验，
//   鉴权仍由 cookie / Bearer 负责。
//
// 鉴权（为什么不是 Authorization 头）：
//   iframe 用 `sandbox="allow-scripts"`（**不加 allow-same-origin**），文档是 opaque origin，
//   读不到我们的 cookie/localStorage，但发往同站点的请求仍会带 same-site cookie。所以反代
//   接受两种凭据：普通 Bearer 会话（给非 iframe 调用）或 `roost_dsh_<workspace hash>` cookie。
//   cookie 值 = base64url(`workspaceId|accountId|exp`) + '.' + HMAC-SHA256(secret, payload)，
//   HttpOnly / Path=/w/<workspaceId>/dsh/ / SameSite=Lax / Max-Age=900。
//   签名 secret 优先 ROOST_SIGNING_SECRET（ServerOptions.signingSecret），未配置则进程内随机。
//
// 安全边界：
//   - 上游固定 127.0.0.1，路径只做前缀剥离，不做任何目标地址拼接（无 SSRF 面）。
//   - 控制面的 Authorization / Cookie / X-Runtime-Token / X-Roost-* 不往上游带；
//     上游的 Set-Cookie 也不回传，避免把第三方 cookie 种到控制面源上。
//   - 只支持普通 HTTP 方法；WebSocket upgrade 留到后续（见文件末尾说明）。
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { DSH_WEB_PORT } from '../../../packages/plugins/src/surface.ts'
import {
  getWorkspaceRole,
  listInstalls,
  listVersions,
} from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import type { StorePort } from './port.ts'
import { authenticate, readText, sendError, sendJson } from './server.ts'

/** dsh web 面板会话 cookie 的有效期（秒 / 毫秒）。 */
export const DSH_SESSION_MAX_AGE_SECONDS = 900
export const DSH_SESSION_TTL_MS = DSH_SESSION_MAX_AGE_SECONDS * 1000

export interface DshRouteContext {
  store: StorePort
  rawStore?: Store
  now: () => number
  /** 假上游端口由 ServerOptions.dshWebPort 注入；生产默认 4099。 */
  dshWebPort: number
  signingSecret: string
}

/** 反代路径：/w/<workspaceId>/dsh 或 /w/<workspaceId>/dsh/...（不匹配 /dshx）。 */
const DSH_PATH_PATTERN = /^\/w\/([^/]+)\/dsh(?:\/.*)?$/
/** workspaceId 只允许 URL 安全字符：它同时进入 cookie Path/Name，必须防头注入。 */
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9_-]+$/
const PROXY_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** 控制面内部头：只在本进程内使用，不向上游泄漏。 */
const INTERNAL_HEADER_PREFIXES = ['x-runtime-', 'x-roost-']

/** HTML 里的站内绝对路径（//cdn 这类协议相对地址不动）。 */
const HTML_SELF_REFERENCE = /(href|src|action)="\/(?!\/)/g

export function isDshProxyPath(pathname: string): boolean {
  return DSH_PATH_PATTERN.test(pathname)
}

/**
 * 处理 /w/... 下的全部请求。返回 false 表示不是反代路径（交给 server 后续路由）。
 * session 只接受 POST；其它方法访问 session 直接 404，避免和上游同名路径混淆。
 */
export async function handleDshRequest(
  ctx: DshRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const match = /^\/w\/([^/]+)\/dsh(\/.*)?$/.exec(url.pathname)
  if (match === null) return false

  const workspaceId = safeDecode(match[1]!)
  if (workspaceId === null || !SAFE_WORKSPACE_ID.test(workspaceId)) {
    sendError(res, 404, 'workspace_not_found', 'unknown workspace')
    return true
  }

  const rest = match[2] ?? '/'
  const method = req.method ?? 'GET'

  if (/^\/session\/?$/.test(rest)) {
    if (method !== 'POST') {
      sendError(res, 404, 'not_found', `no route for ${method} ${url.pathname}`)
      return true
    }
    await handleDshSession(ctx, req, res, workspaceId)
    return true
  }

  if (!PROXY_METHODS.has(method)) {
    sendError(res, 404, 'not_found', `no route for ${method} ${url.pathname}`)
    return true
  }

  await handleDshProxy(ctx, req, res, url, workspaceId, rest)
  return true
}

// ---- 会话 cookie -------------------------------------------------------------

/** roost_dsh_<workspaceId 的 sha256 前 16 位 hex>：不同 workspace 互不覆盖。 */
export function dshSessionCookieName(workspaceId: string): string {
  const hash = createHash('sha256').update(workspaceId, 'utf8').digest('hex').slice(0, 16)
  return `roost_dsh_${hash}`
}

export function dshSessionCookiePath(workspaceId: string): string {
  return `/w/${workspaceId}/dsh/`
}

function signSessionValue(secret: string, workspaceId: string, accountId: string, exp: number): string {
  const payload = `${workspaceId}|${accountId}|${exp}`
  const signature = createHmac('sha256', secret).update(payload, 'utf8').digest('base64url')
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${signature}`
}

interface VerifiedCookie {
  workspaceId: string
  accountId: string
  exp: number
}

/** 校验签名、过期时间和 workspace 归属；任一不符返回 null。 */
function verifySessionValue(
  secret: string,
  value: string,
  workspaceId: string,
  now: number,
): VerifiedCookie | null {
  const parts = value.split('.')
  if (parts.length !== 2) return null
  const [encoded, signature] = parts as [string, string]

  let payload: string
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return null
  }

  const expected = createHmac('sha256', secret).update(payload, 'utf8').digest()
  let given: Buffer
  try {
    given = Buffer.from(signature, 'base64url')
  } catch {
    return null
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null

  // workspaceId 不含 '|'（路径已校验安全字符）；accountId 从中间拼回，兼容含 '|' 的 id。
  const fields = payload.split('|')
  if (fields.length < 3) return null
  const cookieWorkspace = fields[0]!
  const accountId = fields.slice(1, -1).join('|')
  const exp = Number(fields[fields.length - 1])
  if (cookieWorkspace !== workspaceId || accountId === '') return null
  if (!Number.isSafeInteger(exp) || exp <= now) return null
  return { workspaceId: cookieWorkspace, accountId, exp }
}

function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined || header === '') return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    return part.slice(index + 1).trim()
  }
  return null
}

async function handleDshSession(
  ctx: DshRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
    return
  }
  if (!(await isWorkspaceMember(ctx, workspaceId, auth.session.accountId))) {
    // 不存在或非成员统一 404：不泄漏 workspace 是否存在。
    sendError(res, 404, 'workspace_not_found', 'unknown workspace')
    return
  }

  const exp = ctx.now() + DSH_SESSION_TTL_MS
  const value = signSessionValue(ctx.signingSecret, workspaceId, auth.session.accountId, exp)
  const cookie = `${dshSessionCookieName(workspaceId)}=${value}; Path=${dshSessionCookiePath(
    workspaceId,
  )}; HttpOnly; SameSite=Lax; Max-Age=${DSH_SESSION_MAX_AGE_SECONDS}`

  // 204 不写 body；浏览器拿到 Set-Cookie 就够。
  res.writeHead(204, {
    'set-cookie': cookie,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end()
}

// ---- 反代 --------------------------------------------------------------------

async function handleDshProxy(
  ctx: DshRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  workspaceId: string,
  rest: string,
): Promise<void> {
  const identity = await authenticateProxy(ctx, req, workspaceId)
  if (identity === null) {
    sendError(res, 401, 'unauthenticated', 'dsh proxy needs a session cookie or Bearer session', {
      'www-authenticate': 'Bearer',
    })
    return
  }
  if (!(await isWorkspaceMember(ctx, workspaceId, identity.accountId))) {
    sendError(res, 404, 'workspace_not_found', 'unknown workspace')
    return
  }

  const upstreamPath = pathWithQuery(rest, url.search)
  let settled = false
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: ctx.dshWebPort,
      method: req.method,
      path: upstreamPath,
      headers: upstreamHeaders(req),
    },
    (upstreamRes) => {
      forwardResponse(req, res, upstreamRes, workspaceId)
    },
  )

  upstream.on('error', () => {
    if (settled) return
    settled = true
    if (!res.headersSent) {
      sendError(res, 502, 'dsh.unavailable', 'dsh web is not reachable')
    } else if (!res.writableEnded) {
      res.destroy()
    }
  })

  // 客户端先断开时及时释放上游连接。
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy()
  })

  req.pipe(upstream)
}

interface ProxyIdentity {
  accountId: string
  via: 'bearer' | 'cookie'
}

/**
 * 先试 Bearer（非 iframe 调用），失败再试本 workspace 的 cookie。
 * 两条都没有或都不合法返回 null（调用方 401）。
 */
async function authenticateProxy(
  ctx: DshRouteContext,
  req: IncomingMessage,
  workspaceId: string,
): Promise<ProxyIdentity | null> {
  const auth = await authenticate(ctx, req)
  if (auth.ok) return { accountId: auth.session.accountId, via: 'bearer' }

  const name = dshSessionCookieName(workspaceId)
  const value = readCookie(req.headers.cookie, name)
  if (value === null) return null
  const verified = verifySessionValue(ctx.signingSecret, value, workspaceId, ctx.now())
  if (verified === null) return null
  return { accountId: verified.accountId, via: 'cookie' }
}

/**
 * workspace 成员判定。SQLite 走 workspace_members；memory port 没有成员表，
 * 跳过校验（与 members-routes 的 v0 语义一致）。
 */
async function isWorkspaceMember(
  ctx: DshRouteContext,
  workspaceId: string,
  accountId: string,
): Promise<boolean> {
  if (ctx.rawStore === undefined) return true
  return getWorkspaceRole(ctx.rawStore, workspaceId, accountId) !== null
}

function pathWithQuery(rest: string, search: string): string {
  const path = rest === '' ? '/' : rest
  return `${path}${search}`
}

/** 请求头：去 hop-by-hop 与控制面内部头；cookie/authorization 一律不透传。 */
function upstreamHeaders(req: IncomingMessage): http.OutgoingHttpHeaders {
  const drop = new Set(HOP_BY_HOP)
  const connection = req.headers.connection
  if (typeof connection === 'string') {
    for (const token of connection.split(',')) {
      const name = token.trim().toLowerCase()
      if (name !== '') drop.add(name)
    }
  }
  // host 由 node:http 按上游地址重写；accept-encoding 去掉，保证 HTML 可被重写。
  drop.add('host')
  drop.add('cookie')
  drop.add('authorization')
  drop.add('accept-encoding')

  const headers: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (drop.has(name)) continue
    if (INTERNAL_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    headers[name] = value
  }
  return headers
}

/** 响应头：去 hop-by-hop / x-frame-options / set-cookie；CSP 剥 frame-ancestors。 */
function responseHeaders(upstreamRes: IncomingMessage): http.OutgoingHttpHeaders {
  const drop = new Set(HOP_BY_HOP)
  const connection = upstreamRes.headers.connection
  if (typeof connection === 'string') {
    for (const token of connection.split(',')) {
      const name = token.trim().toLowerCase()
      if (name !== '') drop.add(name)
    }
  }
  drop.add('x-frame-options')
  drop.add('set-cookie')
  drop.add('cache-control')

  const headers: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(upstreamRes.headers)) {
    if (value === undefined) continue
    if (drop.has(name)) continue
    if (name === 'content-security-policy' || name === 'content-security-policy-report-only') {
      const cleaned = stripFrameAncestors(value).filter((entry) => entry !== '')
      if (cleaned.length === 0) continue
      headers[name] = cleaned.length === 1 ? cleaned[0]! : cleaned
      continue
    }
    headers[name] = value
  }
  // 面板内容随时可能变：统一禁缓存，避免 reload 拿到旧壳。
  headers['cache-control'] = 'no-store'
  return headers
}

function stripFrameAncestors(value: string | string[]): string[] {
  const values = Array.isArray(value) ? value : [value]
  return values.map((entry) => {
    const directives = entry
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .filter((part) => part.split(/\s+/)[0]?.toLowerCase() !== 'frame-ancestors')
    return directives.join('; ')
  })
}

function forwardResponse(
  req: IncomingMessage,
  res: ServerResponse,
  upstreamRes: IncomingMessage,
  workspaceId: string,
): void {
  const status = upstreamRes.statusCode ?? 502
  const headers = responseHeaders(upstreamRes)
  const contentType = String(upstreamRes.headers['content-type'] ?? '')
  const contentEncoding = upstreamRes.headers['content-encoding']
  const isHtml = contentType.toLowerCase().startsWith('text/html')
  const canRewrite = isHtml && (contentEncoding === undefined || contentEncoding === 'identity')

  if (canRewrite && req.method !== 'HEAD') {
    void collectAndRewrite(upstreamRes, res, status, headers, workspaceId)
    return
  }

  res.writeHead(status, headers)
  if (req.method === 'HEAD' || status === 204 || status === 304) {
    upstreamRes.resume()
    res.end()
    return
  }
  upstreamRes.pipe(res)
}

/** HTML 缓冲后重写站内绝对路径，并重算 content-length。 */
async function collectAndRewrite(
  upstreamRes: IncomingMessage,
  res: ServerResponse,
  status: number,
  headers: http.OutgoingHttpHeaders,
  workspaceId: string,
): Promise<void> {
  const chunks: Buffer[] = []
  try {
    for await (const chunk of upstreamRes) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
    }
  } catch {
    if (!res.headersSent) sendError(res, 502, 'dsh.unavailable', 'dsh web response was interrupted')
    else if (!res.writableEnded) res.destroy()
    return
  }

  const base = `/w/${workspaceId}/dsh`
  const body = Buffer.from(
    Buffer.concat(chunks).toString('utf8').replace(HTML_SELF_REFERENCE, `$1="${base}/`),
    'utf8',
  )
  headers['content-length'] = String(body.byteLength)
  res.writeHead(status, headers)
  res.end(body)
}

// ---- 面板容器探活 ------------------------------------------------------------

/** 探活超时（毫秒）。 */
export const DSH_STATUS_TIMEOUT_MS = 1500

/**
 * GET /api/workspaces/:id/dsh/status（Bearer，任意成员）。
 * 由控制面代探 127.0.0.1:<dshWebPort>/：前端不必从主控制面源跨源 fetch 反代端口（没有 CORS）。
 * 探活失败不是服务错误：始终 200，用 available 区分，避免前端把"没启动"当接口故障。
 */
export async function handleDshStatus(
  ctx: DshRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
    return
  }
  if (!(await isWorkspaceMember(ctx, workspaceId, auth.session.accountId))) {
    sendError(res, 404, 'workspace_not_found', 'unknown workspace')
    return
  }

  const status = await probeDshWeb(ctx.dshWebPort, DSH_STATUS_TIMEOUT_MS)
  if (status === null) sendJson(res, 200, { available: false })
  else sendJson(res, 200, { available: true, status })
}

/** 对 127.0.0.1:<port>/ 发 GET；拿到任意 HTTP 响应即视为可用。 */
function probeDshWeb(port: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (status: number | null): void => {
      if (settled) return
      settled = true
      resolve(status)
    }
    const probe = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: '/', headers: { accept: '*/*' } },
      (upstreamRes) => {
        finish(upstreamRes.statusCode ?? 0)
        upstreamRes.resume()
      },
    )
    probe.setTimeout(timeoutMs, () => {
      finish(null)
      probe.destroy()
    })
    probe.on('error', () => finish(null))
    probe.end()
  })
}

// ---- 面板清单 ----------------------------------------------------------------

export interface WorkspacePanel {
  pluginSlug: string
  name: string
  title?: string
  slot?: string
  path?: string
}

/**
 * GET /api/workspaces/:id/panels（Bearer，任意成员）。
 * 只读 manifest 里的声明，不做"实际注册数冒烟"（需要沙箱内 DSH Web，留第二/三批）。
 * manifest.panels 必须是数组；旧的纯数量声明（panels: 7）没有名字，不猜。
 */
export async function handleListWorkspacePanels(
  ctx: DshRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
    return
  }

  const store = ctx.rawStore
  if (store === undefined) {
    sendError(res, 503, 'runtime.not_configured', '面板清单需要 SQLite 存储')
    return
  }
  if (getWorkspaceRole(store, workspaceId, auth.session.accountId) === null) {
    sendError(res, 404, 'workspace_not_found', 'unknown workspace')
    return
  }

  const panels: WorkspacePanel[] = []
  for (const install of listInstalls(store, workspaceId)) {
    if (!install.enabled) continue
    const version = listVersions(store, install.slug).find((entry) => entry.version === install.version)
    if (version === undefined) continue
    const declared = version.manifest['panels']
    if (!Array.isArray(declared)) continue
    for (const entry of declared) {
      const panel = readPanelDeclaration(entry)
      if (panel === null) continue
      panels.push({ pluginSlug: install.slug, ...panel })
    }
  }

  sendJson(res, 200, { panels })
}

function readPanelDeclaration(value: unknown): Omit<WorkspacePanel, 'pluginSlug'> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  const name = readText(entry['name'], 128)
  if (name === null) return null

  const panel: Omit<WorkspacePanel, 'pluginSlug'> = { name }
  const title = readText(entry['title'], 200)
  if (title !== null) panel.title = title
  const slot = readText(entry['slot'], 64)
  if (slot !== null) panel.slot = slot
  const path = readText(entry['path'], 512)
  if (path !== null) panel.path = path
  return panel
}

// ---- 小工具 ------------------------------------------------------------------

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/** 端口兜底（server.ts 也做一次同规则校验，这里导出给测试/未来复用）。 */
export function resolveDshWebPort(value: number | undefined, env = process.env.DSH_WEB_PORT): number {
  if (value !== undefined && Number.isInteger(value) && value > 0 && value < 65536) return value
  const parsed = Number.parseInt(env ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DSH_WEB_PORT
}

// 遗留（本批不做）：
// - WebSocket upgrade：DSH Web 若用 ws 推事件，需要在 server 的 'upgrade' 事件里做同样的
//   鉴权与路径剥离；当前 createServer 没有 upgrade 监听，握手会被直接断开。
// - CORS：sandbox 的 opaque origin 发起的 fetch 可能触发预检（OPTIONS）；本批不返回 CORS 头。
// - 面板冒烟：manifest 声明数 vs DSH Web 实际注册数需要沙箱内实例。
