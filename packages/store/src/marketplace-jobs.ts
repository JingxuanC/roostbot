// 插件安装作业（迁移 0020）：一次安装/升级/卸载请求 = 一条 job。
//
// 事实源：docs/build/wave1.md §B（状态机）、docs/design/plugin-marketplace.md §4（安装流程）/
//         §8（供应链与回滚）、migrations/0020_marketplace_jobs.sql。
//
// 分层：
//   * plugin_installs 只描述「装没装成」（installing|installed|failed|disabling）与
//     「它给了哪些工具」（tools_json，5.1.7）。
//   * plugin_install_jobs 描述「这一次操作的进度」：等审批 / 正在装 / 回滚中 / 已回滚，
//     并携带这次要应用的锁（lock_json）与回到哪（snapshot_json）。
//
// 状态机有两份实现，但只有一套语义：纯函数在 packages/plugins/src/install.ts
// （nextJobState），这里落库时再守一遍（JOB_TRANSITIONS）。apps/api/test 里有一张
// 「逐格比对」的用例，两边不一致会红。
//
// 域错误码沿用 approvals.ts 的 `CODE: detail` 约定（errors.ts 的 code 是封闭枚举）。

import { taggedStoreMessage } from './approvals.ts'
import { StoreError } from './errors.ts'
import { newRoostId } from './ids.ts'
import { asInteger, asRecord, assertOpen, errorMessage, toNumber } from './internal.ts'
import { MARKETPLACE_ERROR_CODES } from './marketplace.ts'
import type { Store } from './types.ts'

export const PLUGIN_JOB_STATES = [
  'preflight',
  'awaiting-approval',
  'installing',
  'installed',
  'failed',
  'rolling-back',
  'rolled-back',
  'disabled',
] as const
export type PluginJobState = (typeof PLUGIN_JOB_STATES)[number]

