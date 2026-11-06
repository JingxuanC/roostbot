// 连接器控制面（M6-6.1；docs/design/connectors.md §3、§4、§8、§9）。
//
// 本文件只导出 handler，由 server.ts 接线：
//
//   GET    /api/connectors                     目录 + 连接状态 + Bot 授权摘要（任意成员）
//   POST   /api/connectors/:slug/connect       起 OAuth（owner/admin）→ {url, state}
//   GET    /api/connectors/callback/:slug      OAuth 回调（校验服务端 state，无 Bearer）
//   DELETE /api/connectors/:slug               断开（owner/admin），204 幂等
//   GET    /api/connectors/:slug/grants        按 Bot 授权（owner/admin）
//   PUT    /api/connectors/:slug/grants        覆盖授权（owner/admin）
//   POST   /api/internal/connectors/call       runtime token；连接+授权校验、只读直调、写动作审批、idem 去重
//
// v0 边界：不接真实 OAuth 网关。默认 StubGatewayBackend 的 authorize/call 抛
// `connector.not_configured`，这里映射 501；测试通过 ServerOptions.connectorBackend 注入 fake。
// OAuth state 保存在本进程内存（10 分钟、绑定 workspace/account/slug，一次有效）；
// 多副本部署时要换成共享存储（见 docs 实现状态）。
//
// 凭据永不下发：connections 只有 account_label，connector_calls 只存 ok/字节数/拒绝原因。

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  isActionGranted,
  isConnectorNotConfigured,
  requiresApprovalForWrite,
} from '../../../packages/connectors/src/index.ts'
import type {
  CallResult,
  ConnectorGrant,
  ConnectorSummary,
  GatewayBackend,
} from '../../../packages/connectors/src/index.ts'
import { isConnectorSlug } from '../../../packages/store/src/connectors.ts'
import type {
  Connection,
  ConnectorCallRow,
  ConnectorGrantRow,
} from '../../../packages/store/src/connectors.ts'
import {
  createApproval,
  findApprovalGrant,
} from '../../../packages/store/src/approvals.ts'
import {
  StoreError,
  deleteConnection,
  findCallByIdem,
  findGrant,
  getConnection,
  getWorkspaceRole,
  listConnections,
  listGrants,
  recordCall,
  setGrant,
  upsertConnection,
} from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import type { StorePort, WorkspaceRole } from './port.ts'
import { approvalJson } from './bot-rooms-routes.ts'
import { authenticate, isPlainObject, readJsonBody, readText, sendError, sendJson } from './server.ts'
import { authorizeRuntimeHttp, ensureRuntimeWorkspace } from './runtime-auth.ts'

/** OAuth state 有效期：design §4 要求 10 分钟。 */
export const CONNECTOR_STATE_TTL_MS = 10 * 60 * 1000
/** 审批长期授权的 kind（与 approval_grants 的 kind 匹配）。 */
export const CONNECTOR_APPROVAL_KIND = 'connector_action'

const MAX_ID_CHARS = 200
const MAX_ACTION_CHARS = 200
const MAX_ACTIONS = 200

interface PendingState {
  workspaceId: string
  accountId: string
  slug: string
  expiresAt: number
}

/** 服务端保存的 OAuth state（短时、绑定 workspace/account/slug、一次有效）。 */
const pendingStates = new Map<string, PendingState>()

export interface ConnectorsRouteContext {
  store: StorePort
  now: () => number
  /** 连接/授权/调用审计表只在 SQLite 里；memory port 下所有接口 503。 */
  rawStore?: Store
  runtimeToken?: string
  /** 网关后端；server.ts 默认注入 StubGatewayBackend。 */
  connectorBackend: GatewayBackend
}

type Ctx = ConnectorsRouteContext

// ---- 目录 --------------------------------------------------------------------

