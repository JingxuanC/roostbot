// 网关 HTTP 适配器（M6-6.1.1 OpenConnector / M6-6.1.7 Composio 选择骨架）。
//
// 契约（详见 packages/connectors/README.md 与 docs/design/connectors.md §12）：
//   GET  /connectors                          → [{slug,title,actions:string[]}]
//   POST /authorize  {slug,workspaceId,state} → {url}
//   GET  /status?slug=&workspaceId=           → {status,accountLabel?}
//   POST /call       {slug,action,args,idem,workspaceId,botId}
//                                             → {ok:true,result} | {ok:false,code,message}
//
// 安全：token 只放进 Authorization 头；不写日志、不回显到错误信息，错误正文再截断。
// 零依赖：node:http / node:https。

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import {
  CONNECTION_STATUSES,
  GatewayRequestError,
  MAX_ERROR_CHARS,
  MAX_RESPONSE_BYTES,
  byteLength,
  codeForHttpStatus,
  isRecord,
  messageFromBody,
  normalizeBaseUrl,
  normalizeSummary,
} from './http-utils.ts'
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

export interface HttpGatewayBackendOptions {
  /** 网关 base URL，只接受 http/https，可带路径前缀，不能带 query/hash/凭据。 */
  baseUrl: string
  /** 网关 Bearer token；未配置时不发 Authorization 头。 */
  token?: string
  backendId: GatewayBackendId
  /** 单次请求超时，默认 5000ms。 */
  timeoutMs?: number
}

export const DEFAULT_GATEWAY_TIMEOUT_MS = 5000

type CallResultFailureCode = 'denied' | 'unavailable' | 'needs_reauth' | 'provider_error'
const CALL_FAILURE_CODES = new Set<CallResultFailureCode>([
  'denied',
  'unavailable',
  'needs_reauth',
  'provider_error',
])

interface GatewayResponse {
  status: number
  /** 能解析成 JSON 时是解析结果，否则 undefined。 */
  body: unknown
  /** 原始正文（已按大小上限保护）。 */
  raw: string
}

export class HttpGatewayBackend implements GatewayBackend {
  readonly id: GatewayBackendId
  private readonly baseUrl: string
  private readonly token: string | undefined
  private readonly timeoutMs: number

