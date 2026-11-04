// 控制面最小 API：配对码 → 设备会话 → workspace 列表/创建。
// 设计见 docs/design/auth.md（§3 配对流程、§9 数据模型、§10 接口）与
// docs/design/workspace.md（§8 数据模型、§9 接口）。
//
// 约定：
// - 零依赖：只用 node:http 与 node:crypto；无构建，node --experimental-strip-types 直接跑。
// - 只依赖 port.ts 的 StorePort。真实存储在 packages/store，由 Lead 写适配器接进来。
// - 所有响应都是 JSON + cache-control: no-store；错误统一 { ok: false, error: { code, message: human } }。
// - 默认监听 127.0.0.1（回环）：这是本机控制面，不是公网入口。
import { createHash, randomBytes, randomInt } from 'node:crypto'
import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleListDevices, handleRevokeDevice } from './auth-devices-routes.ts'
import { PairingCodeCollisionError } from './port.ts'
import type {
  DevicePlatform,
  HomeMode,
  PairingRecord,
  SessionRecord,
  StorePort,
  WorkspaceRecord
} from './port.ts'
import {
  handleCreateBot,
  handleDeleteBot,
  handleGetBot,
  handleListBots,
  handlePatchBot,
  handleRestoreBot
} from './bots-routes.ts'
import {
  handleAddRoomMembers,
  handleCreateRoomExtended,
  handleDeleteRoom,
  handleGetRoom,
  handlePatchRoom,
  handleRemoveRoomMember
} from './rooms-routes-ext.ts'
import {
  handleListWorkspaceMembers,
  handleRemoveWorkspaceMember,
  handleSetWorkspaceMemberRole,
  requireWorkspaceRole,
  workspaceIdForRoom
} from './members-routes.ts'
import {
  handleBotCreateRoom,
  handleDecideApproval,
  handleListApprovals,
} from './bot-rooms-routes.ts'
import {
  handleCreateApprovalGrant,
  handleInternalCreateApproval,
  handleInternalGetApproval,
  handleListApprovalGrants,
  handleRevokeApprovalGrant,
} from './approvals-routes.ts'
import {
  handleGetUsage,
  handleInternalBudgetReserve,
  handleInternalBudgetSettle,
  handleInternalUsage,
  handleListQuotas,
  handlePatchQuota,
} from './budget-routes.ts'
import {
  handleCreateSchedule,
  handleDeleteSchedule,
  handleInternalSchedulerTick,
  handleListRuns,
  handleListSchedules,
  handlePatchSchedule,
  handleRunScheduleNow,
  handleStopRun,
} from './schedules-routes.ts'
import { startSchedulerLoop } from './scheduler-loop.ts'
import { handlePluginsSync } from './plugins-sync-routes.ts'
import {
  handleDshRequest,
  handleDshStatus,
  handleListWorkspacePanels,
  isDshProxyPath,
  resolveDshWebPort,
} from './dsh-proxy-routes.ts'
import type { DshRouteContext } from './dsh-proxy-routes.ts'
import {
  handleDeletePluginInstall,
  handleGetMarketplacePlugin,
  handleListMarketplacePlugins,
  handleListMarketplaceVersions,
  handleListPluginInstalls,
  handleMarketplaceInstall,
  handleMarketplacePreflight,
  handlePatchPluginInstall,
} from './marketplace-routes.ts'
import {
  createAttachmentsRuntime,
  handleInternalArtifactUpload,
  handleInternalAttachmentGc,
  handleServeMessageFile,
  handleServeSignedAttachment,
  handleUploadAttachment,
} from './attachments-routes.ts'
import type { AttachmentsRuntime } from './attachments-routes.ts'
import { openRoundForMessage } from './round-orchestrator.ts'
import { activeRound, setStopping } from '../../../packages/store/src/rounds.ts'
import { findExhaustedWorkspaceQuota } from '../../../packages/store/src/budget.ts'
import { handleInternalAdvance, handleInternalAssignments, handleInternalRound } from './rounds-http.ts'
import { readWorkspaceRuntime, startWorkspaceRuntime } from './workspace-runtime.ts'
import type { RuntimeManager } from './workspace-runtime.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import {
  createHttpLogEntry,
  resolveRequestId,
  writeHttpLog,
} from './logger.ts'
import type { HttpLogEntry } from './logger.ts'
import { createMetrics } from './metrics.ts'
import type { MetricsRegistry } from './metrics.ts'
import { handleAudit } from './audit-routes.ts'
import { TokenBucketLimiter } from './rate-limit.ts'
import type { RateLimiter, RateLimitKind } from './rate-limit.ts'
import { getRoomDetail } from '../../../packages/store/src/rooms-ext.ts'
import { hasActiveSessionsForAccount, touchSession } from '../../../packages/store/src/sessions.ts'
import { listMessageAttachments } from '../../../packages/store/src/attachments.ts'
import type { MessageAttachment } from '../../../packages/store/src/attachments.ts'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8787

/** 配对码 5 分钟、单次（auth.md §2）。 */
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000
/** 同一个码错 5 次即锁 10 分钟（auth.md §3）。 */
export const PAIRING_MAX_ATTEMPTS = 5
export const PAIRING_LOCK_MS = 10 * 60 * 1000
/** 设备会话 30 天（auth.md §2）。 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 剩余有效期不足 15 天时续期（auth.md §2/§4）。 */
export const SESSION_RENEW_WINDOW_MS = 15 * 24 * 60 * 60 * 1000
/** 会话自配对起的硬上限 180 天；到顶后必须重新配对。 */
export const SESSION_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000
/** 防御性上限：任何 JSON body 超过 1MiB 直接 413（头像 dataURL ≤256KB 图片，base64 后约 350k 字符）。 */
export const MAX_BODY_BYTES = 1024 * 1024
/** 全局失败窗口：60 秒内 20 次配对失败即 429（每个 server 实例独立计数）。 */
export const CLAIM_FAILURE_WINDOW_MS = 60 * 1000
export const CLAIM_FAILURE_MAX = 20
/** 6 位码碰撞时换码重试次数。 */
const CODE_GENERATION_ATTEMPTS = 8

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
/** 配对码 bootstrap 例外只认这三个远端地址（IPv4-mapped 形式单独列出）。 */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const SESSION_TOKEN_PATTERN = /^[0-9a-f]{64}$/
const PLATFORMS: readonly DevicePlatform[] = ['web', 'desktop', 'ios', 'android', 'cli']

export interface ServerOptions {
  /** SSE 轮询间隔（毫秒）；默认 700，测试里调小。 */
  streamPollMs?: number
  /**
   * 内部接口的 runtime token（`ROOST_RUNTIME_TOKEN`）。不给 = 内部接口关闭（404）。
   * 只有同机的 runtime worker 持有它，不走用户会话。
   */
  runtimeToken?: string
  store: StorePort
  /** 注入时钟（测试用）。默认 Date.now。 */
  now?: () => number
  /** 原始 SQLite store：轮次持久化与工作区运行时状态需要它（memory port 没有）。 */
  rawStore?: Store
  /** 工作区沙箱管理器；不配置时 /start 返回 runtime.not_configured。 */
  runtimeManager?: RuntimeManager
  /** 附件内容存储根目录；默认 ROOST_ATTACHMENTS_DIR 或 <cwd>/data/attachments。 */
  attachmentsDir?: string
  /** 附件签名密钥；默认 ROOST_SIGNING_SECRET，未配置时进程内随机。 */
  signingSecret?: string
  /**
   * 沙箱内 dsh web 端口（反代固定目标 127.0.0.1:<port>）；默认 DSH_WEB_PORT 环境变量或 4099。
   * 测试注入假上游端口。
   */
  dshWebPort?: number
  /**
   * 独立的 DSH 反代监听端口（ADR 0004「独立源」）：undefined=不启动，0=随机端口（测试），
   * >0=固定端口。该端口只服务 /w/:workspaceId/dsh/*，不走主控制面的 Origin 校验；
   * 鉴权仍由 cookie/Bearer 负责。cookie 不区分端口，主端口签发的会话 cookie 对它同样有效。
   */
  dshProxyPort?: number
  /**
   * 是否启动控制面调度 tick 循环（默认 false；ROOST_SCHEDULER=1 时也会启动）。
   * 测试直接用 store.tick，不走真实定时器。
   */
  schedulerLoop?: boolean
  /** 结构化请求日志出口；默认写 stdout，测试可注入收集器。 */
  logSink?: (entry: HttpLogEntry) => void
}

