// 插件安装的纯逻辑：profile 锁输入、patch 行、预检、作业状态机。
//
// 事实源：docs/build/wave1.md §B（5.1.3 / 5.1.5 / 5.1.8 / 5.1.9 / 5.1.10）、
//         docs/design/plugin-marketplace.md §3（A/B/C/D 分级）/ §4（安装流程）/ §8（供应链）。
//
// 这个文件不碰 DB、不跑 pnpm、不发 HTTP：只做「给定事实，算出唯一答案」。
// 真正的副作用（写 job、写锁、审批、synced）在 packages/store/src/marketplace-jobs.ts
// 与 apps/api/src/marketplace-install-routes.ts。
//
// ⚠️ 与 packages/plugins/src/profile-lock.ts 的 `buildProfileLock` 同名但不同层：
//   这里造的是**锁的输入**（package.json / patch 行 / pnpm-lock 占位摘要 + hash）；
//   profile-lock.ts 的 buildProfileLock 组装**带 integrity/id 的锁文档**。
//   所以 packages/plugins/src/index.ts **不要** `export * from './install.ts'`
//   （会与 profile-lock 的同名导出冲突）；直接按路径 import。

import { createHash } from 'node:crypto'

import { classifyPlugin } from './compat.ts'
import type { PluginCapabilities, PluginTier } from './compat.ts'
import { checkReleaseAge, isAllowlisted, signatureState } from './trust.ts'

// ---- 版本区间：最小 semver 实现 -------------------------------------------------
//
// 只为了预检 engines（^ / ~ / >= / <= / > / < / 精确 / `||` / 空格并列），
// 不引依赖、不实现 npm 的全部边角（不含 hyphen range、不含 `x` 通配、不含 peer 解析）。
// 数值三元组 + prerelease 比较遵循 semver §11 的核心规则：
//   prerelease < 同版本正式版；`0.2.1-rc.5` 落在 `^0.2.1-alpha.2` 里。

export interface SemVerParts {
  major: number
  minor: number
  patch: number
  prerelease: (string | number)[]
}

const SEMVER_PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseSemver(value: string): SemVerParts | null {
  const match = SEMVER_PATTERN.exec(value.trim())
  if (match === null) return null
  const major = Number(match[1])
  const minor = match[2] === undefined ? 0 : Number(match[2])
  const patch = match[3] === undefined ? 0 : Number(match[3])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null
  }
  const pre = match[4]
  const prerelease =
    pre === undefined
      ? []
      : pre.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  return { major, minor, patch, prerelease }
}

function parseVersionText(value: string): SemVerParts | null {
  return parseSemver(value)
}

/** semver 比较：<0 / 0 / >0；任一侧不可解析时返回 null（调用方按不满足处理）。 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersionText(a)
  const right = parseVersionText(b)
  if (left === null || right === null) return null
  return compareParsed(left, right)
}

function compareParsed(a: SemVerParts, b: SemVerParts): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x < y ? -1 : 1
      continue
    }
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function caretUpper(target: SemVerParts): SemVerParts {
  // ^1.2.3 → <2.0.0；^0.2.3 → <0.3.0；^0.0.3 → <0.0.4（最小实现，足够覆盖实际插件）。
  if (target.major > 0) return { major: target.major + 1, minor: 0, patch: 0, prerelease: [] }
  if (target.minor > 0) return { major: 0, minor: target.minor + 1, patch: 0, prerelease: [] }
  return { major: 0, minor: 0, patch: target.patch + 1, prerelease: [] }
}

function tildeUpper(target: SemVerParts): SemVerParts {
  // ~1.2.3 → <1.3.0（~1 → <2.0.0 的写法不常见，最小实现按 minor+1 处理）。
  return { major: target.major, minor: target.minor + 1, patch: 0, prerelease: [] }
}

function satisfiesComparator(version: SemVerParts, token: string): boolean {
  const trimmed = token.trim()
  if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'X' || trimmed === 'latest') {
    return true
  }
  const match = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(trimmed)
  if (match === null) return false
  const operator = match[1] ?? '='
  const target = parseSemver(match[2]!)
  if (target === null) return false
  const comparison = compareParsed(version, target)
  switch (operator) {
    case '>=':
      return comparison >= 0
    case '>':
      return comparison > 0
    case '<=':
      return comparison <= 0
    case '<':
      return comparison < 0
    case '~':
      return comparison >= 0 && compareParsed(version, tildeUpper(target)) < 0
    case '^':
      return comparison >= 0 && compareParsed(version, caretUpper(target)) < 0
    default:
      return comparison === 0
  }
}

/**
 * 最小 semver 区间判断。空区间（未声明 engines）= 不限制，返回 true。
 * 支持 `||` 分支与空格并列（`>=1.0.0 <2.0.0`）。
 */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseVersionText(version)
  if (parsed === null) return false
  const text = typeof range === 'string' ? range.trim() : ''
  if (text === '') return true
  for (const alternative of text.split('||')) {
    const tokens = alternative
      .trim()
      .split(/\s+/)
      .filter((token) => token !== '')
    if (tokens.length === 0) continue
    if (tokens.every((token) => satisfiesComparator(parsed, token))) return true
  }
  return false
}

