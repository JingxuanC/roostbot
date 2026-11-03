// 控制面最小 API：配对码 → 设备会话 → workspace 列表/创建。
// 设计见 docs/design/auth.md（§3 配对流程、§9 数据模型、§10 接口）与
// docs/design/workspace.md（§8 数据模型、§9 接口）。
//
// 约定：
// - 零依赖：只用 node:http 与 node:crypto；无构建，node --experimental-strip-types 直接跑。
// - 只依赖 port.ts 的 StorePort。真实存储在 packages/store，由 Lead 写适配器接进来。
// - 所有响应都是 JSON + cache-control: no-store；错误统一 { ok: false, error: { code, message } }。
// - 默认监听 127.0.0.1（回环）：这是本机控制面，不是公网入口。
import { createHash, randomBytes, randomInt } from 'node:crypto'
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PairingCodeCollisionError } from './port.ts'
import type {
  DevicePlatform,
  HomeMode,
  PairingRecord,
  SessionRecord,
  StorePort,
  WorkspaceRecord
} from './port.ts'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8787

/** 配对码 5 分钟、单次（auth.md §2）。 */
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000
/** 同一个码错 5 次即锁 10 分钟（auth.md §3）。 */
export const PAIRING_MAX_ATTEMPTS = 5
export const PAIRING_LOCK_MS = 10 * 60 * 1000
/** 设备会话 30 天（auth.md §2）。续期（<15 天 → 180 天）尚未实现，见报告。 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 防御性上限：任何 JSON body 超过 64KiB 直接 413。 */
export const MAX_BODY_BYTES = 64 * 1024
/** 全局失败窗口：60 秒内 20 次配对失败即 429（每个 server 实例独立计数）。 */
export const CLAIM_FAILURE_WINDOW_MS = 60 * 1000
export const CLAIM_FAILURE_MAX = 20
/** 6 位码碰撞时换码重试次数。 */
const CODE_GENERATION_ATTEMPTS = 8

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const SESSION_TOKEN_PATTERN = /^[0-9a-f]{64}$/
const PLATFORMS: readonly DevicePlatform[] = ['web', 'desktop', 'ios', 'android', 'cli']

export interface ServerOptions {
  store: StorePort
  /** 注入时钟（测试用）。默认 Date.now。 */
  now?: () => number
}

export interface StartedServer {
  server: http.Server
  url: string
  close: () => Promise<void>
}

interface HandlerContext {
  store: StorePort
  now: () => number
  startedAt: number
  /** 全局失败时间戳，用于 429；放在闭包里，每个 server 一份。 */
  claimFailures: number[]
}

type Clock = () => number

/** 明文 token 只在签发瞬间出现；库里只有这个 hash。 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** 32 字节随机 → 64 位小写 hex。 */
function generateSessionToken(): string {
  return randomBytes(32).toString('hex')
}

/** 6 位数字，允许前导零（"000123" 也是合法码）。 */
function generatePairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.writableEnded) return
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers
  })
  res.end(payload)
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {}
): void {
  sendJson(res, status, { ok: false, error: { code, message } }, headers)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 去空白后必须是 1..maxLength 个字符，且不含控制字符。 */
function readText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '' || text.length > maxLength) return null
  if (/[\u0000-\u001f\u007f]/.test(text)) return null
  return text
}

function readPairingCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim()
  return /^\d{6}$/.test(code) ? code : null
}

function readPlatform(value: unknown): DevicePlatform | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return null
  const platform = value.trim()
  return PLATFORMS.includes(platform as DevicePlatform) ? (platform as DevicePlatform) : null
}

function normalizePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/** 写操作只接受回环 Origin；没有 Origin（非浏览器客户端）也放行。 */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return LOOPBACK_HOSTS.has(parsed.hostname)
}

interface ParsedBody {
  ok: true
  value: unknown
}

interface BodyError {
  ok: false
  status: number
  code: string
  message: string
}

/**
 * 读完整个 body 再判断大小：超限的部分直接丢弃但继续 drain，
 * 这样客户端能稳定收到 413，而不是被半路 reset。
 */
