// HttpGatewayBackend 的纯函数与内部错误类型（零依赖）。
// 拆出来只为控制单文件长度；不对外承诺稳定 API。

import type { ConnectorSummary, GatewayBackendId } from './types.ts'

export const MAX_ERROR_CHARS = 200
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
export const CONNECTION_STATUSES = ['connected', 'expired', 'revoked'] as const

export type GatewayErrorKind = 'timeout' | 'network' | 'protocol' | 'http'

/** 适配器内部错误：只描述传输/协议层，绝不携带 token。 */
export class GatewayRequestError extends Error {
  readonly kind: GatewayErrorKind
  readonly status: number | undefined

  constructor(kind: GatewayErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'GatewayRequestError'
    this.kind = kind
    this.status = status
  }
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error('connector gateway baseUrl is required')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('connector gateway baseUrl must be an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('connector gateway baseUrl must be an absolute http(s) URL')
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('connector gateway baseUrl must not contain credentials')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('connector gateway baseUrl must not contain a query or hash')
  }
  return trimmed.replace(/\/+$/, '')
}

/** 契约只给动作名；v0 区分不了读写，统一按 read 展示，实际权限以 grants 为准。 */
export function normalizeSummary(value: unknown, backendId: GatewayBackendId): ConnectorSummary[] {
  if (!isRecord(value)) return []
  const slug = typeof value['slug'] === 'string' ? value['slug'].trim() : ''
  if (slug === '') return []
  const rawTitle = value['title']
  const title = typeof rawTitle === 'string' && rawTitle.trim() !== '' ? rawTitle : slug
  const actions = Array.isArray(value['actions'])
    ? value['actions']
        .filter((action): action is string => typeof action === 'string' && action.trim() !== '')
        .map((name) => ({ name, access: 'read' as const }))
    : []
  return [{ slug, title, backend: backendId, actions }]
}

export function codeForHttpStatus(status: number): 'unavailable' | 'provider_error' {
  if (status === 401 || status === 403) return 'unavailable'
  if (status === 408 || status === 429 || status >= 500) return 'unavailable'
  return 'provider_error'
}

export function messageFromBody(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  if (typeof body['message'] === 'string' && body['message'] !== '') return body['message']
  if (typeof body['error'] === 'string' && body['error'] !== '') return body['error']
  return undefined
}

export function byteLength(value: unknown): number {
  if (value === undefined) return 0
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return 0
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
