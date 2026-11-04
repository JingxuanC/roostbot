// 插件市场目录与安装记录（docs/design/plugin-marketplace.md §5）。
//
// 本批（M5-5.1）只做「目录 + 预检结果 + 安装记录」：
//   * 市场目录 / 版本来自 plugin_market / plugin_versions，由 registry 同步写入；
//     store 不编造任何插件数据，空库就返回空列表。
//   * 安装行 state 默认 'installing' —— 本批不执行沙箱 sync/重启/冒烟/回滚，
//     所以不能假装 'installed'。第二批 sync 成功后由调用方 updateInstall 推进状态。
//   * 安装 / 升级 / 卸载都写 plugin.* 事件（domain='plugin'，actor=user），
//     与审批模块同一套「事件与行同生共死」的 savepoint 约束。
//
// 域错误码沿用 approvals.ts 的 `CODE: detail` 约定：errors.ts 的 code 是封闭枚举，
// 这里不改共享文件，只把市场域错误码写在 StoreError.message 前缀里，API 层用
// storeErrorTag() 取回。

import { StoreError } from './errors.ts'
import { appendEvent } from './events.ts'
import {
  asInteger,
  asRecord,
  assertOpen,
  errorMessage,
  toNumber,
} from './internal.ts'
import { newRoostId } from './ids.ts'
import { taggedStoreMessage } from './approvals.ts'
import type { Store } from './types.ts'

export const MARKETPLACE_ERROR_CODES = {
  installExists: 'PLUGIN_INSTALL_EXISTS',
  installNotFound: 'PLUGIN_INSTALL_NOT_FOUND',
  invalidSlug: 'PLUGIN_INVALID_SLUG',
} as const

/** slug 规则（API 与 store 共用）：小写字母/数字开头，只含小写字母、数字、点、下划线、连字符。 */
export const PLUGIN_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
export const PLUGIN_SLUG_MAX = 128

export const PLUGIN_TIERS = ['A', 'B', 'C', 'D'] as const
export type PluginTier = (typeof PLUGIN_TIERS)[number]

export const PLUGIN_INSTALL_STATES = ['installing', 'installed', 'failed', 'disabling'] as const
export type PluginInstallState = (typeof PLUGIN_INSTALL_STATES)[number]

export function isPluginSlug(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= PLUGIN_SLUG_MAX &&
    PLUGIN_SLUG_PATTERN.test(value)
  )
}

// ---- 发布者 ------------------------------------------------------------------

export interface PluginPublisher {
  id: string
  name: string
  verified: boolean
  /** npm | roost（v1 只有这两种来源）。 */
  registry: string
  createdAt: number
}

export interface UpsertPublisherInput {
  id: string
  name: string
  verified?: boolean
  registry?: string
  at?: number
}

interface PublisherRow {
  id: string
  name: string
  verified: number | bigint
  registry: string
  created_at: number | bigint
}

const PUBLISHER_COLUMNS = 'id, name, verified, registry, created_at'

export function upsertPublisher(store: Store, input: UpsertPublisherInput): PluginPublisher {
  assertOpen(store)
  const req = asRecord(input, 'publisher', 'INVALID_INPUT')
  const id = readId(req.id, 'publisher.id')
  const name = readText(req.name, 'publisher.name', 200)
  const verified = req.verified === undefined ? false : readBoolean(req.verified, 'publisher.verified')
  const registry = readText(req.registry ?? 'npm', 'publisher.registry', 64)
  const at =
    req.at === undefined || req.at === null ? Date.now() : asInteger(req.at, 'publisher.at', 0, 'INVALID_INPUT')

  store.db
    .prepare(
      `INSERT INTO plugin_publishers (${PUBLISHER_COLUMNS})
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         verified = excluded.verified,
         registry = excluded.registry`,
    )
    .run(id, name, verified ? 1 : 0, registry, at)

  // 读回真实行：ON CONFLICT 不更新 created_at，返回值必须与库里一致。
  const saved = getPublisher(store, id)
  if (saved === null) {
    throw new StoreError('INVALID_INPUT', `plugin publisher ${id} was upserted but cannot be read back`)
  }
  return saved
}

