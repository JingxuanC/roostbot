// 把 packages/store（同步 + 抛 StoreError）适配成控制面 API 的 StorePort（异步 + 结果对象）。
//
// 契约见 apps/api/src/port.ts 文件头五条；这里逐条兑现：
//   1. 配对码冲突 → PairingCodeCollisionError（不覆盖活着的码）
//   2. claim 的读改写在 store 内部的 savepoint 里完成（原子）
//   3. 会话只按 hash 查，明文 token 不经过这一层
//   4. now / expiresAt 都由调用方传入，适配器不读时钟
//   5. 返回值都是新对象（store 已经这么做，这里再拷贝一次角色字段）

import { randomUUID } from 'node:crypto'

import {
  StoreError,
  claimPairingCode as claimInStore,
  createPairingCode as createPairingInStore,
  createSession as createSessionInStore,
  createWorkspace as createWorkspaceInStore,
  findSessionByTokenHash,
  listWorkspaces as listWorkspacesInStore,
  touchSession,
} from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/index.ts'
import {
  PairingCodeCollisionError,
  type ClaimPairingCodeInput,
  type ClaimPairingCodeResult,
  type CreatePairingCodeInput,
  type CreateSessionInput,
  type CreateWorkspaceInput,
  type PairingRecord,
  type SessionRecord,
  type StorePort,
  type WorkspaceRecord,
  type WorkspaceRole,
} from './port.ts'

const DEFAULT_PROFILE_VERSION = 'dev'

