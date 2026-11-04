// Composio 托管网关后端（M6-6.1.7 / wave2 §C）。
//
// 与 HttpGatewayBackend 的差别：Composio 的 OAuth 与工具调用都绑定「连接账号」
// （connectedAccount），而不是 slug。因此本模块除了实现 GatewayBackend
// （listConnectors/authorize/call/status）外，还提供 workspace/user 视角的方法：
//
//   listConnections({ workspaceId, userId, connector? }) → ComposioConnection[]
//   authorize({ workspaceId, userId, connector, redirectUri }) → { url, connectionId? }
//   call({ workspaceId, userId, connector, action, args }) → CallResult
//
// 为了兼容既有调用方（server / factory），authorize 同时接受 `(slug, {workspaceId,
// state})`、call 同时接受 `(ConnectorCall, ConnectorGrant)`；两种形式都走同一套
// 请求，state 只属于调用方，不发给 Composio。
//
// 请求形状（base 可带路径前缀，默认 https://backend.composio.dev）：
//   GET  /api/v1/connectedAccounts?user_id=<userId>[&appName=<connector>]
//        → { items: [{ id, appName, status, accountLabel?, createdAt? }] } 或数组
//   POST /api/v1/connectedAccounts
//        body { appName, userId, workspaceId, redirectUri? }
//        → { redirectUrl | redirect_url | url, id? }
//   GET  /api/v1/connectedAccounts/{id}
//        → { id, appName, status, accountLabel? }
//   POST /api/v1/tools/execute/{action}
//        body { connected_account_id, user_id, arguments, idempotency_key? }
//        → { ok:true, data } | { successful:true, data } | { ok:false, message }
//
// 鉴权：key 只放 `x-api-key` 头；不进日志，也不进错误 message（错误正文先抹 key
// 再截断）。env：
//   ROOST_COMPOSIO_BASE_URL   网关 base URL；空 = 未配置
//   ROOST_COMPOSIO_API_KEY    API key；空 = 未配置
//   ROOST_COMPOSIO_TIMEOUT_MS 单次请求超时（默认 15000）
//
// 错误映射：缺配置 → `connector.not_configured`；HTTP/网络/超时 → `connector.upstream`。
// listConnections/authorize/status 抛 ComposioError（带 code，API 层据此 501/502）；
// call 遵循 CallResult 契约不抛，把同一个 code 写进 reason（code 用 unavailable /
// needs_reauth），方便上层区分「没配」「上游挂了」「要重连」。
//
// 零依赖：node:http / node:https。

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

import {
  MAX_ERROR_CHARS,
  MAX_RESPONSE_BYTES,
  byteLength,
  codeForHttpStatus,
  isRecord,
  messageFromBody,
  normalizeBaseUrl,
} from './http-utils.ts'
import { CONNECTOR_NOT_CONFIGURED } from './stub.ts'
import type {
  CallResult,
  ConnectionStatus,
  ConnectorAuthorizeOptions,
  ConnectorCall,
  ConnectorGrant,
  ConnectorStatusOptions,
  ConnectorSummary,
  GatewayBackend,
  GatewayBackendId,
} from './types.ts'

/** 上游/传输错误码前缀；与 connector.not_configured 同级。 */
export const CONNECTOR_UPSTREAM = 'connector.upstream'

export const DEFAULT_COMPOSIO_TIMEOUT_MS = 15_000

export type ComposioErrorCode = typeof CONNECTOR_NOT_CONFIGURED | typeof CONNECTOR_UPSTREAM

/** 只描述「没配」或「上游不可用」，绝不携带 api key。 */
export class ComposioError extends Error {
  readonly code: ComposioErrorCode
  readonly status: number | undefined

  constructor(code: ComposioErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'ComposioError'
    this.code = code
    this.status = status
  }
}

export interface ComposioBackendOptions {
  /** 含协议与可选路径前缀；空字符串表示未配置（不抛，方法调用时映射错误）。 */
  baseUrl?: string
  /** API key；空字符串表示未配置。 */
  apiKey?: string
  /** 单次请求超时，默认 15000ms。 */
  timeoutMs?: number
}

