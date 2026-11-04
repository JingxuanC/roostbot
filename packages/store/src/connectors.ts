// 连接器控制面存储（docs/design/connectors.md §3、§8）。
//
// 三张表的职责：
//   * connections        workspace ↔ 连接器（凭据只在网关，这里只留展示标签）；
//   * connector_grants   按 Bot 的访问授权（read/write + 可选动作白名单）；
//   * connector_calls    调用审计（成功/被拒都记；不含结果正文）。
//
// 幂等：connector_calls 的 (workspace_id, bot_id, idem) 由 0016 的 partial unique index
// 约束（idem 非空时唯一）。recordCall 先读后写，冲突时返回已有行且不重复写事件。
// 所有写入与对应事件在同一个 savepoint 里，同生共死。
//
// 事件（domain='connector'）：connected / disconnected / grant.changed / call。
// 错误码沿用 `CODE: detail` 约定（errors.ts 是封闭枚举，本批不改共享文件）。

import { StoreError } from './errors.ts'
import { appendEvent } from './events.ts'
import {
  asInteger,
  asNonEmptyString,
  asRecord,
  assertOpen,
  errorMessage,
  toNumber,
} from './internal.ts'
import { newRoostId } from './ids.ts'
import type { Store } from './types.ts'

export const CONNECTOR_ACCESS = ['read', 'write'] as const
export type ConnectorAccessLevel = (typeof CONNECTOR_ACCESS)[number]

export const CONNECTOR_STATUSES = ['connected', 'expired', 'revoked'] as const
export type ConnectorConnectionStatus = (typeof CONNECTOR_STATUSES)[number]

export const CONNECTOR_BACKENDS = ['openconnector', 'composio', 'native-mcp'] as const
export type ConnectorBackendName = (typeof CONNECTOR_BACKENDS)[number]

export const CONNECTOR_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
export const CONNECTOR_SLUG_MAX = 128

export function isConnectorSlug(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= CONNECTOR_SLUG_MAX &&
    CONNECTOR_SLUG_PATTERN.test(value)
  )
}

export const CONNECTOR_ERROR_CODES = {
  invalidSlug: 'CONNECTOR_INVALID_SLUG',
  workspaceNotFound: 'CONNECTOR_WORKSPACE_NOT_FOUND',
  invalidInput: 'CONNECTOR_INVALID_INPUT',
} as const

export interface Connection {
  id: string
  workspaceId: string
  slug: string
  backend: ConnectorBackendName
  status: ConnectorConnectionStatus
  /** 展示用（如邮箱）；不含 token。 */
  accountLabel: string | null
  connectedBy: string
  createdAt: number
}

export interface UpsertConnectionInput {
  workspaceId: string
  slug: string
  backend: ConnectorBackendName
  status: ConnectorConnectionStatus
  accountLabel?: string | null
  connectedBy: string
  at?: number
}

export interface DeleteConnectionInput {
  workspaceId: string
  slug: string
  /** 操作人（写 connector.disconnected 事件的 actor）。 */
  by: string
  at?: number
}

export interface ConnectorGrantRow {
  id: string
  workspaceId: string
  botId: string
  slug: string
  access: ConnectorAccessLevel
  /** null 表示该 access 下的全部动作。 */
  actions: string[] | null
  grantedBy: string
  createdAt: number
}

export interface SetGrantInput {
  workspaceId: string
  botId: string
  slug: string
  access: ConnectorAccessLevel
  actions?: string[] | null
  grantedBy: string
  at?: number
}

export interface ConnectorCallRow {
  id: string
  workspaceId: string
  botId: string
  slug: string
  action: string
  ok: boolean
  deniedReason: string | null
  resultBytes: number | null
  idem: string | null
  at: number
}

export interface RecordCallInput {
  workspaceId: string
  botId: string
  slug: string
  action: string
  ok: boolean
  deniedReason?: string | null
  resultBytes?: number | null
  idem?: string | null
  at?: number
}

