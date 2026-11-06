// 控制面最小 API：配对码 → 设备会话 → workspace 列表/创建。
// 设计见 docs/design/auth.md（§3 配对流程、§9 数据模型、§10 接口）与
// docs/design/workspace.md（§8 数据模型、§9 接口）。
//
// 约定：
// - 零依赖：只用 node:http 与 node:crypto；无构建，node --experimental-strip-types 直接跑。
// - 只依赖 port.ts 的 StorePort。真实存储在 packages/store，由 Lead 写适配器接进来。
// - 所有响应都是 JSON + cache-control: no-store；错误统一 { ok: false, error: { code, message: human } }。
// - 默认监听 127.0.0.1（回环）：这是本机控制面，不是公网入口。
//
// 安全边界：公网部署时由反向代理终止 TLS。反代必须覆盖 Host（`proxy_set_header Host $host`）
// 并设置 `X-Forwarded-Proto $scheme`（必要时也覆盖 `X-Forwarded-Host`）；同源 CSRF 判断
// 就建立在“Origin 与反代给出的 Host 完全一致”之上。控制面不得直接暴露公网，否则客户端
// 可以同时伪造 Origin、Host 与 X-Forwarded-* 绕过校验。
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
  handleInternalListBots,
  handleListApprovals,
} from './bot-rooms-routes.ts'
import {
  AUTH_LOGIN_ROUTES,
  oidcProviderFromEnv,
  type AuthRoutesContext,
  type OidcProvider,
} from './auth-login-routes.ts'
import {
  handleMarketplaceInstallStart,
  handlePluginInstallDisable,
  handlePluginInstallEnable,
  handlePluginInstallGet,
  handlePluginInstallList,
  handlePluginInstallRollback,
  handlePluginInstallSynced,
  handlePluginInstallUninstall,
  handlePluginInstallUpdate,
  onInstallApproved,
  type MarketplaceInstallRouteContext,
} from './marketplace-install-routes.ts'
import { getApproval } from '../../../packages/store/src/approvals.ts'
import { handleDeepHealth } from './health-deep.ts'
import { setProxyWorkspace } from '../../../packages/budget/src/proxy.ts'
import {
  DEFAULT_FREE_MODEL,
  handleDeleteModelSettings,
  handleGetModelSettings,
  handlePutModelSettings,
  handleTestModelSettings
} from './model-settings-routes.ts'
import type { ModelSettingsContext } from './model-settings-routes.ts'
import { readModelKeyMaster } from './model-key-crypto.ts'
import { resolveModelProxy } from './model-proxy-resolver.ts'
import { handleMemoryClaims, handleMemoryCleanup } from './memory-claims-routes.ts'
import { createModelProxy } from '../../../packages/budget/src/index.ts'
import type { ModelProxyHandler } from '../../../packages/budget/src/index.ts'
import { handleModelProxy, type ModelProxyRouteContext } from './model-proxy-routes.ts'
import { recordUsage } from '../../../packages/store/src/budget.ts'
import { metricsFromEvent } from '../../../packages/observability/src/index.ts'
import { readWorkspaceRoomEvents, setEventSink } from '../../../packages/store/src/events.ts'
import { appendRoomSignal, readRoomEvents } from '../../../packages/store/src/room-log.ts'
import type { Event } from '../../../packages/store/src/types.ts'
import { armRoomWait, publishFromStoredEvent, publishRoomWake } from './room-bus.ts'
import { encodeSseFrame, framesForRoomEvent, internalEventJson } from './room-stream.ts'
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
  handleInternalMeter,
  handleInternalUsage,
  handleListQuotas,
  handlePatchQuota,
} from './budget-routes.ts'
import {
  handleDeleteMemory,
  handleExportMemories,
  handleInternalRecordReads,
  handleInternalRetrieve,
  handleInternalWriteMemory,
  handleListMemories,
} from './memories-routes.ts'
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
  ensurePanelForward,
  resolvePanelPort,
  stopAllPanelForwards,
  stopPanelForward,
} from './panel-forward.ts'
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
  handleConnectorCallback,
  handleConnectorConnect,
  handleDeleteConnector,
  handleInternalConnectorCall,
  handleListConnectorGrants,
  handleListConnectors,
  handlePutConnectorGrant,
} from './connectors-routes.ts'
import { createGatewayBackend } from '../../../packages/connectors/src/index.ts'
import type { GatewayBackend } from '../../../packages/connectors/src/index.ts'
import {
  createAttachmentsRuntime,
  handleInternalArtifactUpload,
  handleInternalAttachmentGc,
  handleServeMessageFile,
  handleServeSignedAttachment,
  handlePostRoomArtifact,
  handleUploadAttachment,
} from './attachments-routes.ts'
import type { AttachmentsRuntime } from './attachments-routes.ts'
import { openRoundForMessage } from './round-orchestrator.ts'
import { answerChoiceCard, decorateParts, parseCard, postCard, projectApprovalDecision } from './cards.ts'
import { activeRound, setStopping } from '../../../packages/store/src/rounds.ts'
import { findExhaustedWorkspaceQuota } from '../../../packages/store/src/budget.ts'
import { handleInternalAdvance, handleInternalAssignments, handleInternalRound } from './rounds-http.ts'
import { readWorkspaceRuntime, startWorkspaceRuntime } from './workspace-runtime.ts'
import type { RuntimeManager } from './workspace-runtime.ts'
import { authorizeRuntimeHttp, ensureRuntimeWorkspace } from './runtime-auth.ts'
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
import { getArtifact, linkArtifact, listMessageAttachments } from '../../../packages/store/src/attachments.ts'
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

/** 面板端口转发：workspace → 本机端口（openshell forward）。 */
export interface PanelForwardHooks {
  ensure(workspaceId: string, options: { sandboxName: string }): Promise<{ port: number; url: string }>
  resolvePort(workspaceId: string): number | undefined
  stop(workspaceId: string): Promise<boolean>
  stopAll(): Promise<void>
}

export function defaultPanelForwardHooks(): PanelForwardHooks {
  return {
    ensure: (workspaceId, options) => ensurePanelForward(workspaceId, { sandboxName: options.sandboxName }),
    resolvePort: resolvePanelPort,
    stop: (workspaceId) => stopPanelForward(workspaceId),
    stopAll: stopAllPanelForwards
  }
}

export interface ServerOptions {
  /**
   * 没有总线唤醒时，SSE / 长轮询最多再等多久（毫秒）。
   * 写路径会立刻唤醒，这只是漏报兜底。默认 15s；测试里调小。
   */
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
  /** 面板端口转发的可注入钩子（测试用）；默认走 panel-forward.ts 的 openshell submit。 */
  panelForward?: PanelForwardHooks
  /** 发信口（测试注入）；不传时验证/重置 token 写 stdout。 */
  authMailer?: import('./auth-login-routes.ts').Mailer
  /** OIDC provider 注入（测试用）；不传时从 ROOST_OIDC_* 环境变量拼。 */
  oidc?: import('./auth-login-routes.ts').OidcConfig
  authSessionTtlMs?: number
  /** 模型代理（测试注入）；不传时按 ROOST_MODEL_* / DEEPSEEK_* 构造。 */
  modelProxy?: ModelProxyHandler
  /** BYO 模型 Key 加密主密钥；不传时读 ROOST_MODEL_KEY_SECRET。测试可注入固定 key。 */
  modelKeyMaster?: Buffer | null
  /** 免费额度使用的模型；默认 ROOST_FREE_MODEL 或 deepseek-flash。 */
  freeModel?: string
  /** 测试连接的上游 fetch（测试注入）。 */
  modelTestFetch?: typeof fetch
  /** 事件出口（宿主空闲睡眠/外部审计用）；与指标 sink 并行调用。 */
  onEvent?: (event: unknown) => void
  /** workspace 启动成功（运行时就绪）后的回调。 */
  onWorkspaceStarted?: (info: { workspaceId: string; sandbox: string }) => void
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
  /**
   * 连接器网关后端；不配置时按 ROOST_CONNECTOR_BACKEND 选择（默认 StubGatewayBackend，
   * 未配 URL 的 openconnector/composio 也回退 Stub）。测试可注入 fake 覆盖。
   */
  connectorBackend?: GatewayBackend
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
  /** 连接器网关后端（默认 Stub）。 */
  connectorBackend: GatewayBackend
  /** 公网写操作 Origin 白名单（ROOST_ALLOWED_ORIGINS），启动时标准化。 */
  allowedOrigins: readonly string[]
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
  forbidden_origin: '写操作来源不被允许',
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

export interface OriginContext {
  /** 已标准化的公网 Origin 白名单（来自 ROOST_ALLOWED_ORIGINS）。 */
  allowedOrigins?: readonly string[]
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** 请求实际使用的 scheme：只认 X-Forwarded-Proto 的 http/https，其余一律按 http。 */
function requestScheme(req: Pick<IncomingMessage, 'headers'>): 'http' | 'https' {
  const raw = firstHeaderValue(req.headers['x-forwarded-proto'])
  const proto = raw?.split(',')[0]?.trim().toLowerCase()
  return proto === 'https' ? 'https' : 'http'
}

/** 把 Origin 标准化为 scheme://host[:port]；只接受纯 origin，拒绝路径、query、userinfo。 */
function normalizeOrigin(value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username !== '' || parsed.password !== '') return null
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return null
  // URL.origin 已经做小写 host、省略默认端口。
  return parsed.origin
}

/**
 * 解析 ROOST_ALLOWED_ORIGINS：逗号分隔的精确 origin。
 * 不接受 `*` 与 `null`（通配会直接废掉 CSRF 防护）。
 */
export function parseAllowedOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined) return []
  const result: string[] = []
  for (const part of raw.split(',')) {
    const candidate = part.trim()
    if (candidate === '' || candidate === '*' || candidate.toLowerCase() === 'null') continue
    const normalized = normalizeOrigin(candidate)
    if (normalized !== null) result.push(normalized)
  }
  return result
}

