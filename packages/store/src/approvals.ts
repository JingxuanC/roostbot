// 审批（docs/build/m4-addendum.md §B、docs/design/rooms.md §6）。
//
// 审批是「动作的待确认记录」，不是动作本身：Bot 建群先写一条 pending approval，
// 用户批准后由调用方（packages/store/src/bot-rooms.ts）执行动作并把结果写回 payload。
//
// 状态机只有一条边：pending → approved | rejected。
//   * 同一个决定再来一次：幂等返回当前行，不改 decided_at / decided_by（审计时间稳定）。
//   * 相反的决定：不翻案、不报错，原样返回当前行 —— 审批一旦落定就是事实，
//     避免「先批准后拒绝」把已经建好的房间变成孤儿。
//
// StoreError.code 是 errors.ts 的封闭枚举（本批不改共享文件）。审批域的错误码
// 用 `CODE: detail` 的形式写在 message 开头，API 层用 storeErrorTag() 取回，
// 这样 code 稳定、又不污染共享错误码表。

import { StoreError } from './errors.ts'
import { appendEvent } from './events.ts'
import { asInteger, asNonEmptyString, asRecord, assertOpen, errorMessage, toNumber } from './internal.ts'
import { newRoostId } from './ids.ts'
import type { Store } from './types.ts'

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

/** 允许的决定：只接受终态，不接受 'pending'。 */
export type ApprovalDecision = 'approved' | 'rejected'

/** 审批域内部错误码（写在 StoreError.message 的 `CODE: ` 前缀里）。 */
export const APPROVAL_ERROR_CODES = {
  notFound: 'APPROVAL_NOT_FOUND',
  invalid: 'APPROVAL_INVALID',
  conflict: 'APPROVAL_CONFLICT',
} as const

export interface Approval {
  id: string
  workspaceId: string
  kind: string
  requester: string
  requesterKind: string
  /** payload_json 解码后的对象；坏 JSON 读成 {}，不让 GET 500。 */
  payload: Record<string, unknown>
  status: ApprovalStatus
  createdAt: number
  decidedAt: number | null
  decidedBy: string | null
  /** 要做什么（卡片标题下的动作）；旧行为 null。 */
  action: string | null
  /** 作用对象（房间 / 地址 / 文件等）；旧行为 null。 */
  target: string | null
  /** 影响什么（卡片上的后果说明）；旧行为 null。 */
  consequence: string | null
}

export interface CreateApprovalInput {
  workspaceId: string
  kind: string
  requester: string
  /** 默认 'bot'（迁移里的 DEFAULT 同义）。 */
  requesterKind?: string
  payload: Record<string, unknown>
  action?: string | null
  target?: string | null
  consequence?: string | null
  /** epoch 毫秒；默认 Date.now()。 */
  at?: number
}

/** 长期授权：workspace + kind + action + target 精确匹配，不做通配。 */
export interface ApprovalGrant {
  id: string
  workspaceId: string
  kind: string
  action: string | null
  target: string | null
  grantedBy: string
  grantedAt: number
  revokedAt: number | null
}

export interface CreateApprovalGrantInput {
  workspaceId: string
  kind: string
  action?: string | null
  target?: string | null
  /** 授权人（用户 id），审计用。 */
  grantedBy: string
  at?: number
}

export interface FindApprovalGrantInput {
  workspaceId: string
  kind: string
  action?: string | null
  target?: string | null
}

export interface RevokeApprovalGrantInput {
  id: string
  at?: number
}

export interface DecideApprovalInput {
  id: string
  decision: ApprovalDecision
  /** 决定人（用户 id）；写进 decided_by，审计用。 */
  by: string
  at?: number
}

interface ApprovalRow {
  id: string
  workspace_id: string
  kind: string
  requester: string
  requester_kind: string
  payload_json: string
  status: string
  created_at: number | bigint
  decided_at: number | bigint | null
  decided_by: string | null
  action: string | null
  target: string | null
  consequence: string | null
}

interface ApprovalGrantRow {
  id: string
  workspace_id: string
  kind: string
  action: string | null
  target: string | null
  granted_by: string
  granted_at: number | bigint
  revoked_at: number | bigint | null
}

const APPROVAL_COLUMNS =
  'id, workspace_id, kind, requester, requester_kind, payload_json, status, created_at, decided_at, decided_by, action, target, consequence'

