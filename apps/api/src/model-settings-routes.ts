// workspace 模型设置（BYO Key）与测试连接。
//
// 只做控制面：Key 加密后存 workspace_model_credentials；响应只回掩码。
// 该模块不实现模型代理；代理在 model-proxy-routes/model-proxy-resolver 里按 workspace 取密文。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { authenticate, isPlainObject, readJsonBody, sendError, sendJson } from './server.ts'
import type { StorePort } from './port.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import {
  deleteWorkspaceModelCredential,
  getWorkspaceModelCredential,
  saveWorkspaceModelCredential,
} from '../../../packages/store/src/model-credentials.ts'
import { getTokenCreditBalance } from '../../../packages/store/src/token-credits.ts'
import { decryptModelKey, encryptModelKey } from './model-key-crypto.ts'

export interface ModelSettingsContext {
  store: StorePort
  rawStore?: Store
  now: () => number
  masterKey: Buffer | null
  freeModel: string
  fetchImpl?: typeof fetch
}

interface Ctx extends ModelSettingsContext {}

export const DEFAULT_FREE_MODEL = 'deepseek-flash'

async function requireAdmin(ctx: Ctx, req: IncomingMessage, res: ServerResponse, workspaceId: string): Promise<string | null> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
    return null
  }
  const workspaces = await ctx.store.listWorkspaces({ accountId: auth.session.accountId })
  const workspace = workspaces.find((entry) => entry.id === workspaceId)
  if (workspace === undefined || (workspace.role !== 'owner' && workspace.role !== 'admin')) {
    sendError(res, 403, 'forbidden', `workspace ${workspaceId} requires owner/admin role`)
    return null
  }
  return auth.session.accountId
}

async function readBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const parsed = await readJsonBody(req)
  if (!parsed.ok) {
    sendError(res, parsed.status, parsed.code, parsed.message)
    return null
  }
  if (!isPlainObject(parsed.value)) {
    sendError(res, 400, 'invalid_body', 'body must be a JSON object')
    return null
  }
  return parsed.value
}

export function modelSettingsJson(ctx: Ctx, workspaceId: string): Record<string, unknown> {
  const credential = ctx.rawStore === undefined ? null : getWorkspaceModelCredential(ctx.rawStore, workspaceId)
  const ownerId = ctx.rawStore === undefined ? null : workspaceOwner(ctx.rawStore, workspaceId)
  const free = ownerId === null || ctx.rawStore === undefined ? null : getTokenCreditBalance(ctx.rawStore, ownerId, ctx.now())
  return {
    byo:
      credential === null
        ? null
        : {
            provider: credential.provider,
            baseUrl: credential.baseUrl,
            model: credential.model,
            keyHint: credential.keyHint,
            updatedAt: credential.updatedAt,
            updatedBy: credential.updatedBy
          },
    free:
      free === null
        ? null
        : { model: ctx.freeModel, balance: free.balance, expiresAt: free.expiresAt }
  }
}

/** GET /api/workspaces/:id/model */
export async function handleGetModelSettings(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
): Promise<void> {
  const accountId = await requireAdmin(ctx, req, res, workspaceId)
  if (accountId === null) return
  if (ctx.rawStore === undefined) {
    sendError(res, 503, 'runtime.not_configured', 'model settings need the SQLite store')
    return
  }
  sendJson(res, 200, { ok: true, ...modelSettingsJson(ctx, workspaceId) })
}

/** PUT /api/workspaces/:id/model */
export async function handlePutModelSettings(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
): Promise<void> {
  const accountId = await requireAdmin(ctx, req, res, workspaceId)
  if (accountId === null) return
  if (ctx.rawStore === undefined) {
    sendError(res, 503, 'runtime.not_configured', 'model settings need the SQLite store')
    return
  }
  if (ctx.masterKey === null) {
    sendError(res, 503, 'model_key_secret_missing', 'ROOST_MODEL_KEY_SECRET is not configured')
    return
  }
  const body = await readBody(req, res)
  if (body === null) return
  const provider = readProvider(body['provider'])
  const baseUrl = readBaseUrl(body['baseUrl'], provider)
  const model = readModel(body['model'])
  if (provider === null || baseUrl === null || model === null) {
    sendError(res, 400, 'invalid_body', 'provider/baseUrl/model is invalid')
    return
  }
  const existing = getWorkspaceModelCredential(ctx.rawStore, workspaceId)
  const rawKey = typeof body['apiKey'] === 'string' ? body['apiKey'].trim() : ''
  let encrypted
  if (rawKey !== '') {
    if (!/^[\x21-\x7e]{8,512}$/.test(rawKey)) {
      sendError(res, 400, 'invalid_body', 'apiKey must be 8..512 printable characters')
      return
    }
    encrypted = encryptModelKey(rawKey, ctx.masterKey)
  } else if (existing !== null) {
    encrypted = {
      keyCiphertext: existing.keyCiphertext,
      keyIv: existing.keyIv,
      keyTag: existing.keyTag,
      keyHint: existing.keyHint
    }
  } else {
    sendError(res, 400, 'invalid_body', 'apiKey is required for a new model credential')
    return
  }
  const saved = saveWorkspaceModelCredential(ctx.rawStore, {
    workspaceId,
    provider,
    baseUrl,
    model,
    ...encrypted,
    updatedBy: accountId,
    at: ctx.now()
  })
  sendJson(res, 200, {
    ok: true,
    byo: {
      provider: saved.provider,
      baseUrl: saved.baseUrl,
      model: saved.model,
      keyHint: saved.keyHint,
      updatedAt: saved.updatedAt,
      updatedBy: saved.updatedBy
    }
  })
}

