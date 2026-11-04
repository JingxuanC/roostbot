// 插件市场：目录 / 详情 / 预检 / 安装记录（docs/design/plugin-marketplace.md §4–§6）。
//
// 本文件只导出 handler，由 server.ts 接线：
//
//   GET    /api/marketplace/plugins                 handleListMarketplacePlugins  Bearer；?q=&category=&tier=&workspaceId=
//   GET    /api/marketplace/plugins/:slug           handleGetMarketplacePlugin    Bearer
//   GET    /api/marketplace/plugins/:slug/versions  handleListMarketplaceVersions Bearer
//   POST   /api/marketplace/plugins/:slug/preflight handleMarketplacePreflight    Bearer；{version?, workspaceId?}
//   POST   /api/marketplace/plugins/:slug/install   handleMarketplaceInstall      Bearer（owner/admin）；{workspaceId, version}
//   GET    /api/plugin-installs                     handleListPluginInstalls      Bearer；?workspaceId=
//   PATCH  /api/plugin-installs/:id                 handlePatchPluginInstall      Bearer（owner/admin）
//   DELETE /api/plugin-installs/:id                 handleDeletePluginInstall     Bearer（owner/admin），204 幂等
//
// 批次边界（§12）：本批只写安装行（state='installing'）与 plugin.* 事件，返回 next='sync'；
// **不执行**沙箱 sync / 重启 / 冒烟 / 回滚。第二批接手 next='sync' 之后的一切。
//
// 市场目录只在 SQLite 里；内存 port（无 rawStore）一律 503 runtime.not_configured。
// 所有用户输入都做长度校验；slug 只允许 [a-z0-9][a-z0-9._-]*。

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { PluginCapabilities } from '../../../packages/plugins/src/compat.ts'
import { classifyPlugin, tierLabel } from '../../../packages/plugins/src/compat.ts'
import { preflight } from '../../../packages/plugins/src/types.ts'
import type { PluginManifest, PreflightProblem } from '../../../packages/plugins/src/types.ts'
import { lockIdFor } from '../../../packages/plugins/src/profile-lock.ts'
import { StoreError, storeErrorTag } from '../../../packages/store/src/index.ts'
import type {
  MarketPlugin,
  PluginInstall,
  PluginTier,
  PluginVersion,
} from '../../../packages/store/src/index.ts'
import {
  MARKETPLACE_ERROR_CODES,
  PLUGIN_TIERS,
  createInstall,
  deleteInstall,
  getInstall,
  getMarketPlugin,
  getPublisher,
  isPluginSlug,
  listInstalls,
  listMarketPlugins,
  listVersions,
  updateInstall,
} from '../../../packages/store/src/index.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import type { SessionRecord, StorePort, WorkspaceRole } from './port.ts'
import type { RateLimiter } from './rate-limit.ts'
import { authenticate, isPlainObject, readJsonBody, readText, sendError, sendJson } from './server.ts'

export interface MarketplaceRouteContext {
  store: StorePort
  now: () => number
  /** 市场目录 / 安装记录只在 SQLite 里。 */
  rawStore?: Store
  /** 每个 server 实例的写接口限流器。 */
  rateLimiter?: RateLimiter
}

type Ctx = MarketplaceRouteContext

/** 基线镜像里的 DSH 版本（apps/runtime/Dockerfile 的 DSH_VERSION）。预检用它比对 engines。 */
export const DEFAULT_DSH_VERSION = '0.2.1-rc.5'

/** 平台保证可用的只读数据面（plugin-marketplace.md §3 的 bars/news 示例）。 */
const AVAILABLE_DATA_MOUNTS = ['bars', 'news']

/** 镜像里确定存在的可执行文件；其余由插件声明、第二批生成沙箱策略。 */
const AVAILABLE_BINARIES = ['node']