const GRANT_COLUMNS = 'id, workspace_id, kind, action, target, granted_by, granted_at, revoked_at'

/** paylaod 上限：审批只带参数，不该塞大对象（64KiB，与 API body 上限一致）。 */
const PAYLOAD_MAX_BYTES = 64 * 1024
/** action / target / consequence 的长度上限（卡片字段，防止当正文塞）。 */
const ACTION_MAX_CHARS = 200
const TARGET_MAX_CHARS = 500
const CONSEQUENCE_MAX_CHARS = 2000

/** `CODE: detail` —— 把域错误码塞进 message，code 仍用现有枚举。 */
export function taggedStoreMessage(code: string, message: string): string {
  return `${code}: ${message}`
}

/** 取回 taggedStoreMessage 写进去的域错误码；不是这种形状就返回 null。 */
export function storeErrorTag(err: unknown): string | null {
  if (!(err instanceof StoreError)) return null
  const match = /^([A-Z][A-Z0-9_]+): /.exec(err.message)
  return match === null ? null : match[1]!
}

export function createApproval(store: Store, input: CreateApprovalInput): Approval {
  assertOpen(store)
  const req = asRecord(input, 'approval', 'INVALID_INPUT')
  const workspaceId = asNonEmptyString(req.workspaceId, 'approval.workspaceId', 'INVALID_INPUT')
  const kind = readKind(req.kind)
  const requester = readShortId(req.requester, 'approval.requester')
  const requesterKind = readRequesterKind(req.requesterKind)
  const payload = readPayload(req.payload)
  const action = readOptionalText(req.action, 'approval.action', ACTION_MAX_CHARS)
  const target = readOptionalText(req.target, 'approval.target', TARGET_MAX_CHARS)
  const consequence = readOptionalText(req.consequence, 'approval.consequence', CONSEQUENCE_MAX_CHARS)
  const at =
    req.at === undefined || req.at === null
      ? Date.now()
      : asInteger(req.at, 'approval.at', 0, 'INVALID_INPUT')

  const workspace = store.db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId)
  if (workspace === undefined || workspace === null) {
    throw new StoreError('WORKSPACE_NOT_FOUND', `unknown workspace ${workspaceId}`)
  }

  const id = newRoostId('apr', at)
  // 行与 approval.requested 事件同生共死：事件写失败就回滚申请，不留「看不见的审批」。
  store.db.exec('SAVEPOINT roost_create_approval')
  try {
    store.db
      .prepare(
        `INSERT INTO approvals (${APPROVAL_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        kind,
        requester,
        requesterKind,
        JSON.stringify(payload),
        at,
        action,
        target,
        consequence,
      )
    appendEvent(store, {
      at: new Date(at).toISOString(),
      domain: 'approval',
      kind: 'approval.requested',
      actor: { kind: requesterKind, id: requester },
      subject: { kind: 'approval', id },
      audience: 'team',
      idem: `approval:${id}:requested`,
      payload: {
        approvalId: id,
        workspaceId,
        kind,
        action,
        target,
        consequence,
        requester,
        requesterKind,
      },
    })
    store.db.exec('RELEASE roost_create_approval')
  } catch (err) {
    rollback(store, 'roost_create_approval')
    if (err instanceof StoreError) throw err
    throw new StoreError('INVALID_INPUT', `failed to create approval: ${errorMessage(err)}`, { cause: err })
  }

  return {
    id,
    workspaceId,
    kind,
    requester,
    requesterKind,
    payload,
    status: 'pending',
    createdAt: at,
    decidedAt: null,
    decidedBy: null,
    action,
    target,
    consequence,
  }
}

export function getApproval(store: Store, id: string): Approval | null {
  assertOpen(store)
  const approvalId = asNonEmptyString(id, 'approval.id', 'INVALID_INPUT')
  const row = store.db.prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = ?`).get(approvalId)
  return row === undefined || row === null ? null : rowToApproval(row)
}

