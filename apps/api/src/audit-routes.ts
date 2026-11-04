// 审计查询 API（M6-6.6）：
//   GET /api/audit?workspaceId=&domain=&kind=&from=&to=&limit=&before=
//
// 事实源是 events 表（events.md §3）。packages/store 的 readEvents 只支持
// afterSeq/domain/audience/limit 且按 seq 升序，无法满足 kind/time/倒序/游标分页，
// 所以这里直接读表，但保持只读，且 workspace 归属过滤宁少不多。
//
// 归属规则（任一命中）：
//   1. payload.workspaceId 精确匹配（若存在但指向别的 workspace，则整条排除）；
//   2. payload.scope=workspace 且 scopeId 精确匹配；
//   3. payload.roomId / botId 属于该 workspace；
//   4. subject 是 workspace / room / bot / approval / schedule / run / quota /
//      reservation / usage，且其归属是该 workspace；
//   5. audience=room:<id> 且房间属于该 workspace；
//   6. audience=team 且 actor 是该 workspace 的成员（user）或 Bot（bot）。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { getWorkspaceRole } from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import type { StorePort } from './port.ts'
import { authenticate, readText, sendError, sendJson } from './server.ts'

export interface AuditRouteContext {
  store: StorePort
  now: () => number
  rawStore?: Store
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_ID_CHARS = 200
const MAX_FILTER_CHARS = 200
const SCAN_BATCH = 500
const PARSE_INVALID = Symbol('invalid')

interface AuditRow {
  seq: number | bigint
  at: string
  domain: string
  kind: string
  actor_json: string | null
  subject_json: string | null
  audience: string | null
  payload_json: string
}

interface AuditActor {
  kind: string
  id: string
}

interface AuditEvent {
  seq: number
  at: string
  domain: string
  kind: string
  actor: AuditActor | null
  subject: AuditActor | null
  audience: string | null
  payload: Record<string, unknown>
}

interface WorkspaceScope {
  workspaceId: string
  roomIds: Set<string>
  botIds: Set<string>
  memberIds: Set<string>
  approvalIds: Set<string>
  scheduleIds: Set<string>
  runIds: Set<string>
  quotaIds: Set<string>
  reservationIds: Set<string>
  usageIds: Set<string>
}

interface AuditQuery {
  workspaceId: string
  domain: string | null
  kind: string | null
  fromIso: string | null
  toIso: string | null
  limit: number
  before: number | null
}

const COLUMNS = 'seq, at, domain, kind, actor_json, subject_json, audience, payload_json'

export async function handleAudit(
  ctx: AuditRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })

  const store = ctx.rawStore
  if (store === undefined) {
    return sendError(res, 503, 'runtime.not_configured', 'audit needs the SQLite store')
  }

  const parsed = parseQuery(url)
  if (parsed === PARSE_INVALID) return sendError(res, 400, 'invalid_body', 'invalid audit query parameters')

  const role = getWorkspaceRole(store, parsed.workspaceId, auth.session.accountId)
  if (role !== 'owner' && role !== 'admin') {
    return sendError(res, 403, 'forbidden', `workspace ${parsed.workspaceId} requires owner/admin role`)
  }

  try {
    const scope = collectScope(store, parsed.workspaceId)
    const result = readAuditEvents(store, parsed, scope)
    sendJson(res, 200, {
      events: result.events.map((event) => ({
        seq: event.seq,
        at: event.at,
        domain: event.domain,
        kind: event.kind,
        actor: event.actor,
        subject: event.subject,
        payload: event.payload
      })),
      ...(result.nextBefore === undefined ? {} : { nextBefore: result.nextBefore })
    })
  } catch (err) {
    console.error('roost api: audit query failed', err)
    sendError(res, 500, 'internal_error', 'audit query failed')
  }
}