export async function handleListConnectors(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  const store = requireStore(ctx, res)
  if (store === null) return

  const workspaceId = readId(url.searchParams.get('workspaceId'))
  if (workspaceId === null) {
    return sendError(res, 400, 'invalid_body', 'workspaceId is required (non-empty string)')
  }
  const role = getWorkspaceRole(store, workspaceId, auth.accountId)
  if (role === null) {
    return sendError(res, 403, 'forbidden', `account is not a member of workspace ${workspaceId}`)
  }

  let catalog: ConnectorSummary[] = []
  try {
    catalog = await ctx.connectorBackend.listConnectors()
  } catch (err) {
    return sendBackendFailure(res, err)
  }

  const connections = listConnections(store, workspaceId)
  const bySlug = new Map(connections.map((connection) => [connection.slug, connection]))
  const connectors = catalog.map((summary) => connectorCard(summary, bySlug.get(summary.slug)))
  // 目录里没有、但本地已连接的（例如后端临时不可达）也要让用户看到并断开。
  for (const connection of connections) {
    if (!catalog.some((summary) => summary.slug === connection.slug)) {
      connectors.push(connectorCard({ slug: connection.slug, title: connection.slug, backend: connection.backend, actions: [] }, connection))
    }
  }

  const botId = readId(url.searchParams.get('botId'))
  const botGrants =
    botId === null
      ? undefined
      : listGrants(store, workspaceId).filter((grant) => grant.botId === botId).map(grantJson)

  sendJson(res, 200, {
    connectors,
    connections: connections.map(connectionJson),
    ...(botGrants === undefined ? {} : { botGrants }),
  })
}

// ---- OAuth：起授权 / 回调 ----------------------------------------------------

export async function handleConnectorConnect(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  const store = requireStore(ctx, res)
  if (store === null) return

  const slug = slugFromPath(url.pathname, 'connect')
  if (slug === null) return sendError(res, 404, 'not_found', 'malformed connector connect path')

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const workspaceId = readId(parsed.value['workspaceId'])
  if (workspaceId === null) {
    return sendError(res, 400, 'invalid_body', 'workspaceId is required (non-empty string)')
  }
  if (!isAdmin(store, workspaceId, auth.accountId)) {
    return sendError(res, 403, 'forbidden', `workspace ${workspaceId} requires owner/admin role`)
  }

  // state 必须先于 gateway.authorize 生成并传下去：网关要把 state 拼进最终
  // 回调 URL，否则浏览器完成授权后回不到本服务的 callback。
  const state = randomBytes(24).toString('hex')
  pendingStates.set(state, {
    workspaceId,
    accountId: auth.accountId,
    slug,
    expiresAt: ctx.now() + CONNECTOR_STATE_TTL_MS,
  })

  let urlValue: string
  try {
    const authorized = await ctx.connectorBackend.authorize(slug, { workspaceId, state })
    urlValue = authorized.url
  } catch (err) {
    pendingStates.delete(state)
    return sendBackendFailure(res, err)
  }
  sendJson(res, 201, { url: urlValue, state })
}

export async function handleConnectorCallback(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const store = requireStore(ctx, res)
  if (store === null) return

  const slug = callbackSlugFromPath(url.pathname)
  if (slug === null) return sendError(res, 404, 'not_found', 'malformed connector callback path')

  const state = url.searchParams.get('state') ?? ''
  const status = url.searchParams.get('status') ?? ''
  const pending = pendingStates.get(state)
  if (pending === undefined) {
    return sendError(res, 400, 'connector.invalid_state', 'unknown or already-used OAuth state')
  }
  if (pending.slug !== slug || pending.expiresAt <= ctx.now()) {
    pendingStates.delete(state)
    return sendError(res, 400, 'connector.invalid_state', 'OAuth state does not match or has expired')
  }
  // state 一次有效：先消费，后面的校验失败也不会让同一个 state 被重放。
  pendingStates.delete(state)

  if (status !== 'connected') {
    return sendError(res, 400, 'connector.oauth_failed', `provider returned status ${status || '(empty)'}`)
  }

  let backendStatus: string
  try {
    backendStatus = await ctx.connectorBackend.status(slug)
  } catch (err) {
    return sendBackendFailure(res, err)
  }
  if (backendStatus !== 'connected') {
    return sendError(res, 400, 'connector.connect_failed', `gateway reports ${backendStatus}`)
  }

  try {
    const connection = upsertConnection(store, {
      workspaceId: pending.workspaceId,
      slug,
      backend: ctx.connectorBackend.id,
      status: 'connected',
      accountLabel: null,
      connectedBy: pending.accountId,
      at: ctx.now(),
    })
    // v0 没有前端回调页：直接返回 JSON；接入前端后改成 302 到 /connectors。
    sendJson(res, 200, { connected: true, connection: connectionJson(connection) })
  } catch (err) {
    return sendConnectorFailure(res, err)
  }
}

// ---- 断开 / 授权 -------------------------------------------------------------

