// 模型代理（budget.md §2、§6；wave2 §B）。
//
// 目标：runtime 的模型调用统一从这里走，控制面据此按每次响应的 usage 记 token 账。
//   * 只接受 POST；请求体与请求头透传（去掉客户端的 authorization，换成 options.key）；
//   * 非流式：读 `usage.prompt_tokens` / `usage.completion_tokens`；
//   * 流式（text/event-stream）：边转发边解析尾块 usage，拿不到时按字符数估算并标 estimated；
//   * 429 由注入的 limiter 决定，上游 4xx/5xx 原样回传，网络错误 502 upstream_unavailable；
//   * 任何错误正文与日志都不包含 key（本模块不打印 key，也不回显上游请求头）。
//
// 零依赖：node:http 的 req/res + 全局 fetch（可注入）。

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const DEFAULT_UPSTREAM_PATH = '/v1/chat/completions'
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024

/** 路由层用它把解析好的 workspaceId 交给代理（避免代理再猜一遍来源）。 */
export const PROXY_WORKSPACE = Symbol.for('roost.modelProxy.workspaceId')

const WORKSPACE_HEADERS = ['x-roost-workspace-id', 'x-workspace-id'] as const

/** 代理记账回调的入参；字段与 wave2 §B 的契约一致。 */
export interface ProxyUsageRecord {
  workspaceId: string
  /** prompt + completion。 */
  tokens: number
  /** true = 上游没给 usage，按字符数估算。 */
  estimated: boolean
  at: number
  idem: string
}

export type RecordUsageFn = (usage: ProxyUsageRecord) => void | Promise<void>

/** 与 apps/api/src/rate-limit.ts 的 RateLimiter 结构兼容（kind 用 'modelProxy'）。 */
export interface ProxyLimiter {
  consume(kind: string, key: string, now: number): number | null
}

export interface ModelProxyOptions {
  /** 上游基址，例如 https://api.deepseek.com（可带路径前缀）。 */
  upstreamBase: string
  /** 转发到上游的路径；默认 /v1/chat/completions。 */
  upstreamPath?: string
  /** 上游 Bearer key；只放进 Authorization，不落日志。 */
  key: string
  /** 固定模型：请求体里的 model 被改写成它（免费额度只允许免费模型）。 */
  forcedModel?: string
  /** 注入 fetch（测试/自定义传输）；默认全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 记账回调（生产注入 store.recordUsage，测试注入采集器）。 */
  recordUsage?: RecordUsageFn
  /** 进入上游前的限流；返回 null 放行，返回数字是 Retry-After 秒。 */
  limiter?: ProxyLimiter
  /** 注入时钟；默认 Date.now。 */
  now?: () => number
  /** 从请求里解析 workspaceId；未提供时读 request symbol / x-roost-workspace-id 头。 */
  workspaceIdFrom?: (req: IncomingMessage) => string | null
  /** 固定 workspaceId（单工作区部署的兜底）；请求上解析到值时优先。 */
  workspaceId?: string
  /** 请求体上限，默认 10 MiB。 */
  maxBodyBytes?: number
}

export type ModelProxyHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

interface TokenUsage {
  input: number
  output: number
}

interface SseState {
  pending: string
  usage: TokenUsage | null
  contentChars: number
}

const HOP_BY_HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
  'content-length',
])

/** 内部头不向上游透传；authorization 单独换成 options.key。 */
const INTERNAL_HEADERS = new Set(['authorization', 'x-runtime-token'])

function headerValue(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name]
  if (raw === undefined) return null
  const value = Array.isArray(raw) ? raw.join(', ') : raw
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** 路由层用它把 workspaceId 挂到请求上，代理无需再解析 URL/鉴权。 */
export function setProxyWorkspace(req: IncomingMessage, workspaceId: string): void {
  ;(req as unknown as Record<symbol, string>)[PROXY_WORKSPACE] = workspaceId
}

/**
 * 解析本次调用的 workspaceId：
 *   1. options.workspaceIdFrom（调用方注入）；
 *   2. 路由层 setProxyWorkspace 挂上的 symbol；
 *   3. x-roost-workspace-id / x-workspace-id 请求头。
 */