function parseQuery(url: URL): AuditQuery | typeof PARSE_INVALID {
  const workspaceId = readText(url.searchParams.get('workspaceId'), MAX_ID_CHARS)
  if (workspaceId === null) return PARSE_INVALID

  const domain = readFilter(url.searchParams.get('domain'))
  if (domain === PARSE_INVALID) return PARSE_INVALID
  const kind = readFilter(url.searchParams.get('kind'))
  if (kind === PARSE_INVALID) return PARSE_INVALID

  const from = parseTime(url.searchParams.get('from'))
  if (from === PARSE_INVALID) return PARSE_INVALID
  const to = parseTime(url.searchParams.get('to'))
  if (to === PARSE_INVALID) return PARSE_INVALID
  if (from !== null && to !== null && from > to) return PARSE_INVALID

  const limit = readLimit(url.searchParams.get('limit'))
  if (limit === PARSE_INVALID) return PARSE_INVALID

  const before = readPositiveInt(url.searchParams.get('before'))
  if (before === PARSE_INVALID) return PARSE_INVALID

  return {
    workspaceId,
    domain,
    kind,
    fromIso: from === null ? null : new Date(from).toISOString(),
    toIso: to === null ? null : new Date(to).toISOString(),
    limit,
    before
  }
}

function readFilter(value: string | null): string | null | typeof PARSE_INVALID {
  if (value === null) return null
  const text = value.trim()
  if (text === '' || text.length > MAX_FILTER_CHARS) return PARSE_INVALID
  if (!/^[A-Za-z0-9_.-]+$/.test(text)) return PARSE_INVALID
  return text
}

/** ISO 8601 或 epoch 毫秒；返回 null = 未提供。 */
function parseTime(value: string | null): number | null | typeof PARSE_INVALID {
  if (value === null) return null
  const text = value.trim()
  if (text === '') return PARSE_INVALID
  if (/^\d+$/.test(text)) {
    const parsed = Number(text)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : PARSE_INVALID
  }
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? PARSE_INVALID : parsed
}

function readLimit(value: string | null): number | typeof PARSE_INVALID {
  if (value === null) return DEFAULT_LIMIT
  if (!/^\d+$/.test(value.trim())) return PARSE_INVALID
  const parsed = Number(value.trim())
  if (!Number.isSafeInteger(parsed) || parsed < 1) return PARSE_INVALID
  return Math.min(MAX_LIMIT, parsed)
}

function readPositiveInt(value: string | null): number | null | typeof PARSE_INVALID {
  if (value === null) return null
  if (!/^\d+$/.test(value.trim())) return PARSE_INVALID
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : PARSE_INVALID
}

function readIds(store: Store, sql: string, ...params: unknown[]): Set<string> {
  const rows = store.db.prepare(sql).all(...params) as Array<{ id?: unknown }>
  const out = new Set<string>()
  for (const row of rows) if (typeof row.id === 'string') out.add(row.id)
  return out
}

function collectScope(store: Store, workspaceId: string): WorkspaceScope {
  return {
    workspaceId,
    roomIds: readIds(store, 'SELECT id FROM rooms WHERE workspace_id = ?', workspaceId),
    botIds: readIds(store, 'SELECT id FROM bots WHERE workspace_id = ?', workspaceId),
    memberIds: readIds(store, 'SELECT user_id AS id FROM workspace_members WHERE workspace_id = ?', workspaceId),
    approvalIds: readIds(store, 'SELECT id FROM approvals WHERE workspace_id = ?', workspaceId),
    scheduleIds: readIds(store, 'SELECT id FROM workspace_schedules WHERE workspace_id = ?', workspaceId),
    runIds: readIds(
      store,
      'SELECT r.id AS id FROM runs r JOIN activations a ON a.id = r.activation_id WHERE a.workspace_id = ?',
      workspaceId,
    ),
    quotaIds: readIds(store, "SELECT id FROM quotas WHERE scope = 'workspace' AND scope_id = ?", workspaceId),
    reservationIds: readIds(store, 'SELECT id FROM reservations WHERE workspace_id = ?', workspaceId),
    usageIds: readIds(store, 'SELECT id FROM usage_rows WHERE workspace_id = ?', workspaceId)
  }
}