export async function handleDeleteConnector(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  const store = requireStore(ctx, res)
  if (store === null) return

  const slug = slugFromPath(url.pathname, '')
  if (slug === null) return sendError(res, 404, 'not_found', 'malformed connector path')
  const workspaceId = readId(url.searchParams.get('workspaceId'))
  if (workspaceId === null) {
    return sendError(res, 400, 'invalid_body', 'workspaceId is required (non-empty string)')
  }
  if (!isAdmin(store, workspaceId, auth.accountId)) {
    return sendError(res, 403, 'forbidden', `workspace ${workspaceId} requires owner/admin role`)
  }

  try {
    deleteConnection(store, { workspaceId, slug, by: auth.accountId, at: ctx.now() })
  } catch (err) {
    return sendConnectorFailure(res, err)
  }
  res.writeHead(204, { 'cache-control': 'no-store' })
  res.end()
}

export async function handleListConnectorGrants(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  const store = requireStore(ctx, res)
  if (store === null) return

  const slug = slugFromPath(url.pathname, 'grants')
  if (slug === null) return sendError(res, 404, 'not_found', 'malformed connector grants path')
  const workspaceId = readId(url.searchParams.get('workspaceId'))
  if (workspaceId === null) {
    return sendError(res, 400, 'invalid_body', 'workspaceId is required (non-empty string)')
  }
  if (!isAdmin(store, workspaceId, auth.accountId)) {
    return sendError(res, 403, 'forbidden', `workspace ${workspaceId} requires owner/admin role`)
  }

  try {
    sendJson(res, 200, { grants: listGrants(store, workspaceId, slug).map(grantJson) })
  } catch (err) {
    sendConnectorFailure(res, err)
  }
}

export async function handlePutConnectorGrant(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  const store = requireStore(ctx, res)
  if (store === null) return

  const slug = slugFromPath(url.pathname, 'grants')
  if (slug === null) return sendError(res, 404, 'not_found', 'malformed connector grants path')

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
  const botId = readId(body['botId'])
  if (botId === null) {
    return sendError(res, 400, 'invalid_body', 'botId is required (non-empty string)')
  }
  const access = body['access']
  if (access !== 'read' && access !== 'write') {
    return sendError(res, 400, 'invalid_body', "access must be 'read' or 'write'")
  }
  const actions = readActions(body['actions'])
  if (actions === INVALID) {
    return sendError(res, 400, 'invalid_body', `actions must be an array of 1..${MAX_ACTION_CHARS}-char strings`)
  }
  if (!isAdmin(store, workspaceId, auth.accountId)) {
    return sendError(res, 403, 'forbidden', `workspace ${workspaceId} requires owner/admin role`)
  }

  try {
    const grant = setGrant(store, {
      workspaceId,
      botId,
      slug,
      access,
      actions,
      grantedBy: auth.accountId,
      at: ctx.now(),
    })
    sendJson(res, 200, { grant: grantJson(grant) })
  } catch (err) {
    sendConnectorFailure(res, err)
  }
}

// ---- 内部：Bot 调用连接器 ----------------------------------------------------

