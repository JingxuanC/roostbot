// 本地 Computer / roostd API（docs/design/local-computer.md，P0）。
//
// 用户侧：
//   GET    /api/computers
//   POST   /api/computers                     注册电脑并返回一次性 computer token
//   DELETE /api/computers/:id                 吊销
//
// 电脑侧（computer token）：
//   POST /api/computers/:id/heartbeat
//   GET  /api/computers/:id/jobs?wait=25
//   POST /api/computers/:id/jobs/:jobId/claim
//   POST /api/computers/:id/jobs/:jobId/result
//
// 绑定（用户侧，workspace member）：
//   GET    /api/workspaces/:id/computer-bindings
//   POST   /api/workspaces/:id/computer-bindings
//   DELETE /api/computer-bindings/:id

import type { IncomingMessage, ServerResponse } from 'node:http'

import { isAgentRuntimeKind } from '../../../packages/agent-runtime/src/index.ts'
import { getBot, getWorkspaceRole } from '../../../packages/store/src/index.ts'
import { appendRoomSignal } from '../../../packages/store/src/room-log.ts'
import { getComputerJob } from '../../../packages/store/src/computers.ts'
import {
  createComputer,
  createComputerBinding,
  createComputerToken,
  findComputerByTokenHash,
  generateComputerToken,
  getComputer,
  getComputerBinding,
  hashComputerToken,
  heartbeatComputer,
  listComputerBindings,
  listComputers,
  revokeComputer,
  revokeComputerBinding,
} from '../../../packages/store/src/computers.ts'
import type { Computer } from '../../../packages/store/src/computers.ts'
import type { SlotResult } from '../../../packages/contract/src/index.ts'
import type { StorePort } from './port.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { authenticate, isPlainObject, readJsonBody, sendError, sendJson } from './server.ts'
import { claimJobForComputer, completeComputerJob, waitForComputerJob } from './computer-jobs.ts'

export interface ComputersRouteContext {
  store: StorePort
  rawStore?: Store
  now: () => number
}

const COMPUTER_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000

function bearer(req: IncomingMessage): string | null {
  const raw = req.headers['x-roost-computer-token'] ?? req.headers.authorization
  const text = Array.isArray(raw) ? raw[0] : raw
  if (typeof text !== 'string') return null
  const match = /^Bearer\s+(\S+)$/i.exec(text.trim())
  if (match !== null) return match[1]!
  return text.trim().startsWith('roostc_') ? text.trim() : null
}

function authenticateComputer(ctx: ComputersRouteContext, req: IncomingMessage, res: ServerResponse): Computer | null {
  if (ctx.rawStore === undefined) {
    sendError(res, 503, 'computer.not_configured', 'computer APIs need the SQLite store')
    return null
  }
  const token = bearer(req)
  if (token === null) {
    sendError(res, 401, 'unauthorized', 'computer token required', { 'www-authenticate': 'Bearer' })
    return null
  }
  const computer = findComputerByTokenHash(ctx.rawStore, hashComputerToken(token), ctx.now())
  if (computer === null) {
    sendError(res, 401, 'unauthorized', 'unknown or expired computer token', { 'www-authenticate': 'Bearer' })
    return null
  }
  return computer
}

async function authenticateUser(ctx: ComputersRouteContext, req: IncomingMessage, res: ServerResponse) {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
    return null
  }
  return auth.session
}

function pathId(pathname: string, pattern: RegExp): string | null {
  const match = pattern.exec(pathname)
  if (match === null) return null
  try { return decodeURIComponent(match[1]!) } catch { return null }
}

export async function handleListComputers(ctx: ComputersRouteContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = await authenticateUser(ctx, req, res)
  if (session === null || ctx.rawStore === undefined) return
  const now = ctx.now()
  const computers = listComputers(ctx.rawStore, session.accountId).map((computer) => ({
    ...computer,
    status: computer.status === 'connected' && computer.lastSeenAt !== undefined && now - computer.lastSeenAt > 90_000
      ? 'offline'
      : computer.status,
  }))
  sendJson(res, 200, { computers })
}