// ---- profile 锁输入（package.json / patch 行 / pnpm-lock 占位）------------------

export const PROFILE_PACKAGE_NAME = 'roostbot-workspace-profile'
export const INSTALL_PATCH_ID_PREFIX = 'roost-plugin-'

const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const PACKAGE_NAME_PATTERN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const VERSION_TEXT_PATTERN = /^[0-9A-Za-z.+_-]+$/

export interface ProfilePluginInput {
  slug: string
  version: string
  /** 包 integrity（`sha512-...`）；拿不到就写进 lockfile 占位为 unknown。 */
  integrity?: string | null
  /** npm 包名；默认就是 slug（市场的 slug 就是包名）。 */
  packageName?: string | null
}

export interface BuildProfileLockInput {
  /** 这次生成 profile 针对的 DSH 版本（写进 engines.dsh）。 */
  dshVersion: string
  /** 镜像基线 bundle 列表（有序）；v1 一般是空数组。 */
  baseBundles?: readonly string[] | null
  plugins: readonly ProfilePluginInput[]
}

export interface ProfileLockInputs {
  /** profile/package.json 原文。 */
  packageJson: string
  /** 每个插件一条 `cordis.patch.yml` 追加块（只允许 insert）。 */
  patchRows: string[]
  /** pnpm-lock.yaml 的占位摘要：形状像锁，但不执行 pnpm。 */
  lockfile: string
  /** 对上面三份内容取 sha256；同输入同 hash（与调用时间无关）。 */
  hash: string
}

function assertSlug(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SLUG_PATTERN.test(value.trim()) || value.trim().length > 128) {
    throw new TypeError(`${label} must match ${SLUG_PATTERN} (max 128 chars)`)
  }
  return value.trim()
}

function assertVersion(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  const text = value.trim()
  if (text === '' || text.length > 100 || !VERSION_TEXT_PATTERN.test(text)) {
    throw new TypeError(`${label} must be a version string (max 100 chars)`)
  }
  return text
}

function packageNameOf(plugin: ProfilePluginInput): string {
  const raw = plugin.packageName ?? plugin.slug
  if (typeof raw !== 'string' || !PACKAGE_NAME_PATTERN.test(raw.trim())) {
    throw new TypeError(`packageName must be a valid npm package name, got ${String(raw)}`)
  }
  return raw.trim()
}

function integrityOf(plugin: ProfilePluginInput): string {
  if (typeof plugin.integrity === 'string' && plugin.integrity.trim() !== '') {
    return plugin.integrity.trim()
  }
  return 'sha512-unknown'
}

function normalizePlugins(plugins: readonly ProfilePluginInput[]): ProfilePluginInput[] {
  if (!Array.isArray(plugins)) throw new TypeError('plugins must be an array')
  const bySlug = new Map<string, ProfilePluginInput>()
  for (const plugin of plugins) {
    if (typeof plugin !== 'object' || plugin === null) throw new TypeError('plugins entries must be objects')
    const slug = assertSlug(plugin.slug, 'plugins[].slug')
    const version = assertVersion(plugin.version, 'plugins[].version')
    bySlug.set(slug, {
      slug,
      version,
      integrity: integrityOf(plugin),
      packageName: packageNameOf({ ...plugin, slug }),
    })
  }
  return [...bySlug.values()].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
}