const CLASSIFICATION_CONTEXT = {
  platform: 'cloud' as const,
  availableBinaries: AVAILABLE_BINARIES,
  availableDataMounts: AVAILABLE_DATA_MOUNTS,
}

const MAX_SLUG_CHARS = 128
const MAX_ID_CHARS = 200
const MAX_VERSION_CHARS = 100
const MAX_QUERY_CHARS = 200
const MAX_CATEGORY_CHARS = 64

// ---- 列表 / 详情 -------------------------------------------------------------

export async function handleListMarketplacePlugins(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  if (!requireStore(ctx, res)) return

  const q = readOptionalQuery(url, 'q', MAX_QUERY_CHARS)
  if (q === INVALID) return sendError(res, 400, 'invalid_body', `q must be at most ${MAX_QUERY_CHARS} characters`)
  const category = readOptionalQuery(url, 'category', MAX_CATEGORY_CHARS)
  if (category === INVALID) {
    return sendError(res, 400, 'invalid_body', `category must be at most ${MAX_CATEGORY_CHARS} characters`)
  }
  const tierRaw = readOptionalQuery(url, 'tier', 1)
  if (tierRaw === INVALID) return sendError(res, 400, 'invalid_body', 'tier must be one of A|B|C|D')
  if (tierRaw !== null && !PLUGIN_TIERS.includes(tierRaw as PluginTier)) {
    return sendError(res, 400, 'invalid_body', 'tier must be one of A|B|C|D')
  }

  let installedSlugs = new Set<string>()
  if (url.searchParams.has('workspaceId')) {
    const workspaceId = readOptionalQuery(url, 'workspaceId', MAX_ID_CHARS)
    if (workspaceId === INVALID) return sendError(res, 400, 'invalid_body', 'workspaceId must not be empty or too long')
    if (workspaceId === null) return sendError(res, 400, 'invalid_body', 'workspaceId must not be empty')
    const role = await workspaceRole(ctx, auth.accountId, workspaceId)
    if (role === null) {
      return sendError(res, 403, 'forbidden', `account is not a member of workspace ${workspaceId}`)
    }
    installedSlugs = new Set(listInstalls(storeOf(ctx), workspaceId).map((install) => install.slug))
  }

  const plugins = listMarketPlugins(storeOf(ctx), {
    q,
    category,
    tier: tierRaw === null ? null : (tierRaw as PluginTier),
  })

  sendJson(res, 200, {
    plugins: plugins.map((plugin) => {
      const latest = findVersion(storeOf(ctx), plugin.slug, plugin.latest)
      return pluginCardJson(plugin, latest, installedSlugs.has(plugin.slug))
    }),
  })
}

export async function handleGetMarketplacePlugin(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  if (!requireStore(ctx, res)) return

  const slug = slugFromPath(url.pathname, '')
  if (slug === null) return sendError(res, 404, 'not_found', 'malformed plugin path')

  const plugin = getMarketPlugin(storeOf(ctx), slug)
  if (plugin === null) return sendError(res, 404, 'plugin.not_found', `unknown plugin ${slug}`)

  const versions = listVersions(storeOf(ctx), slug)
  const latest = versions.find((version) => version.version === plugin.latest) ?? versions[0] ?? null
  const publisher = getPublisher(storeOf(ctx), plugin.publisherId)

  sendJson(res, 200, {
    plugin: {
      ...pluginCardJson(plugin, latest, false),
      readme: plugin.readme,
      screenshots: plugin.screenshots,
      publisher: publisherJson(publisher, plugin.publisherId),
    },
    versions: versions.map(versionJson),
  })
}

export async function handleListMarketplaceVersions(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  if (!requireStore(ctx, res)) return

  const slug = slugFromPath(url.pathname, 'versions')
  if (slug === null) return sendError(res, 404, 'not_found', 'malformed plugin versions path')

  const plugin = getMarketPlugin(storeOf(ctx), slug)
  if (plugin === null) return sendError(res, 404, 'plugin.not_found', `unknown plugin ${slug}`)

  sendJson(res, 200, {
    slug,
    latest: plugin.latest,
    versions: listVersions(storeOf(ctx), slug).map(versionJson),
  })
}