/** 规范化 Host 头：小写、去默认端口、保留 IPv6 方括号；非法值返回 null。 */
function normalizeHostHeader(host: string, scheme: 'http' | 'https'): string | null {
  const trimmed = host.trim().toLowerCase()
  if (trimmed === '') return null

  let hostname: string
  let port: string | undefined
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end < 0) return null
    hostname = trimmed.slice(0, end + 1)
    const rest = trimmed.slice(end + 1)
    if (rest !== '') {
      if (!/^:\d{1,5}$/.test(rest)) return null
      port = rest.slice(1)
    }
  } else {
    const index = trimmed.lastIndexOf(':')
    if (index >= 0) {
      hostname = trimmed.slice(0, index)
      port = trimmed.slice(index + 1)
    } else {
      hostname = trimmed
    }
  }
  if (hostname === '') return null
  if (port !== undefined) {
    const value = Number(port)
    if (!/^\d{1,5}$/.test(port) || value < 1 || value > 65535) return null
    if (value === (scheme === 'https' ? 443 : 80)) port = undefined
  }
  return port === undefined ? hostname : `${hostname}:${port}`
}

/** Origin 与请求自身的 scheme + Host（或 X-Forwarded-Host）完全一致。 */
function isSameOrigin(req: Pick<IncomingMessage, 'headers'>, origin: URL): boolean {
  const scheme = requestScheme(req)
  if (origin.protocol !== `${scheme}:`) return false
  const hostHeader = firstHeaderValue(req.headers['x-forwarded-host']) ?? req.headers.host
  if (hostHeader === undefined) return false
  const normalizedHost = normalizeHostHeader(hostHeader, scheme)
  return normalizedHost !== null && origin.host === normalizedHost
}

/**
 * 写操作 Origin 校验（CSRF）：
 * - 没有 Origin（非浏览器客户端）放行；
 * - `Origin: null` 拒绝；
 * - 回环 Origin 放行；
 * - 同源（Origin 与 X-Forwarded-Proto + Host 一致）放行；
 * - 命中 ROOST_ALLOWED_ORIGINS 精确白名单放行。
 */
export function isAllowedOrigin(
  req: Pick<IncomingMessage, 'headers'>,
  ctx?: OriginContext
): boolean {
  const origin = firstHeaderValue(req.headers.origin)
  if (origin === undefined || origin === '') return true
  if (origin.trim().toLowerCase() === 'null') return false

  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (LOOPBACK_HOSTS.has(parsed.hostname)) return true
  if (isSameOrigin(req, parsed)) return true

  const allowed = ctx?.allowedOrigins ?? parseAllowedOrigins(process.env.ROOST_ALLOWED_ORIGINS)
  const normalized = normalizeOrigin(origin)
  return normalized !== null && allowed.includes(normalized)
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

export type AuthResult =
  | { ok: true; session: SessionRecord; via?: 'bearer' | 'cookie' }
  | { ok: false; status: number; code: string; message: string }

/** 读一个 cookie；同名只取第一个。 */
export function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie
  if (typeof header !== 'string' || header === '') return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    return part.slice(index + 1).trim()
  }
  return null
}

/** Bearer 优先；否则回退到登录下发的 roost_session cookie（wave1 §A/§D）。 */
function requestSessionToken(req: IncomingMessage): { token: string; via: 'bearer' | 'cookie' } | null {
  const header = req.headers.authorization
  if (typeof header === 'string' && header.trim() !== '') {
    const match = /^Bearer[ ]+(\S+)$/.exec(header.trim())
    if (match === null) return null
    return { token: match[1]!, via: 'bearer' }
  }
  const cookie = readCookie(req, 'roost_session')
  return cookie === null || cookie === '' ? null : { token: cookie, via: 'cookie' }
}

function hasBearer(req: IncomingMessage): boolean {
  const header = req.headers.authorization
  return typeof header === 'string' && /^Bearer[ ]+\S+$/.test(header.trim())
}

/** OIDC provider 从环境变量拼；没有配置时返回 null（前端隐藏按钮）。 */
function buildOidcConfig(): Record<string, OidcProvider> | null {
  const out: Record<string, OidcProvider> = {}
  for (const name of ['google', 'github']) {
    const provider = oidcProviderFromEnv(name)
    if (provider !== null) out[name] = provider
  }
  return Object.keys(out).length === 0 ? null : out
}

function cookieCsrfInvalid(req: IncomingMessage): boolean {
  const cookie = readCookie(req, 'roost_csrf')
  const header = req.headers['x-csrf-token']
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value !== 'string' || value === '') return true
  if (cookie === null || cookie === '') return true
  return cookie !== value
}

function authFailure(message: string, code = 'unauthenticated'): AuthResult {
  return { ok: false, status: 401, code, message }
}

const BEARER_HEADER = 'Authorization: Bearer <sessionToken> is required'

/** 校验 Bearer token：只做一次 sha256，然后按 hash 查库。 */
export async function authenticate(ctx: AuthContext, req: IncomingMessage): Promise<AuthResult> {
  const resolved = requestSessionToken(req)
  if (resolved === null) {
    return authFailure(
      typeof req.headers.authorization === 'string'
        ? 'Authorization header must be "Bearer <sessionToken>"'
        : BEARER_HEADER
    )
  }

  const { token, via } = resolved
  if (!SESSION_TOKEN_PATTERN.test(token)) return authFailure('session token must be 64 lowercase hex characters')

  const session = await ctx.store.findSessionByToken(hashSessionToken(token))
  if (session === null) return authFailure('unknown session token')
  if (session.revokedAt !== undefined) return authFailure('session revoked', 'session_revoked')
  if (session.expiresAt <= ctx.now()) return authFailure('session expired; pair this device again', 'session_expired')

  return { ok: true, session: renewSession(ctx, session), via }
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
 * GET /api/config（无需鉴权）：告诉前端 DSH 面板的公开源地址。
 * 优先级：
 *   1. ROOST_DSH_PUBLIC_ORIGIN（完整 http/https origin，不带路径/query）；
 *   2. X-Forwarded-Proto（缺省 http）+ Host 主机名 + ROOST_DSH_PROXY_PUBLIC_PORT（缺省实际反代端口）；
 *   3. 未启用反代端口且没有 PUBLIC_ORIGIN 时返回 null。
 * https + 443 / http + 80 省略端口；Host 主机名不合法回退 127.0.0.1，避免把任意 Host 透出成 URL。
 */
function handleGetConfig(ctx: HandlerContext, req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, { dshBase: resolveDshBase(req, ctx.serverState) })
}