export function getPublisher(store: Store, id: string): PluginPublisher | null {
  assertOpen(store)
  const publisherId = readId(id, 'publisher.id')
  const row = store.db
    .prepare(`SELECT ${PUBLISHER_COLUMNS} FROM plugin_publishers WHERE id = ?`)
    .get(publisherId)
  return row === undefined || row === null ? null : rowToPublisher(row)
}

export function listPublishers(store: Store): PluginPublisher[] {
  assertOpen(store)
  return store.db
    .prepare(`SELECT ${PUBLISHER_COLUMNS} FROM plugin_publishers ORDER BY created_at, id`)
    .all()
    .map(rowToPublisher)
}

// ---- 市场目录 ----------------------------------------------------------------

export interface MarketPlugin {
  slug: string
  title: string
  publisherId: string
  category: string
  tier: PluginTier
  summary: string
  readme: string | null
  latest: string
  icon: string | null
  screenshots: string[]
  updatedAt: number
}

export interface UpsertMarketPluginInput {
  slug: string
  title: string
  publisherId: string
  category: string
  tier: PluginTier
  summary: string
  readme?: string | null
  latest: string
  icon?: string | null
  screenshots?: string[] | null
  updatedAt?: number
}

export interface ListMarketPluginsQuery {
  q?: string | null
  category?: string | null
  tier?: PluginTier | null
}

interface MarketRow {
  slug: string
  title: string
  publisher_id: string
  category: string
  tier: string
  summary: string
  readme: string | null
  latest: string
  icon: string | null
  screenshots: string | null
  updated_at: number | bigint
}

const MARKET_COLUMNS =
  'slug, title, publisher_id, category, tier, summary, readme, latest, icon, screenshots, updated_at'

export function upsertMarketPlugin(store: Store, input: UpsertMarketPluginInput): MarketPlugin {
  assertOpen(store)
  const req = asRecord(input, 'marketPlugin', 'INVALID_INPUT')
  const slug = readSlug(req.slug, 'marketPlugin.slug')
  const title = readText(req.title, 'marketPlugin.title', 200)
  const publisherId = readId(req.publisherId, 'marketPlugin.publisherId')
  const category = readText(req.category, 'marketPlugin.category', 64)
  const tier = readTier(req.tier, 'marketPlugin.tier')
  const summary = readText(req.summary, 'marketPlugin.summary', 2000)
  const readme = readOptionalLongText(req.readme, 'marketPlugin.readme', 200_000)
  const latest = readVersion(req.latest, 'marketPlugin.latest')
  const icon = readOptionalText(req.icon, 'marketPlugin.icon', 2000)
  const screenshots = readScreenshots(req.screenshots)
  const updatedAt =
    req.updatedAt === undefined || req.updatedAt === null
      ? Date.now()
      : asInteger(req.updatedAt, 'marketPlugin.updatedAt', 0, 'INVALID_INPUT')

  store.db
    .prepare(
      `INSERT INTO plugin_market (${MARKET_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         title = excluded.title,
         publisher_id = excluded.publisher_id,
         category = excluded.category,
         tier = excluded.tier,
         summary = excluded.summary,
         readme = excluded.readme,
         latest = excluded.latest,
         icon = excluded.icon,
         screenshots = excluded.screenshots,
         updated_at = excluded.updated_at`,
    )
    .run(
      slug,
      title,
      publisherId,
      category,
      tier,
      summary,
      readme,
      latest,
      icon,
      screenshots === null ? null : JSON.stringify(screenshots),
      updatedAt,
    )

  return {
    slug,
    title,
    publisherId,
    category,
    tier,
    summary,
    readme,
    latest,
    icon,
    screenshots: screenshots ?? [],
    updatedAt,
  }
}

export function getMarketPlugin(store: Store, slug: string): MarketPlugin | null {
  assertOpen(store)
  const pluginSlug = readSlug(slug, 'marketPlugin.slug')
  const row = store.db
    .prepare(`SELECT ${MARKET_COLUMNS} FROM plugin_market WHERE slug = ?`)
    .get(pluginSlug)
  return row === undefined || row === null ? null : rowToMarketPlugin(row)
}