export interface ComposioConnection {
  /** Composio connectedAccount id。 */
  id: string
  /** 连接器 slug（Composio 的 appName）。 */
  connector: string
  status: ConnectionStatus
  /** 展示用账号标签（如邮箱）；绝不包含 token。 */
  accountLabel?: string
}

export interface ComposioListConnectionsInput {
  workspaceId: string
  userId: string
  /** 只列某个连接器的连接。 */
  connector?: string
}

export interface ComposioAuthorizeInput {
  workspaceId: string
  userId: string
  connector: string
  /** OAuth 完成后回到的地址。 */
  redirectUri: string
}

export interface ComposioCallInput {
  workspaceId: string
  userId: string
  connector: string
  action: string
  args?: unknown
  /** 幂等键；有副作用的动作建议必填。 */
  idem?: string
}

interface ComposioResponse {
  status: number
  body: unknown
  raw: string
}

/** 从 env 读 Composio 配置；空字符串保持为空（= 未配置）。 */
export function composioOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): ComposioBackendOptions {
  const baseUrl = (env['ROOST_COMPOSIO_BASE_URL'] ?? '').trim()
  const apiKey = (env['ROOST_COMPOSIO_API_KEY'] ?? '').trim()
  const timeoutMs = parseTimeoutMs(env['ROOST_COMPOSIO_TIMEOUT_MS'])
  return {
    baseUrl,
    apiKey,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

function parseTimeoutMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}

const CALL_FAILURE_CODES = new Set(['denied', 'unavailable', 'needs_reauth', 'provider_error'])
type CallFailureCode = 'denied' | 'unavailable' | 'needs_reauth' | 'provider_error'

export class ComposioGatewayBackend implements GatewayBackend {
  readonly id: GatewayBackendId = 'composio'
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number

  constructor(options: ComposioBackendOptions = {}) {
    const baseUrl = (options.baseUrl ?? '').trim()
    // 空 = 未配置，允许构造；非空则必须是合法 http(s) URL。
    this.baseUrl = baseUrl === '' ? '' : normalizeBaseUrl(baseUrl)
    this.apiKey = (options.apiKey ?? '').trim()
    const timeout = options.timeoutMs ?? DEFAULT_COMPOSIO_TIMEOUT_MS
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error('composio timeoutMs must be a positive number')
    }
    this.timeoutMs = Math.floor(timeout)
  }

  /** BASE_URL 与 API_KEY 都在才算配置完成。 */
  get configured(): boolean {
    return this.baseUrl !== '' && this.apiKey !== ''
  }

  // ---- GatewayBackend ------------------------------------------------------

  /** Composio 的目录是按用户连接账号派生的，没有 workspace 上下文时返回空。 */
  async listConnectors(): Promise<ConnectorSummary[]> {
    this.assertConfigured('listConnectors')
    return []
  }

  async authorize(
    slugOrInput: string | ComposioAuthorizeInput,
    options: ConnectorAuthorizeOptions = {},
  ): Promise<{ url: string; connectionId?: string }> {
    this.assertConfigured('authorize')
    const input: { workspaceId?: string; userId?: string; connector: string; redirectUri?: string } =
      typeof slugOrInput === 'string'
        ? { connector: slugOrInput, workspaceId: options.workspaceId }
        : {
            connector: slugOrInput.connector,
            workspaceId: slugOrInput.workspaceId,
            userId: slugOrInput.userId,
            redirectUri: slugOrInput.redirectUri,
          }
    if (input.connector.trim() === '') {
      throw new ComposioError(CONNECTOR_UPSTREAM, 'composio authorize requires a connector')
    }

    const body: Record<string, unknown> = { appName: input.connector }
    if (input.workspaceId !== undefined) body['workspaceId'] = input.workspaceId
    if (input.userId !== undefined) body['userId'] = input.userId
    if (input.redirectUri !== undefined) body['redirectUri'] = input.redirectUri

    const response = await this.request('POST', '/api/v1/connectedAccounts', body)
    if (response.status < 200 || response.status >= 300) {
      throw new ComposioError(
        CONNECTOR_UPSTREAM,
        this.describeHttp(response, 'authorize'),
        response.status,
      )
    }
    const value = response.body
    const url = isRecord(value)
      ? firstString(value, ['redirectUrl', 'redirect_url', 'url'])
      : undefined
    if (url === undefined || url.trim() === '') {
      throw new ComposioError(CONNECTOR_UPSTREAM, 'composio authorize returned no redirect url')
    }
    const connectionId = isRecord(value) ? firstString(value, ['id', 'connectionId']) : undefined
    return connectionId === undefined ? { url } : { url, connectionId }
  }

  async status(
    slug: string,
    options: ConnectorStatusOptions & { userId?: string } = {},
  ): Promise<ConnectionStatus> {
    this.assertConfigured('status')
    if (options.userId === undefined || options.userId.trim() === '') return 'revoked'
    const connections = await this.listConnections({
      workspaceId: options.workspaceId ?? '',
      userId: options.userId,
      connector: slug,
    }).then((items) => items.filter((connection) => connection.connector === slug))
    const active = connections.find((connection) => connection.status === 'connected')
    if (active !== undefined) return 'connected'
    return connections.some((connection) => connection.status === 'expired')
      ? 'expired'
      : 'revoked'
  }

  async call(
    request: ConnectorCall | ComposioCallInput,
    grant?: ConnectorGrant,
  ): Promise<CallResult> {
    const input = normalizeCallInput(request)
    if (!this.configured) {
      return {
        ok: false,
        code: 'unavailable',
        reason:
          `${CONNECTOR_NOT_CONFIGURED}: composio backend is not configured ` +
          '(set ROOST_COMPOSIO_BASE_URL and ROOST_COMPOSIO_API_KEY)',
      }
    }
    if (grant !== undefined && grant.slug !== input.connector) {
      // 打错连接器就拒绝，避免拿 A 的授权调 B。
      return {
        ok: false,
        code: 'denied',
        reason: `connector.denied: grant is for ${grant.slug}, call is for ${input.connector}`,
      }
    }
    if (input.connector.trim() === '' || input.action.trim() === '') {
      return {
        ok: false,
        code: 'provider_error',
        reason: 'connector.invalid_request: connector and action are required',
      }
    }

    const connection = await this.findConnection(input)
    if (!connection.ok) return connection.result

    const body: Record<string, unknown> = {
      connected_account_id: connection.value.id,
      user_id: input.userId,
      arguments: input.args ?? {},
    }
    if (input.idem !== undefined) body['idempotency_key'] = input.idem

    let response: ComposioResponse
    try {
      response = await this.request(
        'POST',
        `/api/v1/tools/execute/${encodeURIComponent(input.action)}`,
        body,
      )
    } catch (err) {
      return { ok: false, code: 'unavailable', reason: this.describeError(err) }
    }

    return this.resultFromExecute(response, input.action)
  }

  // ---- workspace/user 视角 --------------------------------------------------

  async listConnections(input: ComposioListConnectionsInput): Promise<ComposioConnection[]> {
    this.assertConfigured('listConnections')
    if (input.userId.trim() === '') {
      throw new ComposioError(CONNECTOR_UPSTREAM, 'composio listConnections requires a userId')
    }
    const query = new URLSearchParams({ user_id: input.userId })
    if (input.connector !== undefined && input.connector.trim() !== '') {
      query.set('appName', input.connector)
    }
    const response = await this.request('GET', `/api/v1/connectedAccounts?${query.toString()}`)
    if (response.status < 200 || response.status >= 300) {
      throw new ComposioError(
        CONNECTOR_UPSTREAM,
        this.describeHttp(response, 'listConnections'),
        response.status,
      )
    }
    return connectionsFromBody(response.body)
  }

  /** 读单个连接账号；404 返回 null，其他错误抛 connector.upstream。 */
  async getConnection(connectionId: string): Promise<ComposioConnection | null> {
    this.assertConfigured('getConnection')
    if (connectionId.trim() === '') {
      throw new ComposioError(CONNECTOR_UPSTREAM, 'composio getConnection requires a connection id')
    }
    const response = await this.request(
      'GET',
      `/api/v1/connectedAccounts/${encodeURIComponent(connectionId)}`,
    )
    if (response.status === 404) return null
    if (response.status < 200 || response.status >= 300) {
      throw new ComposioError(
        CONNECTOR_UPSTREAM,
        this.describeHttp(response, 'getConnection'),
        response.status,
      )
    }
    const body = response.body
    const item = isRecord(body) && Array.isArray(body['items']) ? body['items'][0] : body
    return connectionFromItem(item)
  }

  // ---- 内部 ----------------------------------------------------------------

  private async findConnection(
    input: ComposioCallInput,
  ): Promise<{ ok: true; value: ComposioConnection } | { ok: false; result: CallResult }> {
    let connections: ComposioConnection[]
    try {
      connections = await this.listConnections({
        workspaceId: input.workspaceId,
        userId: input.userId,
        connector: input.connector,
      })
    } catch (err) {
      return { ok: false, result: { ok: false, code: 'unavailable', reason: this.describeError(err) } }
    }

    const active = connections.find(
      (connection) => connection.status === 'connected' && connection.connector === input.connector,
    )
    if (active !== undefined) return { ok: true, value: active }
    if (connections.some((connection) => connection.status === 'expired')) {
      return {
        ok: false,
        result: {
          ok: false,
          code: 'needs_reauth',
          reason: `connector.needs_reauth: ${input.connector} connection expired`,
        },
      }
    }
    return {
      ok: false,
      result: {
        ok: false,
        code: 'needs_reauth',
        reason: `connector.not_connected: no composio connection for ${input.connector}`,
      },
    }
  }

  private resultFromExecute(response: ComposioResponse, action: string): CallResult {
    const body = response.body
    if (isRecord(body)) {
      const okFlag = body['ok'] ?? body['successful'] ?? body['success']
      if (okFlag === true) {
        const data = 'data' in body ? body['data'] : body['result']
        return { ok: true, data, bytes: byteLength(data) }
      }
      if (okFlag === false) {
        const rawCode = body['code']
        const code: CallFailureCode =
          typeof rawCode === 'string' && CALL_FAILURE_CODES.has(rawCode)
            ? (rawCode as CallFailureCode)
            : 'provider_error'
        const message = messageFromBody(body) ?? `composio action ${action} failed`
        return { ok: false, code, reason: this.redact(message) }
      }
    }
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, data: body, bytes: byteLength(body) }
    }
    return {
      ok: false,
      code: codeForHttpStatus(response.status),
      reason: this.describeHttp(response, `execute ${action}`),
    }
  }

  private assertConfigured(operation: string): void {
    if (this.configured) return
    const missing =
      this.baseUrl === ''
        ? 'ROOST_COMPOSIO_BASE_URL'
        : 'ROOST_COMPOSIO_API_KEY'
    throw new ComposioError(
      CONNECTOR_NOT_CONFIGURED,
      `${CONNECTOR_NOT_CONFIGURED}: composio ${operation} requires ${missing}`,
    )
  }

  // ---- HTTP 传输 ------------------------------------------------------------

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<ComposioResponse> {
    const url = new URL(`${this.baseUrl}${path}`)
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-api-key': this.apiKey,
    }
    if (payload !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.byteLength)
    }

    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    return await new Promise<ComposioResponse>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        fn()
      }
      const fail = (err: ComposioError): void => finish(() => reject(err))

      const req = send(url, { method, headers }, (res) => {
        const chunks: Buffer[] = []
        let length = 0
        res.on('data', (chunk: Buffer) => {
          length += chunk.length
          if (length > MAX_RESPONSE_BYTES) {
            res.destroy()
            req.destroy()
            fail(new ComposioError(CONNECTOR_UPSTREAM, 'composio response exceeded size limit'))
            return
          }
          chunks.push(chunk)
        })
        res.on('error', (err: Error) => {
          fail(new ComposioError(CONNECTOR_UPSTREAM, this.redact(err.message)))
        })
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown
          if (raw !== '') {
            try {
              parsed = JSON.parse(raw)
            } catch {
              parsed = undefined
            }
          }
          finish(() => resolve({ status: res.statusCode ?? 0, body: parsed, raw }))
        })
      })

      timer = setTimeout(() => {
        req.destroy()
        fail(
          new ComposioError(
            CONNECTOR_UPSTREAM,
            `composio request timed out after ${this.timeoutMs}ms`,
          ),
        )
      }, this.timeoutMs)
      timer.unref?.()

      req.on('error', (err: Error) => {
        fail(new ComposioError(CONNECTOR_UPSTREAM, this.redact(err.message)))
      })

      if (payload !== undefined) req.write(payload)
      req.end()
    })
  }

  private describeHttp(response: ComposioResponse, operation: string): string {
    const detail =
      messageFromBody(response.body) ?? (response.raw === '' ? 'no response body' : response.raw)
    return this.redact(
      `${CONNECTOR_UPSTREAM}: composio ${operation} failed with HTTP ${response.status}: ${detail}`,
    )
  }

  private describeError(err: unknown): string {
    if (err instanceof ComposioError) {
      const text = err.message.startsWith(err.code) ? err.message : `${err.code}: ${err.message}`
      return this.redact(text)
    }
    const message = err instanceof Error ? err.message : String(err)
    return this.redact(`${CONNECTOR_UPSTREAM}: ${message}`)
  }

  /** 抹掉 key 再截断，避免上游把凭据回显到错误串。 */
  private redact(text: string): string {
    const key = this.apiKey
    const withoutKey = key === '' ? text : text.split(key).join('[redacted]')
    return withoutKey.length > MAX_ERROR_CHARS
      ? `${withoutKey.slice(0, MAX_ERROR_CHARS)}…`
      : withoutKey
  }
}