export const PLUGIN_JOB_EVENTS = [
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
export type PluginJobEvent = (typeof PLUGIN_JOB_EVENTS)[number]

/** 作业域错误码（写在 StoreError.message 的 `CODE: ` 前缀里）。 */
export const JOB_ERROR_CODES = {
  notFound: 'PLUGIN_JOB_NOT_FOUND',
  illegalTransition: 'PLUGIN_JOB_ILLEGAL_TRANSITION',
  invalid: 'PLUGIN_JOB_INVALID',
} as const

/** 落库时守的状态机（与 packages/plugins/src/install.ts 的 JOB_TRANSITIONS 等价）。 */
export const JOB_TRANSITIONS: Readonly<
  Record<PluginJobState, Readonly<Partial<Record<PluginJobEvent, PluginJobState>>>>
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

export interface PluginInstallJob {
  id: string
  /** plugin_installs.id；新装时是预分配 id（审批通过前安装行可能还不存在）。 */
  installId: string
  workspaceId: string
  slug: string
  version: string
  state: PluginJobState
  /** 这次要应用的 profile 锁文档（JSON 原文）。 */
  lockJson: string | null
  /** 安装前快照（JSON 原文）：旧锁 + 旧安装行。 */
  snapshotJson: string | null
  /** 权限披露 / 预检结果。 */
  permissionsJson: Record<string, unknown> | null
  error: string | null
  createdAt: number
  updatedAt: number
}

export interface CreateJobInput {
  id?: string
  installId: string
  workspaceId: string
  slug: string
  version: string
  /** 初始状态；默认 'preflight'。卸载作业直接从 'installing' 开始。 */
  state?: PluginJobState
  lockJson?: string | null
  snapshotJson?: string | null
  permissionsJson?: Record<string, unknown> | null
  error?: string | null
  at?: number
}

export interface UpdateJobInput {
  id: string
  state?: PluginJobState
  lockJson?: string | null
  snapshotJson?: string | null
  permissionsJson?: Record<string, unknown> | null
  error?: string | null
  at?: number
}

export interface AdvanceJobInput {
  id: string
  event: PluginJobEvent
  lockJson?: string | null
  snapshotJson?: string | null
  permissionsJson?: Record<string, unknown> | null
  error?: string | null
  at?: number
}

export interface ListJobsQuery {
  workspaceId?: string
  slug?: string
  installId?: string
  state?: PluginJobState
}

interface JobRow {
  id: string
  install_id: string
  workspace_id: string
  slug: string
  version: string
  state: string
  lock_json: string | null
  snapshot_json: string | null
  permissions_json: string | null
  error: string | null
  created_at: number | bigint
  updated_at: number | bigint
}

const JOB_COLUMNS =
  'id, install_id, workspace_id, slug, version, state, lock_json, snapshot_json, permissions_json, error, created_at, updated_at'

const MAX_DOCUMENT_BYTES = 512 * 1024
const MAX_PERMISSIONS_BYTES = 64 * 1024
const MAX_ERROR_CHARS = 2000
const MAX_TOOLS = 500

export function isJobState(value: unknown): value is PluginJobState {
  return typeof value === 'string' && (PLUGIN_JOB_STATES as readonly string[]).includes(value)
}

export function isJobEvent(value: unknown): value is PluginJobEvent {
  return typeof value === 'string' && (PLUGIN_JOB_EVENTS as readonly string[]).includes(value)
}

/** 合法迁移；非法返回 null（与 packages/plugins 的 nextJobState 同语义）。 */
export function nextJobStateFor(state: PluginJobState, event: PluginJobEvent): PluginJobState | null {
  if (!isJobState(state) || !isJobEvent(event)) return null
  return JOB_TRANSITIONS[state][event] ?? null
}

// ---- 创建 / 读取 / 更新 -------------------------------------------------------

export function createJob(store: Store, input: CreateJobInput): PluginInstallJob {
  assertOpen(store)
  const req = asRecord(input, 'job', 'INVALID_INPUT')
  const at =
    req.at === undefined || req.at === null
      ? Date.now()
      : asInteger(req.at, 'job.at', 0, 'INVALID_INPUT')
  const id = req.id === undefined || req.id === null ? newRoostId('plj', at) : readId(req.id, 'job.id')
  const installId = readId(req.installId, 'job.installId')
  const workspaceId = readId(req.workspaceId, 'job.workspaceId')
  const slug = readSlug(req.slug)
  const version = readVersion(req.version)
  const state = req.state === undefined ? 'preflight' : readState(req.state, 'job.state')
  const lockJson = readDocument(req.lockJson, 'job.lockJson')
  const snapshotJson = readDocument(req.snapshotJson, 'job.snapshotJson')
  const permissionsJson = readOptionalRecord(req.permissionsJson, 'job.permissionsJson')
  const error = readOptionalText(req.error, 'job.error', MAX_ERROR_CHARS)

  try {
    store.db
      .prepare(
        `INSERT INTO plugin_install_jobs (${JOB_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        installId,
        workspaceId,
        slug,
        version,
        state,
        lockJson,
        snapshotJson,
        permissionsJson === null ? null : JSON.stringify(permissionsJson),
        error,
        at,
        at,
      )
  } catch (err) {
    throw new StoreError(
      'INVALID_INPUT',
      taggedStoreMessage(JOB_ERROR_CODES.invalid, `failed to create plugin install job: ${errorMessage(err)}`),
      { cause: err },
    )
  }

  const created = getJob(store, id)
  if (created === null) {
    throw new StoreError(
      'INVALID_INPUT',
      taggedStoreMessage(JOB_ERROR_CODES.invalid, `plugin install job ${id} was inserted but cannot be read back`),
    )
  }
  return created
}

export function getJob(store: Store, id: string): PluginInstallJob | null {
  assertOpen(store)
  const jobId = readId(id, 'job.id')
  const row = store.db.prepare(`SELECT ${JOB_COLUMNS} FROM plugin_install_jobs WHERE id = ?`).get(jobId)
  return row === undefined || row === null ? null : rowToJob(row)
}

/** 某个安装行最近一次的作业（安装行可以有多条 job：装、升级、卸载、回滚）。 */
export function latestJobForInstall(store: Store, installId: string): PluginInstallJob | null {
  assertOpen(store)
  const id = readId(installId, 'job.installId')
  const row = store.db
    .prepare(
      `SELECT ${JOB_COLUMNS} FROM plugin_install_jobs
        WHERE install_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(id)
  return row === undefined || row === null ? null : rowToJob(row)
}

export function listJobs(store: Store, query: ListJobsQuery = {}): PluginInstallJob[] {
  assertOpen(store)
  const req = asRecord(query, 'jobQuery', 'INVALID_INPUT')
  const clauses: string[] = []
  const params: unknown[] = []
  if (req.workspaceId !== undefined && req.workspaceId !== null) {
    clauses.push('workspace_id = ?')
    params.push(readId(req.workspaceId, 'jobQuery.workspaceId'))
  }
  if (req.slug !== undefined && req.slug !== null) {
    clauses.push('slug = ?')
    params.push(readSlug(req.slug))
  }
  if (req.installId !== undefined && req.installId !== null) {
    clauses.push('install_id = ?')
    params.push(readId(req.installId, 'jobQuery.installId'))
  }
  if (req.state !== undefined && req.state !== null) {
    clauses.push('state = ?')
    params.push(readState(req.state, 'jobQuery.state'))
  }
  let sql = `SELECT ${JOB_COLUMNS} FROM plugin_install_jobs`
  if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`
  // rowid 兜底同一毫秒内的插入顺序：id 是 ULID 形状但尾段随机，不能当顺序用。
  sql += ' ORDER BY created_at ASC, rowid ASC'
  return store.db.prepare(sql).all(...params).map(rowToJob)
}

/**
 * 更新作业。state 变化必须是契约里的迁移（否则 PLUGIN_JOB_ILLEGAL_TRANSITION）；
 * 同状态视为幂等（重复投递 sync/disable 不报错）。
 */
export function updateJob(store: Store, input: UpdateJobInput): PluginInstallJob {
  assertOpen(store)
  const req = asRecord(input, 'jobUpdate', 'INVALID_INPUT')
  const id = readId(req.id, 'jobUpdate.id')
  const at =
    req.at === undefined || req.at === null
      ? Date.now()
      : asInteger(req.at, 'jobUpdate.at', 0, 'INVALID_INPUT')

  const current = getJob(store, id)
  if (current === null) throw jobNotFound(id)

  const state = req.state === undefined ? current.state : readState(req.state, 'jobUpdate.state')
  if (state !== current.state) assertReachable(current.state, state)

  const lockJson =
    req.lockJson === undefined ? current.lockJson : readDocument(req.lockJson, 'jobUpdate.lockJson')
  const snapshotJson =
    req.snapshotJson === undefined
      ? current.snapshotJson
      : readDocument(req.snapshotJson, 'jobUpdate.snapshotJson')
  const permissionsJson =
    req.permissionsJson === undefined
      ? current.permissionsJson
      : readOptionalRecord(req.permissionsJson, 'jobUpdate.permissionsJson')
  const error =
    req.error === undefined ? current.error : readOptionalText(req.error, 'jobUpdate.error', MAX_ERROR_CHARS)

  store.db
    .prepare(
      `UPDATE plugin_install_jobs
          SET state = ?, lock_json = ?, snapshot_json = ?, permissions_json = ?, error = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      state,
      lockJson,
      snapshotJson,
      permissionsJson === null ? null : JSON.stringify(permissionsJson),
      error,
      at,
      id,
    )

  return requireJob(store, id)
}

/**
 * 按事件推进状态机（路由层用这个，不直接写 state）。
 * 非法事件/迁移抛 PLUGIN_JOB_ILLEGAL_TRANSITION；可选的 lock/snapshot/permissions/error
 * 与状态在同一条 UPDATE 里落库。
 */
export function advanceJob(store: Store, input: AdvanceJobInput): PluginInstallJob {
  assertOpen(store)
  const req = asRecord(input, 'jobAdvance', 'INVALID_INPUT')
  const id = readId(req.id, 'jobAdvance.id')
  const event = readEvent(req.event, 'jobAdvance.event')
  const at =
    req.at === undefined || req.at === null
      ? Date.now()
      : asInteger(req.at, 'jobAdvance.at', 0, 'INVALID_INPUT')

  const current = getJob(store, id)
  if (current === null) throw jobNotFound(id)

  const next = JOB_TRANSITIONS[current.state][event]
  if (next === undefined) {
    throw new StoreError(
      'INVALID_INPUT',
      taggedStoreMessage(
        JOB_ERROR_CODES.illegalTransition,
        `job ${id} in state ${current.state} cannot handle event ${event}`,
      ),
    )
  }

  return updateJob(store, {
    id,
    state: next,
    ...(req.lockJson === undefined ? {} : { lockJson: readDocument(req.lockJson, 'jobAdvance.lockJson') }),
    ...(req.snapshotJson === undefined
      ? {}
      : { snapshotJson: readDocument(req.snapshotJson, 'jobAdvance.snapshotJson') }),
    ...(req.permissionsJson === undefined
      ? {}
      : { permissionsJson: readOptionalRecord(req.permissionsJson, 'jobAdvance.permissionsJson') }),
    ...(req.error === undefined ? {} : { error: readOptionalText(req.error, 'jobAdvance.error', MAX_ERROR_CHARS) }),
    at,
  })
}

/** 删除作业（只给「审批/建行失败要回滚这次请求」用）。不存在返回 false。 */
export function deleteJob(store: Store, id: string): boolean {
  assertOpen(store)
  const jobId = readId(id, 'job.id')
  const result = store.db.prepare('DELETE FROM plugin_install_jobs WHERE id = ?').run(jobId)
  return toNumber(result.changes) > 0
}

// ---- tools_json（5.1.7 工具来源）---------------------------------------------

/** 一个工具及其来源插件：`{name: 'market_quote', source: 'market-center'}`。 */
export interface InstallToolSource {
  name: string
  source: string
}

export interface SetInstallToolsOptions {
  /** 条目没写 source 时的兜底来源（一般传插件 slug）。 */
  source?: string | null
}

/** 读安装行的工具来源；行不存在 / 坏 JSON → []（列表接口不该因为一行坏数据 500）。 */
export function getInstallTools(store: Store, installId: string): InstallToolSource[] {
  assertOpen(store)
  const id = readId(installId, 'tools.installId')
  const row = store.db.prepare('SELECT tools_json FROM plugin_installs WHERE id = ?').get(id)
  if (row === undefined || row === null) return []
  const raw = (row as { tools_json?: string | null }).tools_json
  return decodeTools(raw)
}

/** 写安装行的工具来源（数组 [{name, source}]）；安装行不存在抛 PLUGIN_INSTALL_NOT_FOUND。 */
export function setInstallTools(
  store: Store,
  installId: string,
  tools: unknown,
  options: SetInstallToolsOptions = {},
): InstallToolSource[] {
  assertOpen(store)
  const id = readId(installId, 'tools.installId')
  const fallback = typeof options.source === 'string' ? options.source : null
  const normalized = normalizeTools(tools, fallback)
  const encoded = normalized.length === 0 ? null : JSON.stringify(normalized)
  const result = store.db.prepare('UPDATE plugin_installs SET tools_json = ? WHERE id = ?').run(encoded, id)
  if (toNumber(result.changes) === 0) {
    throw new StoreError(
      'INVALID_INPUT',
      taggedStoreMessage(MARKETPLACE_ERROR_CODES.installNotFound, `unknown plugin install ${id}`),
    )
  }
  return normalized
}

// ---- 内部 --------------------------------------------------------------------

function jobNotFound(id: string): StoreError {
  return new StoreError(
    'INVALID_INPUT',
    taggedStoreMessage(JOB_ERROR_CODES.notFound, `unknown plugin install job ${id}`),
  )
}

function requireJob(store: Store, id: string): PluginInstallJob {
  const job = getJob(store, id)
  if (job === null) throw jobNotFound(id)
  return job
}

function assertReachable(from: PluginJobState, to: PluginJobState): void {
  const reachable = Object.values(JOB_TRANSITIONS[from])
  if (!reachable.includes(to)) {
    throw new StoreError(
      'INVALID_INPUT',
      taggedStoreMessage(
        JOB_ERROR_CODES.illegalTransition,
        `job cannot move from ${from} to ${to}`,
      ),
    )
  }
}

function readId(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new StoreError('INVALID_INPUT', `${label} must be a string`)
  const id = value.trim()
  if (id === '') throw new StoreError('INVALID_INPUT', `${label} must not be empty`)
  if (id.length > 200) throw new StoreError('INVALID_INPUT', `${label} must be at most 200 characters`)
  return id
}

function readSlug(value: unknown): string {
  if (typeof value !== 'string') throw new StoreError('INVALID_INPUT', 'job.slug must be a string')
  const slug = value.trim()
  if (slug === '' || slug.length > 128 || !/^[a-z0-9][a-z0-9._-]*$/.test(slug)) {
    throw new StoreError(
      'INVALID_INPUT',
      taggedStoreMessage(MARKETPLACE_ERROR_CODES.invalidSlug, `job.slug must match ${/^[a-z0-9][a-z0-9._-]*$/}`),
    )
  }
  return slug
}

function readVersion(value: unknown): string {
  if (typeof value !== 'string') throw new StoreError('INVALID_INPUT', 'job.version must be a string')
  const version = value.trim()
  if (version === '' || version.length > 100) {
    throw new StoreError('INVALID_INPUT', 'job.version must be 1..100 characters')
  }
  if (/[\u0000-\u001f\u007f]/.test(version)) {
    throw new StoreError('INVALID_INPUT', 'job.version must not contain control characters')
  }
  return version
}

function readState(value: unknown, label: string): PluginJobState {
  if (!isJobState(value)) {
    throw new StoreError(
      'INVALID_INPUT',
      `${label} must be one of ${PLUGIN_JOB_STATES.join('|')}`,
    )
  }
  return value
}

function readEvent(value: unknown, label: string): PluginJobEvent {
  if (!isJobEvent(value)) {
    throw new StoreError(
      'INVALID_INPUT',
      `${label} must be one of ${PLUGIN_JOB_EVENTS.join('|')}`,
    )
  }
  return value
}

function readDocument(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new StoreError('INVALID_INPUT', `${label} must be a string when present`)
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new StoreError('INVALID_INPUT', `${label} exceeds ${MAX_DOCUMENT_BYTES} bytes`)
  }
  return value
}

function readOptionalRecord(value: unknown, label: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null
  const record = asRecord(value, label, 'INVALID_INPUT')
  let encoded: string
  try {
    encoded = JSON.stringify(record)
  } catch (err) {
    throw new StoreError('INVALID_INPUT', `${label} is not JSON-serializable: ${errorMessage(err)}`)
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PERMISSIONS_BYTES) {
    throw new StoreError('INVALID_INPUT', `${label} exceeds ${MAX_PERMISSIONS_BYTES} bytes`)
  }
  return record
}

function readOptionalText(value: unknown, label: string, maxChars: number): string | null {
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

function normalizeTools(value: unknown, fallbackSource: string | null): InstallToolSource[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new StoreError('INVALID_INPUT', 'tools must be an array of strings or {name, source} objects')
  }
  if (value.length > MAX_TOOLS) {
    throw new StoreError('INVALID_INPUT', `tools must have at most ${MAX_TOOLS} entries`)
  }
  const out: InstallToolSource[] = []
  for (const entry of value) {
    let name: unknown
    let source: unknown
    if (typeof entry === 'string') {
      name = entry
      source = fallbackSource
    } else if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>
      name = record['name']
      source = record['source'] ?? fallbackSource
    } else {
      continue
    }
    if (typeof name !== 'string') continue
    const toolName = name.trim()
    if (toolName === '' || toolName.length > 200) continue
    const toolSource = typeof source === 'string' && source.trim() !== '' ? source.trim().slice(0, 200) : 'unknown'
    if (out.some((tool) => tool.name === toolName && tool.source === toolSource)) continue
    out.push({ name: toolName, source: toolSource })
  }
  return out
}

function decodeTools(raw: string | null | undefined): InstallToolSource[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: InstallToolSource[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record['name'] !== 'string' || typeof record['source'] !== 'string') continue
    out.push({ name: record['name'], source: record['source'] })
  }
  return out
}

function rowToJob(row: unknown): PluginInstallJob {
  const r = row as JobRow
  return {
    id: r.id,
    installId: r.install_id,
    workspaceId: r.workspace_id,
    slug: r.slug,
    version: r.version,
    state: r.state as PluginJobState,
    lockJson: r.lock_json,
    snapshotJson: r.snapshot_json,
    permissionsJson: decodeObject(r.permissions_json),
    error: r.error,
    createdAt: toNumber(r.created_at),
    updatedAt: toNumber(r.updated_at),
  }
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