/** 目录筛选：q 在 slug/title/summary 上做不区分大小写的子串匹配；category/tier 精确匹配。 */
export function listMarketPlugins(store: Store, query: ListMarketPluginsQuery = {}): MarketPlugin[] {
  assertOpen(store)
  const input = asRecord(query, 'marketQuery', 'INVALID_INPUT')
  const q = readOptionalText(input.q, 'marketQuery.q', 200)
  const category = readOptionalText(input.category, 'marketQuery.category', 64)
  const tier = input.tier === undefined || input.tier === null ? null : readTier(input.tier, 'marketQuery.tier')

  const clauses: string[] = []
  const params: unknown[] = []
  if (q !== null) {
    clauses.push(
      "instr(lower(slug || ' ' || title || ' ' || summary), lower(?)) > 0",
    )
    params.push(q)
  }
  if (category !== null) {
    clauses.push('category = ?')
    params.push(category)
  }
  if (tier !== null) {
    clauses.push('tier = ?')
    params.push(tier)
  }

  let sql = `SELECT ${MARKET_COLUMNS} FROM plugin_market`
  if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`
  sql += ' ORDER BY updated_at DESC, slug ASC'

  return store.db.prepare(sql).all(...params).map(rowToMarketPlugin)
}

// ---- 版本 --------------------------------------------------------------------

export interface PluginVersion {
  slug: string
  version: string
  integrity: string
  engines: string | null
  /** 兼容声明（engines/slots/services/panels/routes/data/diskBytes）。 */
  manifest: Record<string, unknown>
  /** 能力与资源声明（network/credentials/disk/binaries/data_mounts…）。 */
  permissions: Record<string, unknown>
  publishedAt: number
}

export interface UpsertVersionInput {
  slug: string
  version: string
  integrity: string
  engines?: string | null
  manifest: Record<string, unknown>
  permissions: Record<string, unknown>
  publishedAt?: number
}

interface VersionRow {
  slug: string
  version: string
  integrity: string
  engines: string | null
  manifest: string
  permissions: string
  published_at: number | bigint
}

const VERSION_COLUMNS = 'slug, version, integrity, engines, manifest, permissions, published_at'

export function upsertVersion(store: Store, input: UpsertVersionInput): PluginVersion {
  assertOpen(store)
  const req = asRecord(input, 'pluginVersion', 'INVALID_INPUT')
  const slug = readSlug(req.slug, 'pluginVersion.slug')
  const version = readVersion(req.version, 'pluginVersion.version')
  const integrity = readText(req.integrity, 'pluginVersion.integrity', 512)
  const engines = readOptionalText(req.engines, 'pluginVersion.engines', 200)
  const manifest = readJsonObject(req.manifest, 'pluginVersion.manifest')
  const permissions = readJsonObject(req.permissions, 'pluginVersion.permissions')
  const publishedAt =
    req.publishedAt === undefined || req.publishedAt === null
      ? Date.now()
      : asInteger(req.publishedAt, 'pluginVersion.publishedAt', 0, 'INVALID_INPUT')

  store.db
    .prepare(
      `INSERT INTO plugin_versions (${VERSION_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug, version) DO UPDATE SET
         integrity = excluded.integrity,
         engines = excluded.engines,
         manifest = excluded.manifest,
         permissions = excluded.permissions`,
    )
    .run(
      slug,
      version,
      integrity,
      engines,
      JSON.stringify(manifest),
      JSON.stringify(permissions),
      publishedAt,
    )

  // ON CONFLICT 保留首次发布时间；读回真实行，避免返回值与库里不一致。
  const saved = listVersions(store, slug).find((entry) => entry.version === version)
  if (saved === undefined) {
    throw new StoreError('INVALID_INPUT', `plugin version ${slug}@${version} was upserted but cannot be read back`)
  }
  return saved
}

/** 版本按发布时间倒序（最新在前）；同一时间按版本号倒序兜底。 */
export function listVersions(store: Store, slug: string): PluginVersion[] {
  assertOpen(store)
  const pluginSlug = readSlug(slug, 'pluginVersion.slug')
  return store.db
    .prepare(
      `SELECT ${VERSION_COLUMNS} FROM plugin_versions
        WHERE slug = ?
        ORDER BY published_at DESC, version DESC`,
    )
    .all(pluginSlug)
    .map(rowToVersion)
}

// ---- 安装记录 ----------------------------------------------------------------

export interface PluginInstall {
  id: string
  workspaceId: string
  slug: string
  version: string
  enabled: boolean
  /** profile-lock 摘要 JSON（见 docs §4 ④）。 */
  lock: string
  installedBy: string
  installedAt: number
  preflight: Record<string, unknown> | null
  state: PluginInstallState
}

export interface CreateInstallInput {
  id?: string
  workspaceId: string
  slug: string
  version: string
  enabled?: boolean
  lock: string
  installedBy: string
  installedAt?: number
  preflight?: Record<string, unknown> | null
  state?: PluginInstallState
}

export interface UpdateInstallInput {
  id: string
  enabled?: boolean
  version?: string
  lock?: string
  preflight?: Record<string, unknown> | null
  state?: PluginInstallState
  /** 操作人（写 plugin.update 事件的 actor）；版本变化时必填才能写事件。 */
  by: string
  at?: number
}

export interface DeleteInstallInput {
  id: string
  /** 操作人（写 plugin.uninstall 事件的 actor）。 */
  by: string
  at?: number
}

interface InstallRow {
  id: string
  workspace_id: string
  slug: string
  version: string
  enabled: number | bigint
  lock: string
  installed_by: string
  installed_at: number | bigint
  preflight: string | null
  state: string
}

const INSTALL_COLUMNS =
  'id, workspace_id, slug, version, enabled, lock, installed_by, installed_at, preflight, state'

/**
 * 写一条安装记录并追加 plugin.install 事件。
 * UNIQUE(workspace_id, slug) 冲突会抛 `PLUGIN_INSTALL_EXISTS` 的 tagged StoreError，
 * 由 API 层转成「幂等返回已有安装」。
 */
export function createInstall(store: Store, input: CreateInstallInput): PluginInstall {
  assertOpen(store)
  const req = asRecord(input, 'install', 'INVALID_INPUT')
  const id = req.id === undefined || req.id === null ? newRoostId('pli', Date.now()) : readId(req.id, 'install.id')
  const workspaceId = readId(req.workspaceId, 'install.workspaceId')
  const slug = readSlug(req.slug, 'install.slug')
  const version = readVersion(req.version, 'install.version')
  const enabled = req.enabled === undefined ? true : readBoolean(req.enabled, 'install.enabled')
  const lock = readLock(req.lock)
  const installedBy = readId(req.installedBy, 'install.installedBy')
  const installedAt =
    req.installedAt === undefined || req.installedAt === null
      ? Date.now()
      : asInteger(req.installedAt, 'install.installedAt', 0, 'INVALID_INPUT')
  const preflight = req.preflight === undefined || req.preflight === null ? null : readJsonObject(req.preflight, 'install.preflight')
  const state = req.state === undefined ? 'installing' : readInstallState(req.state, 'install.state')

  store.db.exec('SAVEPOINT roost_create_install')
  try {
    store.db
      .prepare(
        `INSERT INTO plugin_installs (${INSTALL_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        slug,
        version,
        enabled ? 1 : 0,
        lock,
        installedBy,
        installedAt,
        preflight === null ? null : JSON.stringify(preflight),
        state,
      )

    appendPluginEvent(store, {
      at: installedAt,
      kind: 'plugin.install',
      by: installedBy,
      idem: `plugin:${id}:install`,
      payload: {
        installId: id,
        workspaceId,
        slug,
        version,
        lock,
        enabled,
      },
    })
    store.db.exec('RELEASE roost_create_install')
  } catch (err) {
    rollback(store, 'roost_create_install')
    if (err instanceof StoreError) throw err
    const message = errorMessage(err)
    if (message.includes('UNIQUE constraint failed') || message.includes('plugin_installs.workspace_id')) {
      throw new StoreError(
        'INVALID_INPUT',
        taggedStoreMessage(
          MARKETPLACE_ERROR_CODES.installExists,
          `plugin ${slug} is already installed in workspace ${workspaceId}`,
        ),
        { cause: err },
      )
    }
    throw new StoreError('INVALID_INPUT', `failed to create plugin install: ${message}`, { cause: err })
  }

  const created = getInstall(store, id)
  if (created === null) {
    throw new StoreError('INVALID_INPUT', `plugin install ${id} was inserted but cannot be read back`)
  }
  return created
}

export function getInstall(store: Store, id: string): PluginInstall | null {
  assertOpen(store)
  const installId = readId(id, 'install.id')
  const row = store.db
    .prepare(`SELECT ${INSTALL_COLUMNS} FROM plugin_installs WHERE id = ?`)
    .get(installId)
  return row === undefined || row === null ? null : rowToInstall(row)
}

export function listInstalls(store: Store, workspaceId: string): PluginInstall[] {
  assertOpen(store)
  const wsId = readId(workspaceId, 'install.workspaceId')
  return store.db
    .prepare(
      `SELECT ${INSTALL_COLUMNS} FROM plugin_installs
        WHERE workspace_id = ?
        ORDER BY installed_at ASC, id ASC`,
    )
    .all(wsId)
    .map(rowToInstall)
}

/**
 * 更新安装记录。版本变化时追加 plugin.update；仅 enabled/state 变化不写事件
 * （停用/启停不是升级，审计由后续 batch 的同步结果事件承担）。
 */
export function updateInstall(store: Store, input: UpdateInstallInput): PluginInstall {
  assertOpen(store)
  const req = asRecord(input, 'installUpdate', 'INVALID_INPUT')
  const id = readId(req.id, 'installUpdate.id')
  const by = readId(req.by, 'installUpdate.by')
  const at =
    req.at === undefined || req.at === null ? Date.now() : asInteger(req.at, 'installUpdate.at', 0, 'INVALID_INPUT')

  const current = getInstall(store, id)
  if (current === null) {
    throw new StoreError(
      'INVALID_INPUT',
      taggedStoreMessage(MARKETPLACE_ERROR_CODES.installNotFound, `unknown plugin install ${id}`),
    )
  }

  const enabled =
    req.enabled === undefined ? current.enabled : readBoolean(req.enabled, 'installUpdate.enabled')
  const version =
    req.version === undefined ? current.version : readVersion(req.version, 'installUpdate.version')
  const lock = req.lock === undefined ? current.lock : readLock(req.lock)
  const preflight =
    req.preflight === undefined
      ? current.preflight
      : req.preflight === null
        ? null
        : readJsonObject(req.preflight, 'installUpdate.preflight')
  const state =
    req.state === undefined ? current.state : readInstallState(req.state, 'installUpdate.state')

  const versionChanged = version !== current.version

  store.db.exec('SAVEPOINT roost_update_install')
  try {
    store.db
      .prepare(
        `UPDATE plugin_installs
            SET version = ?, enabled = ?, lock = ?, preflight = ?, state = ?
          WHERE id = ?`,
      )
      .run(version, enabled ? 1 : 0, lock, preflight === null ? null : JSON.stringify(preflight), state, id)

    if (versionChanged) {
      appendPluginEvent(store, {
        at,
        kind: 'plugin.update',
        by,
        idem: `plugin:${id}:update:${version}:${at}`,
        payload: {
          installId: id,
          workspaceId: current.workspaceId,
          slug: current.slug,
          version,
          previousVersion: current.version,
          lock,
          enabled,
        },
      })
    }
    store.db.exec('RELEASE roost_update_install')
  } catch (err) {
    rollback(store, 'roost_update_install')
    if (err instanceof StoreError) throw err
    throw new StoreError('INVALID_INPUT', `failed to update plugin install: ${errorMessage(err)}`, { cause: err })
  }

  const updated = getInstall(store, id)
  if (updated === null) {
    throw new StoreError(
      'INVALID_INPUT',
      taggedStoreMessage(MARKETPLACE_ERROR_CODES.installNotFound, `unknown plugin install ${id}`),
    )
  }
  return updated
}

/**
 * 删除安装记录并追加 plugin.uninstall。行不存在返回 false（API 层据此保持 204 幂等），
 * 不写事件。
 */
export function deleteInstall(store: Store, input: DeleteInstallInput): boolean {
  assertOpen(store)
  const req = asRecord(input, 'installDelete', 'INVALID_INPUT')
  const id = readId(req.id, 'installDelete.id')
  const by = readId(req.by, 'installDelete.by')
  const at =
    req.at === undefined || req.at === null ? Date.now() : asInteger(req.at, 'installDelete.at', 0, 'INVALID_INPUT')

  const current = getInstall(store, id)
  if (current === null) return false

  store.db.exec('SAVEPOINT roost_delete_install')
  try {
    store.db.prepare('DELETE FROM plugin_installs WHERE id = ?').run(id)
    appendPluginEvent(store, {
      at,
      kind: 'plugin.uninstall',
      by,
      idem: `plugin:${id}:uninstall`,
      payload: {
        installId: id,
        workspaceId: current.workspaceId,
        slug: current.slug,
        version: current.version,
        lock: current.lock,
      },
    })
    store.db.exec('RELEASE roost_delete_install')
  } catch (err) {
    rollback(store, 'roost_delete_install')
    if (err instanceof StoreError) throw err
    throw new StoreError('INVALID_INPUT', `failed to delete plugin install: ${errorMessage(err)}`, { cause: err })
  }
  return true
}

// ---- 内部 --------------------------------------------------------------------

function appendPluginEvent(
  store: Store,
  input: {
    at: number
    kind: 'plugin.install' | 'plugin.update' | 'plugin.uninstall'
    by: string
    idem: string
    payload: Record<string, unknown>
  },
): void {
  appendEvent(store, {
    at: new Date(input.at).toISOString(),
    domain: 'plugin',
    kind: input.kind,
    actor: { kind: 'user', id: input.by },
    subject: { kind: 'plugin', id: String(input.payload.slug) },
    audience: 'team',
    idem: input.idem,
    payload: input.payload,
  })
}

function rollback(store: Store, savepoint: string): void {
  try {
    store.db.exec(`ROLLBACK TO ${savepoint}`)
    store.db.exec(`RELEASE ${savepoint}`)
  } catch {
    // 外层事务可能已经把 savepoint 一起回滚；保留原始错误。
  }
}

function readId(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new StoreError('INVALID_INPUT', `${label} must be a string`)
  const id = value.trim()
  if (id === '') throw new StoreError('INVALID_INPUT', `${label} must not be empty`)
  if (id.length > 200) throw new StoreError('INVALID_INPUT', `${label} must be at most 200 characters`)
  return id
}

function readSlug(value: unknown, label: string): string {
  if (!isPluginSlug(value)) {
    throw new StoreError(
      'INVALID_INPUT',
      taggedStoreMessage(
        MARKETPLACE_ERROR_CODES.invalidSlug,
        `${label} must match ${PLUGIN_SLUG_PATTERN} (max ${PLUGIN_SLUG_MAX} chars)`,
      ),
    )
  }
  return value
}

function readVersion(value: unknown, label: string): string {
  return readText(value, label, 100)
}

function readText(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== 'string') throw new StoreError('INVALID_INPUT', `${label} must be a string`)
  const text = value.trim()
  if (text === '') throw new StoreError('INVALID_INPUT', `${label} must not be empty`)
  if (text.length > maxChars) {
    throw new StoreError('INVALID_INPUT', `${label} must be at most ${maxChars} characters`)
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new StoreError('INVALID_INPUT', `${label} must not contain control characters`)
  }
  return text
}

