// 设计见 docs/design/plugins.md。只有类型与纯判定。

export type PluginTier = 'base' | 'paid' | 'community'

/** 插件自带的兼容声明（§6）。 */
export interface PluginManifest {
  engines: string                 // DSH peer 区间，例如 "^0.2.1-alpha.2"
  slots: string[]                 // 占用的 slot 名
  services: string[]              // 依赖的 Cordis 服务
  panels: number
  routes: string[]                // 注册的 HTTP 前缀
  data: string[]                  // 需要的只读数据集（bars/news…）
  diskBytes?: number
}

export interface PluginInstall {
  workspaceId: string
  slug: string
  version: string
  enabled: boolean
  installedBy: string
  installedAt: number
  preflight?: PreflightResult
}

export interface CatalogEntry {
  slug: string
  title: string
  tier: PluginTier
  latest: string
  manifest: PluginManifest
}

export interface PreflightInput {
  manifest: PluginManifest
  pluginVersion: string
  dshVersion: string
  installedRoutes: string[]
  installedSlots: string[]
  availableData: string[]
  freeDiskBytes: number
}

export type PreflightProblem =
  | { code: 'dsh-version'; detail: string }
  | { code: 'route-conflict'; detail: string }
  | { code: 'slot-conflict'; detail: string }
  | { code: 'missing-data'; detail: string }
  | { code: 'disk'; detail: string }

export interface PreflightResult {
  ok: boolean
  problems: PreflightProblem[]
}

/** 极简 semver 区间判断：只支持云上实际用到的三种写法（^x.y.z / >=x.y.z / x.y.z）。 */
export function satisfies(version: string, range: string): boolean {
  const parse = (v: string): number[] => v.replace(/^[^0-9]*/, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const [maj, min = 0, pat = 0] = parse(version)
  const trimmed = range.trim()
  const target = parse(trimmed)
  const [tmaj, tmin = 0, tpat = 0] = target
  if (trimmed.startsWith('^')) {
    if (maj !== tmaj) return false
    return min > tmin || (min === tmin && pat >= tpat)
  }
  if (trimmed.startsWith('>=')) {
    if (maj !== tmaj) return maj > tmaj
    if (min !== tmin) return min > tmin
    return pat >= tpat
  }
  return maj === tmaj && min === tmin && pat === tpat
}

/**
 * 预检：任何一项失败就禁止安装（不是装完再炸）。
 * 对应 design §3 ① 的六项，这里是可判定的四项（dry-run mount 由运行时负责）。
 */
export function preflight(input: PreflightInput): PreflightResult {
  const problems: PreflightProblem[] = []
  if (!satisfies(input.dshVersion, input.manifest.engines)) {
    problems.push({ code: 'dsh-version', detail: `requires ${input.manifest.engines}, have ${input.dshVersion}` })
  }
  for (const route of input.manifest.routes) {
    if (input.installedRoutes.includes(route)) problems.push({ code: 'route-conflict', detail: route })
  }
  for (const slot of input.manifest.slots) {
    if (input.installedSlots.includes(slot)) problems.push({ code: 'slot-conflict', detail: slot })
  }
  for (const data of input.manifest.data) {
    if (!input.availableData.includes(data)) problems.push({ code: 'missing-data', detail: data })
  }
  const need = input.manifest.diskBytes ?? 0
  if (need > 0 && input.freeDiskBytes < need) {
    problems.push({ code: 'disk', detail: `needs ${Math.ceil(need / 1e6)}MB, free ${Math.floor(input.freeDiskBytes / 1e6)}MB` })
  }
  return { ok: problems.length === 0, problems }
}

const CLOUD_PACKAGE_SPEC = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** 云上只接受 registry 包名 @ semver。本地路径、git 和任意 URL 都拒绝。 */
export function isCloudInstallable(spec: string): boolean {
  return CLOUD_PACKAGE_SPEC.test(spec.trim())
}