// ---- 预检 -------------------------------------------------------------------

export async function handleMarketplacePreflight(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  if (!requireStore(ctx, res)) return

  const slug = slugFromPath(url.pathname, 'preflight')
  if (slug === null) return sendError(res, 404, 'not_found', 'malformed preflight path')

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const body = parsed.value

  const versionRaw = body['version']
  let version: string | null = null
  if (versionRaw !== undefined && versionRaw !== null) {
    version = readText(versionRaw, MAX_VERSION_CHARS)
    if (version === null) {
      return sendError(res, 400, 'invalid_body', `version must be a string of 1..${MAX_VERSION_CHARS} chars`)
    }
  }

  const workspaceRaw = body['workspaceId']
  let workspaceId: string | null = null
  if (workspaceRaw !== undefined && workspaceRaw !== null) {
    workspaceId = readText(workspaceRaw, MAX_ID_CHARS)
    if (workspaceId === null) {
      return sendError(res, 400, 'invalid_body', 'workspaceId must be a non-empty string')
    }
    const role = await workspaceRole(ctx, auth.accountId, workspaceId)
    if (role === null) {
      return sendError(res, 403, 'forbidden', `account is not a member of workspace ${workspaceId}`)
    }
  }

  const plugin = getMarketPlugin(storeOf(ctx), slug)
  if (plugin === null) return sendError(res, 404, 'plugin.not_found', `unknown plugin ${slug}`)

  const resolved = findVersion(storeOf(ctx), slug, version ?? plugin.latest)
  if (resolved === null) {
    return sendError(
      res,
      404,
      'plugin.version_not_found',
      `plugin ${slug} has no version ${version ?? plugin.latest}`,
    )
  }

  const result = runPreflight(storeOf(ctx), plugin, resolved, workspaceId, DEFAULT_DSH_VERSION)
  sendJson(res, 200, result)
}

// ---- 安装 -------------------------------------------------------------------

