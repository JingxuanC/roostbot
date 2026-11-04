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
}

export interface CreateApprovalInput {
  workspaceId: string
  kind: string
  requester: string
  /** 默认 'bot'（迁移里的 DEFAULT 同义）。 */
  requesterKind?: string
  payload: Record<string, unknown>
  /** epoch 毫秒；默认 Date.now()。 */
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
}

const APPROVAL_COLUMNS =
  'id, workspace_id, kind, requester, requester_kind, payload_json, status, created_at, decided_at, decided_by'

/** paylaod 上限：审批只带参数，不该塞大对象（64KiB，与 API body 上限一致）。 */
const PAYLOAD_MAX_BYTES = 64 * 1024

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
  const at =
    req.at === undefined || req.at === null
      ? Date.now()
      : asInteger(req.at, 'approval.at', 0, 'INVALID_INPUT')

  const workspace = store.db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId)
  if (workspace === undefined || workspace === null) {
    throw new StoreError('WORKSPACE_NOT_FOUND', `unknown workspace ${workspaceId}`)
  }

  const id = newRoostId('apr', at)
  try {
    store.db
      .prepare(
        `INSERT INTO approvals (${APPROVAL_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)`,
      )
      .run(id, workspaceId, kind, requester, requesterKind, JSON.stringify(payload), at)
  } catch (err) {
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
  if (current.status !== 'pending') return current

  store.db
    .prepare("UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'")
    .run(decision, at, by, id)

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
