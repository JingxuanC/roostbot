// workspace 成员与角色（docs/design/auth.md §5、§13）。
//
// workspace_members 由 0001 迁移建好；本模块只补「读成员 + 改角色 + 移除成员」。
// 邀请（email 绑定角色）留到 5.3.1，这里不写 invites。
//
// 规则（auth.md §5）：
//   * 调用者 by 必须是 owner/admin；
//   * 只有 owner 能授予/撤销 owner（admin 不能把别人抬成 owner，也不能动 owner）；
//   * 不能把最后一个 owner 降级或移除（先数 owner 数量）。
//
// 事件（events.md §3）：角色变化写 auth.role.changed，移除成员写 auth.member.removed
// （后者是实现补充，见 auth.md §13）。行与事件在同一个 savepoint 里，同生共死。
//
// StoreError.code 是 errors.ts 的封闭枚举，本批不扩共享错误码；成员域错误码用
// `CODE: detail` 写在 message 前缀里，API 层用 storeErrorTag() 取回（与 approvals 同法）。

import { StoreError } from './errors.ts'
import { appendEvent } from './events.ts'
import { asInteger, asNonEmptyString, asRecord, assertOpen, toNumber } from './internal.ts'
import type { Store } from './types.ts'

export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'viewer'] as const
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number]

/** 成员域内部错误码（写在 StoreError.message 的 `CODE: ` 前缀里）。 */
export const MEMBER_ERROR_CODES = {
  notFound: 'WORKSPACE_MEMBER_NOT_FOUND',
  lastOwner: 'WORKSPACE_LAST_OWNER',
  forbidden: 'WORKSPACE_MEMBER_FORBIDDEN',
} as const

export interface WorkspaceMember {
  accountId: string
  role: WorkspaceRole
  /** 谁邀请的；v0 的创建者 owner 为 null。 */
  invitedBy: string | null
  createdAt: number
}

export interface SetWorkspaceMemberRoleInput {
  workspaceId: string
  accountId: string
  role: WorkspaceRole
  /** 调用者（审计 actor）。 */
  by: string
  /** epoch 毫秒；默认 Date.now()。 */
  at?: number
}

export interface RemoveWorkspaceMemberInput {
  workspaceId: string
  accountId: string
  by: string
  at?: number
}

interface MemberRow {
  user_id: string
  role: string
  invited_by: string | null
  created_at: number | bigint
}

const MEMBER_COLUMNS = 'user_id, role, invited_by, created_at'

/** 按 created_at 升序列出成员；同一毫秒按 accountId 兜底，保证顺序稳定。 */
export function listWorkspaceMembers(store: Store, workspaceId: string): WorkspaceMember[] {
  assertOpen(store)
  const id = asNonEmptyString(workspaceId, 'workspaceId')
  const rows = store.db
    .prepare(
      `SELECT ${MEMBER_COLUMNS} FROM workspace_members WHERE workspace_id = ? ORDER BY created_at ASC, user_id ASC`,
    )
    .all(id)
  return rows.map(rowToMember)
}