export interface RecordCallResult {
  call: ConnectorCallRow
  /** true = 命中已有 idem，未写新行/新事件。 */
  duplicate: boolean
}

interface ConnectionDbRow {
  id: string
  workspace_id: string
  slug: string
  backend: string
  status: string
  account_label: string | null
  connected_by: string
  created_at: number | bigint
}

interface GrantDbRow {
  id: string
  workspace_id: string
  bot_id: string
  slug: string
  access: string
  actions: string | null
  granted_by: string
  created_at: number | bigint
}

interface CallDbRow {
  id: string
  workspace_id: string
  bot_id: string
  slug: string
  action: string
  ok: number | bigint
  denied_reason: string | null
  result_bytes: number | bigint | null
  idem: string | null
  at: number | bigint
}

const CONNECTION_COLUMNS =
  'id, workspace_id, slug, backend, status, account_label, connected_by, created_at'
const GRANT_COLUMNS = 'id, workspace_id, bot_id, slug, access, actions, granted_by, created_at'
const CALL_COLUMNS =
  'id, workspace_id, bot_id, slug, action, ok, denied_reason, result_bytes, idem, at'

// ---- 连接 --------------------------------------------------------------------

/** 同一 workspace+slug 覆盖；保留首次 id，更新状态/后端/展示名/连接人/时间。 */
export function upsertConnection(store: Store, input: UpsertConnectionInput): Connection {
  assertOpen(store)
  const req = asRecord(input, 'connection', 'INVALID_INPUT')
  const workspaceId = asNonEmptyString(req.workspaceId, 'connection.workspaceId', 'INVALID_INPUT')
  const slug = readSlug(req.slug, 'connection.slug')
  const backend = readBackend(req.backend)
  const status = readStatus(req.status)
  const accountLabel = readOptionalText(req.accountLabel, 'connection.accountLabel', 200)
  const connectedBy = asNonEmptyString(req.connectedBy, 'connection.connectedBy', 'INVALID_INPUT')
  const at = readAt(req.at)
  assertWorkspaceExists(store, workspaceId)

  const id = newRoostId('conn', at)
  store.db.exec('SAVEPOINT roost_upsert_connection')
  try {
    store.db
      .prepare(
        `INSERT INTO connections (${CONNECTION_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, slug) DO UPDATE SET
           backend = excluded.backend,
           status = excluded.status,
           account_label = excluded.account_label,
           connected_by = excluded.connected_by,
           created_at = excluded.created_at`,
      )
      .run(id, workspaceId, slug, backend, status, accountLabel, connectedBy, at)

    const saved = getConnection(store, workspaceId, slug)
    if (saved === null) {
      throw new StoreError('INVALID_INPUT', `connection ${slug} was upserted but cannot be read back`)
    }
    appendConnectorEvent(store, {
      at,
      kind: 'connector.connected',
      by: connectedBy,
      actorKind: 'user',
      subjectId: slug,
      idem: `connector:${saved.id}:connected:${at}`,
      payload: {
        connectionId: saved.id,
        workspaceId,
        slug,
        backend,
        status,
        accountLabel,
        connectedBy,
      },
    })
    store.db.exec('RELEASE roost_upsert_connection')
    return saved
  } catch (err) {
    rollback(store, 'roost_upsert_connection')
    if (err instanceof StoreError) throw err
    throw new StoreError('INVALID_INPUT', `failed to upsert connection: ${errorMessage(err)}`, {
      cause: err,
    })
  }
}

export function getConnection(store: Store, workspaceId: string, slug: string): Connection | null {
  assertOpen(store)
  const wsId = asNonEmptyString(workspaceId, 'connection.workspaceId', 'INVALID_INPUT')
  const connectorSlug = readSlug(slug, 'connection.slug')
  const row = store.db
    .prepare(`SELECT ${CONNECTION_COLUMNS} FROM connections WHERE workspace_id = ? AND slug = ?`)
    .get(wsId, connectorSlug)
  return row === undefined || row === null ? null : rowToConnection(row)
}