/** 按 created_at 升序（审批是队列，先来先处理）；status 省略 = 全部。 */
export function listApprovals(store: Store, workspaceId: string, status?: ApprovalStatus): Approval[] {
  assertOpen(store)
  const wsId = asNonEmptyString(workspaceId, 'approval.workspaceId', 'INVALID_INPUT')
  const filter = readStatusFilter(status)
  const rows =
    filter === null
      ? store.db
          .prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE workspace_id = ? ORDER BY created_at, id`)
          .all(wsId)
      : store.db
          .prepare(
            `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE workspace_id = ? AND status = ? ORDER BY created_at, id`,
          )
          .all(wsId, filter)
  return rows.map((row) => rowToApproval(row))
}

/**
 * 落定审批。只有 pending 能变；重复决定返回当前行（幂等），相反决定不翻案。
 * 用 `WHERE status = 'pending'` 做条件更新：并发下只有一个调用点真正写入。
 */
export function decideApproval(store: Store, input: DecideApprovalInput): Approval {
  assertOpen(store)
  const req = asRecord(input, 'approval.decision', 'INVALID_INPUT')
  const id = asNonEmptyString(req.id, 'approval.id', 'INVALID_INPUT')
  const decision = readDecision(req.decision)
  const by = readShortId(req.by, 'approval.by')
  const at =
    req.at === undefined || req.at === null
      ? Date.now()
      : asInteger(req.at, 'approval.at', 0, 'INVALID_INPUT')

  const current = getApproval(store, id)
  if (current === null) {
    throw new StoreError(
      'INVALID_INPUT',
      taggedStoreMessage(APPROVAL_ERROR_CODES.notFound, `unknown approval ${id}`),
    )
  }

  // 已经是终态：同决定幂等返回；相反决定也不翻案（审批是事实，不是偏好）。
  // 终态不再写 approval.decided：决策事件恰好一次。
  if (current.status !== 'pending') return current

  // 决策与 approval.decided 事件同一 savepoint：要么都落，要么都不落。
  store.db.exec('SAVEPOINT roost_decide_approval')
  try {
    const result = store.db
      .prepare("UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'")
      .run(decision, at, by, id)
    if (toNumber(result.changes) === 1) {
      appendEvent(store, {
        at: new Date(at).toISOString(),
        domain: 'approval',
        kind: 'approval.decided',
        actor: { kind: 'user', id: by },
        subject: { kind: 'approval', id },
        audience: 'team',
        idem: `approval:${id}:decided`,
        payload: {
          approvalId: id,
          workspaceId: current.workspaceId,
          kind: current.kind,
          action: current.action,
          target: current.target,
          consequence: current.consequence,
          requester: current.requester,
          requesterKind: current.requesterKind,
          decision,
          decidedBy: by,
        },
      })
    }
    store.db.exec('RELEASE roost_decide_approval')
  } catch (err) {
    rollback(store, 'roost_decide_approval')
    if (err instanceof StoreError) throw err
    throw new StoreError('INVALID_INPUT', `failed to decide approval: ${errorMessage(err)}`, { cause: err })
  }

  // 条件更新没命中 = 另一个调用点刚把它落定；读回当前行，返回值仍一致。
  const updated = getApproval(store, id)
  if (updated === null) {
    throw new StoreError(
      'INVALID_INPUT',
      taggedStoreMessage(APPROVAL_ERROR_CODES.notFound, `unknown approval ${id}`),
    )
  }
  return updated
}

// ---- 长期授权（设置里显式打开；决策接口绝不隐式写入）--------------------------

/**
 * 建一条长期授权。同一 workspace+kind+action+target 已有未吊销授权时返回它（幂等），
 * 避免双击设置按钮堆出重复行。
 */
export function createApprovalGrant(store: Store, input: CreateApprovalGrantInput): ApprovalGrant {
  assertOpen(store)
  const req = asRecord(input, 'approvalGrant', 'INVALID_INPUT')
  const workspaceId = asNonEmptyString(req.workspaceId, 'approvalGrant.workspaceId', 'INVALID_INPUT')
  const kind = readKind(req.kind)
  const action = readOptionalText(req.action, 'approvalGrant.action', ACTION_MAX_CHARS)
  const target = readOptionalText(req.target, 'approvalGrant.target', TARGET_MAX_CHARS)
  const grantedBy = readShortId(req.grantedBy, 'approvalGrant.grantedBy')
  const at =
    req.at === undefined || req.at === null
      ? Date.now()
      : asInteger(req.at, 'approvalGrant.at', 0, 'INVALID_INPUT')

  assertWorkspaceExists(store, workspaceId)

  const existing = findApprovalGrant(store, { workspaceId, kind, action, target })
  if (existing !== null) return existing

  const id = newRoostId('apg', at)
  try {
    store.db
      .prepare(
        `INSERT INTO approval_grants (${GRANT_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, workspaceId, kind, action, target, grantedBy, at)
  } catch (err) {
    throw new StoreError('INVALID_INPUT', `failed to create approval grant: ${errorMessage(err)}`, {
      cause: err,
    })
  }

  const created = getApprovalGrant(store, id)
  if (created === null) {
    throw new StoreError('INVALID_INPUT', `approval grant ${id} was inserted but cannot be read back`)
  }
  return created
}