export function getWorkspaceMember(
  store: Store,
  workspaceId: string,
  accountId: string,
): WorkspaceMember | null {
  assertOpen(store)
  const id = asNonEmptyString(workspaceId, 'workspaceId')
  const account = asNonEmptyString(accountId, 'accountId')
  const row = store.db
    .prepare(`SELECT ${MEMBER_COLUMNS} FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
    .get(id, account)
  return row === undefined || row === null ? null : rowToMember(row)
}

/**
 * 返回账号在 workspace 里的角色；非成员返回 null。
 * 刻意不默认成 viewer：viewer 只用于展示，不能拿它做授权判断（auth.md §5）。
 */
export function getWorkspaceRole(
  store: Store,
  workspaceId: string,
  accountId: string,
): WorkspaceRole | null {
  const member = getWorkspaceMember(store, workspaceId, accountId)
  return member === null ? null : member.role
}

/** 改角色（幂等：角色没变时不写事件）。 */
export function setWorkspaceMemberRole(store: Store, input: SetWorkspaceMemberRoleInput): WorkspaceMember {
  assertOpen(store)
  const req = asRecord(input, 'member')
  const workspaceId = asNonEmptyString(req.workspaceId, 'member.workspaceId')
  const accountId = asNonEmptyString(req.accountId, 'member.accountId')
  const by = asNonEmptyString(req.by, 'member.by')
  const role = readRole(req.role)
  const at = readAt(req.at)

  return withSavepoint(store, 'roost_set_workspace_member_role', () => {
    const byRole = requireManager(store, workspaceId, by)
    const target = getWorkspaceMember(store, workspaceId, accountId)
    if (target === null) {
      throw new StoreError(
        'INVALID_INPUT',
        tag(MEMBER_ERROR_CODES.notFound, `account ${accountId} is not a member of ${workspaceId}`),
      )
    }

    // 角色没变：不写行、不写事件，直接返回当前成员。
    if (target.role === role) return target

    // 授予/撤销 owner 是 owner 专属；admin 不能碰 owner。
    if ((target.role === 'owner' || role === 'owner') && byRole !== 'owner') {
      throw new StoreError(
        'FORBIDDEN',
        tag(MEMBER_ERROR_CODES.forbidden, `only an owner can grant or revoke owner (actor ${by})`),
      )
    }
    // 最后一个 owner 不能降级（count 与 UPDATE 在同一 savepoint，避免并发漏判）。
    if (target.role === 'owner' && countOwners(store, workspaceId) <= 1) {
      throw new StoreError(
        'FORBIDDEN',
        tag(MEMBER_ERROR_CODES.lastOwner, `workspace ${workspaceId} must keep at least one owner`),
      )
    }

    store.db
      .prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?')
      .run(role, workspaceId, accountId)

    appendEvent(store, {
      domain: 'auth',
      kind: 'auth.role.changed',
      at: new Date(at).toISOString(),
      actor: { kind: 'user', id: by },
      subject: { kind: 'member', id: accountId },
      payload: { workspaceId, from: target.role, to: role },
    })

    const saved = getWorkspaceMember(store, workspaceId, accountId)
    if (saved === null) {
      throw new StoreError(
        'INVALID_INPUT',
        tag(MEMBER_ERROR_CODES.notFound, `member ${accountId} vanished after update`),
      )
    }
    return saved
  })
}

/** 移除成员；不能移除最后一个 owner，admin 不能移除 owner。 */
export function removeWorkspaceMember(store: Store, input: RemoveWorkspaceMemberInput): void {
  assertOpen(store)
  const req = asRecord(input, 'member')
  const workspaceId = asNonEmptyString(req.workspaceId, 'member.workspaceId')
  const accountId = asNonEmptyString(req.accountId, 'member.accountId')
  const by = asNonEmptyString(req.by, 'member.by')
  const at = readAt(req.at)

  withSavepoint(store, 'roost_remove_workspace_member', () => {
    const byRole = requireManager(store, workspaceId, by)
    const target = getWorkspaceMember(store, workspaceId, accountId)
    if (target === null) {
      throw new StoreError(
        'INVALID_INPUT',
        tag(MEMBER_ERROR_CODES.notFound, `account ${accountId} is not a member of ${workspaceId}`),
      )
    }

    if (target.role === 'owner') {
      if (byRole !== 'owner') {
        throw new StoreError(
          'FORBIDDEN',
          tag(MEMBER_ERROR_CODES.forbidden, `only an owner can remove an owner (actor ${by})`),
        )
      }
      if (countOwners(store, workspaceId) <= 1) {
        throw new StoreError(
          'FORBIDDEN',
          tag(MEMBER_ERROR_CODES.lastOwner, `workspace ${workspaceId} must keep at least one owner`),
        )
      }
    }

    store.db
      .prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .run(workspaceId, accountId)

    appendEvent(store, {
      domain: 'auth',
      kind: 'auth.member.removed',
      at: new Date(at).toISOString(),
      actor: { kind: 'user', id: by },
      subject: { kind: 'member', id: accountId },
      payload: { workspaceId, role: target.role },
    })
  })
}

// ---- 内部 --------------------------------------------------------------------

function requireManager(store: Store, workspaceId: string, by: string): WorkspaceRole {
  const role = getWorkspaceRole(store, workspaceId, by)
  if (role !== 'owner' && role !== 'admin') {
    throw new StoreError(
      'FORBIDDEN',
      tag(MEMBER_ERROR_CODES.forbidden, `account ${by} cannot manage members of ${workspaceId}`),
    )
  }
  return role
}

function countOwners(store: Store, workspaceId: string): number {
  const row = store.db
    .prepare("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'owner'")
    .get(workspaceId) as { n: number | bigint } | undefined
  return row === undefined || row === null ? 0 : toNumber(row.n)
}

function readRole(value: unknown): WorkspaceRole {
  if (typeof value !== 'string' || !(WORKSPACE_ROLES as readonly string[]).includes(value)) {
    throw new StoreError('INVALID_INPUT', `member.role must be one of ${WORKSPACE_ROLES.join(', ')}`)
  }
  return value as WorkspaceRole
}

function readAt(value: unknown): number {
  return value === undefined || value === null ? Date.now() : asInteger(value, 'member.at', 0)
}

function rowToMember(row: unknown): WorkspaceMember {
  const r = row as MemberRow
  return {
    accountId: r.user_id,
    role: r.role as WorkspaceRole,
    invitedBy: r.invited_by,
    createdAt: toNumber(r.created_at),
  }
}

function tag(code: string, detail: string): string {
  return `${code}: ${detail}`
}

/** 行与事件同一 savepoint：事件写失败时回滚角色/成员变更。 */
function withSavepoint<T>(store: Store, name: string, fn: () => T): T {
  store.db.exec(`SAVEPOINT ${name}`)
  try {
    const result = fn()
    store.db.exec(`RELEASE ${name}`)
    return result
  } catch (err) {
    try {
      store.db.exec(`ROLLBACK TO ${name}`)
      store.db.exec(`RELEASE ${name}`)
    } catch {
      // savepoint 可能已随外层事务回滚；保留原始错误。
    }
    throw err
  }
}
