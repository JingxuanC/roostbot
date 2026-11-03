// StorePort 的内存实现：测试、本地跑、以及 Lead 接真实 store 之前的占位。
//
// 有意不持久化：进程退出即丢。这不是「假成功」，是 v0 本地控制面的诚实行为
// （main.ts 启动时会明确打印 state is lost on exit）。
//
// 与真实 store 的差别：这里没有跨进程并发，单线程 JS 天然满足 port.ts 的原子性契约。
import { randomBytes } from 'node:crypto'
import { PairingCodeCollisionError } from './port.ts'
import type {
  ClaimPairingCodeInput,
  ClaimPairingCodeResult,
  CreatePairingCodeInput,
  CreateSessionInput,
  CreateWorkspaceInput,
  DevicePlatform,
  HomeMode,
  PairingRecord,
  SessionRecord,
  StorePort,
  WorkspaceRecord,
  WorkspaceRole
} from './port.ts'

interface DeviceEntry {
  id: string
  accountId: string
  label?: string
  platform?: DevicePlatform
  createdAt: number
}

/** 内部记录不含 role：role 是「当前账号」的视角，按成员表算出来。 */
type WorkspaceEntryRecord = Omit<WorkspaceRecord, 'role'>

interface WorkspaceEntry {
  record: WorkspaceEntryRecord
  members: Map<string, WorkspaceRole>
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('hex')}`
}

function copyPairing(record: PairingRecord): PairingRecord {
  return { ...record }
}

export function createMemoryStore(): StorePort {
  const pairing = new Map<string, PairingRecord>()
  const workspaces = new Map<string, WorkspaceEntry>()
  const sessions = new Map<string, SessionRecord>()
  const devices = new Map<string, DeviceEntry>()

  function fail(record: PairingRecord, input: ClaimPairingCodeInput, reason: 'expired' | 'used'): ClaimPairingCodeResult {
    record.attempts += 1
    if (record.attempts >= input.maxAttempts) {
      record.lockedUntil = input.now + input.lockMs
      return { ok: false, reason: 'locked' }
    }
    return { ok: false, reason }
  }

  return {
    async createPairingCode(input: CreatePairingCodeInput): Promise<PairingRecord> {
      const existing = pairing.get(input.code)
      const active = existing !== undefined && existing.usedAt === undefined && existing.expiresAt > input.now
      if (active) throw new PairingCodeCollisionError(input.code)

      const record: PairingRecord = {
        code: input.code,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        createdAt: input.now,
        expiresAt: input.expiresAt,
        attempts: 0
      }
      pairing.set(input.code, record)
      return copyPairing(record)
    },

    async claimPairingCode(input: ClaimPairingCodeInput): Promise<ClaimPairingCodeResult> {
      const record = pairing.get(input.code)
      if (record === undefined) return { ok: false, reason: 'invalid' }

      if (record.lockedUntil !== undefined) {
        if (record.lockedUntil > input.now) return { ok: false, reason: 'locked' }
        // 锁过期：重新给次数，但码本身通常也已经过期了。
        record.lockedUntil = undefined
        record.attempts = 0
      }

      if (record.usedAt !== undefined) return fail(record, input, 'used')
      if (record.expiresAt <= input.now) return fail(record, input, 'expired')

      record.usedAt = input.now
      return { ok: true, pairing: copyPairing(record) }
    },

    async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
      const homeMode: HomeMode = input.homeMode ?? 'local'
      const record: WorkspaceEntryRecord = {
        id: newId('ws'),
        // v0：一个账号一个租户。真正的租户/计费模型不在这一层（见 workspace.md §8）。
        tenantId: input.accountId,
        name: input.name,
        homeMode,
        state: 'stopped',
        profileVersion: input.profileVersion ?? 'dev',
        createdAt: input.now
      }
      const members = new Map<string, WorkspaceRole>()
      members.set(input.accountId, 'owner')
      workspaces.set(record.id, { record, members })
      return { ...record, role: 'owner' }
    },

    async listWorkspaces(input: { accountId: string }): Promise<WorkspaceRecord[]> {
      const rows: WorkspaceRecord[] = []
      for (const entry of workspaces.values()) {
        const role = entry.members.get(input.accountId)
        if (role === undefined) continue
        rows.push({ ...entry.record, role })
      }
      rows.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return rows
    },

    async createSession(input: CreateSessionInput): Promise<SessionRecord> {
      if (sessions.has(input.tokenHash)) throw new Error('session token hash already exists')

      const device: DeviceEntry = {
        id: newId('dev'),
        accountId: input.accountId,
        label: input.deviceLabel,
        platform: input.platform,
        createdAt: input.now
      }
      devices.set(device.id, device)

      const session: SessionRecord = {
        id: newId('ses'),
        accountId: input.accountId,
        deviceId: device.id,
        workspaceId: input.workspaceId,
        tokenHash: input.tokenHash,
        createdAt: input.now,
        expiresAt: input.expiresAt
      }
      sessions.set(session.tokenHash, session)
      return { ...session }
    },

    async findSessionByToken(tokenHash: string): Promise<SessionRecord | null> {
      const session = sessions.get(tokenHash)
      return session === undefined ? null : { ...session }
    }
  }
}