async function readJsonBody(req: IncomingMessage): Promise<ParsedBody | BodyError> {
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  try {
    for await (const chunk of req) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      size += buf.byteLength
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        chunks.length = 0
        continue
      }
      if (!tooLarge) chunks.push(buf)
    }
  } catch {
    return { ok: false, status: 400, code: 'invalid_json', message: 'could not read request body' }
  }

  if (tooLarge || size > MAX_BODY_BYTES) {
    return {
      ok: false,
      status: 413,
      code: 'payload_too_large',
      message: `request body exceeds ${MAX_BODY_BYTES} bytes`
    }
  }

  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') {
    return { ok: false, status: 400, code: 'invalid_body', message: 'request body must be a JSON object' }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, status: 400, code: 'invalid_json', message: 'request body is not valid JSON' }
  }
}

type AuthResult = { ok: true; session: SessionRecord } | { ok: false; status: number; code: string; message: string }

function authFailure(message: string, code = 'unauthenticated'): AuthResult {
  return { ok: false, status: 401, code, message }
}

const BEARER_HEADER = 'Authorization: Bearer <sessionToken> is required'

/** 校验 Bearer token：只做一次 sha256，然后按 hash 查库。 */
async function authenticate(ctx: HandlerContext, req: IncomingMessage): Promise<AuthResult> {
  const header = req.headers.authorization
  if (typeof header !== 'string') return authFailure(BEARER_HEADER)

  const match = /^Bearer[ ]+(\S+)$/.exec(header.trim())
  if (match === null) return authFailure('Authorization header must be "Bearer <sessionToken>"')

  const token = match[1]!
  if (!SESSION_TOKEN_PATTERN.test(token)) return authFailure('session token must be 64 lowercase hex characters')

  const session = await ctx.store.findSessionByToken(hashSessionToken(token))
  if (session === null) return authFailure('unknown session token')
  if (session.revokedAt !== undefined) return authFailure('session revoked', 'session_revoked')
  if (session.expiresAt <= ctx.now()) return authFailure('session expired; pair this device again', 'session_expired')

  return { ok: true, session }
}

function workspaceJson(workspace: WorkspaceRecord): Record<string, unknown> {
  const json: Record<string, unknown> = {
    id: workspace.id,
    tenantId: workspace.tenantId,
    name: workspace.name,
    homeMode: workspace.homeMode,
    state: workspace.state,
    profileVersion: workspace.profileVersion,
    role: workspace.role,
    createdAt: workspace.createdAt
  }
  if (workspace.volumeId !== undefined) json.volumeId = workspace.volumeId
  return json
}

function retryAfterSeconds(ms: number): string {
  return String(Math.max(1, Math.ceil(ms / 1000)))
}

function pruneFailures(ctx: HandlerContext, now: number): void {
  while (ctx.claimFailures.length > 0 && now - ctx.claimFailures[0]! > CLAIM_FAILURE_WINDOW_MS) {
    ctx.claimFailures.shift()
  }
}

/** 返回 0 表示未触发；否则是建议的 retry-after 毫秒数。 */
function globalWindowRemaining(ctx: HandlerContext, now: number): number {
  pruneFailures(ctx, now)
  if (ctx.claimFailures.length < CLAIM_FAILURE_MAX) return 0
  const oldest = ctx.claimFailures[0]!
  return Math.max(1000, CLAIM_FAILURE_WINDOW_MS - (now - oldest))
}

function recordFailure(ctx: HandlerContext, now: number): void {
  ctx.claimFailures.push(now)
  pruneFailures(ctx, now)
}

async function handleCreatePairingCode(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJsonBody(req)
  if (!body.ok) {
    sendError(res, body.status, body.code, body.message)
    return
  }
  if (!isPlainObject(body.value)) {
    sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
    return
  }

  const accountId = readText(body.value['accountId'], 128)
  if (accountId === null) {
    sendError(res, 400, 'invalid_body', 'accountId is required (string, 1..128 chars)')
    return
  }

  let workspaceId: string | undefined
  if (body.value['workspaceId'] !== undefined) {
    const parsed = readText(body.value['workspaceId'], 128)
    if (parsed === null) {
      sendError(res, 400, 'invalid_body', 'workspaceId must be a string of 1..128 chars when present')
      return
    }
    workspaceId = parsed
  }

  const issuedAt = ctx.now()
  const expiresAt = issuedAt + PAIRING_CODE_TTL_MS

  let pairing: PairingRecord | null = null
  for (let attempt = 0; attempt < CODE_GENERATION_ATTEMPTS; attempt += 1) {
    const code = generatePairingCode()
    try {
      pairing = await ctx.store.createPairingCode({ code, accountId, workspaceId, now: issuedAt, expiresAt })
      break
    } catch (err) {
      if (!(err instanceof PairingCodeCollisionError)) throw err
      // 6 位码撞上还活着的码：换一个再试。
    }
  }

  if (pairing === null) {
    sendError(res, 503, 'pairing_unavailable', 'could not allocate a pairing code; retry')
    return
  }

  sendJson(res, 200, { code: pairing.code, expiresAt: pairing.expiresAt })
}