function readOptionalText(value: unknown, label: string, maxChars: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new StoreError('INVALID_INPUT', `${label} must be a string when present`)
  }
  const text = value.trim()
  if (text === '') return null
  return readText(text, label, maxChars)
}

/** 长文本（README）：允许换行/制表符，但拒绝其它控制字符。 */
function readOptionalLongText(value: unknown, label: string, maxChars: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new StoreError('INVALID_INPUT', `${label} must be a string when present`)
  }
  const text = value.trim()
  if (text === '') return null
  if (text.length > maxChars) {
    throw new StoreError('INVALID_INPUT', `${label} must be at most ${maxChars} characters`)
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new StoreError('INVALID_INPUT', `${label} must not contain control characters`)
  }
  return text
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return value === 1
  throw new StoreError('INVALID_INPUT', `${label} must be a boolean`)
}

function readTier(value: unknown, label: string): PluginTier {
  if (typeof value !== 'string' || !PLUGIN_TIERS.includes(value as PluginTier)) {
    throw new StoreError('INVALID_INPUT', `${label} must be one of A|B|C|D`)
  }
  return value as PluginTier
}

function readInstallState(value: unknown, label: string): PluginInstallState {
  if (typeof value !== 'string' || !PLUGIN_INSTALL_STATES.includes(value as PluginInstallState)) {
    throw new StoreError(
      'INVALID_INPUT',
      `${label} must be one of ${PLUGIN_INSTALL_STATES.join('|')}`,
    )
  }
  return value as PluginInstallState
}