function yamlKey(value: string): string {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : JSON.stringify(value)
}

/** 单条 `insert` 行（只允许 insert；id 前缀固定 roost-plugin-）。 */
export function renderPluginPatchRow(plugin: ProfilePluginInput): string {
  const slug = assertSlug(plugin.slug, 'plugin.slug')
  const name = packageNameOf({ ...plugin, slug })
  return [`- insert:`, `    - id: ${INSTALL_PATCH_ID_PREFIX}${slug}`, `      name: ${yamlKey(name)}`].join('\n')
}

/**
 * 我们的 `cordis.patch.yml` 追加行：只 insert、id 前缀 roost-plugin-。
 * `plugins` 给出 profile 现有插件；`slug` 不在其中时补到末尾（安装场景）。
 * 行按 slug 排序，保证同一组插件永远渲染出同一段文本（锁摘要才稳定）。
 */
export function renderInstallPatch(input: {
  slug: string
  plugins?: readonly ProfilePluginInput[]
}): string {
  for (const key of Object.keys(input)) {
    if (key !== 'slug' && key !== 'plugins') throw new TypeError(`renderInstallPatch got unknown key ${key}`)
  }
  const slug = assertSlug(input.slug, 'renderInstallPatch.slug')
  const list = [...(input.plugins ?? [])]
  if (!list.some((plugin) => plugin.slug === slug)) {
    // 刚装的插件可能还不在 plugins 里；patch 行不带版本，补一条占位即可
    // （真正的版本/integrity 走 buildProfileLock 的 dependencies 与 lockfile）。
    list.push({ slug, version: '0.0.0' })
  }
  const normalized = normalizePlugins(list)
  return normalized.map((plugin) => renderPluginPatchRow(plugin)).join('\n')
}

/**
 * 生成 profile 的 package.json / patch 行 / pnpm-lock 占位摘要。
 *
 * **不执行 pnpm**：lockfile 是按插件版本与 integrity 拼出来的确定性占位（5.1.9 的
 * `--frozen-lockfile` 由沙箱内真实 pnpm 校验；控制面只负责「同输入同锁」）。
 */
export function buildProfileLock(input: BuildProfileLockInput): ProfileLockInputs {
  if (typeof input !== 'object' || input === null) throw new TypeError('buildProfileLock input must be an object')
  const dshVersion = typeof input.dshVersion === 'string' ? input.dshVersion.trim() : ''
  if (dshVersion === '') throw new TypeError('dshVersion is required')
  const bundles = (input.baseBundles ?? []).map((bundle) => {
    if (typeof bundle !== 'string' || bundle.trim() === '') {
      throw new TypeError('baseBundles entries must be non-empty strings')
    }
    return bundle.trim()
  })
  const plugins = normalizePlugins(input.plugins)

  const dependencies: Record<string, string> = {}
  for (const plugin of plugins) dependencies[packageNameOf(plugin)] = plugin.version

  const packageJson = `${JSON.stringify(
    {
      name: PROFILE_PACKAGE_NAME,
      version: '0.0.0',
      private: true,
      description: 'Per-workspace DSH profile generated by the Roost control plane.',
      engines: { dsh: dshVersion },
      dsh: { profile: { bundles } },
      dependencies,
    },
    null,
    2,
  )}\n`

  const patchRows = plugins.map((plugin) => renderPluginPatchRow(plugin))

  const lines = [
    '# roost profile lockfile (placeholder: the control plane never runs pnpm)',
    "lockfileVersion: '9.0'",
    'settings:',
    '  autoInstallPeers: false',
    '  ignoreScripts: true',
    'importers:',
    '  .:',
    '    dependencies:',
  ]
  if (plugins.length === 0) lines.push('      {}')
  for (const plugin of plugins) {
    lines.push(`      ${yamlKey(packageNameOf(plugin))}:`)
    lines.push(`        specifier: ${plugin.version}`)
    lines.push(`        version: ${plugin.version}`)
  }
  lines.push('packages:')
  if (plugins.length === 0) lines.push('  {}')
  for (const plugin of plugins) {
    lines.push(`  ${yamlKey(`${packageNameOf(plugin)}@${plugin.version}`)}:`)
    lines.push(`    resolution: {integrity: ${integrityOf(plugin)}}`)
  }
  const lockfile = `${lines.join('\n')}\n`

  return { packageJson, patchRows, lockfile, hash: profileLockInputsHash({ packageJson, patchRows, lockfile }) }
}