export function listConnections(store: Store, workspaceId: string): Connection[] {
  assertOpen(store)
  const wsId = asNonEmptyString(workspaceId, 'connection.workspaceId', 'INVALID_INPUT')
  return store.db
    .prepare(`SELECT ${CONNECTION_COLUMNS} FROM connections WHERE workspace_id = ? ORDER BY created_at ASC, slug ASC`)
    .all(wsId)
    .map(rowToConnection)
}

/** 删除连接；不存在返回 false（API 保持 204 幂等），不写事件。 */
export function deleteConnection(store: Store, input: DeleteConnectionInput): boolean {
  assertOpen(store)
  const req = asRecord(input, 'connectionDelete', 'INVALID_INPUT')
  const workspaceId = asNonEmptyString(req.workspaceId, 'connectionDelete.workspaceId', 'INVALID_INPUT')
  const slug = readSlug(req.slug, 'connectionDelete.slug')
  const by = asNonEmptyString(req.by, 'connectionDelete.by', 'INVALID_INPUT')
  const at = readAt(req.at)

  const current = getConnection(store, workspaceId, slug)
  if (current === null) return false

  store.db.exec('SAVEPOINT roost_delete_connection')
  try {
    store.db.prepare('DELETE FROM connections WHERE workspace_id = ? AND slug = ?').run(workspaceId, slug)
    appendConnectorEvent(store, {
      at,
      kind: 'connector.disconnected',
      by,
      actorKind: 'user',
      subjectId: slug,
      idem: `connector:${current.id}:disconnected:${at}`,
      payload: {
        connectionId: current.id,
        workspaceId,
        slug,
        backend: current.backend,
        by,
      },
    })
    store.db.exec('RELEASE roost_delete_connection')
  } catch (err) {
    rollback(store, 'roost_delete_connection')
    if (err instanceof StoreError) throw err
    throw new StoreError('INVALID_INPUT', `failed to delete connection: ${errorMessage(err)}`, { cause: err })
  }
  return true
}

// ---- 授权 --------------------------------------------------------------------

/** 同一 workspace+bot+slug 覆盖（不堆历史行）；已有行保留首次 created_at。 */
export function setGrant(store: Store, input: SetGrantInput): ConnectorGrantRow {
  assertOpen(store)
  const req = asRecord(input, 'grant', 'INVALID_INPUT')
  const workspaceId = asNonEmptyString(req.workspaceId, 'grant.workspaceId', 'INVALID_INPUT')
  const botId = asNonEmptyString(req.botId, 'grant.botId', 'INVALID_INPUT')
  const slug = readSlug(req.slug, 'grant.slug')
  const access = readAccess(req.access)
  const actions = readActions(req.actions)
  const grantedBy = asNonEmptyString(req.grantedBy, 'grant.grantedBy', 'INVALID_INPUT')
  const at = readAt(req.at)
  assertWorkspaceExists(store, workspaceId)

  const id = newRoostId('cg', at)
  store.db.exec('SAVEPOINT roost_set_grant')
  try {
    store.db
      .prepare(
        `INSERT INTO connector_grants (${GRANT_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, bot_id, slug) DO UPDATE SET
           access = excluded.access,
           actions = excluded.actions,
           granted_by = excluded.granted_by`,
      )
      .run(
        id,
        workspaceId,
        botId,
        slug,
        access,
        actions === null ? null : JSON.stringify(actions),
        grantedBy,
        at,
      )

    const saved = findGrant(store, workspaceId, botId, slug)
    if (saved === null) {
      throw new StoreError('INVALID_INPUT', `grant ${slug} was upserted but cannot be read back`)
    }
    appendConnectorEvent(store, {
      at,
      kind: 'connector.grant.changed',
      by: grantedBy,
      actorKind: 'user',
      subjectId: slug,
      idem: `connector:${saved.id}:grant:${at}`,
      payload: {
        grantId: saved.id,
        workspaceId,
        botId,
        slug,
        access,
        actions,
        grantedBy,
      },
    })
    store.db.exec('RELEASE roost_set_grant')
    return saved
  } catch (err) {
    rollback(store, 'roost_set_grant')
    if (err instanceof StoreError) throw err
    throw new StoreError('INVALID_INPUT', `failed to set connector grant: ${errorMessage(err)}`, {
      cause: err,
    })
  }
}