async function handleClaimPairingCode(
  ctx: HandlerContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readJsonBody(req)
  if (!body.ok) {
    sendError(res, body.status, body.code, body.message)
    return
  }
  if (!isPlainObject(body.value)) {
    sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
    return
  }

  const code = readPairingCode(body.value['code'])
  if (code === null) {
    sendError(res, 400, 'invalid_body', 'code must be a string of exactly 6 digits')
    return
  }

  let deviceLabel: string | undefined
  if (body.value['deviceLabel'] !== undefined) {
    const parsed = readText(body.value['deviceLabel'], 80)
    if (parsed === null) {
      sendError(res, 400, 'invalid_body', 'deviceLabel must be a string of 1..80 chars when present')
      return
    }
    deviceLabel = parsed
  }

  const platform = readPlatform(body.value['platform'])
  if (platform === null) {
    sendError(res, 400, 'invalid_body', `platform must be one of ${PLATFORMS.join(', ')}`)
    return
  }

  const claimedAt = ctx.now()

  // 第一层：全局失败窗口。按 server 实例计数，不按 IP —— 回环下没有可信的客户端标识。
  const windowRemaining = globalWindowRemaining(ctx, claimedAt)
  if (windowRemaining > 0) {
    sendError(res, 429, 'too_many_attempts', 'too many failed claims; wait before retrying', {
      'retry-after': retryAfterSeconds(windowRemaining)
    })
    return
  }

  const result = await ctx.store.claimPairingCode({
    code,
    now: claimedAt,
    maxAttempts: PAIRING_MAX_ATTEMPTS,
    lockMs: PAIRING_LOCK_MS
  })

  if (!result.ok) {
    recordFailure(ctx, claimedAt)
    switch (result.reason) {
      case 'locked':
        sendError(res, 429, 'pairing_code_locked', 'too many failed attempts for this code; request a new one', {
          'retry-after': retryAfterSeconds(PAIRING_LOCK_MS)
        })
        return
      case 'expired':
        sendError(res, 401, 'pairing_code_expired', 'pairing code expired; request a new one')
        return
      case 'used':
        sendError(res, 401, 'pairing_code_used', 'pairing code already used; request a new one')
        return
      default:
        sendError(res, 401, 'pairing_code_invalid', 'pairing code is not valid')
        return
    }
  }

  // 第二层：码已消费（store 里已原子标记使用）。下面是签发设备会话。
  await appendDeviceSession(ctx, result.pairing, claimedAt, deviceLabel, platform, res)
}

async function appendDeviceSession(
  ctx: HandlerContext,
  pairing: PairingRecord,
  claimedAt: number,
  deviceLabel: string | undefined,
  platform: DevicePlatform | undefined,
  res: ServerResponse
): Promise<void> {
  const sessionToken = generateSessionToken()
  try {
    const session = await ctx.store.createSession({
      accountId: pairing.accountId,
      tokenHash: hashSessionToken(sessionToken),
      now: claimedAt,
      expiresAt: claimedAt + SESSION_TTL_MS,
      workspaceId: pairing.workspaceId,
      deviceLabel,
      platform
    })
    sendJson(res, 200, {
      deviceId: session.deviceId,
      sessionToken,
      expiresAt: session.expiresAt
    })
  } catch (err) {
    // 码已经烧掉：用户重新生成一个即可。这里如实报错，不假装配对成功。
    console.error('roost api: failed to create session after claiming pairing code', err)
    sendError(res, 500, 'session_create_failed', 'pairing code was consumed but session creation failed; request a new code')
  }
}

async function handleListWorkspaces(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
    return
  }
  const workspaces = await ctx.store.listWorkspaces({ accountId: auth.session.accountId })
  sendJson(res, 200, { workspaces: workspaces.map(workspaceJson) })
}