export function createStorePort(store: Store): StorePort {
  return {
    async createPairingCode(input: CreatePairingCodeInput): Promise<PairingRecord> {
      try {
        const created = createPairingInStore(store, {
          code: input.code,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          now: input.now,
          expiresAt: input.expiresAt,
        })
        return toPairingRecord(created)
      } catch (err) {
        if (err instanceof StoreError && err.code === 'PAIRING_CODE_CONFLICT') {
          throw new PairingCodeCollisionError(`pairing code ${input.code} is still live`)
        }
        throw err
      }
    },

    async claimPairingCode(input: ClaimPairingCodeInput): Promise<ClaimPairingCodeResult> {
      try {
        const claim = claimInStore(store, {
          code: input.code,
          now: input.now,
          maxAttempts: input.maxAttempts,
        })
        // claim 成功后回读一次：端口要 createdAt/expiresAt，而 PairingClaim 只带部分字段。
        const row = store.db
          .prepare('SELECT created_at, expires_at, used_at, attempts FROM pairing_codes WHERE code = ?')
          .get(input.code) as
          | { created_at: number | bigint; expires_at: number | bigint; used_at: number | bigint | null; attempts: number | bigint }
          | undefined
        return {
          ok: true,
          pairing: {
            code: claim.code,
            accountId: claim.accountId,
            ...(claim.workspaceId === null ? {} : { workspaceId: claim.workspaceId }),
            createdAt: row === undefined ? claim.createdAt : Number(row.created_at),
            expiresAt: row === undefined ? input.now : Number(row.expires_at),
            usedAt: row === undefined ? claim.usedAt : (row.used_at === null ? undefined : Number(row.used_at)),
            attempts: row === undefined ? claim.attempts : Number(row.attempts),
          },
        }
      } catch (err) {
        if (err instanceof StoreError) {
          const reason = claimReason(err.code)
          if (reason !== null) return { ok: false, reason }
        }
        throw err
      }
    },

    async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
      const workspace = createWorkspaceInStore(store, {
        tenantId: input.accountId,
        name: input.name,
        homeMode: input.homeMode ?? 'cloud',
        state: 'stopped',
        volumeId: null,
        profileVersion: input.profileVersion ?? DEFAULT_PROFILE_VERSION,
        createdAt: input.now,
      })
      // 创建者即 owner（port 契约：createWorkspace 要写成员并返回 role）。
      store.db
        .prepare(
          'INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, invited_by, created_at) VALUES (?, ?, ?, NULL, ?)',
        )
        .run(workspace.id, input.accountId, 'owner', input.now)
      return {
        id: workspace.id,
        tenantId: workspace.tenantId,
        name: workspace.name,
        homeMode: workspace.homeMode,
        state: workspace.state,
        ...(workspace.volumeId === null ? {} : { volumeId: workspace.volumeId }),
        profileVersion: workspace.profileVersion,
        role: 'owner',
        createdAt: workspace.createdAt,
      }
    },

    async listWorkspaces(input: { accountId: string }): Promise<WorkspaceRecord[]> {
      const rows = listWorkspacesInStore(store, { tenantId: input.accountId })
      return rows.map((workspace) => ({
        id: workspace.id,
        tenantId: workspace.tenantId,
        name: workspace.name,
        homeMode: workspace.homeMode,
        state: workspace.state,
        ...(workspace.volumeId === null ? {} : { volumeId: workspace.volumeId }),
        profileVersion: workspace.profileVersion,
        role: roleOf(store, workspace.id, input.accountId),
        createdAt: workspace.createdAt,
      }))
    },

    async createSession(input: CreateSessionInput): Promise<SessionRecord> {
      // 端口只给 deviceLabel/platform：设备由适配器建，会话绑定到它。
      const deviceId = `dev_${randomUUID().replaceAll('-', '')}`
      store.db
        .prepare(
          'INSERT INTO devices (id, account_id, label, platform, last_seen_at, revoked_at, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)',
        )
        .run(deviceId, input.accountId, input.deviceLabel ?? null, input.platform ?? null, input.now)
      const session = createSessionInStore(store, {
        id: `ses_${randomUUID().replaceAll('-', '')}`,
        accountId: input.accountId,
        deviceId,
        tokenHash: input.tokenHash,
        createdAt: input.now,
        expiresAt: input.expiresAt,
      })
      return {
        id: session.id,
        accountId: session.accountId,
        deviceId: session.deviceId,
        tokenHash: session.tokenHash,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
      }
    },

    async findSessionByToken(tokenHash: string): Promise<SessionRecord | null> {
      const session = findSessionByTokenHash(store, tokenHash)
      if (session === null) return null
      // 每次成功鉴权都记一次活跃（会话续期由调用方决定，这里不动 expiresAt）。
      const touched = touchSession(store, session.id, { lastSeenAt: Date.now() })
      return {
        id: touched.id,
        accountId: touched.accountId,
        deviceId: touched.deviceId,
        tokenHash: touched.tokenHash,
        createdAt: touched.createdAt,
        expiresAt: touched.expiresAt,
        lastSeenAt: touched.lastSeenAt ?? undefined,
        ...(touched.revokedAt === null ? {} : { revokedAt: touched.revokedAt }),
      }
    },
  }
}

function roleOf(store: Store, workspaceId: string, accountId: string): WorkspaceRole {
  const row = store.db
    .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(workspaceId, accountId) as { role: WorkspaceRole } | undefined
  return row?.role ?? 'viewer'
}

function claimReason(code: string): 'invalid' | 'expired' | 'used' | 'locked' | null {
  switch (code) {
    case 'PAIRING_CODE_NOT_FOUND':
      return 'invalid'
    case 'PAIRING_CODE_EXPIRED':
      return 'expired'
    case 'PAIRING_CODE_USED':
      return 'used'
    case 'PAIRING_CODE_LOCKED':
      return 'locked'
    default:
      return null
  }
}

function toPairingRecord(created: {
  code: string
  accountId: string
  workspaceId: string | null
  createdAt: number
  expiresAt: number
  usedAt: number | null
  attempts: number
}): PairingRecord {
  return {
    code: created.code,
    accountId: created.accountId,
    ...(created.workspaceId === null ? {} : { workspaceId: created.workspaceId }),
    createdAt: created.createdAt,
    expiresAt: created.expiresAt,
    attempts: created.attempts,
    ...(created.usedAt === null ? {} : { usedAt: created.usedAt }),
  }
}