export async function handleMarketplaceInstall(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  if (!requireStore(ctx, res)) return

  const slug = slugFromPath(url.pathname, 'install')
  if (slug === null) return sendError(res, 404, 'not_found', 'malformed install path')

  const retryAfter = ctx.rateLimiter?.consume('pluginInstall', auth.accountId, ctx.now()) ?? null
  if (retryAfter !== null) {
    return sendError(res, 429, 'rate_limited', `too many plugin install requests; retry after ${retryAfter}s`, {
      'retry-after': String(retryAfter)
    })
  }

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const body = parsed.value

  const workspaceId = readText(body['workspaceId'], MAX_ID_CHARS)
  if (workspaceId === null) {
    return sendError(res, 400, 'invalid_body', 'workspaceId is required (non-empty string)')
  }
  const versionText = readText(body['version'], MAX_VERSION_CHARS)
  if (versionText === null) {
    return sendError(res, 400, 'invalid_body', 'version is required (non-empty string)')
  }

  const role = await workspaceRole(ctx, auth.accountId, workspaceId)
  if (role === null) {
    return sendError(res, 403, 'forbidden', `account is not a member of workspace ${workspaceId}`)
  }
  if (role !== 'owner' && role !== 'admin') {
    return sendError(res, 403, 'forbidden', `workspace ${workspaceId} requires owner/admin role`)
  }

  const store = storeOf(ctx)
  const plugin = getMarketPlugin(store, slug)
  if (plugin === null) return sendError(res, 404, 'plugin.not_found', `unknown plugin ${slug}`)

  const version = findVersion(store, slug, versionText)
  if (version === null) {
    return sendError(res, 404, 'plugin.version_not_found', `plugin ${slug} has no version ${versionText}`)
  }

  // 幂等：同 workspace 同 slug 已安装则原样返回，不写第二条事件。
  const existing = listInstalls(store, workspaceId).find((install) => install.slug === slug)
  if (existing !== undefined) {
    return sendJson(res, 200, { install: installJson(existing), next: 'sync', alreadyInstalled: true })
  }

  const publisher = getPublisher(store, plugin.publisherId)
  if (publisher === null || !publisher.verified) {
    return sendError(
      res,
      403,
      'plugin.publisher_unverified',
      `publisher ${plugin.publisherId} is not verified (v1 allowlist)`,
    )
  }

  const checked = runPreflight(store, plugin, version, workspaceId, DEFAULT_DSH_VERSION)
  if (checked.tier !== 'A' && checked.tier !== 'B') {
    return sendError(res, 400, 'plugin.tier', `plugin ${slug} is tier ${checked.tier}; only A/B can be installed in v1`)
  }
  if (!checked.ok) {
    return sendError(res, 400, 'plugin.preflight_failed', `plugin ${slug} failed preflight: ${firstProblem(checked.problems)}`)
  }

  const at = ctx.now()
  const lock = buildLockSummary(plugin.slug, version, at)
  try {
    const install = createInstall(store, {
      workspaceId,
      slug,
      version: version.version,
      lock,
      installedBy: auth.accountId,
      installedAt: at,
      preflight: preflightSnapshot(checked),
      state: 'installing',
    })
    // 202：接受的是「安装意图」；沙箱 sync 由第二批执行，所以还不是 installed。
    sendJson(res, 202, { install: installJson(install), next: 'sync' })
  } catch (err) {
    // 并发下唯一约束兜底：回头读已有安装，仍然按幂等返回。
    if (err instanceof StoreError && storeErrorTag(err) === MARKETPLACE_ERROR_CODES.installExists) {
      const raced = listInstalls(store, workspaceId).find((install) => install.slug === slug)
      if (raced !== undefined) {
        return sendJson(res, 200, { install: installJson(raced), next: 'sync', alreadyInstalled: true })
      }
    }
    sendMarketFailure(res, err)
  }
}

// ---- 已安装 -----------------------------------------------------------------

export async function handleListPluginInstalls(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  if (!requireStore(ctx, res)) return

  const workspaceId = readText(url.searchParams.get('workspaceId'), MAX_ID_CHARS)
  if (workspaceId === null) {
    return sendError(res, 400, 'invalid_body', 'workspaceId is required (non-empty string)')
  }

  const role = await workspaceRole(ctx, auth.accountId, workspaceId)
  if (role === null) {
    return sendError(res, 403, 'forbidden', `account is not a member of workspace ${workspaceId}`)
  }

  const store = storeOf(ctx)
  const installs = listInstalls(store, workspaceId).map((install) => {
    const plugin = getMarketPlugin(store, install.slug)
    const latest = plugin === null ? null : plugin.latest
    return {
      ...installJson(install),
      latest,
      updateAvailable: latest !== null && latest !== install.version,
    }
  })

  sendJson(res, 200, { installs })
}