function readAuditEvents(
  store: Store,
  query: AuditQuery,
  scope: WorkspaceScope,
): { events: AuditEvent[]; nextBefore?: number } {
  const events: AuditEvent[] = []
  let cursor = query.before ?? Number.MAX_SAFE_INTEGER
  let exhausted = false
  let hasMore = false
  const batchSize = Math.min(SCAN_BATCH, Math.max(100, query.limit * 4))

  while (!exhausted && events.length <= query.limit) {
    const clauses = ['seq < ?']
    const params: unknown[] = [cursor]
    if (query.domain !== null) {
      clauses.push('domain = ?')
      params.push(query.domain)
    }
    if (query.kind !== null) {
      clauses.push('kind = ?')
      params.push(query.kind)
    }
    if (query.fromIso !== null) {
      clauses.push('at >= ?')
      params.push(query.fromIso)
    }
    if (query.toIso !== null) {
      clauses.push('at < ?')
      params.push(query.toIso)
    }

    const rows = store.db
      .prepare(`SELECT ${COLUMNS} FROM events WHERE ${clauses.join(' AND ')} ORDER BY seq DESC LIMIT ?`)
      .all(...params, batchSize) as AuditRow[]

    if (rows.length === 0) break

    for (const row of rows) {
      const event = rowToAuditEvent(row)
      if (event === null || !belongsToWorkspace(event, scope)) continue
      events.push(event)
      if (events.length > query.limit) {
        hasMore = true
        break
      }
    }

    const last = rows[rows.length - 1]!
    cursor = Number(last.seq)
    if (rows.length < batchSize) exhausted = true
  }

  const visible = events.slice(0, query.limit)
  const lastVisible = visible[visible.length - 1]
  return hasMore && lastVisible !== undefined
    ? { events: visible, nextBefore: lastVisible.seq }
    : { events: visible }
}

function rowToAuditEvent(row: AuditRow): AuditEvent | null {
  const payload = parseObject(row.payload_json)
  if (payload === null) return null
  const actor = normalizeActor(parseObject(row.actor_json))
  const subject = normalizeActor(parseObject(row.subject_json))
  return {
    seq: Number(row.seq),
    at: row.at,
    domain: row.domain,
    kind: row.kind,
    actor,
    subject,
    audience: row.audience,
    payload
  }
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function normalizeActor(value: Record<string, unknown> | null): AuditActor | null {
  if (value === null || typeof value.kind !== 'string' || typeof value.id !== 'string') return null
  return { kind: value.kind, id: value.id }
}

function belongsToWorkspace(event: AuditEvent, scope: WorkspaceScope): boolean {
  const payload = event.payload

  // payload 里出现明确的 workspace 归属时，它就是裁决者；指向别人就整条排除。
  if (typeof payload.workspaceId === 'string') return payload.workspaceId === scope.workspaceId
  if (payload.scope === 'workspace' && typeof payload.scopeId === 'string') {
    return payload.scopeId === scope.workspaceId
  }

  const roomId = payload.roomId
  if (typeof roomId === 'string' && scope.roomIds.has(roomId)) return true
  const botId = payload.botId
  if (typeof botId === 'string' && scope.botIds.has(botId)) return true

  const subject = event.subject
  if (subject !== null) {
    if (subject.kind === 'workspace' && subject.id === scope.workspaceId) return true
    if (subject.kind === 'room' && scope.roomIds.has(subject.id)) return true
    if (subject.kind === 'bot' && scope.botIds.has(subject.id)) return true
    if (subject.kind === 'approval' && scope.approvalIds.has(subject.id)) return true
    if (subject.kind === 'schedule' && scope.scheduleIds.has(subject.id)) return true
    if (subject.kind === 'run' && scope.runIds.has(subject.id)) return true
    if (subject.kind === 'quota' && scope.quotaIds.has(subject.id)) return true
    if (subject.kind === 'reservation' && scope.reservationIds.has(subject.id)) return true
    if (subject.kind === 'usage' && scope.usageIds.has(subject.id)) return true
  }

  const audience = event.audience
  if (typeof audience === 'string') {
    if (audience.startsWith('room:') && scope.roomIds.has(audience.slice(5))) return true
    if (audience === 'team' && event.actor !== null) {
      if (event.actor.kind === 'user' && scope.memberIds.has(event.actor.id)) return true
      if (event.actor.kind === 'bot' && scope.botIds.has(event.actor.id)) return true
    }
  }
  return false
}