/** slug 省略 = 该 workspace 的全部授权；按 created_at 升序。 */
export function listGrants(store: Store, workspaceId: string, slug?: string | null): ConnectorGrantRow[] {
  assertOpen(store)
  const wsId = asNonEmptyString(workspaceId, 'grant.workspaceId', 'INVALID_INPUT')
  const connectorSlug = slug === undefined || slug === null ? null : readSlug(slug, 'grant.slug')
  const rows =
    connectorSlug === null
      ? store.db
          .prepare(`SELECT ${GRANT_COLUMNS} FROM connector_grants WHERE workspace_id = ? ORDER BY created_at ASC, id ASC`)
          .all(wsId)
      : store.db
          .prepare(
            `SELECT ${GRANT_COLUMNS} FROM connector_grants
              WHERE workspace_id = ? AND slug = ? ORDER BY created_at ASC, id ASC`,
          )
          .all(wsId, connectorSlug)
  return rows.map(rowToGrant)
}

export function findGrant(
  store: Store,
  workspaceId: string,
  botId: string,
  slug: string,
): ConnectorGrantRow | null {
  assertOpen(store)
  const wsId = asNonEmptyString(workspaceId, 'grant.workspaceId', 'INVALID_INPUT')
  const bot = asNonEmptyString(botId, 'grant.botId', 'INVALID_INPUT')
  const connectorSlug = readSlug(slug, 'grant.slug')
  const row = store.db
    .prepare(
      `SELECT ${GRANT_COLUMNS} FROM connector_grants
        WHERE workspace_id = ? AND bot_id = ? AND slug = ? LIMIT 1`,
    )
    .get(wsId, bot, connectorSlug)
  return row === undefined || row === null ? null : rowToGrant(row)
}

// ---- 调用审计 ----------------------------------------------------------------

/**
 * 记一次调用。idem 非空且已存在时返回首次行（duplicate=true），不写事件。
 * 成功与被拒都建议走这里：`ok=false` + deniedReason 是授权拒绝/网关失败的审计证据。
 */
