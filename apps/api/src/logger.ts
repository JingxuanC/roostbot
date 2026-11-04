// 结构化 HTTP 日志（M6-6.6）。
//
// 每条日志一行 JSON：{level,time,requestId,method,path,status,durationMs,msg?}。
// 只记录信封，不记录 body；path 里的敏感 query（token / access_token）必须脱敏。
// 这里同时负责请求 id：客户端给了合法值就沿用，否则进程随机生成。

import { randomBytes } from 'node:crypto'

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/
export const REDACTED = '[REDACTED]'

const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'token',
  'access_token',
  'accesstoken'
])

export type HttpLogLevel = 'info' | 'warn' | 'error'

export interface HttpLogEntry {
  level: HttpLogLevel
  time: string
  requestId: string
  method: string
  path: string
  status: number
  durationMs: number
  msg?: string
}

export interface HttpLogInput {
  requestId: string
  method: string
  path: string
  status: number
  durationMs: number
  msg?: string
  /** 测试可注入，默认当前时间。 */
  time?: string
}

/** 客户端请求头 → 请求 id；不合法就随机生成。 */
export function resolveRequestId(raw: string | string[] | undefined): string {
  if (typeof raw === 'string' && REQUEST_ID_PATTERN.test(raw)) return raw
  return randomBytes(16).toString('hex')
}

/** 4xx warn、5xx error，其余 info。 */
export function levelForStatus(status: number): HttpLogLevel {
  if (status >= 500) return 'error'
  if (status >= 400) return 'warn'
  return 'info'
}

/**
 * 构建日志行。path 一定先经过 redactRequestPath，避免调用方漏掉 query token。
 */
export function createHttpLogEntry(input: HttpLogInput): HttpLogEntry {
  const durationMs = Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs)) : 0
  const entry: HttpLogEntry = {
    level: levelForStatus(input.status),
    time: input.time ?? new Date().toISOString(),
    requestId: input.requestId,
    method: input.method,
    path: redactRequestPath(input.path),
    status: input.status,
    durationMs
  }
  if (input.msg !== undefined) entry.msg = input.msg
  return entry
}

/** 默认落 stdout；测试通过 ServerOptions.logSink 注入收集器。 */
export function writeHttpLog(entry: HttpLogEntry): void {
  console.log(JSON.stringify(entry))
}

/** 去掉 query 里的会话凭据；保留其余参数便于排查。 */
export function redactRequestPath(rawUrl: string): string {
  const question = rawUrl.indexOf('?')
  const pathname = question >= 0 ? rawUrl.slice(0, question) : rawUrl
  if (question < 0) return pathname
  try {
    const url = new URL(rawUrl, 'http://log.local')
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) url.searchParams.set(key, REDACTED)
    }
    // URLSearchParams 会把方括号编码；日志里还原成可读的 [REDACTED]。
    return `${url.pathname}${url.search}`.replace(/%5BREDACTED%5D/g, REDACTED)
  } catch {
    return pathname
  }
}

/**
 * 通用脱敏：给未来扩展留的兜底。按 key 判断，authorization/cookie/token 等一律替换。
 * 当前日志不打印 headers，但测试与后续字段扩展可以直接复用。
 */
export function redactForLog(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  if (Array.isArray(value)) {
    const list = value.map((item) => redactForLog(item, seen))
    seen.delete(value)
    return list
  }

  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redactForLog(item, seen)
  }
  seen.delete(value)
  return out
}