export interface StartedServer {
  server: http.Server
  url: string
  /** 独立反代源（如 `http://127.0.0.1:4098`）；未启用反代端口时为 undefined。 */
  dshProxyUrl?: string
  close: () => Promise<void>
}

/** 启动期共享的可变状态：随机反代端口的实际值要 listen 之后才知道，/api/config 需要读它。 */
export interface ServerState {
  dshProxyPort?: number
  dsh?: DshRouteContext
}

/** 鉴权只需要 store 与时钟；新的路由模块用这个最小形状，不依赖 server 内部状态。 */
export interface AuthContext {
  store: StorePort
  now: () => number
  /** 原始 SQLite store；会话续期、设备列表/吊销与事件写入需要它，memory 模式下为 undefined。 */
  rawStore?: Store
}

interface HandlerContext extends AuthContext {
  startedAt: number
  /** 全局失败时间戳，用于 429；放在闭包里，每个 server 一份。 */
  claimFailures: number[]
  /**
   * 本进程签发过会话的账号（memory 模式下无法查 sessions 表，用它做 bootstrap 判定）。
   * SQLite 模式以 hasActiveSessionsForAccount 为准，这个集合只是同进程的补充。
   */
  sessionAccounts: Set<string>
  runtimeManager?: RuntimeManager
  /** 内容存储；只有 rawStore 可用时才创建。 */
  attachments?: AttachmentsRuntime
  /** DSH Web 反代与面板清单（ADR 0004）。 */
  dsh: DshRouteContext
  /** 反代端口的实际绑定值等启动期可变状态。 */
  serverState: ServerState
  /** 每个 server 实例独立的请求指标。 */
  metrics: MetricsRegistry
  /** 每个 server 实例独立的内存令牌桶。 */
  rateLimiter: RateLimiter
  /** 调度循环是否实际启用（memory port 下不启动）。 */
  schedulerEnabled: boolean
  /** 结构化请求日志出口。 */
  logSink: (entry: HttpLogEntry) => void
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

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
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


// 面向人的文案（auth.md §8 要求中文话术）；code 保持英文稳定，前端按 code 分支。
// 未列出的 code 原样返回调用点给的 message（保留技术细节，便于排查）。
const ERROR_TEXT: Record<string, string> = {
  unauthenticated: '请先配对：缺少有效的会话令牌',
  session_expired: '会话已过期，请重新配对',
  session_revoked: '会话已被吊销，请重新配对',
  invalid_body: '请求内容不完整或格式不对',
  invalid_json: '请求体不是合法的 JSON',
  payload_too_large: '请求体过大',
  forbidden_origin: '写操作只允许来自本机回环页面',
  pairing_forbidden: '没有权限签发配对码',
  devices_unavailable: '设备管理需要 SQLite 存储',
  device_not_found: '找不到这个设备会话',
  pairing_code_invalid: '配对码不对',
  pairing_code_used: '这个配对码已经用过了',
  pairing_code_expired: '配对码已过期，请重新生成',
  pairing_code_locked: '尝试次数过多，请重新生成配对码',
  too_many_attempts: '尝试次数过多，请稍后再试',
  workspace_name_invalid: 'workspace 名字不能为空，且不超过 60 字',
  workspace_not_found: '找不到这个 workspace',
  'bot.invalid': 'Bot 信息不合法',
  'bot.name_taken': '这个 workspace 里已经有同名 Bot',
  'bot.no_model': '创建 Bot 时必须指定模型',
  'bot.not_found': '找不到这个 Bot',
  'room.invalid': '房间信息不合法',
  'room.members': '房间成员不合法',
  'room.responder': '「谁回答」必须指向房间成员',
  room_not_found: '找不到这个房间',
  rate_limited: '操作太频繁，请稍后再试',
  internal_error: '服务出错了，请稍后重试'
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {}
): void {
  // code 是稳定契约；message 面向人（中文），技术细节放在括号里便于排查。
  const human = ERROR_TEXT[code] === undefined ? message : `${ERROR_TEXT[code]}（${message}）`
  sendJson(res, status, { ok: false, error: { code, message: human } }, headers)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 去空白后必须是 1..maxLength 个字符，且不含控制字符。 */
export function readText(value: unknown, maxLength: number): string | null {
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

/** 解码路径段；非法百分号编码返回 null（调用方按 404 处理）。 */
function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value).trim()
    return decoded === '' ? null : decoded
  } catch {
    return null
  }
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

export interface ParsedBody {
  ok: true
  value: unknown
}

export interface BodyError {
  ok: false
  status: number
  code: string
  message: string
}

/**
 * 读完整个 body 再判断大小：超限的部分直接丢弃但继续 drain，
 * 这样客户端能稳定收到 413，而不是被半路 reset。
 */
export async function readJsonBody(req: IncomingMessage): Promise<ParsedBody | BodyError> {
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

export type AuthResult = { ok: true; session: SessionRecord } | { ok: false; status: number; code: string; message: string }

function authFailure(message: string, code = 'unauthenticated'): AuthResult {
  return { ok: false, status: 401, code, message }
}

const BEARER_HEADER = 'Authorization: Bearer <sessionToken> is required'

/** 校验 Bearer token：只做一次 sha256，然后按 hash 查库。 */
export async function authenticate(ctx: AuthContext, req: IncomingMessage): Promise<AuthResult> {
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

  return { ok: true, session: renewSession(ctx, session) }
}

/**
 * 会话续期（auth.md §2/§4）：剩余有效期 <15 天时续到 createdAt+180 天。
 * 不到续期窗口、已到 180 天封顶、或当前 expiresAt 已经更晚时都不动（touchSession 只增不减）。
 * memory 模式没有 sessions 查询接口，保持固定 30 天。
 */
function renewSession(ctx: AuthContext, session: SessionRecord): SessionRecord {
  const store = ctx.rawStore
  if (store === undefined) return session
  const now = ctx.now()
  if (now < session.expiresAt - SESSION_RENEW_WINDOW_MS) return session
  const cap = session.createdAt + SESSION_MAX_AGE_MS
  if (now >= cap || cap <= session.expiresAt) return session
  const touched = touchSession(store, session.id, { lastSeenAt: now, expiresAt: cap })
  return {
    ...session,
    expiresAt: touched.expiresAt,
    lastSeenAt: touched.lastSeenAt ?? session.lastSeenAt
  }
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

/** 写接口限流；返回 false 时已经写好 429 响应。 */
function enforceRateLimit(
  ctx: HandlerContext,
  res: ServerResponse,
  kind: RateLimitKind,
  accountId: string
): boolean {
  const retryAfter = ctx.rateLimiter.consume(kind, accountId, ctx.now())
  if (retryAfter === null) return true
  sendError(res, 429, 'rate_limited', `too many ${kind} requests; retry after ${retryAfter}s`, {
    'retry-after': String(retryAfter)
  })
  return false
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

type PairingAuthorizeResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string; wwwAuthenticate?: boolean }

/**
 * 配对码签发鉴权（auth.md §5）：
 * - 带 Bearer：body.accountId 必须等于会话账号；workspaceId 必须是该账号 owner/admin 的 workspace；
 * - 不带 Bearer：只允许回环地址 + bootstrap（该账号尚无任何有效会话）——首配例外。
 * 带了但无效的 Bearer 直接 401，不回退到 bootstrap，避免“坏 token 也能签发”。
 */
async function authorizePairingCode(
  ctx: HandlerContext,
  req: IncomingMessage,
  accountId: string,
  workspaceId: string | undefined
): Promise<PairingAuthorizeResult> {
  const header = req.headers.authorization
  if (typeof header === 'string') {
    const auth = await authenticate(ctx, req)
    if (!auth.ok) {
      return { ok: false, status: auth.status, code: auth.code, message: auth.message, wwwAuthenticate: true }
    }
    if (auth.session.accountId !== accountId) {
      return {
        ok: false,
        status: 403,
        code: 'pairing_forbidden',
        message: 'body.accountId must match the authenticated session account'
      }
    }
    if (workspaceId !== undefined) {
      const workspaces = await ctx.store.listWorkspaces({ accountId: auth.session.accountId })
      const workspace = workspaces.find((entry) => entry.id === workspaceId)
      if (workspace === undefined || (workspace.role !== 'owner' && workspace.role !== 'admin')) {
        return {
          ok: false,
          status: 403,
          code: 'pairing_forbidden',
          message: `workspace ${workspaceId} requires owner/admin role`
        }
      }
    }
    return { ok: true }
  }

  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) {
    return {
      ok: false,
      status: 403,
      code: 'pairing_forbidden',
      message: 'bootstrap pairing codes are only issued to loopback requests'
    }
  }
  // SQLite 以库里的有效会话为准；memory 没有查询接口，只能看本进程签发过哪些账号。
  const hasSession =
    ctx.rawStore === undefined
      ? ctx.sessionAccounts.has(accountId)
      : hasActiveSessionsForAccount(ctx.rawStore, accountId, ctx.now())
  if (hasSession) {
    return {
      ok: false,
      status: 403,
      code: 'pairing_forbidden',
      message: 'account already has an active session; issue the code from an authenticated device'
    }
  }
  return { ok: true }
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

  const authorized = await authorizePairingCode(ctx, req, accountId, workspaceId)
  if (!authorized.ok) {
    sendError(
      res,
      authorized.status,
      authorized.code,
      authorized.message,
      authorized.wwwAuthenticate === true ? { 'www-authenticate': 'Bearer' } : {}
    )
    return
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
    // 记住这个账号已经有会话：memory 模式靠它区分 bootstrap 与后续签发。
    ctx.sessionAccounts.add(pairing.accountId)
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


// ---- 客户端配置 --------------------------------------------------------------

/**
 * GET /api/config（无需鉴权）：告诉前端反代源地址。
 * 用请求 Host 的主机名（去端口、保留 IPv6 方括号）+ 实际反代端口拼出 dshBase；
 * 没有启用反代端口时返回 null。主机名不合法回退 127.0.0.1，避免把任意 Host 透出成 URL。
 */
function handleGetConfig(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): void {
  const port = ctx.serverState.dshProxyPort
  const dshBase =
    port === undefined || port <= 0 ? null : `http://${hostnameFromHostHeader(req.headers.host)}:${port}`
  sendJson(res, 200, { dshBase })
}

/** 从 Host 头取主机名：去掉端口，IPv6 字面量保留方括号；非法值回退 127.0.0.1。 */
export function hostnameFromHostHeader(host: string | undefined): string {
  if (host === undefined) return DEFAULT_HOST
  const trimmed = host.trim()
  if (trimmed === '') return DEFAULT_HOST

  // IPv6 字面量必须带方括号：`[::1]:4098` → `[::1]`。
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end < 0) return DEFAULT_HOST
    const inner = trimmed.slice(1, end)
    const rest = trimmed.slice(end + 1)
    if (rest !== '' && !/^:\d+$/.test(rest)) return DEFAULT_HOST
    return /^[0-9A-Fa-f:.]+$/.test(inner) ? `[${inner}]` : DEFAULT_HOST
  }

  // 主机名 / IPv4：只允许字母数字、点、连字符、下划线，拒绝冒号以外的注入字符。
  const name = trimmed.split(':')[0] ?? ''
  if (name === '' || name.length > 253) return DEFAULT_HOST
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return DEFAULT_HOST
  return name
}

// ---- 同源伺服 apps/web -------------------------------------------------------
// 浏览器直连 ?api= 会触发跨源预检，而控制面没有 CORS（有意：v0 不回 CORS 头）。
// 所以把网页也从控制面伺服，页面用同源相对路径调 API，一个进程就是完整应用。

const WEB_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../web')
const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2'
}

async function serveStatic(res: ServerResponse, path: string): Promise<boolean> {
  const relative = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
  if (relative.includes('..') || relative.startsWith('.')) return false
  const filePath = join(WEB_ROOT, normalize(relative))
  try {
    const info = await stat(filePath)
    if (!info.isFile()) return false
    const body = await readFile(filePath)
    res.writeHead(200, {
      'content-type': STATIC_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    })
    res.end(body)
    return true
  } catch {
    return false
  }
}


// ---- 房间与消息（docs/design/messaging.md）---------------------------------

interface RoomRouteContext extends HandlerContext {
  runtimeToken?: string
  /** SSE 轮询间隔（测试可调小）。 */
  streamPollMs: number
}

export function roomJson(room: RoomRecord): Record<string, unknown> {
  return {
    id: room.id,
    workspaceId: room.workspaceId,
    name: room.name,
    replyMode: room.replyMode,
    responder: room.responder ?? { kind: 'mentions' },
    createdAt: room.createdAt,
    // 旧的内存 store 不带 members；默认 [] 让房间列表在两种实现下形状一致。
    members: room.members ?? [],
    ...(room.notice === undefined ? {} : { notice: room.notice }),
    ...(room.hostBotId === undefined ? {} : { hostBotId: room.hostBotId }),
    ...(room.purpose === undefined ? {} : { purpose: room.purpose }),
    ...(room.createdByKind === undefined ? {} : { createdByKind: room.createdByKind }),
    ...(room.createdBy === undefined ? {} : { createdBy: room.createdBy }),
    ...(room.dm === true ? { dm: true } : {})
  }
}

function messageJson(
  message: RoomMessageRecord,
  attachments: MessageAttachment[] = []
): Record<string, unknown> {
  return {
    seq: message.seq,
    at: message.at,
    actor: { kind: message.actorKind, id: message.actorId },
    text: message.text,
    // 无附件时也返回 []，前端形状稳定。
    attachments: attachments.map((item) => ({
      artifactId: item.artifactId,
      kind: item.kind,
      name: item.name,
      size: item.size,
      mime: item.mime,
      url: item.url
    }))
  }
}

/** 批量给消息挂上附件；只有 SQLite store 可用时才查（memory harness 不查）。 */
function messagesJson(
  ctx: HandlerContext,
  messages: RoomMessageRecord[]
): Record<string, unknown>[] {
  if (ctx.rawStore === undefined || messages.length === 0) {
    return messages.map((message) => messageJson(message))
  }
  let grouped: Map<number, MessageAttachment[]>
  try {
    grouped = new Map()
    for (const item of listMessageAttachments(ctx.rawStore, messages.map((message) => message.seq))) {
      const list = grouped.get(item.messageSeq)
      if (list === undefined) grouped.set(item.messageSeq, [item])
      else list.push(item)
    }
  } catch (error) {
    // 附件读失败不能把整条消息列表打成 500：降级为 []，并把原因留在日志里。
    console.error('roost api: failed to load message attachments', error)
    grouped = new Map()
  }
  return messages.map((message) => messageJson(message, grouped.get(message.seq) ?? []))
}


/**
 * 房间接口的存储错误映射：不认识的房间/workspace 是 404（不是 500），
 * 权限不足是 403；其余一律 500，并把原始错误留在日志里。
 */

// ---- 服务端内部接口（runtime worker 专用，runtime token 鉴权）----------------
// 这不是给浏览器用的：worker 要能发现房间、按 seq 读、以 Bot 身份说话。

function runtimeTokenFrom(req: IncomingMessage): string | null {
  const header = (req.headers['x-runtime-token'] ?? '').toString()
  if (header !== '') return header
  const auth = (req.headers.authorization ?? '').trim()
  const match = /^Runtime[ ]+(\S+)$/.exec(auth)
  return match === null ? null : match[1]!
}

function authorizeRuntime(ctx: RoomRouteContext, req: IncomingMessage, res: ServerResponse): boolean {
  if (ctx.runtimeToken === undefined || ctx.runtimeToken === '') {
    // 没配置 = 功能关闭：404 而不是 401，避免暴露"这里有内部接口"。
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

async function handleInternalRooms(ctx: RoomRouteContext, req: IncomingMessage, res: ServerResponse, url?: URL): Promise<void> {
  if (!authorizeRuntime(ctx, req, res)) return
  try {
    // 一沙箱一 workspace：带 workspaceId 时只返回这个 workspace 的房间，避免串房间。
    const requested = url?.searchParams.get('workspaceId') ?? process.env.ROOST_WORKSPACE_ID ?? null
    const all = await ctx.store.listAllRooms()
    const filtered = requested === null ? all : all.filter((room) => room.workspaceId === requested)
    sendJson(res, 200, { rooms: filtered.map(roomJson) })
  } catch (err) {
    sendStoreFailure(res, err)
  }
}

async function handleInternalMessages(ctx: RoomRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!authorizeRuntime(ctx, req, res)) return
  const roomId = internalRoomIdFromPath(url.pathname)
  if (roomId === null) return sendError(res, 404, 'not_found', 'malformed room path')
  const afterRaw = url.searchParams.get('after')
  const afterSeq = afterRaw === null ? undefined : Number.parseInt(afterRaw, 10)
  if (afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
    return sendError(res, 400, 'invalid_body', 'after must be a non-negative integer seq')
  }
  try {
    if (afterSeq !== undefined) {
      // 增量路径（room-agent 轮询）不受裁剪影响：after 之后照单全收。
      const messages = await ctx.store.readMessagesInternal({ roomId, afterSeq })
      sendJson(res, 200, { messages: messagesJson(ctx, messages) })
      return
    }
    // 首看/向前翻页走裁剪投影（rooms.md §3：保留 60、首看 12）。
    const query = readLogQuery(res, url)
    if (query === null) return
    const page = await ctx.store.readRoomLogInternal({ roomId, ...query })
    sendJson(res, 200, { messages: messagesJson(ctx, page.messages), page: logPageJson(page) })
  } catch (err) {
    sendStoreFailure(res, err)
  }
}

async function handleSay(ctx: RoomRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!authorizeRuntime(ctx, req, res)) return
  const roomId = roomIdFromPath(url.pathname)
  if (roomId === null) return sendError(res, 404, 'not_found', 'malformed room path')
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  const body = parsed.value as Record<string, unknown>
  const botId = typeof body.botId === 'string' ? body.botId.trim() : ''
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (botId === '' || botId.length > 64) {
    return sendError(res, 400, 'invalid_body', 'body.botId must be 1..64 characters')
  }
  if (text === '' || text.length > 8000) {
    return sendError(res, 400, 'invalid_body', 'body.text must be 1..8000 characters')
  }
  const idem = typeof body.idem === 'string' && body.idem !== '' ? body.idem : undefined
  try {
    const message = await ctx.store.postBotMessage({ roomId, botId, text, ...(idem === undefined ? {} : { idem }) })
    sendJson(res, 201, { message: messagesJson(ctx, [message])[0] })
  } catch (err) {
    sendStoreFailure(res, err)
  }
}

function sendStoreFailure(res: ServerResponse, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  if (/unknown room/i.test(message)) {
    sendError(res, 404, 'room_not_found', message)
    return
  }
  if (/unknown workspace/i.test(message)) {
    sendError(res, 404, 'workspace_not_found', message)
    return
  }
  if (/not a member|forbidden/i.test(message)) {
    sendError(res, 403, 'forbidden', message)
    return
  }
  console.error('roost api: room store failure', err)
  sendError(res, 500, 'internal_error', 'room store failure')
}

async function handleListRooms(ctx: RoomRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message)
  const workspaceId = url.searchParams.get('workspaceId') ?? undefined
  try {
    const rooms = await ctx.store.listRooms({
      accountId: auth.session.accountId,
      ...(workspaceId === undefined ? {} : { workspaceId })
    })
    sendJson(res, 200, { rooms: rooms.map(roomJson) })
  } catch (err) {
    sendStoreFailure(res, err)
  }
}

