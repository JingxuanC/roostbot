// Profile 锁的 IO 侧（TODO 4.3.4）：纯构造在 packages/plugins/src/profile-lock.ts，
// 这里只剩两件事——从基线 profile 目录读出锁、从控制面 HTTP 把锁拉回来。
//
// M4 的锁数据源是镜像基线 profile（apps/runtime/profile/：package.json +
// cordis.patch.yml，无依赖故无 pnpm-lock.yaml）；插件市场落地后 load 侧换成
// 从 plugins 表生成，fetch 侧与锁形状不变。

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildProfileLock, verifyProfileLock } from '../../../packages/plugins/src/profile-lock.ts'
import type { ProfileLock } from '../../../packages/plugins/src/profile-lock.ts'

/** 仓库内基线 profile：apps/api/src → apps/runtime/profile。 */
export const BASELINE_PROFILE_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../runtime/profile')

/** 从基线 profile 目录生成锁；目录缺文件时抛错（调用方决定 500 还是中止启动）。 */
export async function loadBaselineProfileLock(options: { profileDir?: string; now?: () => number } = {}): Promise<ProfileLock> {
  const dir = options.profileDir ?? BASELINE_PROFILE_DIR
  let packageJson: string
  let patch: string
  try {
    ;[packageJson, patch] = await Promise.all([
      readFile(resolve(dir, 'package.json'), 'utf8'),
      readFile(resolve(dir, 'cordis.patch.yml'), 'utf8')
    ])
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`baseline profile unreadable at ${dir}: ${detail}`)
  }
  // pnpm-lock.yaml 可选：基线没有依赖，将来有依赖时必须带上。
  const lockfile = await readFile(resolve(dir, 'pnpm-lock.yaml'), 'utf8').catch(() => null)
  return buildProfileLock({
    source: 'baseline-profile',
    packageJson,
    patch,
    lockfile,
    generatedAt: options.now?.() ?? Date.now()
  })
}

/**
 * 从控制面拉锁（runtime 侧；POST /api/internal/plugins/sync，runtime token 鉴权）。
 * 失败一律抛错：锁拉不到就不许假装启动成功。拉到后校验形状与 integrity，
 * 被篡改/截断的锁文档同样算失败。
 */
export async function fetchProfileLock(options: {
  apiBase: string
  runtimeToken: string
  fetchImpl?: typeof fetch
}): Promise<ProfileLock> {
  const doFetch = options.fetchImpl ?? fetch
  const url = `${options.apiBase.replace(/\/+$/, '')}/api/internal/plugins/sync`
  let res: Awaited<ReturnType<typeof fetch>>
  try {
    res = await doFetch(url, { method: 'POST', headers: { 'x-runtime-token': options.runtimeToken } })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`profile lock sync failed: ${url} unreachable (${detail})`)
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    throw new Error(`profile lock sync failed: POST ${url} -> ${res.status}${text === '' ? '' : `: ${text.slice(0, 200)}`}`)
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`profile lock sync failed: POST ${url} returned invalid JSON`)
  }
  const lock = (payload as { lock?: unknown }).lock
  if (!verifyProfileLock(lock)) {
    throw new Error(`profile lock sync failed: POST ${url} returned an invalid lock document (shape or integrity)`)
  }
  return lock
}