/** 解析公网端口环境变量：非法值按未配置处理。 */
function readPublicPort(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const trimmed = raw.trim()
  if (!/^\d{1,5}$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= 1 && value <= 65535 ? value : null
}

export function resolveDshBase(
  req: Pick<IncomingMessage, 'headers'>,
  state: Pick<ServerState, 'dshProxyPort'>
): string | null {
  const publicOrigin = normalizeOrigin(process.env.ROOST_DSH_PUBLIC_ORIGIN ?? '')
  if (publicOrigin !== null) return publicOrigin

  const actualPort = state.dshProxyPort
  if (actualPort === undefined || actualPort <= 0) return null

  const port = readPublicPort(process.env.ROOST_DSH_PROXY_PUBLIC_PORT) ?? actualPort
  const scheme = requestScheme(req)
  const hostname = hostnameFromHostHeader(firstHeaderValue(req.headers.host))
  const defaultPort = scheme === 'https' ? 443 : 80
  return port === defaultPort ? `${scheme}://${hostname}` : `${scheme}://${hostname}:${port}`
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
  authRoutes?: AuthRoutesContext
  installRoutes?: MarketplaceInstallRouteContext
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
    ...(message.parts === undefined ? {} : { parts: message.parts }),
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

/** `<img>` 不能带 Bearer。消息里的图片换成这么久的签名地址。 */
const MESSAGE_IMAGE_TTL_SECONDS = 120

/** 批量给消息挂上附件；只有 SQLite store 可用时才查（memory harness 不查）。 */
async function messagesJson(
  ctx: HandlerContext,
  messages: RoomMessageRecord[],
  roomId?: string,
): Promise<Record<string, unknown>[]> {
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
  const jsons = messages.map((message) => {
    const json = messageJson(message, grouped.get(message.seq) ?? [])
    if (roomId === undefined || ctx.rawStore === undefined || !Array.isArray(json.parts)) return json
    return { ...json, parts: decorateParts(ctx.rawStore, roomId, json.parts as never) }
  })
  await signMessageImages(ctx, jsons)
  return jsons
}

/**
 * 成员校验通过之后才签名。陌生人拿不到这条响应，也就拿不到 token。
 * 签名失败时保留原来的成员路径，不把整条消息打成 500。
 */
async function signMessageImages(ctx: HandlerContext, jsons: Record<string, unknown>[]): Promise<void> {
  const content = ctx.attachments?.content
  if (content === undefined) return
  const signed = new Map<string, string>()
  const urlFor = async (artifactId: string): Promise<string | null> => {
    const cached = signed.get(artifactId)
    if (cached !== undefined) return cached
    try {
      const url = await content.signRead(artifactId, MESSAGE_IMAGE_TTL_SECONDS)
      signed.set(artifactId, url)
      return url
    } catch (error) {
      console.error('roost api: failed to sign message image', error)
      return null
    }
  }
  for (const json of jsons) {
    if (Array.isArray(json.attachments)) {
      for (const item of json.attachments) {
        if (item === null || typeof item !== 'object') continue
        const artifactId = (item as { artifactId?: unknown }).artifactId
        if (typeof artifactId !== 'string' || artifactId === '') continue
        const url = await urlFor(artifactId)
        if (url !== null) (item as { url: string }).url = url
      }
    }
    if (!Array.isArray(json.parts)) continue
    const next = []
    for (const part of json.parts) {
      if (part === null || typeof part !== 'object') {
        next.push(part)
        continue
      }
      const image = part as { type?: unknown; artifactId?: unknown }
      if (image.type === 'image' && typeof image.artifactId === 'string' && image.artifactId !== '') {
        const url = await urlFor(image.artifactId)
        next.push(url === null ? part : { ...image, url })
      } else {
        next.push(part)
      }
    }
    json.parts = next
  }
}


/**
 * 房间接口的存储错误映射：不认识的房间/workspace 是 404（不是 500），
 * 权限不足是 403；其余一律 500，并把原始错误留在日志里。
 */

// ---- 服务端内部接口（runtime worker 专用，runtime token 鉴权）----------------
// 这不是给浏览器用的：worker 要能发现房间、按 seq 读、以 Bot 身份说话。
// 鉴权统一走 runtime-auth.ts：全局 token（管理员）或每 workspace 短期 token；
// workspace token 只能访问自己 workspace 的房间（见 handleInternal* 的归属校验）。

async function handleInternalRooms(ctx: RoomRouteContext, req: IncomingMessage, res: ServerResponse, url?: URL): Promise<void> {
  const auth = authorizeRuntimeHttp(ctx, req, res)
  if (auth === null) return
  try {
    // 一沙箱一 workspace：带 workspaceId 时只返回这个 workspace 的房间，避免串房间。
    const requested = url?.searchParams.get('workspaceId') ?? process.env.ROOST_WORKSPACE_ID ?? null
    if (auth.workspaceId !== null) {
      // workspace token：省略 workspaceId 时按自己的 workspace 处理；显式给了别的
      // workspaceId 一律 403，而不是静默返回空列表。
      if (!ensureRuntimeWorkspace(auth, requested ?? auth.workspaceId, res)) return
    }
    const effective = auth.workspaceId ?? requested
    const all = await ctx.store.listAllRooms()
    const filtered = effective === null ? all : all.filter((room) => room.workspaceId === effective)
    sendJson(res, 200, { rooms: filtered.map(roomJson) })
  } catch (err) {
    sendStoreFailure(res, err)
  }
}

async function handleInternalMessages(ctx: RoomRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const auth = authorizeRuntimeHttp(ctx, req, res)
  if (auth === null) return
  const roomId = internalRoomIdFromPath(url.pathname)
  if (roomId === null) return sendError(res, 404, 'not_found', 'malformed room path')
  if (auth.workspaceId !== null) {
    const roomWorkspace = await ctx.store.getRoomWorkspace(roomId).catch(() => null)
    if (!ensureRuntimeWorkspace(auth, roomWorkspace, res)) return
  }
  const afterRaw = url.searchParams.get('after')
  const afterSeq = afterRaw === null ? undefined : Number.parseInt(afterRaw, 10)
  if (afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
    return sendError(res, 400, 'invalid_body', 'after must be a non-negative integer seq')
  }
  try {
    if (afterSeq !== undefined) {
      // 增量路径（room-agent 轮询）不受裁剪影响：after 之后照单全收。
      // waitMs>0 且当前没有新消息时挂起，直到房间总线唤醒或超时（替代紧轮询）。
      const waitMs = readWaitMs(res, url)
      if (waitMs === null) return
      const messages = await waitForRoomLoad(req, roomId, waitMs, async () =>
        ctx.store.readMessagesInternal({ roomId, afterSeq }),
      )
      if (res.writableEnded || req.destroyed) return
      sendJson(res, 200, { messages: await messagesJson(ctx, messages) })
      return
    }
    // 首看/向前翻页走裁剪投影（rooms.md §3：保留 60、首看 12）。
    const query = readLogQuery(res, url)
    if (query === null) return
    const page = await ctx.store.readRoomLogInternal({ roomId, ...query })
    sendJson(res, 200, { messages: await messagesJson(ctx, page.messages), page: logPageJson(page) })
  } catch (err) {
    sendStoreFailure(res, err)
  }
}

async function handleSay(ctx: RoomRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const auth = authorizeRuntimeHttp(ctx, req, res)
  if (auth === null) return
  const roomId = roomIdFromPath(url.pathname)
  if (roomId === null) return sendError(res, 404, 'not_found', 'malformed room path')
  if (auth.workspaceId !== null) {
    const roomWorkspace = await ctx.store.getRoomWorkspace(roomId).catch(() => null)
    if (!ensureRuntimeWorkspace(auth, roomWorkspace, res)) return
  }
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  const body = parsed.value as Record<string, unknown>
  const botId = typeof body.botId === 'string' ? body.botId.trim() : ''
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (botId === '' || botId.length > 64) {
    return sendError(res, 400, 'invalid_body', 'body.botId must be 1..64 characters')
  }
  if (text.length > 8000) {
    return sendError(res, 400, 'invalid_body', 'body.text must be at most 8000 characters')
  }
  if (body.card !== undefined) {
    if (ctx.rawStore === undefined) {
      return sendError(res, 503, 'runtime.not_configured', 'cards need the SQLite store')
    }
    let card
    try {
      card = parseCard(body.card)
    } catch (error) {
      return sendError(res, 400, 'invalid_body', error instanceof Error ? error.message : 'invalid card')
    }
    try {
      const posted = postCard({ store: ctx.rawStore, roomId, botId, text, card })
      const [postedJson] = await messagesJson(ctx, [messageRecordFromRoom(posted.message)], roomId)
      sendJson(res, 201, {
        message: postedJson,
        cardId: posted.cardId,
        ...(posted.approvalId === undefined ? {} : { approvalId: posted.approvalId }),
        round: posted.round,
      })
    } catch (err) {
      sendStoreFailure(res, err)
    }
    return
  }
  if (text === '') {
    return sendError(res, 400, 'invalid_body', 'body.text must be 1..8000 characters')
  }
  const idem = typeof body.idem === 'string' && body.idem !== '' ? body.idem : undefined
  try {
    const message = await ctx.store.postBotMessage({ roomId, botId, text, ...(idem === undefined ? {} : { idem }) })
    const [postedJson] = await messagesJson(ctx, [message], roomId)
    sendJson(res, 201, { message: postedJson })
  } catch (err) {
    sendStoreFailure(res, err)
  }
}

function messageRecordFromRoom(message: { seq: number; at: string; actor: { kind: string; id: string } | null; text: string; parts?: RoomMessageRecord['parts'] }): RoomMessageRecord {
  const kind = message.actor?.kind
  const actorKind = kind === 'user' || kind === 'bot' || kind === 'system' || kind === 'control-plane' ? kind : 'system'
  return {
    seq: message.seq,
    at: message.at,
    actorKind,
    actorId: message.actor?.id ?? 'unknown',
    text: message.text,
    ...(message.parts === undefined ? {} : { parts: message.parts }),
  }
}

function sendStoreFailure(res: ServerResponse, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  if (/unknown room/i.test(message)) {
    sendError(res, 404, 'room_not_found', message)
    return
  }
  if (/unknown card/i.test(message)) {
    sendError(res, 404, 'card.not_found', message)
    return
  }
  if (/unknown option|card\.|choice card|approval card/i.test(message)) {
    sendError(res, 400, 'invalid_body', message)
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
      sendJson(res, 200, { messages: await messagesJson(ctx, messages, roomId) })
      return
    }
    // 首看给最近 12 条；before 游标向前翻，最多翻到最近 60 条（rooms.md §3）。
    const query = readLogQuery(res, url)
    if (query === null) return
    const page = await ctx.store.readRoomLog({ accountId: auth.session.accountId, roomId, ...query })
    sendJson(res, 200, { messages: await messagesJson(ctx, page.messages, roomId), page: logPageJson(page) })
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

async function handleAnswerCard(ctx: RoomRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message)
  if (ctx.rawStore === undefined) {
    return sendError(res, 503, 'runtime.not_configured', 'cards need the SQLite store')
  }
  const match = /^\/api\/rooms\/([^/]+)\/cards\/([^/]+)\/answer$/.exec(url.pathname)
  const roomId = match === null ? null : safeDecode(match[1]!)
  const cardId = match === null ? null : safeDecode(match[2]!)
  if (roomId === null || roomId === '' || cardId === null || cardId === '') {
    return sendError(res, 404, 'not_found', 'malformed card path')
  }
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  const body = parsed.value as Record<string, unknown>
  const optionId = typeof body.optionId === 'string' ? body.optionId.trim() : ''
  if (optionId === '') return sendError(res, 400, 'invalid_body', 'body.optionId is required')
  const workspaceId = workspaceIdForRoom(ctx, roomId)
  if (workspaceId !== null) {
    const gate = requireWorkspaceRole(ctx, workspaceId, auth.session.accountId, ['owner', 'admin', 'member'])
    if (!gate.ok) return sendError(res, gate.status, gate.code, gate.message)
  }
  try {
    await ctx.store.readMessages({ accountId: auth.session.accountId, roomId, limit: 1 })
    const result = answerChoiceCard({
      store: ctx.rawStore,
      roomId,
      cardId,
      optionId,
      accountId: auth.session.accountId,
      at: ctx.now(),
    })
    const [answeredJson] = await messagesJson(ctx, [messageRecordFromRoom(result.message)], roomId)
    sendJson(res, 200, {
      optionId: result.optionId,
      label: result.label,
      alreadyAnswered: result.alreadyAnswered,
      message: answeredJson,
      round: result.round,
    })
  } catch (err) {
    sendStoreFailure(res, err)
  }
}

async function handlePostMessage(ctx: RoomRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message)
  if (!enforceRateLimit(ctx, res, 'messages', auth.session.accountId)) return
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  const body = parsed.value as Record<string, unknown>
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  const artifactIds = parseArtifactIds(body.artifactIds)
  if (artifactIds === null) {
    return sendError(res, 400, 'invalid_body', 'body.artifactIds must be an array of artifact ids')
  }
  if ((text === '' && artifactIds.length === 0) || text.length > 8000) {
    return sendError(res, 400, 'invalid_body', 'body.text must be 1..8000 characters, or attach an image')
  }
  if (artifactIds.length > 0 && ctx.rawStore === undefined) {
    return sendError(res, 503, 'runtime.not_configured', 'image messages need the SQLite store')
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

  if (artifactIds.length > 0 && ctx.rawStore !== undefined) {
    for (const artifactId of artifactIds) {
      const artifact = getArtifact(ctx.rawStore, artifactId)
      if (artifact === null || (workspaceId !== null && artifact.workspaceId !== workspaceId)) {
        return sendError(res, 400, 'invalid_body', `unknown artifact ${artifactId}`)
      }
    }
  }

  const parts =
    artifactIds.length === 0
      ? undefined
      : [
          ...(text === '' ? [] : [{ type: 'text', text }]),
          ...artifactIds.map((artifactId) => ({ type: 'image', artifactId })),
        ]

  try {
    const message = await ctx.store.postMessage({
      accountId: auth.session.accountId,
      roomId,
      text,
      ...(parts === undefined ? {} : { parts }),
      ...(idem === undefined ? {} : { idem })
    })
    if (ctx.rawStore !== undefined && artifactIds.length > 0) {
      artifactIds.forEach((artifactId, position) => linkArtifact(ctx.rawStore!, message.seq, artifactId, position))
    }
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
    const [postedJson] = await messagesJson(ctx, [message], roomId)
    sendJson(res, 201, { message: postedJson })
  } catch (err) {
    sendStoreFailure(res, err)
  }
}

function parseArtifactIds(value: unknown): string[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 8) return null
  const ids: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !/^[0-9a-f]{32}$/.test(item)) return null
    ids.push(item)
  }
  return ids
}