async function handleReadMessages(ctx: RoomRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message)
  const afterRaw = url.searchParams.get('after')
  const afterSeq = afterRaw === null ? undefined : Number.parseInt(afterRaw, 10)
  if (afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
    return sendError(res, 400, 'invalid_body', 'after must be a non-negative integer seq')
  }
  const roomId = roomIdFromPath(url.pathname)
  if (roomId === null) return sendError(res, 404, 'not_found', 'malformed room path')
  try {
    if (afterSeq !== undefined) {
      // 增量路径（SSE 断线补拉）不受裁剪影响：after 之后照单全收。
      const messages = await ctx.store.readMessages({ accountId: auth.session.accountId, roomId, afterSeq })
      sendJson(res, 200, { messages: messagesJson(ctx, messages) })
      return
    }
    // 首看给最近 12 条；before 游标向前翻，最多翻到最近 60 条（rooms.md §3）。
    const query = readLogQuery(res, url)
    if (query === null) return
    const page = await ctx.store.readRoomLog({ accountId: auth.session.accountId, roomId, ...query })
    sendJson(res, 200, { messages: messagesJson(ctx, page.messages), page: logPageJson(page) })
  } catch (err) {
    sendStoreFailure(res, err)
  }
}

/** 解析 before/limit 翻页参数；不合法时直接回 400 并返回 null。 */
function readLogQuery(res: ServerResponse, url: URL): { beforeSeq?: number; limit?: number } | null {
  const beforeRaw = url.searchParams.get('before')
  const beforeSeq = beforeRaw === null ? undefined : Number.parseInt(beforeRaw, 10)
  if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) {
    sendError(res, 400, 'invalid_body', 'before must be a positive integer seq')
    return null
  }
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw === null ? undefined : Number.parseInt(limitRaw, 10)
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    sendError(res, 400, 'invalid_body', 'limit must be a positive integer')
    return null
  }
  return {
    ...(beforeSeq === undefined ? {} : { beforeSeq }),
    ...(limit === undefined ? {} : { limit })
  }
}