export async function handleCreateComputer(ctx: ComputersRouteContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = await authenticateUser(ctx, req, res)
  if (session === null || ctx.rawStore === undefined) return
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  const body = parsed.value
  const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
  const os = typeof body['os'] === 'string' ? body['os'].trim() : ''
  const arch = typeof body['arch'] === 'string' ? body['arch'].trim() : ''
  const fingerprint = typeof body['fingerprint'] === 'string' ? body['fingerprint'].trim() : ''
  if (name === '' || os === '' || arch === '' || fingerprint === '') {
    return sendError(res, 400, 'computer.invalid', 'name, os, arch and fingerprint are required')
  }
  try {
    const computer = createComputer(ctx.rawStore, {
      accountId: session.accountId,
      name: name.slice(0, 80),
      os: os.slice(0, 80),
      arch: arch.slice(0, 40),
      fingerprint: fingerprint.slice(0, 200),
      ...(typeof body['version'] === 'string' ? { version: body['version'].slice(0, 40) } : {}),
      ...(isPlainObject(body['capabilities']) ? { capabilities: body['capabilities'] } : {}),
      now: ctx.now(),
    })
    const token = generateComputerToken()
    createComputerToken(ctx.rawStore, {
      computerId: computer.id,
      tokenHash: hashComputerToken(token),
      expiresAt: ctx.now() + COMPUTER_TOKEN_TTL_MS,
      now: ctx.now(),
    })
    sendJson(res, 201, { computer, token, tokenExpiresAt: ctx.now() + COMPUTER_TOKEN_TTL_MS })
  } catch (error) {
    sendError(res, 400, 'computer.invalid', error instanceof Error ? error.message : String(error))
  }
}

export async function handleDeleteComputer(ctx: ComputersRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const session = await authenticateUser(ctx, req, res)
  if (session === null || ctx.rawStore === undefined) return
  const id = pathId(url.pathname, /^\/api\/computers\/([^/]+)$/)
  if (id === null) return sendError(res, 404, 'not_found', 'malformed computer path')
  const computer = getComputer(ctx.rawStore, id)
  if (computer === null || computer.accountId !== session.accountId) return sendError(res, 404, 'computer.not_found', 'unknown computer')
  sendJson(res, 200, { computer: revokeComputer(ctx.rawStore, id, ctx.now()) })
}

export async function handleComputerHeartbeat(ctx: ComputersRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const computer = authenticateComputer(ctx, req, res)
  if (computer === null || ctx.rawStore === undefined) return
  const id = pathId(url.pathname, /^\/api\/computers\/([^/]+)\/heartbeat$/)
  if (id === null || id !== computer.id) return sendError(res, 403, 'computer.forbidden', 'computer token does not match path')
  let version
  let capabilities
  try {
    const parsed = await readJsonBody(req)
    if (parsed.ok && isPlainObject(parsed.value)) {
      if (typeof parsed.value['version'] === 'string') version = parsed.value['version'].slice(0, 40)
      if (isPlainObject(parsed.value['capabilities'])) capabilities = parsed.value['capabilities']
    }
  } catch {
    // Heartbeats may be empty; capability reporting is optional.
  }
  const updated = heartbeatComputer(ctx.rawStore, computer.id, {
    at: ctx.now(),
    ...(version === undefined ? {} : { version }),
    ...(capabilities === undefined ? {} : { capabilities }),
  })
  sendJson(res, 200, { computer: updated })
}

export async function handleComputerJobs(ctx: ComputersRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const computer = authenticateComputer(ctx, req, res)
  if (computer === null || ctx.rawStore === undefined) return
  const id = pathId(url.pathname, /^\/api\/computers\/([^/]+)\/jobs$/)
  if (id === null || id !== computer.id) return sendError(res, 403, 'computer.forbidden', 'computer token does not match path')
  const wait = Number(url.searchParams.get('wait') ?? '0')
  try {
    const job = await waitForComputerJob(ctx.rawStore, computer, Number.isFinite(wait) ? Math.max(0, Math.min(wait, 25)) * 1000 : 0, ctx.now)
    sendJson(res, 200, { job })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendError(res, 503, 'computer.unavailable', message)
  }
}