/** 锁输入摘要：与时间无关，只对三份内容取 sha256。 */
export function profileLockInputsHash(parts: {
  packageJson: string
  patchRows: readonly string[]
  lockfile: string
}): string {
  const hash = createHash('sha256')
  hash.update('roost.profile-lock-inputs/v1', 'utf8')
  hash.update('\0', 'utf8')
  hash.update(parts.packageJson, 'utf8')
  hash.update('\0', 'utf8')
  hash.update(parts.patchRows.join('\n'), 'utf8')
  hash.update('\0', 'utf8')
  hash.update(parts.lockfile, 'utf8')
  return hash.digest('hex')
}

// ---- 预检 ---------------------------------------------------------------------

export type PreflightSeverity = 'blocking' | 'warning'

export interface InstallPreflightProblem {
  code:
    | 'slug-missing'
    | 'version-missing'
    | 'engines'
    | 'integrity'
    | 'integrity-format'
    | 'allowlist'
    | 'release-age'
    | 'tier'
    | 'signature'
  severity: PreflightSeverity
  detail: string
}

export interface PreflightPluginInput {
  slug?: string | null
  publisherId?: string | null
  /** 目录级的权限声明（版本级缺失时兜底）。 */
  permissions?: Record<string, unknown> | null
}

export interface PreflightVersionInput {
  version?: string | null
  integrity?: string | null
  engines?: string | null
  manifest?: Record<string, unknown> | null
  permissions?: Record<string, unknown> | null
  publishedAt?: number | null
  /** 签名/来源元数据（npm dist 的 attestations/signatures 等）；没有就当作 none。 */
  signature?: unknown
}

export interface PreflightInstallInput {
  plugin: PreflightPluginInput | null | undefined
  version: PreflightVersionInput | null | undefined
  dshVersion: string
  /** `ROOST_PLUGIN_ALLOWLIST` 原文或已解析数组；空 = 拒绝。 */
  allowlist?: string | readonly string[] | null
  /** 发布时长门槛毫秒；<=0 = 不设门槛。 */
  minReleaseAgeMs?: number | null
  now?: number | null
}

export interface InstallPreflightResult {
  /** 没有 blocking 问题才为 true（warning 不阻断）。 */
  ok: boolean
  problems: InstallPreflightProblem[]
  permissions: PluginCapabilities
  tier: PluginTier
}

const AVAILABLE_BINARIES = ['node']
const AVAILABLE_DATA_MOUNTS = ['bars', 'news']

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '' || text.length > 200 || out.includes(text)) continue
    out.push(text)
  }
  return out
}

function nonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return value
}

/** 把市场里的 permissions JSON 归一成 compat.PluginCapabilities（缺省就不写该键）。 */
export function normalizePermissions(raw: Record<string, unknown> | null | undefined): PluginCapabilities {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const caps: PluginCapabilities = {}
  const tools = nonNegativeNumber(raw['tools'])
  if (tools !== null) caps.tools = tools
  const skills = nonNegativeNumber(raw['skills'])
  if (skills !== null) caps.skills = skills
  const panels = nonNegativeNumber(raw['panels'])
  if (panels !== null) caps.panels = panels
  const diskBytes = nonNegativeNumber(raw['diskBytes'])
  if (diskBytes !== null) caps.diskBytes = diskBytes
  const network = stringArray(raw['network'])
  if (network.length > 0) caps.network = network
  const credentials = stringArray(raw['credentials'])
  if (credentials.length > 0) caps.credentials = credentials
  const binaries = stringArray(raw['binaries'])
  if (binaries.length > 0) caps.binaries = binaries
  const dataMounts = stringArray(raw['dataMounts'] ?? raw['data_mounts'])
  if (dataMounts.length > 0) caps.dataMounts = dataMounts
  if (raw['clientHalf'] === true) caps.clientHalf = true
  if (raw['desktopOnly'] === true) caps.desktopOnly = true
  return caps
}