/** 只返回未吊销的授权（设置页展示用），按授权时间升序。 */
export function listApprovalGrants(store: Store, workspaceId: string): ApprovalGrant[] {
  assertOpen(store)
  const wsId = asNonEmptyString(workspaceId, 'approvalGrant.workspaceId', 'INVALID_INPUT')
  return store.db
    .prepare(
      `SELECT ${GRANT_COLUMNS} FROM approval_grants
        WHERE workspace_id = ? AND revoked_at IS NULL
        ORDER BY granted_at, id`,
    )
    .all(wsId)
    .map(rowToApprovalGrant)
}

/** 按 id 读（含已吊销）：撤销接口需要它做权限判断。 */
export function getApprovalGrant(store: Store, id: string): ApprovalGrant | null {
  assertOpen(store)
  const grantId = asNonEmptyString(id, 'approvalGrant.id', 'INVALID_INPUT')
  const row = store.db.prepare(`SELECT ${GRANT_COLUMNS} FROM approval_grants WHERE id = ?`).get(grantId)
  return row === undefined || row === null ? null : rowToApprovalGrant(row)
}

/**
 * 精确匹配未吊销的授权：workspace + kind + action + target 全等，v1 不做通配。
 * action/target 省略等价于「匹配 NULL」，即有值请求不会被 NULL 授权放行。
 */
export function findApprovalGrant(store: Store, input: FindApprovalGrantInput): ApprovalGrant | null {
  assertOpen(store)
  const req = asRecord(input, 'approvalGrant.find', 'INVALID_INPUT')
  const workspaceId = asNonEmptyString(req.workspaceId, 'approvalGrant.workspaceId', 'INVALID_INPUT')
  const kind = readKind(req.kind)
  const action = readOptionalText(req.action, 'approvalGrant.action', ACTION_MAX_CHARS)
  const target = readOptionalText(req.target, 'approvalGrant.target', TARGET_MAX_CHARS)
  const row = store.db
    .prepare(
      `SELECT ${GRANT_COLUMNS} FROM approval_grants
        WHERE workspace_id = ? AND kind = ? AND action IS ? AND target IS ? AND revoked_at IS NULL
        ORDER BY granted_at, id LIMIT 1`,
    )
    .get(workspaceId, kind, action, target)
  return row === undefined || row === null ? null : rowToApprovalGrant(row)
}

/** 软撤销；重复撤销幂等（保留第一次的 revoked_at）。不存在返回 null。 */
export function revokeApprovalGrant(store: Store, input: RevokeApprovalGrantInput): ApprovalGrant | null {
  assertOpen(store)
  const req = asRecord(input, 'approvalGrant.revoke', 'INVALID_INPUT')
  const id = asNonEmptyString(req.id, 'approvalGrant.id', 'INVALID_INPUT')
  const at =
    req.at === undefined || req.at === null
      ? Date.now()
      : asInteger(req.at, 'approvalGrant.at', 0, 'INVALID_INPUT')

  const current = getApprovalGrant(store, id)
  if (current === null) return null
  if (current.revokedAt !== null) return current

  store.db
    .prepare('UPDATE approval_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(at, id)
  return getApprovalGrant(store, id)
}

/** 是否有待处理的审批（「需要你」角标用）。 */
export function hasPendingApproval(store: Store, workspaceId: string, requester: string): boolean {
  assertOpen(store)
  const wsId = asNonEmptyString(workspaceId, 'approval.workspaceId', 'INVALID_INPUT')
  const who = asNonEmptyString(requester, 'approval.requester', 'INVALID_INPUT')
  const row = store.db
    .prepare("SELECT 1 AS ok FROM approvals WHERE workspace_id = ? AND requester = ? AND status = 'pending' LIMIT 1")
    .get(wsId, who)
  return row !== undefined && row !== null
}

// ---- 内部 --------------------------------------------------------------------

function rowToApproval(row: unknown): Approval {
  const r = row as ApprovalRow
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind,
    requester: r.requester,
    requesterKind: r.requester_kind,
    payload: decodePayload(r.payload_json),
    status: readStoredStatus(r.status),
    createdAt: toNumber(r.created_at),
    decidedAt: r.decided_at === null ? null : toNumber(r.decided_at),
    decidedBy: r.decided_by,
    action: r.action,
    target: r.target,
    consequence: r.consequence,
  }
}