/** 给前端的翻页信息：before 是下一页的游标（本页最旧一条的 seq）。 */
function logPageJson(page: { hasMore: boolean; oldestSeq: number | null; floorSeq: number }): Record<string, unknown> {
  return { hasMore: page.hasMore, before: page.oldestSeq, floor: page.floorSeq }
}

async function handlePostMessage(ctx: RoomRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message)
  if (!enforceRateLimit(ctx, res, 'messages', auth.session.accountId)) return
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  const body = parsed.value as Record<string, unknown>
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (text === '' || text.length > 8000) {
    return sendError(res, 400, 'invalid_body', 'body.text must be 1..8000 characters')
  }
  const idem = typeof body.idem === 'string' && body.idem !== '' ? body.idem : undefined
  const roomId = roomIdFromPath(url.pathname)
  if (roomId === null) return sendError(res, 404, 'not_found', 'malformed room path')

  // 发消息：viewer 只读（auth.md §5）。memory port 没有成员表时跳过（requireWorkspaceRole 内处理）。
  const workspaceId = workspaceIdForRoom(ctx, roomId)
  if (workspaceId !== null) {
    const gate = requireWorkspaceRole(ctx, workspaceId, auth.session.accountId, ['owner', 'admin', 'member'])
    if (!gate.ok) return sendError(res, gate.status, gate.code, gate.message)
    // 准入拦截（budget.md §5）：日 runs / tokens 配额耗尽时消息不落库。
    if (ctx.rawStore !== undefined) {
      const blocked = findExhaustedWorkspaceQuota(ctx.rawStore, workspaceId, ctx.now())
      if (blocked !== null) {
        return sendError(
          res,
          429,
          'quota_exhausted',
          `workspace ${workspaceId} daily ${blocked.metric} quota exhausted`,
        )
      }
    }
  }

  try {
    const message = await ctx.store.postMessage({
      accountId: auth.session.accountId,
      roomId,
      text,
      ...(idem === undefined ? {} : { idem })
    })
    // 一条用户消息开启一轮；失败不影响消息本身（消息已经落库）。
    if (ctx.rawStore !== undefined) {
      try {
        const detail = getRoomDetail(ctx.rawStore, roomId)
        if (detail !== null) {
          openRoundForMessage({ store: ctx.rawStore, room: detail.room, seq: message.seq, text: message.text })
        }
      } catch (error) {
        console.error('roost api: failed to open round', error)
      }
    }
    sendJson(res, 201, { message: messagesJson(ctx, [message])[0] })
  } catch (err) {
    sendStoreFailure(res, err)
  }
}