  constructor(options: HttpGatewayBackendOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.id = options.backendId
    this.token = options.token === undefined || options.token === '' ? undefined : options.token
    const timeout = options.timeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error('connector gateway timeoutMs must be a positive number')
    }
    this.timeoutMs = Math.floor(timeout)
  }

  async listConnectors(): Promise<ConnectorSummary[]> {
    const response = await this.request('GET', '/connectors')
    this.assertOk(response, 'listConnectors')
    if (!Array.isArray(response.body)) {
      throw new GatewayRequestError('protocol', 'gateway /connectors did not return an array')
    }
    return response.body.flatMap((item) => normalizeSummary(item, this.id))
  }

  async authorize(slug: string, options: ConnectorAuthorizeOptions = {}): Promise<{ url: string }> {
    const body: Record<string, unknown> = { slug }
    if (options.workspaceId !== undefined) body['workspaceId'] = options.workspaceId
    if (options.state !== undefined) body['state'] = options.state
    if (options.accountId !== undefined) body['accountId'] = options.accountId
    if (options.connectionAlias !== undefined) body['connectionName'] = options.connectionAlias

    const response = await this.request('POST', '/authorize', body)
    this.assertOk(response, 'authorize')
    const value = response.body
    if (!isRecord(value) || typeof value['url'] !== 'string' || value['url'].trim() === '') {
      throw new GatewayRequestError('protocol', 'gateway /authorize returned no url')
    }
    return { url: value['url'] }
  }

  async status(slug: string, options: ConnectorStatusOptions = {}): Promise<ConnectionStatus> {
    const query = new URLSearchParams({ slug })
    if (options.workspaceId !== undefined) query.set('workspaceId', options.workspaceId)
    if (options.accountId !== undefined) query.set('accountId', options.accountId)
    if (options.connectionAlias !== undefined) query.set('connectionName', options.connectionAlias)

    const response = await this.request('GET', `/status?${query.toString()}`)
    this.assertOk(response, 'status')
    const value = response.body
    const status = isRecord(value) ? value['status'] : undefined
    if (
      typeof status !== 'string' ||
      !(CONNECTION_STATUSES as readonly string[]).includes(status)
    ) {
      throw new GatewayRequestError('protocol', 'gateway /status returned an unknown status')
    }
    return status as ConnectionStatus
  }

  async call(call: ConnectorCall, _grant: ConnectorGrant): Promise<CallResult> {
    const body: Record<string, unknown> = {
      slug: call.slug,
      action: call.action,
      args: call.args ?? {},
      workspaceId: call.workspaceId,
      botId: call.botId,
    }
    if (call.idem !== undefined) body['idem'] = call.idem
    if (call.accountId !== undefined) body['accountId'] = call.accountId
    if (call.connectionAlias !== undefined) body['connectionName'] = call.connectionAlias

    let response: GatewayResponse
    try {
      response = await this.request('POST', '/call', body)
    } catch (err) {
      return { ok: false, code: 'unavailable', reason: this.describeTransportError(err) }
    }

    // 真实网关可能用非 2xx 表达失败；只要正文是契约形状，就按正文映射。
    if (isRecord(response.body) && typeof response.body['ok'] === 'boolean') {
      if (response.body['ok'] === true) {
        const data = response.body['result']
        return { ok: true, data, bytes: byteLength(data) }
      }
      const rawCode = response.body['code']
      const code =
        typeof rawCode === 'string' && CALL_FAILURE_CODES.has(rawCode as CallResultFailureCode)
          ? (rawCode as CallResultFailureCode)
          : 'provider_error'
      const message =
        typeof response.body['message'] === 'string'
          ? response.body['message']
          : `gateway /call failed with HTTP ${response.status}`
      return { ok: false, code, reason: this.redact(message) }
    }

    if (response.status >= 200 && response.status < 300) {
      return { ok: false, code: 'provider_error', reason: 'gateway /call returned a malformed response' }
    }
    return {
      ok: false,
      code: codeForHttpStatus(response.status),
      reason: this.describeHttp(response, 'call'),
    }
  }

  // ---- HTTP 传输 ------------------------------------------------------------

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<GatewayResponse> {
    const url = new URL(`${this.baseUrl}${path}`)
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    const headers: Record<string, string> = { accept: 'application/json' }
    if (payload !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.byteLength)
    }
    if (this.token !== undefined) headers['authorization'] = `Bearer ${this.token}`

    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    return await new Promise<GatewayResponse>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        fn()
      }
      const fail = (err: GatewayRequestError): void => finish(() => reject(err))

      const req = send(url, { method, headers }, (res) => {
        const chunks: Buffer[] = []
        let length = 0
        res.on('data', (chunk: Buffer) => {
          length += chunk.length
          if (length > MAX_RESPONSE_BYTES) {
            res.destroy()
            req.destroy()
            fail(new GatewayRequestError('protocol', 'gateway response exceeded size limit'))
            return
          }
          chunks.push(chunk)
        })
        res.on('error', (err: Error) => {
          fail(new GatewayRequestError('network', this.redact(err.message)))
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
        fail(new GatewayRequestError('timeout', `gateway request timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      timer.unref?.()

      req.on('error', (err: Error) => {
        // 超时分支已经 destroy + fail，这里只处理真正的网络错误。
        fail(new GatewayRequestError('network', this.redact(err.message)))
      })

      if (payload !== undefined) req.write(payload)
      req.end()
    })
  }

  private assertOk(response: GatewayResponse, operation: string): void {
    if (response.status >= 200 && response.status < 300) return
    throw new GatewayRequestError('http', this.describeHttp(response, operation), response.status)
  }

  private describeHttp(response: GatewayResponse, operation: string): string {
    const detail =
      messageFromBody(response.body) ?? (response.raw === '' ? 'no response body' : response.raw)
    return this.redact(`gateway ${operation} failed with HTTP ${response.status}: ${detail}`)
  }

  private describeTransportError(err: unknown): string {
    if (err instanceof GatewayRequestError) {
      return this.redact(err.message)
    }
    return 'gateway request failed'
  }

  /** 截断 + 抹掉 token，避免上游把凭据回显到错误串里。 */
  private redact(text: string): string {
    const withoutToken = this.token === undefined ? text : text.split(this.token).join('[redacted]')
    return withoutToken.length > MAX_ERROR_CHARS
      ? `${withoutToken.slice(0, MAX_ERROR_CHARS)}…`
      : withoutToken
  }
}