export function resolveProxyWorkspace(
  req: IncomingMessage,
  workspaceIdFrom?: (req: IncomingMessage) => string | null,
  fallback?: string,
): string | null {
  const fromOption = workspaceIdFrom === undefined ? null : normalizeId(workspaceIdFrom(req))
  if (fromOption !== null) return fromOption
  const fromSymbol = normalizeId((req as unknown as Record<symbol, unknown>)[PROXY_WORKSPACE])
  if (fromSymbol !== null) return fromSymbol
  for (const name of WORKSPACE_HEADERS) {
    const fromHeader = normalizeId(headerValue(req, name))
    if (fromHeader !== null) return fromHeader
  }
  return normalizeId(fallback)
}

function normalizeId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id === '' ? null : id
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.writableEnded) return
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { ok: false, error: { code, message } }, headers)
}

function joinUpstream(base: string, path: string): string {
  const normalizedBase = base.replace(/\/+$/, '')
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${normalizedBase}${normalizedPath}`
}

function forwardHeaders(req: IncomingMessage, key: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || INTERNAL_HEADERS.has(lower)) continue
    if (lower === 'x-api-key') continue
    if (lower.startsWith('x-roost-')) continue
    if (value === undefined) continue
    headers[lower] = Array.isArray(value) ? value.join(', ') : value
  }
  if (key !== '') {
    headers['authorization'] = `Bearer ${key}`
    // DSH 的 Messages 传输发 x-api-key；上游可能是 Anthropic 兼容端点。
    headers['x-api-key'] = key
  }
  return headers
}

interface ReadBodyResult {
  ok: boolean
  body?: Buffer
  status?: number
  code?: string
  message?: string
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<ReadBodyResult> {
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  try {
    for await (const chunk of req) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
      size += buf.byteLength
      if (size > maxBytes) {
        tooLarge = true
        chunks.length = 0
        continue
      }
      if (!tooLarge) chunks.push(buf)
    }
  } catch {
    return { ok: false, status: 400, code: 'invalid_body', message: 'could not read request body' }
  }
  if (tooLarge) {
    return {
      ok: false,
      status: 413,
      code: 'payload_too_large',
      message: `request body exceeds ${maxBytes} bytes`,
    }
  }
  return { ok: true, body: Buffer.concat(chunks) }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null
}

/** 从任意 JSON 对象里取 `usage.prompt_tokens/completion_tokens`（兼容 input/output 命名）。 */
function usageFromPayload(value: unknown): TokenUsage | null {
  const record = asRecord(value)
  if (record === null) return null
  // Anthropic Messages：message_start 把 usage 放在 message 里，message_delta 放顶层。
  const usage = asRecord(record['usage']) ?? asRecord(asRecord(record['message'])?.['usage'])
  if (usage === null) return null
  const input = readTokenCount(usage['prompt_tokens']) ?? readTokenCount(usage['input_tokens'])
  const output = readTokenCount(usage['completion_tokens']) ?? readTokenCount(usage['output_tokens'])
  if (input === null && output === null) return null
  return { input: input ?? 0, output: output ?? 0 }
}

/** 取一条响应/流事件里的可见文本，用于无 usage 时的字符估算。 */
function contentFromPayload(value: unknown): string | null {
  const record = asRecord(value)
  if (record === null) return null
  const anthropicDelta = asRecord(record['delta'])
  const anthropicText = textOf(anthropicDelta?.['text'])
  if (anthropicText !== null) return anthropicText
  const block = asRecord(record['content_block'])
  const blockText = textOf(block?.['text'])
  if (blockText !== null) return blockText

  const choices = record['choices']
  if (!Array.isArray(choices) || choices.length === 0) return null
  const choice = asRecord(choices[0])
  if (choice === null) return null
  const delta = asRecord(choice['delta'])
  const message = asRecord(choice['message'])
  return (
    textOf(delta?.['content']) ??
    textOf(choice['text']) ??
    textOf(message?.['content']) ??
    null
  )
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return null
  let text = ''
  for (const part of value) {
    const record = asRecord(part)
    const piece = record === null ? null : textOf(record['text'])
    if (piece !== null) text += piece
  }
  return text
}

/** 字符数 → token 估算（约 4 字符/token，向上取整）。 */
export function estimateTokens(chars: number): number {
  return Number.isFinite(chars) && chars > 0 ? Math.ceil(chars / 4) : 0
}

/** 估算 prompt 字符数：优先数 messages 的文本，否则退回原始 body 长度。 */
export function promptChars(body: Buffer): number {
  const text = body.toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return text.length
  }
  const record = asRecord(parsed)
  if (record === null) return text.length
  const messages = record['messages']
  if (Array.isArray(messages)) {
    let chars = 0
    for (const message of messages) {
      const entry = asRecord(message)
      if (entry === null) continue
      chars += textOf(entry['content'])?.length ?? 0
      chars += textOf(entry['reasoning_content'])?.length ?? 0
    }
    return chars
  }
  const direct = textOf(record['prompt']) ?? textOf(record['input'])
  return direct === null ? text.length : direct.length
}

function createSseState(): SseState {
  return { pending: '', usage: null, contentChars: 0 }
}

function processSseLine(state: SseState, line: string): void {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
  if (!trimmed.startsWith('data:')) return
  const data = trimmed.slice(5).trim()
  if (data === '' || data === '[DONE]') return
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return
  }
  const usage = usageFromPayload(payload)
  if (usage !== null) {
    // 流式 usage 是累计值；不同帧可能只带 input 或 output，逐字段取最大。
    state.usage = {
      input: Math.max(state.usage?.input ?? 0, usage.input),
      output: Math.max(state.usage?.output ?? 0, usage.output)
    }
  }
  const content = contentFromPayload(payload)
  if (content !== null) state.contentChars += content.length
}

/** 喂入一段 SSE 文本；跨 chunk 的半行留在 pending 里。 */
function pushSseText(state: SseState, text: string): void {
  state.pending += text
  let index = state.pending.indexOf('\n')
  while (index !== -1) {
    processSseLine(state, state.pending.slice(0, index))
    state.pending = state.pending.slice(index + 1)
    index = state.pending.indexOf('\n')
  }
  // 防御：上游若一直不发换行，别让 pending 无限长（usage 一般在尾部）。
  if (state.pending.length > 1_000_000) {
    state.pending = state.pending.slice(-1_000_000)
  }
}

function finishSse(state: SseState): void {
  if (state.pending !== '') {
    processSseLine(state, state.pending)
    state.pending = ''
  }
}

function responseFromJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function usageRecord(
  workspaceId: string,
  inputTokens: number | null,
  outputTokens: number | null,
  inputFallbackChars: number,
  outputFallbackChars: number,
  at: number,
  idem: string,
): ProxyUsageRecord {
  if (inputTokens !== null || outputTokens !== null) {
    return {
      workspaceId,
      tokens: (inputTokens ?? 0) + (outputTokens ?? 0),
      estimated: false,
      at,
      idem,
    }
  }
  return {
    workspaceId,
    tokens: estimateTokens(inputFallbackChars) + estimateTokens(outputFallbackChars),
    estimated: true,
    at,
    idem,
  }
}

async function recordSafely(recordUsage: RecordUsageFn | undefined, usage: ProxyUsageRecord): Promise<void> {
  if (recordUsage === undefined) return
  try {
    await recordUsage(usage)
  } catch {
    // 记账失败不能把已经回来的模型响应吞掉；调用方会从 store 的失败告警里看到。
  }
}

function idemFor(req: IncomingMessage, workspaceId: string): string {
  const explicit =
    headerValue(req, 'x-roost-idem') ??
    headerValue(req, 'idempotency-key') ??
    headerValue(req, 'x-request-id')
  return `model:${workspaceId}:${explicit ?? randomUUID()}`
}

/**
 * 创建代理处理函数。返回 `(req, res) => Promise<void>`，可直接挂到 node:http。
 */
export function createModelProxy(options: ModelProxyOptions): ModelProxyHandler {
  if (typeof options.upstreamBase !== 'string' || options.upstreamBase.trim() === '') {
    throw new Error('model proxy requires upstreamBase')
  }
  let parsedBase: URL
  try {
    parsedBase = new URL(options.upstreamBase)
  } catch {
    throw new Error('model proxy upstreamBase must be a valid URL')
  }
  if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
    throw new Error('model proxy upstreamBase must be http or https')
  }

  const upstreamPath = options.upstreamPath ?? DEFAULT_UPSTREAM_PATH
  const upstreamUrl = joinUpstream(options.upstreamBase, upstreamPath)
  const key = typeof options.key === 'string' ? options.key : ''
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const clock = options.now ?? Date.now

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendError(res, 405, 'method_not_allowed', 'model proxy only accepts POST', { allow: 'POST' })
      return
    }

    const workspaceId = resolveProxyWorkspace(req, options.workspaceIdFrom, options.workspaceId)
    if (workspaceId === null) {
      sendError(res, 400, 'workspace_required', 'workspaceId is required for model metering')
      return
    }

    const now = clock()
    if (options.limiter !== undefined) {
      const retryAfter = options.limiter.consume('modelProxy', workspaceId, now)
      if (retryAfter !== null && retryAfter !== undefined) {
        sendError(res, 429, 'rate_limited', 'too many model calls', {
          'retry-after': String(Math.max(1, Math.ceil(retryAfter))),
        })
        return
      }
    }

    const read = await readRequestBody(req, maxBodyBytes)
    if (!read.ok || read.body === undefined) {
      sendError(res, read.status ?? 400, read.code ?? 'invalid_body', read.message ?? 'invalid body')
      return
    }
    let body = read.body
    if (options.forcedModel !== undefined) {
      try {
        const parsed = JSON.parse(body.toString('utf8')) as unknown
        const record = asRecord(parsed)
        if (record === null) {
          sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
          return
        }
        body = Buffer.from(JSON.stringify({ ...record, model: options.forcedModel }), 'utf8')
      } catch {
        sendError(res, 400, 'invalid_json', 'request body is not valid JSON')
        return
      }
    }
    const idem = idemFor(req, workspaceId)
    const inputChars = promptChars(body)
    const headers = forwardHeaders(req, key)

    let upstream: Response
    try {
      upstream = await fetchImpl(upstreamUrl, {
        method: 'POST',
        headers,
        body: body.byteLength === 0 ? undefined : body,
      })
    } catch {
      sendError(res, 502, 'upstream_unavailable', 'model upstream is unavailable')
      return
    }

    const contentType = upstream.headers.get('content-type')
    const retryAfter = upstream.headers.get('retry-after')
    const extra: Record<string, string> = retryAfter === null ? {} : { 'retry-after': retryAfter }
    const streaming = contentType !== null && contentType.toLowerCase().includes('text/event-stream')

    // 上游错误原样回传状态与 body，不记账。
    if (upstream.status < 200 || upstream.status >= 300) {
      let payload: Buffer
      try {
        payload = Buffer.from(await upstream.arrayBuffer())
      } catch {
        sendError(res, 502, 'upstream_unavailable', 'model upstream is unavailable')
        return
      }
      writeRaw(res, upstream.status, payload, contentType, extra)
      return
    }

    if (!streaming) {
      let text: string
      try {
        text = await upstream.text()
      } catch {
        sendError(res, 502, 'upstream_unavailable', 'model upstream is unavailable')
        return
      }
      const parsed = responseFromJson(text)
      const usage = usageFromPayload(parsed)
      const outputChars = contentFromPayload(parsed)?.length ?? text.length
      const record = usageRecord(
        workspaceId,
        usage?.input ?? null,
        usage?.output ?? null,
        inputChars,
        outputChars,
        now,
        idem,
      )
      await recordSafely(options.recordUsage, record)
      writeRaw(
        res,
        upstream.status,
        Buffer.from(text, 'utf8'),
        contentType ?? 'application/json; charset=utf-8',
        extra,
      )
      return
    }

    // 流式：先发头，边转发边解析；usage 通常在最后一帧。
    if (!res.headersSent) {
      res.writeHead(upstream.status, {
        'content-type': contentType ?? 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...extra,
      })
    }
    const state = createSseState()
    const decoder = new TextDecoder()
    const upstreamBody = upstream.body
    if (upstreamBody !== null) {
      const reader = upstreamBody.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value === undefined) continue
          pushSseText(state, decoder.decode(value, { stream: true }))
          if (!res.writableEnded && !res.destroyed) {
            try {
              res.write(value)
            } catch {
              // 客户端断开后继续读完上游，账还是要记。
            }
          }
        }
      } catch {
        // 上游中途断开：已转发的部分照常结束，usage 可能缺失 → 估算。
      } finally {
        try {
          reader.releaseLock()
        } catch {
          // ignore
        }
      }
    }
    pushSseText(state, decoder.decode())
    finishSse(state)

    const record = usageRecord(
      workspaceId,
      state.usage?.input ?? null,
      state.usage?.output ?? null,
      inputChars,
      state.contentChars,
      now,
      idem,
    )
    await recordSafely(options.recordUsage, record)
    if (!res.writableEnded) res.end()
  }
}

function writeRaw(
  res: ServerResponse,
  status: number,
  payload: Buffer,
  contentType: string | null,
  headers: Record<string, string> = {},
): void {
  if (res.writableEnded) return
  res.writeHead(status, {
    'content-type': contentType ?? 'application/octet-stream',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}
