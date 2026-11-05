// 模型代理的按 workspace 解析：BYO Key 优先，其次平台 Key + 账号免费额度。
//
// 认证：沙箱 DSH 把 workspace runtime token 作为 Authorization: Bearer 发给 /v1；
// 这里校验 runtime token（workspace/global），再按 x-roost-workspace-id / ROOST_WORKSPACE_ID 归属。
// 真实模型 Key 只在本进程解密后交给 createModelProxy，绝不进沙箱。

import { createModelProxy } from '../../../packages/budget/src/index.ts'
import type { ModelProxyHandler } from '../../../packages/budget/src/index.ts'
import type { RateLimiter } from './rate-limit.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { getWorkspaceModelCredential } from '../../../packages/store/src/model-credentials.ts'
import { consumeTokenCredit, getTokenCreditBalance } from '../../../packages/store/src/token-credits.ts'
import { recordUsage } from '../../../packages/store/src/budget.ts'
import { authorizeRuntimeRequest, storeRuntimeTokenVerifier } from './runtime-token.ts'
import { decryptModelKey } from './model-key-crypto.ts'

export interface ModelProxyResolverContext {
  rawStore?: Store
  runtimeToken?: string
  now: () => number
  masterKey: Buffer | null
  platformKey: string
  platformBase: string
  freeModel: string
  limiter?: RateLimiter
  fetchImpl?: typeof fetch
}

export interface ResolvedModelProxy {
  ok: true
  proxy: ModelProxyHandler
  workspaceId: string
  byo: boolean
  /** 本次允许的模型（免费额度固定为免费模型；BYO 用 workspace 配置）。 */
  model: string
  baseUrl: string
}

export interface ResolveModelProxyError {
  ok: false
  status: number
  code: string
  message: string
}

export type ModelProxyResolution = ResolvedModelProxy | ResolveModelProxyError

export async function resolveModelProxy(
  ctx: ModelProxyResolverContext,
  req: import('node:http').IncomingMessage,
): Promise<ModelProxyResolution> {
  const store = ctx.rawStore
  if (store === undefined) {
    return { ok: false, status: 503, code: 'runtime.not_configured', message: 'model proxy needs the SQLite store' }
  }

  // DSH 只会把 runtime token 当成「模型 API Key」发成 Authorization: Bearer；
  // 这里两种 header 都接受，再交给统一的 runtime token 校验。
  const authHeader = headerValue(req, 'authorization') ?? ''
  const bearer = /^Bearer\s+(\S+)$/i.exec(authHeader)?.[1] ?? null
  const headerToken = headerValue(req, 'x-runtime-token') ?? headerValue(req, 'x-api-key') ?? bearer
  const auth = authorizeRuntimeRequest({
    store: storeRuntimeTokenVerifier(store),
    globalToken: ctx.runtimeToken,
    ...(ctx.now === undefined ? {} : { now: ctx.now() }),
    ...(headerToken === null ? {} : { headerToken })
  })
  if (!auth.ok) return { ok: false, status: 401, code: 'unauthorized', message: 'runtime token required' }

  const headerWorkspace = headerValue(req, 'x-roost-workspace-id') ?? (process.env['ROOST_WORKSPACE_ID'] ?? '').trim()
  const workspaceId = headerWorkspace !== '' ? headerWorkspace : auth.workspaceId ?? ''
  if (workspaceId === '') return { ok: false, status: 400, code: 'workspace_required', message: 'workspace id is required' }
  if (auth.workspaceId !== null && auth.workspaceId !== workspaceId) {
    return { ok: false, status: 403, code: 'forbidden_workspace', message: 'runtime token belongs to another workspace' }
  }

  const owner = store.db.prepare('SELECT tenant_id FROM workspaces WHERE id = ?').get(workspaceId) as
    | { tenant_id?: string }
    | undefined
  if (owner === undefined || typeof owner.tenant_id !== 'string' || owner.tenant_id === '') {
    return { ok: false, status: 404, code: 'workspace_not_found', message: `unknown workspace ${workspaceId}` }
  }
  const accountId = owner.tenant_id
  const at = ctx.now()

  const credential = getWorkspaceModelCredential(store, workspaceId)
  let key = ''
  let baseUrl = ctx.platformBase
  let model = ctx.freeModel
  let byo = false
  if (credential !== null) {
    if (ctx.masterKey === null) {
      return { ok: false, status: 503, code: 'model_key_secret_missing', message: 'ROOST_MODEL_KEY_SECRET is not configured' }
    }
    try {
      key = decryptModelKey(credential, ctx.masterKey)
    } catch {
      return { ok: false, status: 500, code: 'model_key_corrupt', message: 'stored model key could not be decrypted' }
    }
    baseUrl = credential.baseUrl
    model = credential.model
    byo = true
  } else {
    if (ctx.platformKey.trim() === '') {
      return { ok: false, status: 503, code: 'platform_model_key_missing', message: 'no BYO key and no platform model key configured' }
    }
    key = ctx.platformKey.trim()
    const balance = getTokenCreditBalance(store, accountId, at)
    if (balance.balance <= 0) {
      return {
        ok: false,
        status: 402,
        code: 'quota_exceeded',
        message: 'free token balance is exhausted; add your own model key or top up'
      }
    }
  }

  const upstreamBase = stripV1(baseUrl)
  const messages = requestPath(req) === '/v1/messages'
  if (messages && credential !== null && (credential.provider !== 'deepseek' || baseUrl !== 'https://api.deepseek.com')) {
    // 当前只对 DeepSeek 官方端点支持 Messages 透传；OpenAI-compatible 的自定义端点暂不支持 DSH 的 Messages 协议。
    if (credential.provider !== 'deepseek') {
      return { ok: false, status: 501, code: 'messages_not_supported', message: 'DSH Messages protocol currently requires a DeepSeek provider' }
    }
  }
  const upstreamPath = messages
    ? (upstreamBase.endsWith('/anthropic') ? '/v1/messages' : '/anthropic/v1/messages')
    : '/v1/chat/completions'
  const proxy = createModelProxy({
    upstreamBase,
    upstreamPath,
    ...(byo ? { forcedModel: model } : { forcedModel: ctx.freeModel }),
    key,
    ...(ctx.limiter === undefined ? {} : { limiter: ctx.limiter }),
    ...(ctx.fetchImpl === undefined ? {} : { fetchImpl: ctx.fetchImpl }),
    recordUsage: (usage) => {
      try {
        recordUsage(store, {
          workspaceId,
          source: usage.estimated ? 'estimated' : 'provider_report',
          idem: usage.idem,
          at: usage.at,
          outputTokens: usage.tokens
        })
      } catch {
        // 记账失败不影响响应。
      }
      if (!byo && usage.tokens > 0) {
        try {
          consumeTokenCredit(store, {
            accountId,
            tokens: usage.tokens,
            reason: 'model_usage',
            idem: usage.idem,
            at: usage.at
          })
        } catch {
          // 扣额度失败不能把已经完成的模型响应变成错误；下一次请求会因余额不足被拦。
        }
      }
    }
  })

  return { ok: true, proxy, workspaceId, byo, model, baseUrl: upstreamBase }
}

function requestPath(req: import('node:http').IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://control-plane.local').pathname
  } catch {
    return ''
  }
}

function stripV1(base: string): string {
  const trimmed = base.replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed
}

function headerValue(req: import('node:http').IncomingMessage, name: string): string | null {
  const raw = req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}