/**
 * SSE：新消息推送。用轮询读 store（SQLite 是唯一真相，轮询不会漏；写侧不需要广播）。
 * 浏览器 EventSource 不能带 Authorization 头，所以这条路由额外接受 ?access_token=。
 * 仅本机回环 + no-store；上公网前要改成同源 cookie 或 fetch 流。
 */
async function handleStream(ctx: RoomRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const headerToken = /^Bearer[ ]+(\S+)$/.exec((req.headers.authorization ?? '').trim())
  const queryToken = url.searchParams.get('access_token')
  const token = headerToken?.[1] ?? queryToken
  if (token === null || token === undefined || !SESSION_TOKEN_PATTERN.test(token)) {
    return sendError(res, 401, 'unauthenticated', 'stream needs a session token')
  }
  const session = await ctx.store.findSessionByToken(hashSessionToken(token))
  if (session === null) return sendError(res, 401, 'unauthenticated', 'unknown session token')
  if (session.expiresAt <= ctx.now()) return sendError(res, 401, 'session_expired', 'session expired')

  const roomId = roomIdFromPath(url.pathname)
  if (roomId === null) return sendError(res, 404, 'not_found', 'malformed room path')
  const afterRaw = url.searchParams.get('after')
  let lastSeq = afterRaw === null ? 0 : Number.parseInt(afterRaw, 10)
  if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) lastSeq = 0

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.write(': connected\n\n')

  let closed = false
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n')
  }, 15_000)
  heartbeat.unref?.()

  const pump = async (): Promise<void> => {
    while (!closed) {
      let batch: RoomMessageRecord[]
      try {
        batch = await ctx.store.readMessages({
          accountId: session.accountId,
          roomId,
          afterSeq: lastSeq,
          limit: 200
        })
      } catch {
        // 房间被删或权限变化：结束流，让客户端重连并处理。
        res.write('event: error\ndata: {"code":"stream_unavailable"}\n\n')
        break
      }
      const batchJson = messagesJson(ctx, batch)
      for (let index = 0; index < batch.length; index += 1) {
        const message = batch[index]!
        lastSeq = message.seq
        res.write(`id: ${message.seq}\nevent: message\ndata: ${JSON.stringify(batchJson[index])}\n\n`)
      }
      if (batch.length > 0) res.write(`event: cursor\ndata: ${JSON.stringify({ seq: lastSeq })}\n\n`)
      await sleep(ctx.streamPollMs)
    }
  }

  req.on('close', () => {
    closed = true
    clearInterval(heartbeat)
  })

  await pump()
  clearInterval(heartbeat)
  if (!res.writableEnded) res.end()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function roomIdFromPath(pathname: string, suffix = '(?:messages|stream|say)'): string | null {
  const match = new RegExp(`^/api/rooms/([^/]+)(?:/${suffix})?$`).exec(pathname)
  if (match === null) return null
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return null
  }
}

function internalRoomIdFromPath(pathname: string): string | null {
  const match = /^\/api\/internal\/rooms\/([^/]+)\/messages$/.exec(pathname)
  if (match === null) return null
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return null
  }
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function notFound(req: IncomingMessage, res: ServerResponse, method: string, path: string): void {
  req.resume()
  sendError(res, 404, 'not_found', `no route for ${method} ${path}`)
}