export async function handleComputerClaimJob(ctx: ComputersRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const computer = authenticateComputer(ctx, req, res)
  if (computer === null || ctx.rawStore === undefined) return
  const match = /^\/api\/computers\/([^/]+)\/jobs\/([^/]+)\/claim$/.exec(url.pathname)
  if (match === null) return sendError(res, 404, 'not_found', 'malformed job path')
  const computerId = decodeURIComponent(match[1]!)
  const jobId = decodeURIComponent(match[2]!)
  if (computerId !== computer.id) return sendError(res, 403, 'computer.forbidden', 'computer token does not match path')
  const job = claimJobForComputer(ctx.rawStore, computer, jobId, ctx.now())
  if (job === null) return sendError(res, 409, 'job.not_claimable', 'job is not queued for this computer')
  sendJson(res, 200, { job })
}

export async function handleComputerJobDelta(ctx: ComputersRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const computer = authenticateComputer(ctx, req, res)
  if (computer === null || ctx.rawStore === undefined) return
  const match = /^\/api\/computers\/([^/]+)\/jobs\/([^/]+)\/events$/.exec(url.pathname)
  if (match === null) return sendError(res, 404, 'not_found', 'malformed job path')
  const computerId = decodeURIComponent(match[1]!)
  const jobId = decodeURIComponent(match[2]!)
  if (computerId !== computer.id) return sendError(res, 403, 'computer.forbidden', 'computer token does not match path')
  const job = getComputerJob(ctx.rawStore, jobId)
  if (job === null || job.computerId !== computer.id) return sendError(res, 404, 'job.not_found', 'unknown job')
  if (job.state !== 'claimed' && job.state !== 'running') return sendError(res, 409, 'job.not_running', `job is ${job.state}`)
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  const delta = typeof parsed.value['delta'] === 'string' ? parsed.value['delta'] : ''
  if (delta === '' || delta.length > 8000) return sendError(res, 400, 'invalid_body', 'delta must be 1..8000 characters')
  try {
    const event = appendRoomSignal(ctx.rawStore, {
      roomId: job.roomId,
      domain: 'chat',
      kind: 'chat.message.delta',
      actor: { kind: 'bot', id: job.botId },
      payload: { delta, roundId: job.roundId, botId: job.botId },
    })
    sendJson(res, 201, { seq: event.seq })
  } catch (error) {
    sendError(res, 500, 'job.delta_failed', error instanceof Error ? error.message : String(error))
  }
}

export async function handleComputerJobResult(ctx: ComputersRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const computer = authenticateComputer(ctx, req, res)
  if (computer === null || ctx.rawStore === undefined) return
  const match = /^\/api\/computers\/([^/]+)\/jobs\/([^/]+)\/result$/.exec(url.pathname)
  if (match === null) return sendError(res, 404, 'not_found', 'malformed job path')
  const computerId = decodeURIComponent(match[1]!)
  const jobId = decodeURIComponent(match[2]!)
  if (computerId !== computer.id) return sendError(res, 403, 'computer.forbidden', 'computer token does not match path')
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  const result = parsed.value['result']
  if (!isPlainObject(result) || typeof result['kind'] !== 'string') {
    return sendError(res, 400, 'invalid_body', 'result must be a SlotResult object')
  }
  if (result['kind'] === 'posted' && (typeof result['text'] !== 'string' || result['text'].trim() === '')) {
    return sendError(res, 400, 'invalid_body', 'posted result needs non-empty text')
  }
  try {
    const outcome = completeComputerJob(ctx.rawStore, computer, jobId, result as SlotResult, ctx.now())
    sendJson(res, 200, { job: outcome.job, round: outcome.advanced?.round, next: outcome.advanced?.next ?? null })
  } catch (error) {
    sendError(res, 409, 'job.conflict', error instanceof Error ? error.message : String(error))
  }
}