export async function handlePatchPluginInstall(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  if (!requireStore(ctx, res)) return

  const installId = installIdFromPath(url.pathname)
  if (installId === null) return sendError(res, 404, 'not_found', 'malformed plugin install path')

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const body = parsed.value

  const hasEnabled = body['enabled'] !== undefined
  const hasVersion = body['version'] !== undefined
  if (!hasEnabled && !hasVersion) {
    return sendError(res, 400, 'invalid_body', 'at least one of enabled|version is required')
  }
  if (hasEnabled && typeof body['enabled'] !== 'boolean') {
    return sendError(res, 400, 'invalid_body', 'enabled must be a boolean')
  }
  const versionText = hasVersion ? readText(body['version'], MAX_VERSION_CHARS) : null
  if (hasVersion && versionText === null) {
    return sendError(res, 400, 'invalid_body', `version must be a string of 1..${MAX_VERSION_CHARS} chars`)
  }

  const store = storeOf(ctx)
  const current = getInstall(store, installId)
  if (current === null) {
    return sendError(res, 404, 'plugin.install_not_found', `unknown plugin install ${installId}`)
  }

  const role = await workspaceRole(ctx, auth.accountId, current.workspaceId)
  if (role === null || (role !== 'owner' && role !== 'admin')) {
    return sendError(res, 403, 'forbidden', `workspace ${current.workspaceId} requires owner/admin role`)
  }

  let lock: string | undefined
  if (versionText !== null && versionText !== current.version) {
    const plugin = getMarketPlugin(store, current.slug)
    if (plugin === null) return sendError(res, 404, 'plugin.not_found', `unknown plugin ${current.slug}`)
    const nextVersion = findVersion(store, current.slug, versionText)
    if (nextVersion === null) {
      return sendError(res, 404, 'plugin.version_not_found', `plugin ${current.slug} has no version ${versionText}`)
    }
    const publisher = getPublisher(store, plugin.publisherId)
    if (publisher === null || !publisher.verified) {
      return sendError(res, 403, 'plugin.publisher_unverified', `publisher ${plugin.publisherId} is not verified`)
    }
    const checked = runPreflight(store, plugin, nextVersion, current.workspaceId, DEFAULT_DSH_VERSION)
    if (checked.tier !== 'A' && checked.tier !== 'B') {
      return sendError(res, 400, 'plugin.tier', `plugin ${current.slug} is tier ${checked.tier}; only A/B can be installed in v1`)
    }
    if (!checked.ok) {
      return sendError(res, 400, 'plugin.preflight_failed', `plugin ${current.slug} failed preflight: ${firstProblem(checked.problems)}`)
    }
    lock = buildLockSummary(current.slug, nextVersion, ctx.now())
  }

  try {
    const updated = updateInstall(store, {
      id: installId,
      ...(hasEnabled ? { enabled: body['enabled'] as boolean } : {}),
      ...(versionText === null ? {} : { version: versionText }),
      // 版本变化 = 锁变了，必须重新 sync；在第二批执行前保持 installing，不假装已生效。
      ...(lock === undefined ? {} : { lock, state: 'installing' }),
      by: auth.accountId,
      at: ctx.now(),
    })
    sendJson(res, 200, { install: installJson(updated) })
  } catch (err) {
    sendMarketFailure(res, err)
  }
}

export async function handleDeletePluginInstall(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  if (!requireStore(ctx, res)) return

  const installId = installIdFromPath(url.pathname)
  if (installId === null) return sendError(res, 404, 'not_found', 'malformed plugin install path')

  const store = storeOf(ctx)
  const current = getInstall(store, installId)
  if (current !== null) {
    const role = await workspaceRole(ctx, auth.accountId, current.workspaceId)
    if (role === null || (role !== 'owner' && role !== 'admin')) {
      return sendError(res, 403, 'forbidden', `workspace ${current.workspaceId} requires owner/admin role`)
    }
    try {
      deleteInstall(store, { id: installId, by: auth.accountId, at: ctx.now() })
    } catch (err) {
      return sendMarketFailure(res, err)
    }
  }

  // 行不存在也返回 204：DELETE 是幂等的。
  res.writeHead(204, { 'cache-control': 'no-store' })
  res.end()
}

// ---- 预检实现 ---------------------------------------------------------------

interface VersionCheck {
  slug: string
  version: string
  tier: PluginTier
  tierLabel: string
  ok: boolean
  problems: { code: string; detail: string }[]
  reasons: string[]
  permissions: PluginCapabilities
  requires: {
    network: string[]
    credentials: string[]
    diskBytes: number
    binaries: string[]
    dataMounts: string[]
    panels: number
  }
  engines: string
}

