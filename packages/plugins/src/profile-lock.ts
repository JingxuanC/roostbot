// Profile 锁文档：沙箱启动前 runtime 从控制面拉的那一份
// （docs/design/plugin-marketplace.md §4 ④⑤、§6 接口清单；docs/runtime-contract.md §6）。
//
// 锁 = profile 的 package.json + cordis.patch.yml + pnpm-lock.yaml（可空）+ integrity。
// M4 还没有插件市场：锁的内容就是镜像基线 profile（apps/runtime/profile/），
// source = 'baseline-profile'；市场落地后由 plugins 表生成，锁的形状不变。
//
// integrity 只对内容取 sha256，不含 generatedAt：同一份 profile 任何时候拉，
// integrity 与 id 都相同（内容寻址）。
//
// ⚠️ 沙箱内校验锁时需要同一份配方（镜像只拷 room-agent.mjs，不能 import 包）；
// 在沙箱侧落地 sync 时把本文件的哈希配方复制过去，并保持两处同步。

import { createHash } from 'node:crypto'

export const PROFILE_LOCK_KIND = 'roost.profile-lock'
export const PROFILE_LOCK_VERSION = 1

export interface ProfileLock {
  kind: typeof PROFILE_LOCK_KIND
  version: typeof PROFILE_LOCK_VERSION
  /** 锁标识：内容寻址（`lock-` + integrity 前 12 位），同内容同 id。 */
  id: string
  /** 锁数据源：M4 = 'baseline-profile'；市场落地后 = plugins 表生成。 */
  source: string
  /** 生成时间（毫秒）。不参与 integrity。 */
  generatedAt: number
  /** profile/package.json 原文。 */
  packageJson: string
  /** cordis.patch.yml 原文（用户覆盖层；基线是空数组）。 */
  patch: string
  /** pnpm-lock.yaml 原文；基线 profile 没有依赖，故为 null。 */
  lockfile: string | null
  /** 对上面三份内容的 sha256（hex）。 */
  integrity: string
}

export function profileLockIntegrity(parts: { packageJson: string; patch: string; lockfile: string | null }): string {
  const hash = createHash('sha256')
  hash.update('roost.profile-lock/v1', 'utf8')
  hash.update('\0', 'utf8')
  hash.update(parts.packageJson, 'utf8')
  hash.update('\0', 'utf8')
  hash.update(parts.patch, 'utf8')
  hash.update('\0', 'utf8')
  hash.update(parts.lockfile ?? '', 'utf8')
  return hash.digest('hex')
}

export function lockIdFor(integrity: string): string {
  return `lock-${integrity.slice(0, 12)}`
}

export function buildProfileLock(parts: {
  source: string
  packageJson: string
  patch: string
  lockfile?: string | null
  generatedAt: number
}): ProfileLock {
  const lockfile = parts.lockfile ?? null
  const integrity = profileLockIntegrity({ packageJson: parts.packageJson, patch: parts.patch, lockfile })
  return {
    kind: PROFILE_LOCK_KIND,
    version: PROFILE_LOCK_VERSION,
    id: lockIdFor(integrity),
    source: parts.source,
    generatedAt: parts.generatedAt,
    packageJson: parts.packageJson,
    patch: parts.patch,
    lockfile,
    integrity
  }
}

/** 形状 + integrity 校验：拉锁的一侧用它拒绝被篡改/截断的锁文档。 */
export function verifyProfileLock(lock: unknown): lock is ProfileLock {
  if (typeof lock !== 'object' || lock === null) return false
  const doc = lock as Record<string, unknown>
  if (doc['kind'] !== PROFILE_LOCK_KIND || doc['version'] !== PROFILE_LOCK_VERSION) return false
  if (typeof doc['id'] !== 'string' || typeof doc['source'] !== 'string') return false
  if (typeof doc['generatedAt'] !== 'number' || !Number.isFinite(doc['generatedAt'])) return false
  if (typeof doc['packageJson'] !== 'string' || typeof doc['patch'] !== 'string') return false
  if (doc['lockfile'] !== null && typeof doc['lockfile'] !== 'string') return false
  const integrity = doc['integrity']
  if (typeof integrity !== 'string' || !/^[0-9a-f]{64}$/.test(integrity)) return false
  const expected = profileLockIntegrity({
    packageJson: doc['packageJson'] as string,
    patch: doc['patch'] as string,
    lockfile: (doc['lockfile'] as string | null) ?? null
  })
  return integrity === expected && doc['id'] === lockIdFor(integrity)
}