function enginesOf(version: PreflightVersionInput): string {
  const manifest = version.manifest
  if (typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)) {
    const declared = manifest['engines']
    if (typeof declared === 'string' && declared.trim() !== '') return declared.trim()
  }
  if (typeof version.engines === 'string' && version.engines.trim() !== '') return version.engines.trim()
  return ''
}

/**
 * 安装预检（§4 ① ②）：版本存在 / engines / integrity / 白名单 / 发布时长 / tier / 签名。
 * 阻断项让 ok=false；C 级（需要 DSH Web 面板容器）与缺签名只是提示。
 */
export function preflightInstall(input: PreflightInstallInput): InstallPreflightResult {
  const problems: InstallPreflightProblem[] = []
  const blocking = (code: InstallPreflightProblem['code'], detail: string): void => {
    problems.push({ code, severity: 'blocking', detail })
  }
  const warning = (code: InstallPreflightProblem['code'], detail: string): void => {
    problems.push({ code, severity: 'warning', detail })
  }

  const plugin = input.plugin ?? null
  const version = input.version ?? null
  const slug = typeof plugin?.slug === 'string' ? plugin.slug.trim() : ''
  if (slug === '') blocking('slug-missing', 'plugin slug is missing')

  const versionText = typeof version?.version === 'string' ? version.version.trim() : ''
  if (version === null || versionText === '') {
    blocking('version-missing', 'plugin version does not exist in the market')
  }

  const permissions = normalizePermissions(version?.permissions ?? plugin?.permissions ?? null)
  const classification = classifyPlugin(permissions, {
    platform: 'cloud',
    availableBinaries: AVAILABLE_BINARIES,
    availableDataMounts: AVAILABLE_DATA_MOUNTS,
  })
  const tier = classification.tier

  if (version !== null && versionText !== '') {
    const engines = enginesOf(version)
    const dshVersion = typeof input.dshVersion === 'string' ? input.dshVersion.trim() : ''
    if (engines !== '') {
      if (dshVersion === '') {
        blocking('engines', `requires ${engines}, but the DSH version is unknown`)
      } else if (!satisfiesRange(dshVersion, engines)) {
        blocking('engines', `requires ${engines}, have ${dshVersion}`)
      }
    }

    if (typeof version.integrity !== 'string' || version.integrity.trim() === '') {
      blocking('integrity', 'version has no integrity hash; refusing to install')
    } else if (!version.integrity.trim().startsWith('sha512-')) {
      warning('integrity-format', `integrity is not sha512-…: ${version.integrity.trim().slice(0, 32)}`)
    }

    const release = checkReleaseAge(
      version.publishedAt ?? null,
      typeof input.minReleaseAgeMs === 'number' ? input.minReleaseAgeMs : 0,
      typeof input.now === 'number' ? input.now : Date.now(),
    )
    if (!release.ok) blocking('release-age', release.reason ?? 'release is too new')

    if (tier === 'D') {
      blocking('tier', 'tier D is desktop-only and cannot run in the cloud')
    } else if (tier === 'C') {
      warning('tier', 'tier C needs a DSH Web panel container (ADR 0004); tools still load without it')
    }

    if (signatureState(version.signature ?? version) === 'none') {
      warning('signature', 'no sigstore/npm provenance signature; an allowlisted plugin may still install')
    }
  }

  if (!isAllowlisted({ slug, publisherId: plugin?.publisherId ?? null, allowlist: input.allowlist })) {
    blocking('allowlist', `plugin ${slug === '' ? '(unknown)' : slug} is not in ROOST_PLUGIN_ALLOWLIST`)
  }

  return {
    ok: !problems.some((problem) => problem.severity === 'blocking'),
    problems,
    permissions,
    tier,
  }
}