/** `waitMs` 查询参数。省略 = 0（不等）。非法时已经写了 400，返回 null。 */
function readWaitMs(res: ServerResponse, url: URL): number | null {
  const raw = url.searchParams.get('waitMs')
  if (raw === null || raw === '') return 0
  const waitMs = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 25_000) {
    sendError(res, 400, 'invalid_body', 'waitMs must be an integer from 0 to 25000')
    return null
  }
  return waitMs
}

/**
 * 先挂上监听再读，避免「读完到开始等」之间漏掉一次写入。
 * 空结果且 waitMs>0 时挂起，醒来再读一次。
 */
async function waitForRoomLoad<T>(
  req: IncomingMessage,
  roomId: string | null,
  waitMs: number,
  load: () => Promise<T>,
  isEmpty: (value: T) => boolean = (value) => Array.isArray(value) && value.length === 0,
): Promise<T> {
  const waiter = armRoomWait(roomId)
  const abort = new AbortController()
  const onClose = (): void => abort.abort()
  req.on('close', onClose)
  try {
    let value = await load()
    if (isEmpty(value) && waitMs > 0 && abort.signal.aborted !== true) {
      await waiter.wait(waitMs, abort.signal)
      if (abort.signal.aborted !== true && !req.destroyed) value = await load()
    }
    return value
  } finally {
    waiter.cancel()
    req.off('close', onClose)
  }
}

function messageRecordFromEvent(event: Event): RoomMessageRecord {
  const kind = event.actor?.kind
  const actorKind =
    kind === 'user' || kind === 'bot' || kind === 'system' || kind === 'control-plane' ? kind : 'system'
  const text = typeof event.payload.text === 'string' ? event.payload.text : ''
  return { seq: event.seq, at: event.at, actorKind, actorId: event.actor?.id ?? 'unknown', text }
}

/**
 * 把 afterSeq 之后的房间事件写成 SSE 帧。返回写出的事件条数（不是帧数）。
 * 成员校验走 readMessages：没权限或房间没了会抛，调用方结束流。
 */