export async function handleInternalConnectorCall(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = authorizeRuntimeHttp(ctx, req, res)
  if (auth === null) return
  const store = requireStore(ctx, res)
  if (store === null) return

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const body = parsed.value

  const workspaceId = readId(body['workspaceId'])
  const botId = readId(body['botId'])
  const slug = typeof body['slug'] === 'string' ? body['slug'].trim() : ''
  const action = readText(body['action'], MAX_ACTION_CHARS)
  if (workspaceId === null || botId === null || !isConnectorSlug(slug) || action === null) {
    return sendError(res, 400, 'invalid_body', 'workspaceId, botId, slug, action are required')
  }
  // workspace token 只能调用自己 workspace 的连接器。
  if (!ensureRuntimeWorkspace(auth, workspaceId, res)) return
  const idem = readOptionalKey(body['idem'])
  if (idem === INVALID) {
    return sendError(res, 400, 'invalid_body', `idem must be a string of 1..${MAX_ID_CHARS} chars when present`)
  }
  const args = body['args'] === undefined ? {} : body['args']

  // 1) idem 重放：不重复调用后端；connector_calls 只存了 ok，无法重放结果正文。
  if (idem !== null) {
    const existing = findCallByIdem(store, workspaceId, botId, idem)
    if (existing !== null) return replayCall(res, existing)
  }

  const deny = (reason: string): void => {
    try {
      recordCall(store, {
        workspaceId,
        botId,
        slug,
        action,
        ok: false,
        deniedReason: reason,
        idem,
        at: ctx.now(),
      })
    } catch (err) {
      console.error('roost api: failed to record denied connector call', err)
    }
    sendJson(res, 403, {
      ok: false,
      deduped: false,
      deniedReason: reason,
      error: { code: 'connector.denied', message: `connector call denied: ${reason}` },
    })
  }

  // 2) 连接必须 connected。
  const connection = getConnection(store, workspaceId, slug)
  if (connection === null || connection.status !== 'connected') return deny('not_connected')

  // 3) 授权必须存在，且动作在 allowlist 内。
  const grant = findGrant(store, workspaceId, botId, slug)
  if (grant === null) return deny('no_grant')
  const backendGrant: ConnectorGrant = {
    workspaceId,
    botId,
    slug,
    access: grant.access,
    // 旧数据用 NULL 表示「该 access 下全部动作」。函数层空列表是拒绝，所以这里写成显式 *。
    actions: grant.actions === null ? ['*'] : grant.actions,
  }
  if (!isActionGranted(backendGrant, action)) return deny('action_not_granted')

  // 4) 写/副作用动作：命中 approval_grants 直接放行，否则落审批并 202（不调用）。
  if (requiresApprovalForWrite(grant.access, action)) {
    const approvalAction = `${slug}.${action}`
    const allowed = findApprovalGrant(store, {
      workspaceId,
      kind: CONNECTOR_APPROVAL_KIND,
      action: approvalAction,
      target: botId,
    })
    if (allowed === null) {
      try {
        const approval = createApproval(store, {
          workspaceId,
          kind: CONNECTOR_APPROVAL_KIND,
          requester: botId,
          requesterKind: 'bot',
          payload: { slug, action, args, ...(idem === null ? {} : { idem }) },
          action: approvalAction,
          target: botId,
          consequence: `调用连接器 ${approvalAction} 会对外部服务产生副作用，需要人工批准`,
          at: ctx.now(),
        })
        return sendJson(res, 202, { approval: approvalJson(approval) })
      } catch (err) {
        return sendConnectorFailure(res, err)
      }
    }
  }

  // 5) 直调后端；成功/失败都记 connector_calls + connector.call 事件。
  let result: CallResult
  try {
    result = await ctx.connectorBackend.call(
      { workspaceId, botId, slug, action, args, ...(idem === null ? {} : { idem }) },
      backendGrant,
    )
  } catch (err) {
    const notConfigured = isConnectorNotConfigured(err)
    const reason = notConfigured ? 'connector.not_configured' : 'unavailable'
    safeRecordCall(store, { workspaceId, botId, slug, action, ok: false, deniedReason: reason, idem, at: ctx.now() })
    return notConfigured
      ? sendError(res, 501, 'connector.not_configured', 'no connector gateway is configured')
      : sendError(res, 502, 'connector.unavailable', err instanceof Error ? err.message : String(err))
  }

  if (!result.ok) {
    const reason = result.reason === undefined ? result.code : `${result.code}: ${result.reason}`
    safeRecordCall(store, { workspaceId, botId, slug, action, ok: false, deniedReason: reason, idem, at: ctx.now() })
    const mapped = callFailureResponse(result.code)
    return sendError(res, mapped.status, mapped.code, reason)
  }

  try {
    recordCall(store, {
      workspaceId,
      botId,
      slug,
      action,
      ok: true,
      resultBytes: result.bytes,
      idem,
      at: ctx.now(),
    })
  } catch (err) {
    return sendConnectorFailure(res, err)
  }
  sendJson(res, 200, { ok: true, result: result.data })
}

// ---- 序列化 ------------------------------------------------------------------

function connectorCard(summary: ConnectorSummary, connection: Connection | undefined): Record<string, unknown> {
  return {
    slug: summary.slug,
    title: summary.title,
    backend: summary.backend,
    actions: summary.actions,
    connected: connection?.status === 'connected',
    status: connection?.status ?? null,
    accountLabel: connection?.accountLabel ?? null,
  }
}

function connectionJson(connection: Connection): Record<string, unknown> {
  return {
    id: connection.id,
    workspaceId: connection.workspaceId,
    slug: connection.slug,
    backend: connection.backend,
    status: connection.status,
    accountLabel: connection.accountLabel,
    connectedBy: connection.connectedBy,
    createdAt: connection.createdAt,
  }
}

function grantJson(grant: ConnectorGrantRow): Record<string, unknown> {
  return {
    id: grant.id,
    workspaceId: grant.workspaceId,
    botId: grant.botId,
    slug: grant.slug,
    access: grant.access,
    actions: grant.actions,
    grantedBy: grant.grantedBy,
    createdAt: grant.createdAt,
  }
}