function runPreflight(
  store: Store,
  plugin: MarketPlugin,
  version: PluginVersion,
  workspaceId: string | null,
  dshVersion: string,
): VersionCheck {
  const capabilities = readCapabilities(version.permissions)
  const classification = classifyPlugin(capabilities, CLASSIFICATION_CONTEXT)
  const manifest = readManifest(version)

  const surface =
    workspaceId === null
      ? { routes: [] as string[], slots: [] as string[] }
      : installedSurface(store, workspaceId, plugin.slug)

  const result = preflight({
    manifest,
    pluginVersion: version.version,
    dshVersion,
    installedRoutes: surface.routes,
    installedSlots: surface.slots,
    availableData: [...AVAILABLE_DATA_MOUNTS],
    // 控制面看不到沙箱磁盘；真实剩余空间由第二批 sync 在沙箱内校验。
    freeDiskBytes: Number.MAX_SAFE_INTEGER,
  })

  const problems: { code: string; detail: string }[] = result.problems.map((problem: PreflightProblem) => ({
    code: problem.code,
    detail: problem.detail,
  }))
  if (classification.tier === 'C') {
    problems.push({
      code: 'tier-unsupported',
      detail: 'C 级需要 DSH Web 界面容器，v1 暂不安装（见 plugin-marketplace.md §3）',
    })
  }
  if (classification.tier === 'D') {
    problems.push({
      code: 'tier-unsupported',
      detail: 'D 级仅桌面可用，云端不支持（见 plugin-marketplace.md §3）',
    })
  }

  return {
    slug: plugin.slug,
    version: version.version,
    tier: classification.tier,
    tierLabel: tierLabel(classification.tier),
    ok: problems.length === 0,
    problems,
    reasons: classification.reasons,
    permissions: capabilities,
    requires: {
      network: classification.requires.network,
      credentials: classification.requires.credentials,
      diskBytes: classification.requires.diskBytes,
      binaries: classification.requires.binaries,
      dataMounts: classification.requires.dataMounts,
      panels: capabilities.panels ?? 0,
    },
    engines: manifest.engines,
  }
}

function installedSurface(
  store: Store,
  workspaceId: string,
  excludeSlug: string,
): { routes: string[]; slots: string[] } {
  const routes: string[] = []
  const slots: string[] = []
  for (const install of listInstalls(store, workspaceId)) {
    if (install.slug === excludeSlug) continue
    const version = findVersion(store, install.slug, install.version)
    if (version === null) continue
    const manifest = readManifest(version)
    for (const route of manifest.routes) if (!routes.includes(route)) routes.push(route)
    for (const slot of manifest.slots) if (!slots.includes(slot)) slots.push(slot)
  }
  return { routes, slots }
}

function readManifest(version: PluginVersion): PluginManifest {
  const raw = version.manifest
  const engines =
    typeof raw.engines === 'string' && raw.engines.trim() !== ''
      ? raw.engines.trim()
      : version.engines ?? '>=0.0.0'
  return {
    engines,
    slots: stringArray(raw.slots),
    services: stringArray(raw.services),
    panels: numberOrZero(raw.panels),
    routes: stringArray(raw.routes),
    data: stringArray(raw.data),
    ...(typeof raw.diskBytes === 'number' ? { diskBytes: raw.diskBytes } : {}),
  }
}

function readCapabilities(raw: Record<string, unknown>): PluginCapabilities {
  const caps: PluginCapabilities = {}
  const tools = optionalNonNegativeNumber(raw.tools)
  if (tools !== null) caps.tools = tools
  const skills = optionalNonNegativeNumber(raw.skills)
  if (skills !== null) caps.skills = skills
  const panels = optionalNonNegativeNumber(raw.panels)
  if (panels !== null) caps.panels = panels
  const diskBytes = optionalNonNegativeNumber(raw.diskBytes)
  if (diskBytes !== null) caps.diskBytes = diskBytes
  const network = stringArray(raw.network)
  if (network.length > 0) caps.network = network
  const credentials = stringArray(raw.credentials)
  if (credentials.length > 0) caps.credentials = credentials
  const binaries = stringArray(raw.binaries)
  if (binaries.length > 0) caps.binaries = binaries
  const dataMounts = stringArray(raw.dataMounts ?? raw.data_mounts)
  if (dataMounts.length > 0) caps.dataMounts = dataMounts
  if (raw.clientHalf === true) caps.clientHalf = true
  if (raw.desktopOnly === true) caps.desktopOnly = true
  return caps
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '' || text.length > 200) continue
    if (!out.includes(text)) out.push(text)
  }
  return out
}

function optionalNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return value
}

function numberOrZero(value: unknown): number {
  const parsed = optionalNonNegativeNumber(value)
  return parsed === null ? 0 : parsed
}

// ---- 序列化 -----------------------------------------------------------------

function pluginCardJson(plugin: MarketPlugin, latest: PluginVersion | null, installed: boolean): Record<string, unknown> {
  const checked = latest === null ? null : classifyVersion(latest)
  const tier = checked === null ? plugin.tier : checked.tier
  return {
    slug: plugin.slug,
    title: plugin.title,
    publisherId: plugin.publisherId,
    category: plugin.category,
    tier,
    tierLabel: tierLabel(tier),
    summary: plugin.summary,
    latest: plugin.latest,
    icon: plugin.icon,
    screenshots: plugin.screenshots,
    updatedAt: plugin.updatedAt,
    installed,
    ...(latest === null
      ? {}
      : {
          engines: latest.engines,
          permissions: checked!.permissions,
          requirements: checked!.requires,
        }),
  }
}

function versionJson(version: PluginVersion): Record<string, unknown> {
  const checked = classifyVersion(version)
  return {
    version: version.version,
    integrity: version.integrity,
    engines: version.engines,
    publishedAt: version.publishedAt,
    tier: checked.tier,
    tierLabel: tierLabel(checked.tier),
    permissions: checked.permissions,
    requirements: checked.requires,
  }
}

function classifyVersion(version: PluginVersion): {
  tier: PluginTier
  permissions: PluginCapabilities
  requires: VersionCheck['requires']
} {
  const permissions = readCapabilities(version.permissions)
  const classification = classifyPlugin(permissions, CLASSIFICATION_CONTEXT)
  return {
    tier: classification.tier,
    permissions,
    requires: {
      network: classification.requires.network,
      credentials: classification.requires.credentials,
      diskBytes: classification.requires.diskBytes,
      binaries: classification.requires.binaries,
      dataMounts: classification.requires.dataMounts,
      panels: permissions.panels ?? 0,
    },
  }
}

function installJson(install: PluginInstall): Record<string, unknown> {
  return {
    id: install.id,
    workspaceId: install.workspaceId,
    slug: install.slug,
    version: install.version,
    enabled: install.enabled,
    lock: parseJsonOrRaw(install.lock),
    installedBy: install.installedBy,
    installedAt: install.installedAt,
    preflight: install.preflight,
    state: install.state,
  }
}

function publisherJson(
  publisher: { id: string; name: string; verified: boolean; registry: string } | null,
  fallbackId: string,
): Record<string, unknown> {
  if (publisher === null) {
    return { id: fallbackId, name: fallbackId, verified: false, registry: 'unknown' }
  }
  return {
    id: publisher.id,
    name: publisher.name,
    verified: publisher.verified,
    registry: publisher.registry,
  }
}

function preflightSnapshot(checked: VersionCheck): Record<string, unknown> {
  return {
    tier: checked.tier,
    ok: checked.ok,
    problems: checked.problems,
    permissions: checked.permissions,
    requires: checked.requires,
    engines: checked.engines,
  }
}