async function writeRoomStream(
  ctx: RoomRouteContext,
  res: ServerResponse,
  input: { accountId: string; roomId: string; afterSeq: number },
): Promise<{ count: number; lastSeq: number }> {
  if (ctx.rawStore === undefined) {
    const batch = await ctx.store.readMessages({
      accountId: input.accountId,
      roomId: input.roomId,
      afterSeq: input.afterSeq,
      limit: 200,
    })
    const batchJson = await messagesJson(ctx, batch, input.roomId)
    let lastSeq = input.afterSeq
    for (let index = 0; index < batch.length; index += 1) {
      const message = batch[index]!
      lastSeq = message.seq
      res.write(`id: ${message.seq}\nevent: message\ndata: ${JSON.stringify(batchJson[index])}\n\n`)
    }
    if (batch.length > 0) res.write(`event: cursor\ndata: ${JSON.stringify({ seq: lastSeq })}\n\n`)
    return { count: batch.length, lastSeq }
  }

  // 先做一次成员校验（读 1 条即可）。真正的帧从房间日志拼，这样 round/speaking 和消息按 seq 交错。
  await ctx.store.readMessages({
    accountId: input.accountId,
    roomId: input.roomId,
    afterSeq: input.afterSeq,
    limit: 1,
  })
  const events = readRoomEvents(ctx.rawStore, { roomId: input.roomId, afterSeq: input.afterSeq, limit: 200 })
  if (events.length === 0) return { count: 0, lastSeq: input.afterSeq }
  const chatRecords = events.filter((event) => event.kind === 'chat.message').map(messageRecordFromEvent)
  const chatJson = await messagesJson(ctx, chatRecords, input.roomId)
  let chatIndex = 0
  let lastSeq = input.afterSeq
  for (const event of events) {
    const message = event.kind === 'chat.message' ? (chatJson[chatIndex++] ?? null) : null
    for (const frame of framesForRoomEvent(event, message)) res.write(encodeSseFrame(frame))
    lastSeq = event.seq
  }
  res.write(`event: cursor\ndata: ${JSON.stringify({ seq: lastSeq })}\n\n`)
  return { count: events.length, lastSeq }
}

/**
 * SSE：写进房间日志就推。总线负责立刻唤醒；streamPollMs 只是漏报兜底。
 * 浏览器 EventSource 不能带 Authorization 头，所以这条路由额外接受 ?access_token=。
 * `after` 与 Last-Event-ID 取较大者，断线从上次 seq 续。
 */
async function handleStream(ctx: RoomRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const headerToken = /^Bearer[ ]+(\S+)$/.exec((req.headers.authorization ?? '').trim())
  const queryToken = url.searchParams.get('access_token')
  // 账号登录使用 HttpOnly cookie；EventSource 不能设 Authorization，也不能读 cookie。
  // 优先 Bearer/query token（配对会话），没有时回退到同源 cookie。
  const cookieToken = readCookie(req, 'roost_session')
  const candidate = headerToken?.[1] ?? (queryToken !== null && queryToken !== '' ? queryToken : cookieToken)
  if (candidate === null || candidate === undefined || !SESSION_TOKEN_PATTERN.test(candidate)) {
    return sendError(res, 401, 'unauthenticated', 'stream needs a session token')
  }
  const token = candidate
  const session = await ctx.store.findSessionByToken(hashSessionToken(token))
  if (session === null) return sendError(res, 401, 'unauthenticated', 'unknown session token')
  if (session.expiresAt <= ctx.now()) return sendError(res, 401, 'session_expired', 'session expired')

  const roomId = roomIdFromPath(url.pathname)
  if (roomId === null) return sendError(res, 404, 'not_found', 'malformed room path')
  const afterRaw = url.searchParams.get('after')
  let lastSeq = afterRaw === null ? 0 : Number.parseInt(afterRaw, 10)
  if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) lastSeq = 0
  const lastEventHeader = req.headers['last-event-id']
  if (typeof lastEventHeader === 'string' && /^[0-9]+$/.test(lastEventHeader)) {
    const parsed = Number(lastEventHeader)
    if (Number.isSafeInteger(parsed) && parsed > lastSeq) lastSeq = parsed
  }

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
  const waiter = armRoomWait(roomId)
  const abort = new AbortController()

  const pump = async (): Promise<void> => {
    while (!closed) {
      let wrote = 0
      try {
        const result = await writeRoomStream(ctx, res, {
          accountId: session.accountId,
          roomId,
          afterSeq: lastSeq,
        })
        wrote = result.count
        lastSeq = result.lastSeq
      } catch {
        // 房间被删或权限变化：结束流，让客户端重连并处理。
        res.write('event: error\ndata: {"code":"stream_unavailable"}\n\n')
        break
      }
      if (wrote > 0) continue
      if (closed) break
      await waiter.wait(ctx.streamPollMs, abort.signal)
    }
  }

  req.on('close', () => {
    closed = true
    abort.abort()
    waiter.cancel()
    clearInterval(heartbeat)
  })

  try {
    await pump()
  } finally {
    waiter.cancel()
    clearInterval(heartbeat)
    if (!res.writableEnded) res.end()
  }
}

/** GET /api/internal/events?after=&waitMs=&workspaceId= —— 沙箱按 seq 长轮询房间日志。 */
async function handleInternalEvents(ctx: RoomRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const auth = authorizeRuntimeHttp(ctx, req, res)
  if (auth === null) return
  if (ctx.rawStore === undefined) {
    return sendError(res, 503, 'runtime.not_configured', 'room events need the SQLite store')
  }
  const afterRaw = url.searchParams.get('after')
  const afterSeq = afterRaw === null || afterRaw === '' ? 0 : Number.parseInt(afterRaw, 10)
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    return sendError(res, 400, 'invalid_body', 'after must be a non-negative integer seq')
  }
  const waitMs = readWaitMs(res, url)
  if (waitMs === null) return
  const requested = url.searchParams.get('workspaceId')
  const workspaceId = auth.workspaceId ?? (requested === null || requested === '' ? null : requested)
  if (auth.workspaceId !== null) {
    if (!ensureRuntimeWorkspace(auth, requested ?? auth.workspaceId, res)) return
  } else if (requested !== null && requested !== '') {
    // 全局 token 显式点名 workspace 时，确认它存在；不存在就空列表，不 500。
  }

  try {
    const events = await waitForRoomLoad(
      req,
      null,
      waitMs,
      async () =>
        readWorkspaceRoomEvents(ctx.rawStore!, {
          workspaceId,
          afterSeq,
          limit: 200,
        }),
    )
    if (res.writableEnded || req.destroyed) return
    const chat = events.filter((event) => event.kind === 'chat.message').map(messageRecordFromEvent)
    const chatJson = await messagesJson(ctx, chat)
    let chatIndex = 0
    sendJson(res, 200, {
      events: events.map((event) =>
        internalEventJson(event, event.kind === 'chat.message' ? (chatJson[chatIndex++] ?? null) : null),
      ),
    })
  } catch (err) {
    sendStoreFailure(res, err)
  }
}

/** POST /api/internal/rooms/:id/deltas —— 把一段流式增量追加成 chat.message.delta。 */
async function handleInternalDelta(ctx: RoomRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const auth = authorizeRuntimeHttp(ctx, req, res)
  if (auth === null) return
  if (ctx.rawStore === undefined) {
    return sendError(res, 503, 'runtime.not_configured', 'room events need the SQLite store')
  }
  const match = /^\/api\/internal\/rooms\/([^/]+)\/deltas$/.exec(url.pathname)
  const roomId = match === null ? null : safeDecode(match[1]!)
  if (roomId === null || roomId === '') return sendError(res, 404, 'not_found', 'malformed room path')
  if (auth.workspaceId !== null) {
    const roomWorkspace = await ctx.store.getRoomWorkspace(roomId).catch(() => null)
    if (!ensureRuntimeWorkspace(auth, roomWorkspace, res)) return
  }
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  const body = parsed.value as Record<string, unknown>
  const botId = typeof body.botId === 'string' ? body.botId.trim() : ''
  const delta = typeof body.delta === 'string' ? body.delta : ''
  if (botId === '' || botId.length > 64) {
    return sendError(res, 400, 'invalid_body', 'body.botId must be 1..64 characters')
  }
  if (delta === '' || delta.length > 8000) {
    return sendError(res, 400, 'invalid_body', 'body.delta must be 1..8000 characters')
  }
  const messageSeq =
    body.messageSeq === undefined || body.messageSeq === null ? undefined : Number(body.messageSeq)
  if (messageSeq !== undefined && (!Number.isSafeInteger(messageSeq) || messageSeq < 1)) {
    return sendError(res, 400, 'invalid_body', 'body.messageSeq must be a positive integer')
  }
  try {
    const event = appendRoomSignal(ctx.rawStore, {
      roomId,
      domain: 'chat',
      kind: 'chat.message.delta',
      actor: { kind: 'bot', id: botId },
      payload: {
        delta,
        ...(messageSeq === undefined ? {} : { messageSeq }),
      },
    })
    sendJson(res, 201, {
      event: { seq: event.seq, at: event.at, kind: event.kind, delta },
    })
  } catch (err) {
    sendStoreFailure(res, err)
  }
}