// ---- 作业状态机 ----------------------------------------------------------------
//
// 契约态（docs/build/wave1.md §B）：
//   preflight | awaiting-approval | installing | installed | failed
//   | rolling-back | rolled-back | disabled
//
// 事件是我们自己的（契约只规定状态名），每条边都对应一个真实动作：
//   请求安装 → 建 job(preflight) → 写审批 → request-approval
//   审批通过 → approve；审批拒绝 → reject
//   沙箱报告成功/失败 → sync-ok / sync-fail
//   回滚请求 → rollback；回滚结果 → rollback-ok / rollback-fail
//   停用/启用 → disable / enable；升级 → update
// 幂等：sync-ok / sync-fail / rollback-ok / disable / enable 允许自环（重复投递不报错）。

export const JOB_STATES = [
  'preflight',
  'awaiting-approval',
  'installing',
  'installed',
  'failed',
  'rolling-back',
  'rolled-back',
  'disabled',
] as const

export type JobState = (typeof JOB_STATES)[number]

export const JOB_EVENTS = [
  'preflight-ok',
  'request-approval',
  'approve',
  'reject',
  'fail',
  'sync-ok',
  'sync-fail',
  'rollback',
  'rollback-ok',
  'rollback-fail',
  'disable',
  'enable',
  'update',
] as const

export type JobEvent = (typeof JOB_EVENTS)[number]

/** 唯一的状态迁移表（packages/store/src/marketplace-jobs.ts 有一份等价表，测试逐格比对）。 */
export const JOB_TRANSITIONS: Readonly<
  Record<JobState, Readonly<Partial<Record<JobEvent, JobState>>>>
> = {
  preflight: {
    'preflight-ok': 'awaiting-approval',
    'request-approval': 'awaiting-approval',
    reject: 'failed',
    fail: 'failed',
  },
  'awaiting-approval': {
    approve: 'installing',
    reject: 'failed',
    fail: 'failed',
  },
  installing: {
    'sync-ok': 'installed',
    'sync-fail': 'failed',
    rollback: 'rolling-back',
  },
  installed: {
    'sync-ok': 'installed',
    'sync-fail': 'failed',
    rollback: 'rolling-back',
    disable: 'disabled',
    enable: 'installed',
    update: 'installing',
  },
  failed: {
    'sync-fail': 'failed',
    reject: 'failed',
    rollback: 'rolling-back',
  },
  'rolling-back': {
    'rollback-ok': 'rolled-back',
    'rollback-fail': 'failed',
    'sync-fail': 'failed',
  },
  'rolled-back': {
    'rollback-ok': 'rolled-back',
  },
  disabled: {
    disable: 'disabled',
    enable: 'installed',
    rollback: 'rolling-back',
    update: 'installing',
  },
}

export function isJobState(value: unknown): value is JobState {
  return typeof value === 'string' && (JOB_STATES as readonly string[]).includes(value)
}

export function isJobEvent(value: unknown): value is JobEvent {
  return typeof value === 'string' && (JOB_EVENTS as readonly string[]).includes(value)
}

/** 合法的下一状态；非法迁移返回 null（纯函数，不抛错，调用方决定 409 还是忽略）。 */
export function nextJobState(state: JobState, event: JobEvent): JobState | null {
  if (!isJobState(state) || !isJobEvent(event)) return null
  return JOB_TRANSITIONS[state][event] ?? null
}

export interface FailureFallback {
  /** 失败即停用：不让人以为还在用坏的版本。 */
  enabled: false
  /** 安装行落到 failed（job 的 failed 由状态机负责）。 */
  state: 'failed'
  /** 有没有快照可回滚；没有就保持现状，不假装能回到不存在的状态。 */
  rollback: boolean
  /** 回滚应写回的锁：有快照用快照，没有就用当前锁（rollback=false 时只是回显）。 */
  lock: string | null
}

/**
 * 「失败后停用」语义常量：安装/升级失败时安装行怎么落地。
 * 快照存在 → 回滚到快照里的旧锁；没有快照（全新安装）→ 保持当前锁但不声称已回滚。
 * 真正的写库由调用方做；这里只给唯一答案，避免两处各写一套 if。
 */
export function disabledOnFailure(lock: string | null, snapshot: string | null): FailureFallback {
  const current = typeof lock === 'string' && lock !== '' ? lock : null
  const previous = typeof snapshot === 'string' && snapshot !== '' ? snapshot : null
  return {
    enabled: false,
    state: 'failed',
    rollback: previous !== null,
    lock: previous ?? current,
  }
}