export function recordCall(store: Store, input: RecordCallInput): RecordCallResult {
  assertOpen(store)
  const req = asRecord(input, 'call', 'INVALID_INPUT')
  const workspaceId = asNonEmptyString(req.workspaceId, 'call.workspaceId', 'INVALID_INPUT')
  const botId = asNonEmptyString(req.botId, 'call.botId', 'INVALID_INPUT')
  const slug = readSlug(req.slug, 'call.slug')
  const action = asNonEmptyString(req.action, 'call.action', 'INVALID_INPUT')
  const ok = req.ok === true
  const deniedReason = readOptionalText(req.deniedReason, 'call.deniedReason', 500)
  const resultBytes =
    req.resultBytes === undefined || req.resultBytes === null
      ? null
      : asInteger(req.resultBytes, 'call.resultBytes', 0, 'INVALID_INPUT')
  const idem = readOptionalText(req.idem, 'call.idem', 200)
  const at = readAt(req.at)

  if (idem !== null) {
    const existing = findCallByIdem(store, workspaceId, botId, idem)
    if (existing !== null) return { call: existing, duplicate: true }
  }

  const id = newRoostId('cnc', at)
  store.db.exec('SAVEPOINT roost_record_call')
  try {
    store.db
      .prepare(`INSERT INTO connector_calls (${CALL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, workspaceId, botId, slug, action, ok ? 1 : 0, deniedReason, resultBytes, idem, at)

    appendConnectorEvent(store, {
      at,
      kind: 'connector.call',
      by: botId,
      actorKind: 'bot',
      subjectId: slug,
      idem: `connector:${id}:call`,
      payload: {
        callId: id,
        workspaceId,
        botId,
        slug,
        action,
        ok,
        deniedReason,
        resultBytes,
        idem,
      },
    })
    store.db.exec('RELEASE roost_record_call')
  } catch (err) {
    rollback(store, 'roost_record_call')
    // 并发同 idem：读回已有行，按幂等返回。
    if (idem !== null && errorMessage(err).includes('UNIQUE constraint failed')) {
      const existing = findCallByIdem(store, workspaceId, botId, idem)
      if (existing !== null) return { call: existing, duplicate: true }
    }
    if (err instanceof StoreError) throw err
    throw new StoreError('INVALID_INPUT', `failed to record connector call: ${errorMessage(err)}`, {
      cause: err,
    })
  }

  const saved = getCall(store, id)
  if (saved === null) {
    throw new StoreError('INVALID_INPUT', `connector call ${id} was inserted but cannot be read back`)
  }
  return { call: saved, duplicate: false }
}

export function findCallByIdem(
  store: Store,
  workspaceId: string,
  botId: string,
  idem: string,
): ConnectorCallRow | null {
  assertOpen(store)
  const wsId = asNonEmptyString(workspaceId, 'call.workspaceId', 'INVALID_INPUT')
  const bot = asNonEmptyString(botId, 'call.botId', 'INVALID_INPUT')
  const key = asNonEmptyString(idem, 'call.idem', 'INVALID_INPUT')
  const row = store.db
    .prepare(
      `SELECT ${CALL_COLUMNS} FROM connector_calls
        WHERE workspace_id = ? AND bot_id = ? AND idem = ? LIMIT 1`,
    )
    .get(wsId, bot, key)
  return row === undefined || row === null ? null : rowToCall(row)
}

function getCall(store: Store, id: string): ConnectorCallRow | null {
  const row = store.db
    .prepare(`SELECT ${CALL_COLUMNS} FROM connector_calls WHERE id = ?`)
    .get(id)
  return row === undefined || row === null ? null : rowToCall(row)
}

// ---- 内部 --------------------------------------------------------------------

function appendConnectorEvent(
  store: Store,
  input: {
    at: number
    kind: 'connector.connected' | 'connector.disconnected' | 'connector.grant.changed' | 'connector.call'
    by: string
    actorKind: 'user' | 'bot'
    subjectId: string
    idem: string
    payload: Record<string, unknown>
  },
): void {
  appendEvent(store, {
    at: new Date(input.at).toISOString(),
    domain: 'connector',
    kind: input.kind,
    actor: { kind: input.actorKind, id: input.by },
    subject: { kind: 'connector', id: input.subjectId },
    audience: 'team',
    idem: input.idem,
    payload: input.payload,
  })
}

function assertWorkspaceExists(store: Store, workspaceId: string): void {
  const workspace = store.db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId)
  if (workspace === undefined || workspace === null) {
    throw new StoreError('WORKSPACE_NOT_FOUND', `unknown workspace ${workspaceId}`)
  }
}

function rollback(store: Store, savepoint: string): void {
  try {
    store.db.exec(`ROLLBACK TO ${savepoint}`)
    store.db.exec(`RELEASE ${savepoint}`)
  } catch {
    // 外层事务可能已经把 savepoint 一起回滚；保留原始错误。
  }
}

function readSlug(value: unknown, label: string): string {
  if (!isConnectorSlug(value)) {
    throw new StoreError(
      'INVALID_INPUT',
      `${label} must match ${CONNECTOR_SLUG_PATTERN} (max ${CONNECTOR_SLUG_MAX} chars)`,
    )
  }
  return value
}

function readAccess(value: unknown): ConnectorAccessLevel {
  if (typeof value !== 'string' || !(CONNECTOR_ACCESS as readonly string[]).includes(value)) {
    throw new StoreError('INVALID_INPUT', `grant.access must be one of ${CONNECTOR_ACCESS.join('|')}`)
  }
  return value as ConnectorAccessLevel
}

function readBackend(value: unknown): ConnectorBackendName {
  if (typeof value !== 'string' || !(CONNECTOR_BACKENDS as readonly string[]).includes(value)) {
    throw new StoreError('INVALID_INPUT', `connection.backend must be one of ${CONNECTOR_BACKENDS.join('|')}`)
  }
  return value as ConnectorBackendName
}

function readStatus(value: unknown): ConnectorConnectionStatus {
  if (typeof value !== 'string' || !(CONNECTOR_STATUSES as readonly string[]).includes(value)) {
    throw new StoreError('INVALID_INPUT', `connection.status must be one of ${CONNECTOR_STATUSES.join('|')}`)
  }
  return value as ConnectorConnectionStatus
}

/** undefined/null/空白 = null；数组去重、拒绝空串与超长值。 */
function readActions(value: unknown): string[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) throw new StoreError('INVALID_INPUT', 'grant.actions must be an array when present')
  if (value.length > 200) throw new StoreError('INVALID_INPUT', 'grant.actions must have at most 200 entries')
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new StoreError('INVALID_INPUT', 'grant.actions entries must be strings')
    const text = item.trim()
    if (text === '' || text.length > 200) {
      throw new StoreError('INVALID_INPUT', 'grant.actions entries must be 1..200 characters')
    }
    if (!out.includes(text)) out.push(text)
  }
  return out.length === 0 ? null : out
}

function readOptionalText(value: unknown, label: string, maxChars: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new StoreError('INVALID_INPUT', `${label} must be a string when present`)
  const text = value.trim()
  if (text === '') return null
  if (text.length > maxChars) {
    throw new StoreError('INVALID_INPUT', `${label} must be at most ${maxChars} characters`)
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new StoreError('INVALID_INPUT', `${label} must not contain control characters`)
  }
  return text
}

function readAt(value: unknown): number {
  return value === undefined || value === null
    ? Date.now()
    : asInteger(value, 'connector.at', 0, 'INVALID_INPUT')
}

function rowToConnection(row: unknown): Connection {
  const r = row as ConnectionDbRow
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    slug: r.slug,
    backend: r.backend as ConnectorBackendName,
    status: r.status as ConnectorConnectionStatus,
    accountLabel: r.account_label,
    connectedBy: r.connected_by,
    createdAt: toNumber(r.created_at),
  }
}

function rowToGrant(row: unknown): ConnectorGrantRow {
  const r = row as GrantDbRow
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    botId: r.bot_id,
    slug: r.slug,
    access: r.access as ConnectorAccessLevel,
    actions: decodeActions(r.actions),
    grantedBy: r.granted_by,
    createdAt: toNumber(r.created_at),
  }
}

function rowToCall(row: unknown): ConnectorCallRow {
  const r = row as CallDbRow
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    botId: r.bot_id,
    slug: r.slug,
    action: r.action,
    ok: toNumber(r.ok) === 1,
    deniedReason: r.denied_reason,
    resultBytes: r.result_bytes === null ? null : toNumber(r.result_bytes),
    idem: r.idem,
    at: toNumber(r.at),
  }
}

function decodeActions(raw: string | null): string[] | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    const out = parsed.filter((item): item is string => typeof item === 'string')
    return out.length === 0 ? null : out
  } catch {
    return null
  }
}