function readScreenshots(value: unknown): string[] | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) throw new StoreError('INVALID_INPUT', 'marketPlugin.screenshots must be an array')
  if (value.length > 20) throw new StoreError('INVALID_INPUT', 'marketPlugin.screenshots must have at most 20 entries')
  return value.map((item, index) => readText(item, `marketPlugin.screenshots[${index}]`, 2000))
}

function readJsonObject(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value, label, 'INVALID_INPUT')
  let encoded: string
  try {
    encoded = JSON.stringify(record)
  } catch (err) {
    throw new StoreError('INVALID_INPUT', `${label} is not JSON-serializable: ${errorMessage(err)}`)
  }
  if (Buffer.byteLength(encoded, 'utf8') > 256 * 1024) {
    throw new StoreError('INVALID_INPUT', `${label} exceeds 256KiB`)
  }
  return record
}

function readLock(value: unknown): string {
  const lock = readText(value, 'install.lock', 256 * 1024)
  return lock
}


function decodeObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function decodeScreenshots(raw: string | null): string[] {
  if (raw === null || raw === undefined) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

function rowToPublisher(row: unknown): PluginPublisher {
  const r = row as PublisherRow
  return {
    id: r.id,
    name: r.name,
    verified: toNumber(r.verified) === 1,
    registry: r.registry,
    createdAt: toNumber(r.created_at),
  }
}

function rowToMarketPlugin(row: unknown): MarketPlugin {
  const r = row as MarketRow
  return {
    slug: r.slug,
    title: r.title,
    publisherId: r.publisher_id,
    category: r.category,
    tier: r.tier as PluginTier,
    summary: r.summary,
    readme: r.readme,
    latest: r.latest,
    icon: r.icon,
    screenshots: decodeScreenshots(r.screenshots),
    updatedAt: toNumber(r.updated_at),
  }
}

function rowToVersion(row: unknown): PluginVersion {
  const r = row as VersionRow
  return {
    slug: r.slug,
    version: r.version,
    integrity: r.integrity,
    engines: r.engines,
    manifest: decodeObject(r.manifest) ?? {},
    permissions: decodeObject(r.permissions) ?? {},
    publishedAt: toNumber(r.published_at),
  }
}

function rowToInstall(row: unknown): PluginInstall {
  const r = row as InstallRow
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    slug: r.slug,
    version: r.version,
    enabled: toNumber(r.enabled) === 1,
    lock: r.lock,
    installedBy: r.installed_by,
    installedAt: toNumber(r.installed_at),
    preflight: decodeObject(r.preflight),
    state: r.state as PluginInstallState,
  }
}

