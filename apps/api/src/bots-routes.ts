// Bot 用户侧 API（docs/build/m4-contract.md §2、docs/design/bots.md §7）。
//
// 路由：
//   GET    /api/bots?workspaceId=
//   POST   /api/bots
//   GET    /api/bots/:id
//   PATCH  /api/bots/:id
//   DELETE /api/bots/:id
//
// 全部走 Bearer 会话；写操作的 Origin 校验在 server.ts 的路由入口统一做（所有写方法）。
// 错误沿用 {ok:false,error:{code,message}}；code 用契约里的点号形式：
//   bot.invalid / bot.name_taken / bot.no_model / bot.not_found / workspace_not_found。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { BOT_LIMITS } from '../../../packages/contract/src/index.ts'
import type { Bot, UpdateBotInput } from '../../../packages/contract/src/index.ts'
import { StoreError } from '../../../packages/store/src/index.ts'
import {
  authenticate,
  isPlainObject,
  readJsonBody,
  sendError,
  sendJson,
} from './server.ts'
import type { StorePort } from './port.ts'

export interface BotsRouteContext {
  store: StorePort
  now: () => number
}

const BOT_EDITABLE_KEYS = [
  'name',
  'role',
  'persona',
  'avatar',
  'skills',
  'toolsAllow',
  'toolsDeny',
  'approval',
  'memoryScopes',
  'model',
  'status',
] as const

export async function handleListBots(
  ctx: BotsRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })

  const raw = url.searchParams.get('workspaceId')
  if (raw !== null) {
    const requested = raw.trim()
    if (requested === '') return sendError(res, 400, 'invalid_body', 'workspaceId must not be empty')
    const resolved = await resolveWorkspace(ctx, auth.session.accountId, requested)
    if (!resolved.ok) return sendError(res, resolved.status, resolved.code, resolved.message)
    return listBotsInWorkspace(ctx, res, auth.session.accountId, resolved.workspaceId)
  }

  // 省略 workspaceId：列该账号所有 workspace 的 Bot（设计文档的 GET /api/bots）。
  return listBotsInWorkspace(ctx, res, auth.session.accountId, undefined)
}

export async function handleCreateBot(ctx: BotsRouteContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const body = parsed.value

  const name = readBotName(body['name'])
  if (name === null) {
    return sendError(res, 400, 'bot.invalid', `name is required (1..${BOT_LIMITS.nameMax} characters)`)
  }
  if (typeof body['model'] !== 'string' || body['model'].trim() === '') {
    return sendError(res, 400, 'bot.no_model', 'model is required when a bot is created (bots.md §2)')
  }
  const model = body['model'].trim()
  if (model.length > 200) {
    return sendError(res, 400, 'bot.invalid', 'model must be at most 200 characters')
  }

  let workspaceId: string
  if (body['workspaceId'] !== undefined) {
    if (typeof body['workspaceId'] !== 'string' || body['workspaceId'].trim() === '') {
      return sendError(res, 400, 'invalid_body', 'workspaceId must be a non-empty string when present')
    }
    const resolved = await resolveWorkspace(ctx, auth.session.accountId, body['workspaceId'].trim())
    if (!resolved.ok) return sendError(res, resolved.status, resolved.code, resolved.message)
    workspaceId = resolved.workspaceId
  } else {
    const owned = await ctx.store.listWorkspaces({ accountId: auth.session.accountId })
    const first = owned[0]
    if (first === undefined) {
      return sendError(res, 409, 'no_workspace', 'create a workspace before adding bots')
    }
    workspaceId = first.id
  }

  const role = readOptionalText(body['role'], BOT_LIMITS.roleMax, true)
  if (role === INVALID) return sendError(res, 400, 'bot.invalid', `role must be at most ${BOT_LIMITS.roleMax} characters`)
  const persona = readOptionalText(body['persona'], BOT_LIMITS.personaMax, true)
  if (persona === INVALID) {
    return sendError(res, 400, 'bot.invalid', `persona must be at most ${BOT_LIMITS.personaMax} characters`)
  }
  const provider = readOptionalText(body['provider'], 120, false)
  if (provider === INVALID) return sendError(res, 400, 'bot.invalid', 'provider must be a non-empty string')
  if (body['avatar'] !== undefined && !isPlainObject(body['avatar'])) {
    return sendError(res, 400, 'bot.invalid', 'avatar must be an object')
  }

  try {
    const bot = await ctx.store.createBot({
      accountId: auth.session.accountId,
      workspaceId,
      name,
      ...(role === undefined ? {} : { role }),
      ...(persona === undefined ? {} : { persona }),
      ...(provider === undefined ? {} : { provider }),
      model,
      ...(body['avatar'] === undefined ? {} : { avatar: body['avatar'] as Bot['avatar'] }),
      now: ctx.now(),
    })
    sendJson(res, 201, { bot })
  } catch (err) {
    sendBotFailure(res, err)
  }
}