function buildLockSummary(slug: string, version: PluginVersion, at: number): string {
  // 锁形状与 profile-lock 对齐（id 内容寻址），但本批不生成真正的 profile 内容：
  // 数据源是市场版本（slug+version+integrity），第二批由 plugins 表生成完整锁。
  return JSON.stringify({
    kind: 'roost.profile-lock-summary',
    version: 1,
    source: 'marketplace',
    id: lockIdFor(version.integrity),
    integrity: version.integrity,
    slug,
    pluginVersion: version.version,
    generatedAt: at,
  })
}

function parseJsonOrRaw(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function firstProblem(problems: { code: string; detail: string }[]): string {
  const first = problems[0]
  return first === undefined ? 'unknown problem' : `${first.code} (${first.detail})`
}

// ---- 鉴权 / 路径 / 输入 -----------------------------------------------------

async function requireAuth(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<SessionRecord | null> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
    return null
  }
  return auth.session
}

function requireStore(ctx: Ctx, res: ServerResponse): boolean {
  if (ctx.rawStore !== undefined) return true
  sendError(res, 503, 'runtime.not_configured', 'plugin marketplace needs the SQLite store')
  return false
}

function storeOf(ctx: Ctx): Store {
  const store = ctx.rawStore
  if (store === undefined) throw new Error('marketplace store is not configured')
  return store
}

async function workspaceRole(ctx: Ctx, accountId: string, workspaceId: string): Promise<WorkspaceRole | null> {
  const workspaces = await ctx.store.listWorkspaces({ accountId })
  const workspace = workspaces.find((entry) => entry.id === workspaceId)
  return workspace === undefined ? null : workspace.role
}

function findVersion(store: Store, slug: string, version: string): PluginVersion | null {
  return listVersions(store, slug).find((entry) => entry.version === version) ?? null
}

/** 路径最后一段必须是 slug；suffix 为空表示 /plugins/:slug。 */
function slugFromPath(pathname: string, suffix: string): string | null {
  const prefix = '/api/marketplace/plugins/'
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length)
  if (suffix !== '') {
    if (!rest.endsWith(`/${suffix}`)) return null
    const slug = rest.slice(0, -suffix.length - 1)
    return decodeSlug(slug)
  }
  if (rest.includes('/')) return null
  return decodeSlug(rest)
}

function decodeSlug(raw: string): string | null {
  let slug: string
  try {
    slug = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (!isPluginSlug(slug) || slug.length > MAX_SLUG_CHARS) return null
  return slug
}

function installIdFromPath(pathname: string): string | null {
  const match = /^\/api\/plugin-installs\/([^/]+)$/.exec(pathname.replace(/\/+$/, ''))
  if (match === null) return null
  let id: string
  try {
    id = decodeURIComponent(match[1]!)
  } catch {
    return null
  }
  if (id === '' || id.length > MAX_ID_CHARS) return null
  return id
}

const INVALID = Symbol('invalid-query')
function readOptionalQuery(url: URL, name: string, maxChars: number): string | null | typeof INVALID {
  const raw = url.searchParams.get(name)
  if (raw === null) return null
  const value = readText(raw, maxChars)
  return value === null ? INVALID : value
}

function sendMarketFailure(res: ServerResponse, err: unknown): void {
  if (err instanceof StoreError) {
    switch (storeErrorTag(err)) {
      case MARKETPLACE_ERROR_CODES.installExists:
        return sendError(res, 409, 'plugin.already_installed', err.message)
      case MARKETPLACE_ERROR_CODES.installNotFound:
        return sendError(res, 404, 'plugin.install_not_found', err.message)
      case MARKETPLACE_ERROR_CODES.invalidSlug:
        return sendError(res, 400, 'plugin.invalid_slug', err.message)
      default:
        break
    }
    if (err.code === 'WORKSPACE_NOT_FOUND') {
      return sendError(res, 404, 'workspace_not_found', err.message)
    }
  }
  console.error('roost api: marketplace store failure', err)
  sendError(res, 500, 'internal_error', 'plugin marketplace store failure')
}