export async function handleListWorkspaceComputerBindings(ctx: ComputersRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const session = await authenticateUser(ctx, req, res)
  if (session === null || ctx.rawStore === undefined) return
  const workspaceId = pathId(url.pathname, /^\/api\/workspaces\/([^/]+)\/computer-bindings$/)
  if (workspaceId === null) return sendError(res, 404, 'not_found', 'malformed workspace path')
  const role = getWorkspaceRole(ctx.rawStore, workspaceId, session.accountId)
  if (role === null) return sendError(res, 404, 'workspace_not_found', 'unknown workspace')
  sendJson(res, 200, { bindings: listComputerBindings(ctx.rawStore, { workspaceId, status: 'active' }) })
}

export async function handleCreateWorkspaceComputerBinding(ctx: ComputersRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const session = await authenticateUser(ctx, req, res)
  if (session === null || ctx.rawStore === undefined) return
  const workspaceId = pathId(url.pathname, /^\/api\/workspaces\/([^/]+)\/computer-bindings$/)
  if (workspaceId === null) return sendError(res, 404, 'not_found', 'malformed workspace path')
  const role = getWorkspaceRole(ctx.rawStore, workspaceId, session.accountId)
  if (role === null || (role !== 'owner' && role !== 'admin' && role !== 'member')) {
    return sendError(res, 403, 'forbidden', 'workspace member required to bind a computer')
  }
  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  const body = parsed.value
  const computerId = typeof body['computerId'] === 'string' ? body['computerId'].trim() : ''
  const botId = typeof body['botId'] === 'string' ? body['botId'].trim() : ''
  const agentKind = typeof body['agentKind'] === 'string' ? body['agentKind'].trim() : ''
  if (computerId === '' || botId === '' || !isAgentRuntimeKind(agentKind)) {
    return sendError(res, 400, 'computer.invalid', 'computerId, botId and a valid agentKind are required')
  }
  const computer = getComputer(ctx.rawStore, computerId)
  if (computer === null || computer.accountId !== session.accountId) return sendError(res, 404, 'computer.not_found', 'unknown computer')
  const bot = getBot(ctx.rawStore, botId)
  if (bot === null || bot.workspaceId !== workspaceId) return sendError(res, 404, 'bot.not_found', 'unknown bot in this workspace')
  try {
    const binding = createComputerBinding(ctx.rawStore, {
      workspaceId,
      computerId,
      botId,
      agentKind,
      ...(typeof body['workdirLabel'] === 'string' ? { workdirLabel: body['workdirLabel'].slice(0, 200) } : {}),
      ...(isPlainObject(body['permission']) ? { permission: body['permission'] } : {}),
      now: ctx.now(),
    })
    sendJson(res, 201, { binding })
  } catch (error) {
    sendError(res, 409, 'computer.binding_conflict', error instanceof Error ? error.message : String(error))
  }
}

export async function handleDeleteComputerBinding(ctx: ComputersRouteContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const session = await authenticateUser(ctx, req, res)
  if (session === null || ctx.rawStore === undefined) return
  const id = pathId(url.pathname, /^\/api\/computer-bindings\/([^/]+)$/)
  if (id === null) return sendError(res, 404, 'not_found', 'malformed binding path')
  const binding = getComputerBinding(ctx.rawStore, id)
  if (binding === null) return sendError(res, 404, 'computer.binding_not_found', 'unknown binding')
  const computer = getComputer(ctx.rawStore, binding.computerId)
  if (computer === null || computer.accountId !== session.accountId) return sendError(res, 404, 'computer.not_found', 'unknown computer')
  if (getWorkspaceRole(ctx.rawStore, binding.workspaceId, session.accountId) === null) {
    return sendError(res, 403, 'forbidden', 'workspace member required')
  }
  sendJson(res, 200, { binding: revokeComputerBinding(ctx.rawStore, id, ctx.now()) })
}