/** DELETE /api/workspaces/:id/model */
export async function handleDeleteModelSettings(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
): Promise<void> {
  const accountId = await requireAdmin(ctx, req, res, workspaceId)
  if (accountId === null) return
  if (ctx.rawStore === undefined) {
    sendError(res, 503, 'runtime.not_configured', 'model settings need the SQLite store')
    return
  }
  deleteWorkspaceModelCredential(ctx.rawStore, workspaceId)
  sendJson(res, 200, { ok: true, byo: null })
}

/** POST /api/workspaces/:id/model/test：用已保存或 body 里的 Key 做一次最小请求。 */
export async function handleTestModelSettings(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  workspaceId: string,
): Promise<void> {
  const accountId = await requireAdmin(ctx, req, res, workspaceId)
  if (accountId === null) return
  if (ctx.rawStore === undefined) {
    sendError(res, 503, 'runtime.not_configured', 'model settings need the SQLite store')
    return
  }
  const body = await readBody(req, res)
  if (body === null) return
  const existing = getWorkspaceModelCredential(ctx.rawStore, workspaceId)
  const provider = readProvider(body['provider']) ?? existing?.provider ?? 'deepseek'
  const baseUrl = readBaseUrl(body['baseUrl'], provider) ?? existing?.baseUrl ?? null
  const model = readModel(body['model']) ?? existing?.model ?? null
  const rawKey = typeof body['apiKey'] === 'string' ? body['apiKey'].trim() : ''
  let key: string
  if (rawKey !== '') {
    if (!/^[\x21-\x7e]{8,512}$/.test(rawKey)) {
      sendError(res, 400, 'invalid_body', 'apiKey must be 8..512 printable characters')
      return
    }
    key = rawKey
  } else if (existing !== null && ctx.masterKey !== null) {
    try {
      key = decryptModelKey(existing, ctx.masterKey)
    } catch {
      sendError(res, 500, 'model_key_corrupt', 'stored model key could not be decrypted')
      return
    }
  } else {
    sendError(res, 400, 'invalid_body', 'apiKey is required')
    return
  }
  if (baseUrl === null || model === null) {
    sendError(res, 400, 'invalid_body', 'baseUrl/model is required')
    return
  }
  const fetchImpl = ctx.fetchImpl ?? globalThis.fetch
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false
      }),
      signal: controller.signal
    })
    if (!response.ok) {
      sendJson(res, 200, { ok: false, status: response.status, latencyMs: Date.now() - started })
      return
    }
    await response.json().catch(() => null)
    sendJson(res, 200, { ok: true, status: response.status, latencyMs: Date.now() - started })
  } catch (err) {
    sendJson(res, 200, {
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      error: err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'upstream_unreachable'
    })
  } finally {
    clearTimeout(timer)
  }
}

function workspaceOwner(store: Store, workspaceId: string): string | null {
  const row = store.db.prepare('SELECT tenant_id FROM workspaces WHERE id = ?').get(workspaceId) as
    | { tenant_id?: string }
    | undefined
  return typeof row?.tenant_id === 'string' && row.tenant_id !== '' ? row.tenant_id : null
}

function readProvider(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  return /^[a-z][a-z0-9_-]{0,31}$/.test(text) ? text : null
}

function readModel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' || text.length > 80 || /[\s]/.test(text) ? null : text
}

/** 只接受 https；本地开发允许 http 回环。去掉尾部 / 与 /v1，代理统一补 /v1。 */
export function readBaseUrl(value: unknown, provider: string): string | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') {
    if (provider === 'deepseek') return 'https://api.deepseek.com'
    return null
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null
  if (isPrivateHost(url.hostname) && !loopback) return null
  let path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith('/v1')) path = path.slice(0, -3)
  return `${url.origin}${path}`
}

function isPrivateHost(host: string): boolean {
  const text = host.toLowerCase()
  if (text === 'localhost' || text.endsWith('.local') || text.endsWith('.internal')) return true
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (ip === null) return false
  const [a, b] = [Number(ip[1]), Number(ip[2])]
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  )
}