function rowToApprovalGrant(row: unknown): ApprovalGrant {
  const r = row as ApprovalGrantRow
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind,
    action: r.action,
    target: r.target,
    grantedBy: r.granted_by,
    grantedAt: toNumber(r.granted_at),
    revokedAt: r.revoked_at === null ? null : toNumber(r.revoked_at),
  }
}

function assertWorkspaceExists(store: Store, workspaceId: string): void {
  const workspace = store.db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId)
  if (workspace === undefined || workspace === null) {
    throw new StoreError('WORKSPACE_NOT_FOUND', `unknown workspace ${workspaceId}`)
  }
}

/** 可选文本：undefined/null/空白 = null；拒绝控制字符与超长值。 */
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

function rollback(store: Store, savepoint: string): void {
  try {
    store.db.exec(`ROLLBACK TO ${savepoint}`)
    store.db.exec(`RELEASE ${savepoint}`)
  } catch {
    // 外层事务可能已经把 savepoint 一起回滚；保留原始错误。
  }
}

function readKind(value: unknown): string {
  if (typeof value !== 'string') throw new StoreError('INVALID_INPUT', 'approval.kind must be a string')
  const kind = value.trim()
  if (kind === '') throw new StoreError('INVALID_INPUT', 'approval.kind must not be empty')
  if (kind.length > 64) throw new StoreError('INVALID_INPUT', 'approval.kind must be at most 64 characters')
  if (!/^[a-z][a-z0-9_.-]*$/.test(kind)) {
    throw new StoreError('INVALID_INPUT', 'approval.kind must match ^[a-z][a-z0-9_.-]*$')
  }
  return kind
}

function readRequesterKind(value: unknown): string {
  if (value === undefined || value === null) return 'bot'
  if (value !== 'bot' && value !== 'user') {
    throw new StoreError('INVALID_INPUT', "approval.requesterKind must be 'bot' or 'user'")
  }
  return value
}

function readShortId(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new StoreError('INVALID_INPUT', `${label} must be a string`)
  const id = value.trim()
  if (id === '') throw new StoreError('INVALID_INPUT', `${label} must not be empty`)
  if (id.length > 200) throw new StoreError('INVALID_INPUT', `${label} must be at most 200 characters`)
  return id
}

function readPayload(value: unknown): Record<string, unknown> {
  const payload = asRecord(value, 'approval.payload', 'INVALID_INPUT')
  let encoded: string
  try {
    encoded = JSON.stringify(payload)
  } catch (err) {
    throw new StoreError('INVALID_INPUT', `approval.payload is not JSON-serializable: ${errorMessage(err)}`)
  }
  if (Buffer.byteLength(encoded, 'utf8') > PAYLOAD_MAX_BYTES) {
    throw new StoreError('INVALID_INPUT', `approval.payload exceeds ${PAYLOAD_MAX_BYTES} bytes`)
  }
  return payload
}

function decodePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

function readStatusFilter(value: unknown): ApprovalStatus | null {
  if (value === undefined || value === null) return null
  if (value === 'pending' || value === 'approved' || value === 'rejected') return value
  throw new StoreError('INVALID_INPUT', 'approval.status must be pending|approved|rejected')
}

function readStoredStatus(value: string): ApprovalStatus {
  return value === 'approved' || value === 'rejected' ? value : 'pending'
}

function readDecision(value: unknown): ApprovalDecision {
  if (value === 'approved' || value === 'rejected') return value
  throw new StoreError('INVALID_INPUT', "approval.decision must be 'approved' or 'rejected'")
}