/** idem 重放：成功只能回 deduped（结果正文未落盘）；被拒回 403 + 首次原因。 */
function replayCall(res: ServerResponse, existing: ConnectorCallRow): void {
  if (existing.ok) {
    return sendJson(res, 200, {
      ok: true,
      deduped: true,
      note: 'idempotent replay: result body was not stored',
    })
  }
  sendJson(res, 403, {
    ok: false,
    deduped: true,
    deniedReason: existing.deniedReason,
    error: {
      code: 'connector.denied',
      message: `connector call replay: ${existing.deniedReason ?? 'denied'}`,
    },
  })
}

function safeRecordCall(store: Store, input: Parameters<typeof recordCall>[1]): void {
  try {
    recordCall(store, input)
  } catch (err) {
    console.error('roost api: failed to record connector call', err)
  }
}

function callFailureResponse(code: string): { status: number; code: string } {
  switch (code) {
    case 'denied':
      return { status: 403, code: 'connector.denied' }
    case 'needs_reauth':
      return { status: 409, code: 'connector.needs_reauth' }
    case 'unavailable':
      return { status: 503, code: 'connector.unavailable' }
    default:
      return { status: 502, code: 'connector.provider_error' }
  }
}

// ---- 鉴权 / 路径 / 输入 -----------------------------------------------------

async function requireAuth(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ accountId: string } | null> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
    return null
  }
  return { accountId: auth.session.accountId }
}

/** 连接器数据面全部在 SQLite 里；memory port 一律 503。 */
function requireStore(ctx: Ctx, res: ServerResponse): Store | null {
  if (ctx.rawStore !== undefined) return ctx.rawStore
  sendError(res, 503, 'runtime.not_configured', 'connectors need the SQLite store')
  return null
}

function isAdmin(store: Store, workspaceId: string, accountId: string): boolean {
  const role: WorkspaceRole | null = getWorkspaceRole(store, workspaceId, accountId)
  return role === 'owner' || role === 'admin'
}

/** `/api/connectors/<slug>[/<suffix>]`；suffix='' 表示只到 slug。 */
function slugFromPath(pathname: string, suffix: string): string | null {
  const prefix = '/api/connectors/'
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  if (suffix !== '') {
    if (!rest.endsWith(`/${suffix}`)) return null
    return decodeSlug(rest.slice(0, -suffix.length - 1))
  }
  if (rest.includes('/')) return null
  return decodeSlug(rest)
}

function callbackSlugFromPath(pathname: string): string | null {
  const match = /^\/api\/connectors\/callback\/([^/]+)$/.exec(pathname)
  return match === null ? null : decodeSlug(match[1]!)
}

function decodeSlug(raw: string): string | null {
  try {
    const slug = decodeURIComponent(raw)
    return isConnectorSlug(slug) ? slug : null
  } catch {
    return null
  }
}

function readId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  if (id === '' || id.length > MAX_ID_CHARS) return null
  return id
}

const INVALID = Symbol('invalid')
function readOptionalKey(value: unknown): string | null | typeof INVALID {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return INVALID
  const text = value.trim()
  if (text === '' || text.length > MAX_ID_CHARS) return INVALID
  return text
}

function readActions(value: unknown): string[] | null | typeof INVALID {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.length > MAX_ACTIONS) return INVALID
  const out: string[] = []
  for (const item of value) {
    const text = readText(item, MAX_ACTION_CHARS)
    if (text === null) return INVALID
    if (!out.includes(text)) out.push(text)
  }
  return out.length === 0 ? null : out
}

// ---- 错误映射 ----------------------------------------------------------------

function sendBackendFailure(res: ServerResponse, err: unknown): void {
  if (isConnectorNotConfigured(err)) {
    return sendError(res, 501, 'connector.not_configured', 'no connector gateway is configured')
  }
  console.error('roost api: connector backend failure', err)
  sendError(res, 502, 'connector.unavailable', err instanceof Error ? err.message : String(err))
}

function sendConnectorFailure(res: ServerResponse, err: unknown): void {
  if (err instanceof StoreError) {
    if (err.code === 'WORKSPACE_NOT_FOUND') {
      return sendError(res, 404, 'workspace_not_found', err.message)
    }
    if (err.code === 'INVALID_INPUT') {
      return sendError(res, 400, 'connector.invalid', err.message)
    }
  }
  console.error('roost api: connector store failure', err)
  sendError(res, 500, 'internal_error', 'connector store failure')
}