async function handleRequest(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', 'http://control-plane.local')
  const path = normalizePath(url.pathname)
  // /w/<id>/dsh/* 由反代自己鉴权（iframe 的 opaque origin 会发 Origin: null），
  // 不受控制面"写操作只允许回环 Origin"的CSRF 规则约束。
  const isDshPath = isDshProxyPath(url.pathname)

  // auth.md §7：控制面写操作要求 Origin 校验。本机回环之外一律拒绝。
  if (
    !isDshPath &&
    method !== 'GET' &&
    method !== 'HEAD' &&
    !isAllowedOrigin(req.headers.origin)
  ) {
    req.resume()
    sendError(res, 403, 'forbidden_origin', `write requests must come from a loopback origin, got ${req.headers.origin}`)
    return
  }

  if (isDshPath) {
    await handleDshRequest(ctx.dsh, req, res, url)
    return
  }

  if (path === '/healthz') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    sendJson(res, 200, {
      ok: true,
      uptimeMs: Math.max(0, ctx.now() - ctx.startedAt),
      store: ctx.rawStore === undefined ? 'memory' : 'sqlite',
      scheduler: ctx.schedulerEnabled,
      dsh: {
        webPort: ctx.dsh.dshWebPort,
        proxyPort: ctx.serverState.dshProxyPort ?? null
      }
    })
    return
  }

  // Prometheus 抓取端点：无鉴权，手写 text/plain（M6-6.6）。
  if (path === '/metrics') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    const body = Buffer.from(ctx.metrics.render(ctx.rawStore), 'utf8')
    res.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    })
    res.end(body)
    return
  }

  // 审计查询：events 是事实源，只读，owner/admin 才能看（M6-6.6）。
  if (path === '/api/audit') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleAudit(ctx, req, res, url)
    return
  }

  // 前端启动时读一次：反代源地址（无鉴权；只含本机 Host 拼出的地址，不泄漏秘密）。
  if (path === '/api/config') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    handleGetConfig(ctx, req, res)
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

  if (path === '/api/devices') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleListDevices(ctx, req, res)
    return
  }

  if (/^\/api\/devices\/[^/]+$/.test(path)) {
    if (method !== 'DELETE') {
      notFound(req, res, method, path)
      return
    }
    const match = /^\/api\/devices\/([^/]+)$/.exec(path)
    const sessionId = match === null ? null : safeDecode(match[1]!)
    if (sessionId === null || sessionId === '') {
      sendError(res, 404, 'not_found', 'malformed device path')
      return
    }
    await handleRevokeDevice(ctx, req, res, sessionId)
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

  // 面板容器探活（Bearer，任意成员）：由控制面代探，前端不跨源。
  if (/^\/api\/workspaces\/[^/]+\/dsh\/status$/.test(path)) {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    const match = /^\/api\/workspaces\/([^/]+)\/dsh\/status$/.exec(path)
    const workspaceId = match === null ? null : safeDecode(match[1]!)
    if (workspaceId === null || workspaceId === '') {
      sendError(res, 404, 'not_found', 'malformed workspace dsh status path')
      return
    }
    await handleDshStatus(ctx.dsh, req, res, workspaceId)
    return
  }

  // workspace 成员与角色（auth.md §5/§10；M5-5.3.3）。
  if (/^\/api\/workspaces\/[^/]+\/panels$/.test(path)) {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    const match = /^\/api\/workspaces\/([^/]+)\/panels$/.exec(path)
    const workspaceId = match === null ? null : safeDecode(match[1]!)
    if (workspaceId === null || workspaceId === '') {
      sendError(res, 404, 'not_found', 'malformed workspace panels path')
      return
    }
    await handleListWorkspacePanels(ctx.dsh, req, res, workspaceId)
    return
  }

  if (/^\/api\/workspaces\/[^/]+\/members$/.test(path)) {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    const match = /^\/api\/workspaces\/([^/]+)\/members$/.exec(path)
    const workspaceId = match === null ? null : safeDecode(match[1]!)
    if (workspaceId === null || workspaceId === '') {
      sendError(res, 404, 'not_found', 'malformed workspace members path')
      return
    }
    await handleListWorkspaceMembers(ctx, req, res, workspaceId)
    return
  }

  if (/^\/api\/workspaces\/[^/]+\/members\/[^/]+$/.test(path)) {
    if (method !== 'PATCH' && method !== 'DELETE') {
      notFound(req, res, method, path)
      return
    }
    const match = /^\/api\/workspaces\/([^/]+)\/members\/([^/]+)$/.exec(path)
    const workspaceId = match === null ? null : safeDecode(match[1]!)
    const accountId = match === null ? null : safeDecode(match[2]!)
    if (workspaceId === null || workspaceId === '' || accountId === null || accountId === '') {
      sendError(res, 404, 'not_found', 'malformed workspace member path')
      return
    }
    if (method === 'PATCH') {
      await handleSetWorkspaceMemberRole(ctx, req, res, workspaceId, accountId)
      return
    }
    await handleRemoveWorkspaceMember(ctx, req, res, workspaceId, accountId)
    return
  }

  if (path === '/api/rooms') {
    if (method === 'GET') {
      await handleListRooms(ctx as RoomRouteContext, req, res, url)
      return
    }
    if (method === 'POST') {
      await handleCreateRoomExtended(ctx, req, res)
      return
    }
    notFound(req, res, method, path)
    return
  }

  if (/^\/api\/rooms\/[^/]+$/.test(path)) {
    if (method === 'GET') {
      await handleGetRoom(ctx, req, res, url)
      return
    }
    if (method === 'PATCH') {
      await handlePatchRoom(ctx, req, res, url)
      return
    }
    if (method === 'DELETE') {
      await handleDeleteRoom(ctx, req, res, url)
      return
    }
    notFound(req, res, method, path)
    return
  }

  if (/^\/api\/rooms\/[^/]+\/members$/.test(path)) {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleAddRoomMembers(ctx, req, res, url)
    return
  }

  if (/^\/api\/rooms\/[^/]+\/members\/[^/]+$/.test(path)) {
    if (method !== 'DELETE') {
      notFound(req, res, method, path)
      return
    }
    await handleRemoveRoomMember(ctx, req, res, url)
    return
  }

  if (/^\/api\/rooms\/[^/]+\/messages$/.test(path)) {
    if (method === 'GET') {
      await handleReadMessages(ctx as RoomRouteContext, req, res, url)
      return
    }
    if (method === 'POST') {
      await handlePostMessage(ctx as RoomRouteContext, req, res, url)
      return
    }
    notFound(req, res, method, path)
    return
  }

  if (/^\/api\/rooms\/[^/]+\/stream$/.test(path)) {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleStream(ctx as RoomRouteContext, req, res, url)
    return
  }

  if (path === '/api/internal/rooms') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleInternalRooms(ctx as RoomRouteContext, req, res, url)
    return
  }

  if (/^\/api\/rooms\/[^/]+\/turns\/[^/]+\/stop$/.test(path)) {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    const match = /^\/api\/rooms\/([^/]+)\/turns\/([^/]+)\/stop$/.exec(path)
    const roomId = match === null ? null : safeDecode(match[1]!)
    if (roomId === null) {
      sendError(res, 404, 'not_found', 'malformed room path')
      return
    }
    const auth = await authenticate(ctx, req)
    if (!auth.ok) {
      sendError(res, auth.status, auth.code, auth.message)
      return
    }
    if (ctx.rawStore === undefined) {
      sendError(res, 503, 'runtime.not_configured', 'round engine needs the SQLite store')
      return
    }
    try {
      const room = await ctx.store.getRoom({ accountId: auth.session.accountId, roomId })
      if (room === null) {
        sendError(res, 404, 'room_not_found', `unknown room ${roomId}`)
        return
      }
      const round = activeRound(ctx.rawStore, roomId)
      if (round === null) {
        sendError(res, 404, 'round.not_found', 'no running round')
        return
      }
      const speaking = round.slots.findIndex((slot) => slot.status === 'speaking')
      const waiting = round.slots.findIndex((slot) => slot.status === 'waiting')
      const slotIndex = speaking >= 0 ? speaking : waiting
      if (slotIndex < 0) {
        sendError(res, 409, 'round.conflict', 'round has no running slot to stop')
        return
      }
      setStopping(ctx.rawStore, round.id, slotIndex)
      sendJson(res, 202, { roundId: round.id, stopping: slotIndex })
    } catch (error) {
      sendError(res, 500, 'internal_error', error instanceof Error ? error.message : String(error))
    }
    return
  }

  if (path === '/api/internal/bot-rooms') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleBotCreateRoom(ctx as RoomRouteContext, req, res)
    return
  }

  // 沙箱启动前拉 profile 锁（TODO 4.3.4；plugin-marketplace.md §6）。
  if (path === '/api/internal/plugins/sync') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handlePluginsSync(ctx as RoomRouteContext, req, res)
    return
  }

  // 插件市场：目录 / 详情 / 预检 / 安装（plugin-marketplace.md §6；M5-5.1）。
  if (path === '/api/marketplace/plugins') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleListMarketplacePlugins(ctx, req, res, url)
    return
  }

  if (/^\/api\/marketplace\/plugins\/[^/]+\/versions$/.test(path)) {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleListMarketplaceVersions(ctx, req, res, url)
    return
  }

  if (/^\/api\/marketplace\/plugins\/[^/]+\/preflight$/.test(path)) {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleMarketplacePreflight(ctx, req, res, url)
    return
  }

  if (/^\/api\/marketplace\/plugins\/[^/]+\/install$/.test(path)) {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleMarketplaceInstall(ctx, req, res, url)
    return
  }

  if (/^\/api\/marketplace\/plugins\/[^/]+$/.test(path)) {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleGetMarketplacePlugin(ctx, req, res, url)
    return
  }

  if (path === '/api/plugin-installs') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleListPluginInstalls(ctx, req, res, url)
    return
  }

  if (/^\/api\/plugin-installs\/[^/]+$/.test(path)) {
    if (method === 'PATCH') {
      await handlePatchPluginInstall(ctx, req, res, url)
      return
    }
    if (method === 'DELETE') {
      await handleDeletePluginInstall(ctx, req, res, url)
      return
    }
    notFound(req, res, method, path)
    return
  }

  if (path === '/api/approvals') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleListApprovals(ctx as RoomRouteContext, req, res)
    return
  }

  if (/^\/api\/approvals\/[^/]+$/.test(path)) {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleDecideApproval(ctx as RoomRouteContext, req, res, url)
    return
  }

  // 预算：控制面预留-结算与用量（budget.md §6）。
  if (path === '/api/internal/budget/reserve') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleInternalBudgetReserve(ctx, req, res)
    return
  }

  if (path === '/api/internal/budget/settle') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleInternalBudgetSettle(ctx, req, res)
    return
  }

  if (path === '/api/internal/usage') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleInternalUsage(ctx, req, res)
    return
  }

  if (path === '/api/quotas') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleListQuotas(ctx, req, res, url)
    return
  }

  if (/^\/api\/quotas\/[^/]+$/.test(path)) {
    if (method !== 'PATCH') {
      notFound(req, res, method, path)
      return
    }
    await handlePatchQuota(ctx, req, res, url)
    return
  }

  if (path === '/api/usage') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleGetUsage(ctx, req, res, url)
    return
  }

  // 控制面调度：schedule CRUD、立即触发、run 查询/停止与内部 tick（scheduling.md §4–§10）。
  const schedulesCollection = /^\/api\/workspaces\/([^/]+)\/schedules$/.exec(path)
  if (schedulesCollection !== null) {
    const workspaceId = decodeSegment(schedulesCollection[1]!)
    if (workspaceId === null) {
      sendError(res, 404, 'not_found', 'malformed workspace path')
      return
    }
    if (method === 'GET') {
      await handleListSchedules(ctx, req, res, workspaceId)
      return
    }
    if (method === 'POST') {
      await handleCreateSchedule(ctx, req, res, workspaceId)
      return
    }
    notFound(req, res, method, path)
    return
  }

  const scheduleRunPath = /^\/api\/schedules\/([^/]+)\/run$/.exec(path)
  if (scheduleRunPath !== null) {
    const scheduleId = decodeSegment(scheduleRunPath[1]!)
    if (scheduleId === null) {
      sendError(res, 404, 'not_found', 'malformed schedule path')
      return
    }
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleRunScheduleNow(ctx, req, res, scheduleId)
    return
  }

  const schedulePath = /^\/api\/schedules\/([^/]+)$/.exec(path)
  if (schedulePath !== null) {
    const scheduleId = decodeSegment(schedulePath[1]!)
    if (scheduleId === null) {
      sendError(res, 404, 'not_found', 'malformed schedule path')
      return
    }
    if (method === 'PATCH') {
      await handlePatchSchedule(ctx, req, res, scheduleId)
      return
    }
    if (method === 'DELETE') {
      await handleDeleteSchedule(ctx, req, res, scheduleId)
      return
    }
    notFound(req, res, method, path)
    return
  }

  if (path === '/api/runs') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleListRuns(ctx, req, res, url)
    return
  }

  const runStopPath = /^\/api\/runs\/([^/]+)\/stop$/.exec(path)
  if (runStopPath !== null) {
    const runId = decodeSegment(runStopPath[1]!)
    if (runId === null) {
      sendError(res, 404, 'not_found', 'malformed run path')
      return
    }
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleStopRun(ctx, req, res, runId)
    return
  }

  if (path === '/api/internal/scheduler/tick') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleInternalSchedulerTick(ctx, req, res)
    return
  }

  // 运行时审批申请：沙箱里的工具执行前调用，命中长期授权直接放行。
  if (path === '/api/internal/approvals') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleInternalCreateApproval(ctx as RoomRouteContext, req, res)
    return
  }

  if (/^\/api\/internal\/approvals\/[^/]+$/.test(path)) {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleInternalGetApproval(ctx as RoomRouteContext, req, res, url)
    return
  }

  // 长期授权：设置里显式打开；决策接口不会隐式创建。
  if (path === '/api/approval-grants') {
    if (method === 'GET') {
      await handleListApprovalGrants(ctx as RoomRouteContext, req, res, url)
      return
    }
    if (method === 'POST') {
      await handleCreateApprovalGrant(ctx as RoomRouteContext, req, res)
      return
    }
    notFound(req, res, method, path)
    return
  }

  if (/^\/api\/approval-grants\/[^/]+$/.test(path)) {
    if (method !== 'DELETE') {
      notFound(req, res, method, path)
      return
    }
    await handleRevokeApprovalGrant(ctx as RoomRouteContext, req, res, url)
    return
  }

  if (/^\/api\/internal\/rooms\/[^/]+\/assignments$/.test(path)) {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    if (ctx.rawStore === undefined) {
      sendError(res, 503, 'runtime.not_configured', 'round engine needs the SQLite store')
      return
    }
    const match = /^\/api\/internal\/rooms\/([^/]+)\/assignments$/.exec(path)
    const roomId = match === null ? null : safeDecode(match[1]!)
    if (roomId === null) {
      sendError(res, 404, 'not_found', 'malformed room path')
      return
    }
    await handleInternalAssignments({ store: ctx.rawStore, runtimeToken: ctx.runtimeToken, ...(ctx.now === undefined ? {} : { now: ctx.now }) }, req, res, roomId)
    return
  }

  if (/^\/api\/internal\/rooms\/[^/]+\/round$/.test(path)) {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    if (ctx.rawStore === undefined) {
      sendError(res, 503, 'runtime.not_configured', 'round engine needs the SQLite store')
      return
    }
    const match = /^\/api\/internal\/rooms\/([^/]+)\/round$/.exec(path)
    const roomId = match === null ? null : safeDecode(match[1]!)
    if (roomId === null) {
      sendError(res, 404, 'not_found', 'malformed room path')
      return
    }
    await handleInternalRound({ store: ctx.rawStore, runtimeToken: ctx.runtimeToken }, req, res, roomId)
    return
  }

  if (/^\/api\/internal\/rounds\/[^/]+\/advance$/.test(path)) {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    if (ctx.rawStore === undefined) {
      sendError(res, 503, 'runtime.not_configured', 'round engine needs the SQLite store')
      return
    }
    const match = /^\/api\/internal\/rounds\/([^/]+)\/advance$/.exec(path)
    const roundId = match === null ? null : safeDecode(match[1]!)
    if (roundId === null) {
      sendError(res, 404, 'not_found', 'malformed round path')
      return
    }
    await handleInternalAdvance({ store: ctx.rawStore, runtimeToken: ctx.runtimeToken, ...(ctx.now === undefined ? {} : { now: ctx.now }) }, req, res, roundId)
    return
  }

  if (/^\/api\/workspaces\/[^/]+\/(start|runtime)$/.test(path)) {
    const match = /^\/api\/workspaces\/([^/]+)\/(start|runtime)$/.exec(path)
    const workspaceId = match === null ? null : safeDecode(match[1]!)
    const action = match?.[2]
    if (workspaceId === null || action === undefined) {
      sendError(res, 404, 'not_found', 'malformed workspace path')
      return
    }
    if (action === 'start' && method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    if (action === 'runtime' && method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    const auth = await authenticate(ctx, req)
    if (!auth.ok) {
      sendError(res, auth.status, auth.code, auth.message)
      return
    }
    const workspaces = await ctx.store.listWorkspaces({ accountId: auth.session.accountId })
    if (!workspaces.some((workspace) => workspace.id === workspaceId)) {
      sendError(res, 404, 'not_found', 'unknown workspace')
      return
    }
    if (action === 'runtime') {
      if (ctx.rawStore === undefined) {
        sendError(res, 503, 'runtime.not_configured', 'runtime state needs the SQLite store')
        return
      }
      const runtime = await readWorkspaceRuntime(ctx.rawStore, workspaceId, ctx.runtimeManager)
      sendJson(res, 200, { runtime })
      return
    }
    if (ctx.rawStore === undefined || ctx.runtimeManager === undefined) {
      sendError(res, 503, 'runtime.not_configured', 'no runtime manager configured')
      return
    }
    try {
      const result = await startWorkspaceRuntime(ctx.rawStore, workspaceId, ctx.runtimeManager)
      sendJson(res, result.created ? 201 : 200, { runtime: result.runtime })
    } catch (error) {
      sendError(res, 502, 'runtime.start_failed', error instanceof Error ? error.message : String(error))
    }
    return
  }

  if (/^\/api\/internal\/rooms\/[^/]+\/messages$/.test(path)) {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleInternalMessages(ctx as RoomRouteContext, req, res, url)
    return
  }

  if (/^\/api\/rooms\/[^/]+\/say$/.test(path)) {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleSay(ctx as RoomRouteContext, req, res, url)
    return
  }

  // ---- 附件与产物（docs/design/artifacts.md §5）-------------------------------
  if (path === '/api/attachments') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleUploadAttachment(ctx, req, res)
    return
  }

  if (/^\/api\/attachments\/[^/]+$/.test(path)) {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    const match = /^\/api\/attachments\/([^/]+)$/.exec(path)
    const id = match === null ? null : safeDecode(match[1]!)
    if (id === null) {
      sendError(res, 404, 'not_found', 'malformed attachment path')
      return
    }
    await handleServeSignedAttachment(ctx, req, res, url, id)
    return
  }

  if (/^\/api\/messages\/[^/]+\/files\/[^/]+$/.test(path)) {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    const match = /^\/api\/messages\/([^/]+)\/files\/([^/]+)$/.exec(path)
    if (match === null) {
      sendError(res, 404, 'not_found', 'malformed message file path')
      return
    }
    await handleServeMessageFile(ctx, req, res, url, match[1]!, match[2]!)
    return
  }

  if (path === '/api/internal/artifacts') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleInternalArtifactUpload(ctx, req, res)
    return
  }

  if (path === '/api/internal/attachments/gc') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleInternalAttachmentGc(ctx, req, res)
    return
  }

  if (path === '/api/bots') {
    if (method === 'GET') {
      await handleListBots(ctx, req, res, url)
      return
    }
    if (method === 'POST') {
      await handleCreateBot(ctx, req, res)
      return
    }
    notFound(req, res, method, path)
    return
  }

  if (/^\/api\/bots\/[^/]+\/restore$/.test(path)) {
    if (method === 'POST') {
      await handleRestoreBot(ctx, req, res, url)
      return
    }
    notFound(req, res, method, path)
    return
  }

  if (/^\/api\/bots\/[^/]+$/.test(path)) {
    if (method === 'GET') {
      await handleGetBot(ctx, req, res, url)
      return
    }
    if (method === 'PATCH') {
      await handlePatchBot(ctx, req, res, url)
      return
    }
    if (method === 'DELETE') {
      await handleDeleteBot(ctx, req, res, url)
      return
    }
    notFound(req, res, method, path)
    return
  }

  // 同源网页：GET 未命中 API 路由时，尝试 apps/web 里的静态文件。
  if ((method === 'GET' || method === 'HEAD') && (await serveStatic(res, path))) return

  notFound(req, res, method, path)
}