export async function handleGetBot(
  ctx: BotsRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const botId = botIdFromPath(url.pathname)
  if (botId === null) return sendError(res, 404, 'not_found', 'malformed bot path')

  try {
    const bot = await ctx.store.getBot({ accountId: auth.session.accountId, botId })
    if (bot === null) return sendError(res, 404, 'bot.not_found', `unknown bot ${botId}`)
    sendJson(res, 200, { bot })
  } catch (err) {
    sendBotFailure(res, err)
  }
}

export async function handlePatchBot(
  ctx: BotsRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const botId = botIdFromPath(url.pathname)
  if (botId === null) return sendError(res, 404, 'not_found', 'malformed bot path')

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }

  const patch: Record<string, unknown> = {}
  for (const key of BOT_EDITABLE_KEYS) {
    if (parsed.value[key] !== undefined) patch[key] = parsed.value[key]
  }
  if (Object.keys(patch).length === 0) {
    return sendError(res, 400, 'bot.invalid', 'nothing to update')
  }

  try {
    const bot = await ctx.store.updateBot({
      accountId: auth.session.accountId,
      botId,
      patch: patch as UpdateBotInput,
    })
    sendJson(res, 200, { bot })
  } catch (err) {
    sendBotFailure(res, err)
  }
}

export async function handleDeleteBot(
  ctx: BotsRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  const botId = botIdFromPath(url.pathname)
  if (botId === null) return sendError(res, 404, 'not_found', 'malformed bot path')

  try {
    await ctx.store.deleteBot({ accountId: auth.session.accountId, botId })
    sendJson(res, 200, { ok: true })
  } catch (err) {
    sendBotFailure(res, err)
  }
}

// ---- 内部 --------------------------------------------------------------------

const INVALID = Symbol('invalid')

async function listBotsInWorkspace(
  ctx: BotsRouteContext,
  res: ServerResponse,
  accountId: string,
  workspaceId: string | undefined,
): Promise<void> {
  try {
    const bots = await ctx.store.listBots({
      accountId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    })
    sendJson(res, 200, { bots })
  } catch (err) {
    sendBotFailure(res, err)
  }
}

type ResolveWorkspaceResult =
  | { ok: true; workspaceId: string }
  | { ok: false; status: number; code: string; message: string }

async function resolveWorkspace(
  ctx: BotsRouteContext,
  accountId: string,
  requested: string,
): Promise<ResolveWorkspaceResult> {
  const owned = await ctx.store.listWorkspaces({ accountId })
  if (!owned.some((workspace) => workspace.id === requested)) {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      message: `account ${accountId} is not a member of workspace ${requested}`,
    }
  }
  return { ok: true, workspaceId: requested }
}

function botIdFromPath(pathname: string): string | null {
  const match = /^\/api\/bots\/([^/]+)$/.exec(pathname.replace(/\/+$/, ''))
  if (match === null) return null
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return null
  }
}

function readBotName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (name === '' || name.length > BOT_LIMITS.nameMax) return null
  return name
}

/** undefined = 没给；INVALID = 给了但格式不对；allowEmpty 时空串是合法的（role/persona）。 */
function readOptionalText(value: unknown, max: number, allowEmpty: boolean): string | undefined | typeof INVALID {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return INVALID
  const text = value.trim()
  if (text === '') return allowEmpty ? '' : INVALID
  if (text.length > max) return INVALID
  return text
}

function sendBotFailure(res: ServerResponse, err: unknown): void {
  if (err instanceof StoreError) {
    switch (err.code) {
      case 'INVALID_BOT':
        return sendError(res, 400, 'bot.invalid', err.message)
      case 'BOT_NAME_TAKEN':
        return sendError(res, 409, 'bot.name_taken', err.message)
      case 'BOT_NO_MODEL':
        return sendError(res, 400, 'bot.no_model', err.message)
      case 'BOT_NOT_FOUND':
        return sendError(res, 404, 'bot.not_found', err.message)
      case 'WORKSPACE_NOT_FOUND':
        return sendError(res, 404, 'workspace_not_found', err.message)
      case 'FORBIDDEN':
        return sendError(res, 403, 'forbidden', err.message)
      default:
        break
    }
  }
  console.error('roost api: bot store failure', err)
  sendError(res, 500, 'internal_error', 'bot store failure')
}