function normalizeCallInput(request: ConnectorCall | ComposioCallInput): ComposioCallInput {
  if ('connector' in request) {
    return {
      workspaceId: request.workspaceId,
      userId: request.userId,
      connector: request.connector,
      action: request.action,
      args: request.args,
      ...(request.idem === undefined ? {} : { idem: request.idem }),
    }
  }
  // 旧接口只有 botId，没有 userId：Composio 的 user 作用域退化为 workspace，
  // 这样同一 workspace 的连接账号仍能被复用。
  return {
    workspaceId: request.workspaceId,
    userId: request.workspaceId,
    connector: request.slug,
    action: request.action,
    args: request.args,
    ...(request.idem === undefined ? {} : { idem: request.idem }),
  }
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/** Composio 状态 → 本地三态；未知/缺失按 revoked（宁可让上层提示重连）。 */
function statusFromComposio(value: unknown): ConnectionStatus {
  if (typeof value !== 'string') return 'revoked'
  const upper = value.trim().toUpperCase()
  if (upper === 'ACTIVE' || upper === 'CONNECTED' || upper === 'ENABLED') return 'connected'
  if (upper === 'EXPIRED') return 'expired'
  return 'revoked'
}

function connectionFromItem(item: unknown): ComposioConnection | null {
  if (!isRecord(item)) return null
  const id = firstString(item, ['id', 'connectedAccountId', 'connected_account_id'])
  if (id === undefined) return null
  const toolkit = isRecord(item['toolkit']) ? item['toolkit'] : undefined
  const connector =
    firstString(item, ['appName', 'app_name', 'app', 'toolkitSlug', 'toolkit_slug']) ??
    (toolkit === undefined ? undefined : firstString(toolkit, ['slug', 'name']))
  if (connector === undefined) return null
  const status = statusFromComposio(item['status'])
  const accountLabel = firstString(item, [
    'accountLabel',
    'account_label',
    'accountName',
    'account_name',
  ])
  return accountLabel === undefined
    ? { id, connector, status }
    : { id, connector, status, accountLabel }
}

function connectionsFromBody(body: unknown): ComposioConnection[] {
  const items = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body['items'])
      ? body['items']
      : []
  return items.flatMap((item) => {
    const connection = connectionFromItem(item)
    return connection === null ? [] : [connection]
  })
}