/** 返回未监听的 node:http Server；要直接起服务用 startServer()。 */
export function createServer(options: ServerOptions, sharedState?: ServerState): http.Server {
  const now: Clock = options.now ?? (() => Date.now())
  // 反代端口 0 表示随机端口，实际值要 listen 后写回 state；主控制面的 /api/config 从这里读。
  const state: ServerState = sharedState ?? { dshProxyPort: options.dshProxyPort }
  if (state.dshProxyPort === undefined) state.dshProxyPort = options.dshProxyPort
  const dsh: DshRouteContext = {
    store: options.store,
    now,
    dshWebPort: resolveDshWebPort(options.dshWebPort),
    // cookie 签名密钥与附件共用 ROOST_SIGNING_SECRET；都没配置则本进程随机（重启后旧 cookie 失效）。
    signingSecret:
      options.signingSecret ?? process.env.ROOST_SIGNING_SECRET ?? randomBytes(32).toString('hex'),
    ...(options.rawStore === undefined ? {} : { rawStore: options.rawStore }),
  }
  state.dsh = dsh
  const schedulerEnabled =
    (options.schedulerLoop === true || process.env.ROOST_SCHEDULER === '1') && options.rawStore !== undefined
  const ctx: RoomRouteContext = {
    store: options.store,
    now,
    startedAt: now(),
    claimFailures: [],
    sessionAccounts: new Set<string>(),
    streamPollMs: options.streamPollMs ?? 700,
    runtimeToken: options.runtimeToken ?? process.env.ROOST_RUNTIME_TOKEN,
    dsh,
    serverState: state,
    metrics: createMetrics(),
    rateLimiter: new TokenBucketLimiter(),
    schedulerEnabled,
    logSink: options.logSink ?? writeHttpLog,
    ...(options.rawStore === undefined ? {} : { rawStore: options.rawStore }),
    ...(options.runtimeManager === undefined ? {} : { runtimeManager: options.runtimeManager }),
    ...(options.rawStore === undefined
      ? {}
      : {
          attachments: createAttachmentsRuntime({
            rawStore: options.rawStore,
            now,
            ...(options.attachmentsDir === undefined ? {} : { root: options.attachmentsDir }),
            ...(options.signingSecret === undefined ? {} : { signingSecret: options.signingSecret }),
          }),
        })
  }

  const server = http.createServer((req, res) => {
    const requestId = resolveRequestId(req.headers['x-request-id'])
    res.setHeader('x-request-id', requestId)
    const startedAt = ctx.now()

    res.once('finish', () => {
      const status = res.statusCode
      const method = req.method ?? 'GET'
      const path = req.url ?? '/'
      const durationMs = Math.max(0, ctx.now() - startedAt)
      const entry = createHttpLogEntry({
        requestId,
        method,
        path,
        status,
        durationMs,
        ...(status >= 500 ? { msg: 'request failed' } : {})
      })
      // 日志失败不能影响已经发出的响应。
      try {
        ctx.logSink(entry)
      } catch {
        // 忽略日志出口异常。
      }
      ctx.metrics.record(method, path, status, durationMs)
    })

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

/**
 * 独立源监听（ADR 0004）：只接管 /w/:workspaceId/dsh/*，其余一律 JSON 404。
 * 不做主控制面的 Origin 校验——这个源只服务反代，鉴权仍由 cookie/Bearer 负责。
 */
function createDshProxyServer(ctx: DshRouteContext): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh-proxy.local')
    if (!isDshProxyPath(url.pathname)) {
      req.resume()
      sendError(res, 404, 'not_found', `no route for ${req.method ?? 'GET'} ${url.pathname}`)
      return
    }
    handleDshRequest(ctx, req, res, url).catch((err: unknown) => {
      console.error('roost api: dsh proxy request error', err)
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'internal error')
      else if (!res.writableEnded) res.destroy()
    })
  })
}