/**
 * POST /api/internal/notify { roomId, seq? }
 * 另一个进程写完 SQLite 后敲一下，本进程的 SSE / 长轮询立刻醒。
 * 不写事件；醒来的连接自己再读库。
 */
async function handleInternalNotify(ctx: RoomRouteContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = authorizeRuntimeHttp(ctx, req, res)
  if (auth === null) return
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  const body = parsed.value as Record<string, unknown>
  const roomId = typeof body.roomId === 'string' ? body.roomId.trim() : ''
  if (roomId === '' || roomId.length > 80) {
    return sendError(res, 400, 'invalid_body', 'body.roomId is required')
  }
  if (auth.workspaceId !== null) {
    const roomWorkspace = await ctx.store.getRoomWorkspace(roomId).catch(() => null)
    if (!ensureRuntimeWorkspace(auth, roomWorkspace, res)) return
  }
  const seq = typeof body.seq === 'number' && Number.isSafeInteger(body.seq) && body.seq >= 0 ? body.seq : 0
  publishRoomWake({ roomId, seq, kind: 'notify' })
  sendJson(res, 202, { ok: true, roomId, seq })
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

/** 模型代理的 workspace 归属：优先内部头，其次沙箱 env。 */
function modelProxyWorkspaceId(req: IncomingMessage): string | null {
  const raw = req.headers['x-roost-workspace-id']
  const value = (Array.isArray(raw) ? raw[0] : raw) ?? ''
  const trimmed = value.trim()
  if (trimmed !== '') return trimmed
  const fallback = (process.env['ROOST_WORKSPACE_ID'] ?? '').trim()
  return fallback === '' ? null : fallback
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/** 健康检查探库：SQLite 执行 SELECT 1；失败只记日志，不把错误细节透给客户端。 */
function checkDatabase(rawStore: Store | undefined): 'memory' | 'ok' | 'error' {
  if (rawStore === undefined) return 'memory'
  try {
    rawStore.db.prepare('SELECT 1').get()
    return 'ok'
  } catch (err) {
    console.error('roost api: healthz database check failed', err)
    return 'error'
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

  // auth.md §7：控制面写操作要求 Origin 校验（回环 / 同源 / 显式白名单）。
  if (
    !isDshPath &&
    method !== 'GET' &&
    method !== 'HEAD' &&
    !isAllowedOrigin(req, ctx)
  ) {
    req.resume()
    sendError(
      res,
      403,
      'forbidden_origin',
      `write requests must come from a loopback, same-origin, or allow-listed origin, got ${req.headers.origin}`
    )
    return
  }

  // cookie 会话的写操作要 CSRF 双提交（Bearer 不需要，浏览器读不到 Authorization）。
  if (method !== 'GET' && method !== 'HEAD' && !hasBearer(req) && readCookie(req, 'roost_session') !== null) {
    const exempt =
      /^\/api\/(auth\/(login|register|verify-email(\/resend)?|password\/reset(-request)?|oidc\/(start|callback))|pairing\/(code|claim))$/.test(path)
    if (!exempt && cookieCsrfInvalid(req)) {
      sendError(res, 403, 'csrf.invalid', 'cookie 会话的写请求需要 x-csrf-token')
      return
    }
  }

  if (isDshPath) {
    await handleDshRequest(ctx.dsh, req, res, url)
    return
  }

  if (path === '/healthz/deep') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleDeepHealth({
      now: ctx.now,
      probes: {
        api: () => ({ ok: true }),
        store: () => {
          if (ctx.rawStore === undefined) return { ok: true, detail: 'memory store' }
          try {
            ctx.rawStore.db.prepare('SELECT 1').get()
            return { ok: true }
          } catch {
            return { ok: false, detail: 'store query failed' }
          }
        },
        sandbox: async () => {
          if (ctx.runtimeManager === undefined) return { ok: true, detail: 'not configured' }
          try {
            const { OpenShellBackend } = await import('../../../packages/sandbox/src/index.ts')
            const ok = await new OpenShellBackend().available()
            return { ok, detail: ok ? 'openshell available' : 'openshell unavailable' }
          } catch {
            return { ok: false, detail: 'sandbox probe failed' }
          }
        },
        gateway: () => ({ ok: true, detail: 'not configured' })
      }
    }, req, res)
    return
  }

  if (path === '/healthz') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    const db = checkDatabase(ctx.rawStore)
    sendJson(res, db === 'error' ? 503 : 200, {
      ok: db !== 'error',
      db,
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

  if (/^\/api\/workspaces\/[^/]+\/model$/.test(path)) {
    const match = /^\/api\/workspaces\/([^/]+)\/model$/.exec(path)
    const workspaceId = match === null ? null : safeDecode(match[1]!)
    if (workspaceId === null || workspaceId === '') {
      sendError(res, 404, 'not_found', 'malformed workspace model path')
      return
    }
    if (method === 'GET') {
      await handleGetModelSettings(ctx.modelSettings!, req, res, workspaceId)
      return
    }
    if (method === 'PUT') {
      await handlePutModelSettings(ctx.modelSettings!, req, res, workspaceId)
      return
    }
    if (method === 'DELETE') {
      await handleDeleteModelSettings(ctx.modelSettings!, req, res, workspaceId)
      return
    }
    notFound(req, res, method, path)
    return
  }

  if (/^\/api\/workspaces\/[^/]+\/model\/test$/.test(path)) {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    const match = /^\/api\/workspaces\/([^/]+)\/model\/test$/.exec(path)
    const workspaceId = match === null ? null : safeDecode(match[1]!)
    if (workspaceId === null || workspaceId === '') {
      sendError(res, 404, 'not_found', 'malformed workspace model path')
      return
    }
    await handleTestModelSettings(ctx.modelSettings!, req, res, workspaceId)
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

  if (/^\/api\/rooms\/[^/]+\/artifacts$/.test(path)) {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    const match = /^\/api\/rooms\/([^/]+)\/artifacts$/.exec(path)
    const roomId = match === null ? null : safeDecode(match[1]!)
    if (roomId === null || roomId === '') {
      sendError(res, 404, 'not_found', 'malformed room path')
      return
    }
    await handlePostRoomArtifact(ctx, req, res, roomId)
    return
  }

  if (/^\/api\/rooms\/[^/]+\/cards\/[^/]+\/answer$/.test(path)) {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleAnswerCard(ctx as RoomRouteContext, req, res, url)
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

  if (path === '/api/internal/memory/claims') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    if (ctx.rawStore === undefined) {
      sendError(res, 503, 'runtime.not_configured', 'memory requires the SQLite store')
      return
    }
    await handleMemoryClaims({ store: ctx.rawStore, rawStore: ctx.rawStore, now: ctx.now, ...(ctx.runtimeToken === undefined ? {} : { runtimeToken: ctx.runtimeToken }) }, req, res)
    return
  }

  if (path === '/api/internal/memory/cleanup') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    if (ctx.rawStore === undefined) {
      sendError(res, 503, 'runtime.not_configured', 'memory requires the SQLite store')
      return
    }
    await handleMemoryCleanup({ store: ctx.rawStore, rawStore: ctx.rawStore, now: ctx.now, ...(ctx.runtimeToken === undefined ? {} : { runtimeToken: ctx.runtimeToken }) }, req, res)
    return
  }

  if (path === '/v1/models' || path === '/models') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    if (ctx.modelProxy?.resolve === undefined) {
      sendError(res, 503, 'model_proxy_not_configured', 'model proxy is not configured')
      return
    }
    const resolved = await ctx.modelProxy.resolve(req)
    if (!resolved.ok) {
      sendError(res, resolved.status, resolved.code, resolved.message)
      return
    }
    sendJson(res, 200, {
      object: 'list',
      data: [{ id: resolved.model, object: 'model', owned_by: resolved.byo ? 'byo' : 'roost' }]
    })
    return
  }

  if (path === '/v1/messages') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    if (ctx.modelProxy?.resolve === undefined) {
      sendError(res, 503, 'model_proxy_not_configured', 'model proxy is not configured')
      return
    }
    const resolved = await ctx.modelProxy.resolve(req)
    if (!resolved.ok) {
      sendError(res, resolved.status, resolved.code, resolved.message)
      return
    }
    setProxyWorkspace(req, resolved.workspaceId)
    await resolved.proxy(req, res)
    return
  }

  if (path === '/v1/chat/completions') {
    if (ctx.modelProxy === undefined) {
      sendError(res, 501, 'model_proxy_not_configured', 'model proxy is not configured')
      return
    }
    await handleModelProxy(ctx.modelProxy, req, res)
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

  if (path === '/api/internal/bots') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleInternalListBots(ctx as RoomRouteContext, req, res, url)
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

  if (/^\/api\/marketplace\/plugins\/[^/]+$/.test(path)) {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleGetMarketplacePlugin(ctx, req, res, url)
    return
  }

  if (/^\/api\/plugin-installs\/[^/]+$/.test(path)) {
    if (method === 'GET') {
      await handlePluginInstallGet(ctx.installRoutes as never, req, res, url)
      return
    }
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

  // 连接器控制面（connectors.md §9；M6-6.1）。
  if (path === '/api/connectors') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleListConnectors(ctx, req, res, url)
    return
  }

  // 回调必须排在 /:slug 之前；它是 GET，且无 Bearer（OAuth provider 跳转）。
  if (/^\/api\/connectors\/callback\/[^/]+$/.test(path)) {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleConnectorCallback(ctx, req, res, url)
    return
  }

  if (/^\/api\/connectors\/[^/]+\/connect$/.test(path)) {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleConnectorConnect(ctx, req, res, url)
    return
  }

  if (/^\/api\/connectors\/[^/]+\/grants$/.test(path)) {
    if (method === 'GET') {
      await handleListConnectorGrants(ctx, req, res, url)
      return
    }
    if (method === 'PUT') {
      await handlePutConnectorGrant(ctx, req, res, url)
      return
    }
    notFound(req, res, method, path)
    return
  }

  if (path === '/api/internal/connectors/call') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleInternalConnectorCall(ctx, req, res)
    return
  }

  if (/^\/api\/connectors\/[^/]+$/.test(path)) {
    if (method !== 'DELETE') {
      notFound(req, res, method, path)
      return
    }
    await handleDeleteConnector(ctx, req, res, url)
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
    const approvalId = safeDecode(/^\/api\/approvals\/([^/]+)$/.exec(path)?.[1] ?? '')
    const auth = await authenticate(ctx, req)
    await handleDecideApproval(ctx as RoomRouteContext, req, res, url)
    // 插件安装审批：决策落库后把 job 推进到 installing（或 rejected → failed）。
    if (auth.ok && ctx.rawStore !== undefined && approvalId !== null) {
      const approval = getApproval(ctx.rawStore, approvalId)
      if (approval !== null && approval.kind === 'plugin_install' && (approval.status === 'approved' || approval.status === 'rejected')) {
        onInstallApproved(ctx.rawStore, { approvalId, decision: approval.status, by: auth.session.accountId })
      }
    }
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

  // 控制面采样：容器秒 / 存储字节（budget.md §2、§6）。
  if (path === '/api/internal/meter') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleInternalMeter(ctx, req, res)
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

  // 记忆：内部写入 / 检索 / 读取记录，用户列表 / 删除 / 导出（memory.md §4–§9）。
  if (path === '/api/internal/memories') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleInternalWriteMemory(ctx, req, res)
    return
  }

  if (path === '/api/internal/memories/retrieve') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleInternalRetrieve(ctx, req, res)
    return
  }

  if (path === '/api/internal/memories/reads') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleInternalRecordReads(ctx, req, res)
    return
  }

  if (path === '/api/memories/export') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleExportMemories(ctx, req, res, url)
    return
  }

  if (path === '/api/memories') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleListMemories(ctx, req, res, url)
    return
  }

  if (/^\/api\/memories\/[^/]+$/.test(path)) {
    if (method !== 'DELETE') {
      notFound(req, res, method, path)
      return
    }
    await handleDeleteMemory(ctx, req, res, url)
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
    await handleInternalAssignments({ store: ctx.rawStore, rawStore: ctx.rawStore, now: ctx.now, ...(ctx.runtimeToken === undefined ? {} : { runtimeToken: ctx.runtimeToken }) }, req, res, roomId)
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
    await handleInternalRound({ store: ctx.rawStore, rawStore: ctx.rawStore, now: ctx.now, ...(ctx.runtimeToken === undefined ? {} : { runtimeToken: ctx.runtimeToken }) }, req, res, roomId)
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
    await handleInternalAdvance({ store: ctx.rawStore, rawStore: ctx.rawStore, now: ctx.now, ...(ctx.runtimeToken === undefined ? {} : { runtimeToken: ctx.runtimeToken }) }, req, res, roundId)
    return
  }

  if (/^\/api\/workspaces\/[^/]+\/panels\/wake$/.test(path)) {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    const match = /^\/api\/workspaces\/([^/]+)\/panels\/wake$/.exec(path)
    const workspaceId = match === null ? null : safeDecode(match[1]!)
    if (workspaceId === null || workspaceId === '') {
      sendError(res, 404, 'not_found', 'malformed workspace panels wake path')
      return
    }
    const auth = await authenticate(ctx, req)
    if (!auth.ok) {
      sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
      return
    }
    const workspaces = await ctx.store.listWorkspaces({ accountId: auth.session.accountId })
    if (!workspaces.some((workspace) => workspace.id === workspaceId)) {
      sendError(res, 404, 'not_found', 'unknown workspace')
      return
    }
    if (ctx.rawStore === undefined || ctx.runtimeManager === undefined || ctx.panelForward === undefined) {
      sendError(res, 503, 'runtime.not_configured', '面板容器需要 SQLite 存储与运行时')
      return
    }
    const existing = ctx.panelForward.resolvePort(workspaceId)
    if (existing !== undefined) {
      sendJson(res, 200, { port: existing, url: `/w/${workspaceId}/dsh/` })
      return
    }
    try {
      const { runtime } = await startWorkspaceRuntime(ctx.rawStore, workspaceId, ctx.runtimeManager)
      try {
        options.onWorkspaceStarted?.({ workspaceId, sandbox: runtime.sandbox })
      } catch {
        // 同上：宿主回调失败不影响面板唤醒。
      }
      const endpoint = await ctx.panelForward.ensure(workspaceId, { sandboxName: runtime.sandbox })
      sendJson(res, 200, { port: endpoint.port, url: `/w/${workspaceId}/dsh/` })
    } catch (error) {
      sendError(res, 503, 'panel.unavailable', `面板容器不可用：${error instanceof Error ? error.message : String(error)}`)
    }
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
      try {
        options.onWorkspaceStarted?.({ workspaceId, sandbox: result.runtime.sandbox })
      } catch {
        // 启动后的宿主回调失败不影响 API 结果。
      }
      // tokenId 只是可回收凭据的 id，不是明文 token；带上便于审计/测试定位本次签发。
      sendJson(res, result.created ? 201 : 200, {
        runtime: result.runtime,
        ...(result.tokenId === undefined ? {} : { tokenId: result.tokenId }),
      })
    } catch (error) {
      sendError(res, 502, 'runtime.start_failed', error instanceof Error ? error.message : String(error))
    }
    return
  }

  if (path === '/api/internal/notify') {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleInternalNotify(ctx as RoomRouteContext, req, res)
    return
  }

  if (path === '/api/internal/events') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handleInternalEvents(ctx as RoomRouteContext, req, res, url)
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

  if (/^\/api\/internal\/rooms\/[^/]+\/deltas$/.test(path)) {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleInternalDelta(ctx as RoomRouteContext, req, res, url)
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

  if (path === '/api/auth/verify-email/link') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await AUTH_LOGIN_ROUTES.verifyEmailLink(ctx.authRoutes as never, req, res, url)
    return
  }

  const authTable: Record<string, [string, (c: never, q: IncomingMessage, r: ServerResponse) => Promise<void>]> = {
    '/api/auth/register': ['POST', AUTH_LOGIN_ROUTES.register],
    '/api/auth/verify-email': ['POST', AUTH_LOGIN_ROUTES.verifyEmail],
    '/api/auth/verify-email/resend': ['POST', AUTH_LOGIN_ROUTES.resendVerification],
    '/api/auth/login': ['POST', AUTH_LOGIN_ROUTES.login],
    '/api/auth/logout': ['POST', AUTH_LOGIN_ROUTES.logout],
    '/api/auth/me': ['GET', AUTH_LOGIN_ROUTES.me],
    '/api/auth/password/reset-request': ['POST', AUTH_LOGIN_ROUTES.passwordResetRequest],
    '/api/auth/password/reset': ['POST', AUTH_LOGIN_ROUTES.passwordReset],
    '/api/auth/providers': ['GET', AUTH_LOGIN_ROUTES.providers],
    '/api/auth/oidc/start': ['POST', AUTH_LOGIN_ROUTES.oidcStart]
  }
  const authRoute = authTable[path]
  if (authRoute !== undefined) {
    if (method !== authRoute[0]) {
      notFound(req, res, method, path)
      return
    }
    await authRoute[1](ctx.authRoutes as never, req, res)
    return
  }

  if (path === '/api/auth/oidc/callback') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await AUTH_LOGIN_ROUTES.oidcCallback(ctx.authRoutes as never, req, res, url)
    return
  }

  // 插件安装流水线（wave1 §B）：市场安装 → 审批 → 沙箱 sync → 回滚。
  if (/^\/api\/marketplace\/plugins\/[^/]+\/install$/.test(path)) {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handleMarketplaceInstallStart(ctx.installRoutes as never, req, res, url)
    return
  }

  if (path === '/api/plugin-installs') {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handlePluginInstallList(ctx.installRoutes as never, req, res, url)
    return
  }

  if (/^\/api\/plugin-installs\/[^/]+$/.test(path)) {
    if (method !== 'GET') {
      notFound(req, res, method, path)
      return
    }
    await handlePluginInstallGet(ctx.installRoutes as never, req, res, url)
    return
  }

  if (/^\/api\/plugin-installs\/[^/]+\/(update|disable|enable|uninstall|rollback)$/.test(path)) {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    const action = /^\/api\/plugin-installs\/[^/]+\/(update|disable|enable|uninstall|rollback)$/.exec(path)?.[1]
    if (action === 'update') await handlePluginInstallUpdate(ctx.installRoutes as never, req, res, url)
    else if (action === 'disable') await handlePluginInstallDisable(ctx.installRoutes as never, req, res, url)
    else if (action === 'enable') await handlePluginInstallEnable(ctx.installRoutes as never, req, res, url)
    else if (action === 'uninstall') await handlePluginInstallUninstall(ctx.installRoutes as never, req, res, url)
    else await handlePluginInstallRollback(ctx.installRoutes as never, req, res, url)
    return
  }

  if (/^\/api\/internal\/plugin-installs\/[^/]+\/synced$/.test(path)) {
    if (method !== 'POST') {
      notFound(req, res, method, path)
      return
    }
    await handlePluginInstallSynced(ctx.installRoutes as never, req, res, url)
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
  const panelForward = options.panelForward ?? defaultPanelForwardHooks()
  const dsh: DshRouteContext = {
    store: options.store,
    now,
    dshWebPort: resolveDshWebPort(options.dshWebPort),
    resolvePort: panelForward.resolvePort,
    // cookie 签名密钥与附件共用 ROOST_SIGNING_SECRET；都没配置则本进程随机（重启后旧 cookie 失效）。
    signingSecret:
      options.signingSecret ?? process.env.ROOST_SIGNING_SECRET ?? randomBytes(32).toString('hex'),
    ...(options.rawStore === undefined ? {} : { rawStore: options.rawStore }),
  }
  state.dsh = dsh
  const schedulerEnabled =
    (options.schedulerLoop === true || process.env.ROOST_SCHEDULER === '1') && options.rawStore !== undefined
  const authRoutes: AuthRoutesContext = {
    store: options.store,
    now,
    secureCookies: process.env['ROOST_SECURE_COOKIES'] === '1',
    oidc: options.oidc ?? buildOidcConfig(),
    ...(options.authMailer === undefined ? {} : { mailer: options.authMailer }),
    ...(options.authSessionTtlMs === undefined ? {} : { sessionTtlMs: options.authSessionTtlMs }),
    ...(options.rawStore === undefined ? {} : { rawStore: options.rawStore }),
  }
  const installRoutes: MarketplaceInstallRouteContext = {
    store: options.store,
    now,
    ...(options.rawStore === undefined ? {} : { rawStore: options.rawStore }),
    ...(options.runtimeToken === undefined && process.env['ROOST_RUNTIME_TOKEN'] === undefined
      ? {}
      : { runtimeToken: options.runtimeToken ?? process.env['ROOST_RUNTIME_TOKEN'] }),
    ...(process.env['ROOST_DSH_VERSION'] === undefined ? {} : { dshVersion: process.env['ROOST_DSH_VERSION'] }),
    ...(process.env['ROOST_PLUGIN_ALLOWLIST'] === undefined ? {} : { allowlist: process.env['ROOST_PLUGIN_ALLOWLIST'] })
  }
  const ctx: RoomRouteContext = {
    store: options.store,
    now,
    authRoutes,
    installRoutes,
    startedAt: now(),
    claimFailures: [],
    sessionAccounts: new Set<string>(),
    streamPollMs: options.streamPollMs ?? 15_000,
    runtimeToken: options.runtimeToken ?? process.env.ROOST_RUNTIME_TOKEN,
    dsh,
    serverState: state,
    metrics: createMetrics(),
    rateLimiter: new TokenBucketLimiter(),
    schedulerEnabled,
    logSink: options.logSink ?? writeHttpLog,
    connectorBackend: options.connectorBackend ?? createGatewayBackend(process.env),
    allowedOrigins: parseAllowedOrigins(process.env.ROOST_ALLOWED_ORIGINS),
    ...(options.rawStore === undefined ? {} : { rawStore: options.rawStore }),
    ...(options.runtimeManager === undefined ? {} : { runtimeManager: options.runtimeManager }),
    panelForward,
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

  // 插件安装复用控制面的限流桶（10/小时/账号，rate-limit.test.ts 覆盖）。
  installRoutes.rateLimiter = ctx.rateLimiter

  // 事件 → 指标，并唤醒房间 SSE / 长轮询。appendEvent 是 SQLite 的唯一写入口。
  setEventSink((event) => {
    try {
      publishFromStoredEvent(event)
    } catch {
      // 总线失败不影响事件写入。
    }
    try {
      ctx.metrics.ingest(metricsFromEvent(event as never))
    } catch {
      // 指标失败不影响事件写入。
    }
    try {
      options.onEvent?.(event)
    } catch {
      // 其它出口失败同样不影响写入。
    }
  })

  // 模型代理（6.4.5）：/v1/chat/completions 转发并记账。
  // 有 rawStore 时走 per-workspace 解析（BYO Key / 平台 Key + 免费额度）；否则退回旧单 key。
  const modelKey = (process.env['ROOST_MODEL_API_KEY'] ?? process.env['DEEPSEEK_API_KEY'] ?? '').trim()
  const modelKeyMaster = options.modelKeyMaster ?? readModelKeyMaster()
  const freeModel = options.freeModel ?? ((process.env['ROOST_FREE_MODEL'] ?? '').trim() || DEFAULT_FREE_MODEL)
  const platformBase =
    process.env['ROOST_MODEL_UPSTREAM_BASE'] ?? process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com'
  if (ctx.rawStore !== undefined) {
    ctx.modelProxy = {
      workspaceIdFrom: modelProxyWorkspaceId,
      resolve: (req) =>
        resolveModelProxy(
          {
            rawStore: ctx.rawStore,
            ...(ctx.runtimeToken === undefined ? {} : { runtimeToken: ctx.runtimeToken }),
            now: ctx.now,
            masterKey: modelKeyMaster,
            platformKey: modelKey,
            platformBase,
            freeModel,
            limiter: ctx.rateLimiter,
            ...(options.modelTestFetch === undefined ? {} : { fetchImpl: options.modelTestFetch })
          },
          req
        )
    }
  } else if (options.modelProxy !== undefined) {
    ctx.modelProxy = { proxy: options.modelProxy, workspaceIdFrom: modelProxyWorkspaceId }
  } else if (modelKey !== '') {
    ctx.modelProxy = {
      proxy: createModelProxy({
        upstreamBase: platformBase,
        key: modelKey,
        limiter: ctx.rateLimiter,
        recordUsage: () => {}
      }),
      workspaceIdFrom: modelProxyWorkspaceId
    }
  }

  ctx.modelSettings = {
    store: ctx.store,
    ...(ctx.rawStore === undefined ? {} : { rawStore: ctx.rawStore }),
    now: ctx.now,
    masterKey: options.modelKeyMaster ?? readModelKeyMaster(),
    freeModel: options.freeModel ?? ((process.env['ROOST_FREE_MODEL'] ?? '').trim() || DEFAULT_FREE_MODEL),
    ...(options.modelTestFetch === undefined ? {} : { fetchImpl: options.modelTestFetch })
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
      await (options.panelForward ?? defaultPanelForwardHooks()).stopAll().catch(() => {})
      const proxy = dshProxyServer
      await Promise.all([closeServer(server), ...(proxy === undefined ? [] : [closeServer(proxy)])])
    }
  }
}