async function handleCreateWorkspace(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
    return
  }

  const body = await readJsonBody(req)
  if (!body.ok) {
    sendError(res, body.status, body.code, body.message)
    return
  }
  if (!isPlainObject(body.value)) {
    sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
    return
  }

  const name = readText(body.value['name'], 120)
  if (name === null) {
    sendError(res, 400, 'invalid_body', 'name is required (string, 1..120 chars)')
    return
  }

  let homeMode: HomeMode | undefined
  if (body.value['homeMode'] !== undefined) {
    const raw = body.value['homeMode']
    if (raw !== 'cloud' && raw !== 'local') {
      sendError(res, 400, 'invalid_body', 'homeMode must be "cloud" or "local"')
      return
    }
    homeMode = raw
  }

  const workspace = await ctx.store.createWorkspace({
    accountId: auth.session.accountId,
    name,
    now: ctx.now(),
    homeMode
  })

  sendJson(res, 201, { workspace: workspaceJson(workspace) })
}

function notFound(req: IncomingMessage, res: ServerResponse, method: string, path: string): void {
  req.resume()
  sendError(res, 404, 'not_found', `no route for ${method} ${path}`)
}

async function handleRequest(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', 'http://control-plane.local')
  const path = normalizePath(url.pathname)

  // auth.md §7：控制面写操作要求 Origin 校验。本机回环之外一律拒绝。
  if (method !== 'GET' && method !== 'HEAD' && !isAllowedOrigin(req.headers.origin)) {
    req.resume()
    sendError(res, 403, 'forbidden_origin', `write requests must come from a loopback origin, got ${req.headers.origin}`)
    return
  }

  if (path === '/healthz') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    sendJson(res, 200, { ok: true, uptimeMs: Math.max(0, ctx.now() - ctx.startedAt) })
    return
  }

  if (path === '/api/pairing/code') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleCreatePairingCode(ctx, req, res)
    return
  }

  if (path === '/api/pairing/claim') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleClaimPairingCode(ctx, req, res)
    return
  }

  if (path === '/api/workspaces') {
    if (method === 'GET') {
      await handleListWorkspaces(ctx, req, res)
      return
    }
    if (method === 'POST') {
      await handleCreateWorkspace(ctx, req, res)
      return
    }
    notFound(req, res, method, path)
    return
  }

  notFound(req, res, method, path)
}

/** 返回未监听的 node:http Server；要直接起服务用 startServer()。 */
export function createServer(options: ServerOptions): http.Server {
  const now: Clock = options.now ?? (() => Date.now())
  const ctx: HandlerContext = {
    store: options.store,
    now,
    startedAt: now(),
    claimFailures: []
  }

  const server = http.createServer((req, res) => {
    handleRequest(ctx, req, res).catch((err: unknown) => {
      console.error('roost api: unhandled request error', err)
      if (res.headersSent) {
        if (!res.writableEnded) res.end()
        return
      }
      sendError(res, 500, 'internal_error', 'internal error')
    })
  })

  // 连 HTTP 解析都失败时也保持 JSON 形状，不让默认的 text/plain 400 漏出去。
  server.on('clientError', (_err, socket) => {
    if (socket.destroyed || !socket.writable) return
    const body = JSON.stringify({ ok: false, error: { code: 'bad_request', message: 'malformed HTTP request' } })
    socket.end(
      'HTTP/1.1 400 Bad Request\r\n' +
        'content-type: application/json; charset=utf-8\r\n' +
        'cache-control: no-store\r\n' +
        `content-length: ${Buffer.byteLength(body)}\r\n` +
        'connection: close\r\n\r\n' +
        body
    )
  })

  return server
}

/** 起服务并等到 listening：默认 127.0.0.1，port 0 表示随机端口（测试用）。 */
export async function startServer(
  options: ServerOptions & { port?: number; host?: string }
): Promise<StartedServer> {
  const server = createServer(options)
  const port = options.port ?? DEFAULT_PORT
  const host = options.host ?? DEFAULT_HOST

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })

  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port

  return {
    server,
    url: `http://${host}:${boundPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err)
          else resolve()
        })
        // fetch/undici 会保持 keep-alive 连接；不主动清掉，close() 会等到超时。
        server.closeAllConnections()
      })
  }
}