/** listen 并返回实际端口（port 0 时由内核分配）。 */
async function listenOn(server: http.Server, port: number, host: string): Promise<number> {
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
  return typeof address === 'object' && address !== null ? address.port : port
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err)
      else resolve()
    })
    // fetch/undici 会保持 keep-alive 连接；不主动清掉，close() 会等到超时。
    server.closeAllConnections()
  })
}

/** 起服务并等到 listening：默认 127.0.0.1，port 0 表示随机端口（测试用）。 */
export async function startServer(
  options: ServerOptions & { port?: number; host?: string }
): Promise<StartedServer> {
  const requestedProxyPort = options.dshProxyPort
  if (
    requestedProxyPort !== undefined &&
    (!Number.isInteger(requestedProxyPort) || requestedProxyPort < 0 || requestedProxyPort > 65535)
  ) {
    throw new Error(`dshProxyPort must be an integer between 0 and 65535, got ${requestedProxyPort}`)
  }

  const state: ServerState = { dshProxyPort: requestedProxyPort }
  const server = createServer(options, state)
  const port = options.port ?? DEFAULT_PORT
  const host = options.host ?? DEFAULT_HOST

  const boundPort = await listenOn(server, port, host)

  // 第二个监听端口：同 host、不同端口 = 独立 origin（cookie 不区分端口）。
  let dshProxyServer: http.Server | undefined
  let dshProxyUrl: string | undefined
  if (requestedProxyPort !== undefined) {
    const dsh = state.dsh
    if (dsh === undefined) throw new Error('dsh route context was not initialized')
    dshProxyServer = createDshProxyServer(dsh)
    try {
      const boundProxyPort = await listenOn(dshProxyServer, requestedProxyPort, host)
      state.dshProxyPort = boundProxyPort
      dshProxyUrl = `http://${host}:${boundProxyPort}`
    } catch (err) {
      // 主监听已经起来：失败时一起收掉，不留半启动状态。
      dshProxyServer.removeAllListeners()
      await closeServer(server).catch(() => {})
      throw err
    }
  }

  const schedulerEnabled = options.schedulerLoop === true || process.env.ROOST_SCHEDULER === '1'
  const stopScheduler =
    schedulerEnabled && options.rawStore !== undefined
      ? startSchedulerLoop({
          rawStore: options.rawStore,
          ...(options.now === undefined ? {} : { now: options.now }),
        })
      : null

  return {
    server,
    url: `http://${host}:${boundPort}`,
    ...(dshProxyUrl === undefined ? {} : { dshProxyUrl }),
    close: async () => {
      stopScheduler?.()
      const proxy = dshProxyServer
      await Promise.all([closeServer(server), ...(proxy === undefined ? [] : [closeServer(proxy)])])
    }
  }
}
