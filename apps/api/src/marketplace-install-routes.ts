// 插件安装流水线 API（M5-5.1 第二批：5.1.3 / 5.1.5 / 5.1.7 / 5.1.8 / 5.1.9 / 5.1.10）。
//
// 事实源：docs/build/wave1.md §B、docs/design/plugin-marketplace.md §4（安装流程）/ §8（安全与回滚）。
//
// 本文件只导出 handler，由 server.ts 接线（不要在这里 import server.ts 的路由表）：
//
//   POST /api/marketplace/plugins/:slug/install   handleMarketplaceInstallStart   Bearer（owner/admin）{workspaceId?, version}
//   GET  /api/plugin-installs                     handlePluginInstallList         Bearer；?workspaceId=
//   GET  /api/plugin-installs/:id                 handlePluginInstallGet          Bearer
//   POST /api/plugin-installs/:id/update          handlePluginInstallUpdate       Bearer（owner/admin）{version}
//   POST /api/plugin-installs/:id/disable         handlePluginInstallDisable      Bearer（owner/admin）
//   POST /api/plugin-installs/:id/enable          handlePluginInstallEnable       Bearer（owner/admin）
//   POST /api/plugin-installs/:id/uninstall       handlePluginInstallUninstall    Bearer（owner/admin）
//   POST /api/plugin-installs/:id/rollback        handlePluginInstallRollback     Bearer（owner/admin）
//   POST /api/internal/plugin-installs/:id/synced handlePluginInstallSynced       runtime token
//
// 审批通过后的副作用（Lead 在 approvals 决策处理里调用，见 handleDecideApproval）：
//   onInstallApproved(store, {approvalId, decision, by, at}) -> {job, install}
//
// 两条契约细节：
//   * 安装先落 job + approvals(kind='plugin_install')，**审批通过时才写安装行**。
//     这样被拒绝的安装不会在「已安装」列表里留下一条永远装不上的幽灵记录（0013 的
//     UNIQUE(workspace_id, slug) 会让它挡住真正的重试）。等待审批期间用
//     GET /api/plugin-installs/:id（id = job.installId）看进度，install 为 null。
//   * 安装/更新命令固定为 `pnpm install --frozen-lockfile --ignore-scripts`（5.1.9），
//     不接受调用方拼参数；`installCommandFor(lock)` 只是把命令和锁绑在一起审计。

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { PluginCapabilities } from '../../../packages/plugins/src/compat.ts'
import { tierLabel } from '../../../packages/plugins/src/compat.ts'
import {
  buildProfileLock as buildProfileLockInputs,
  preflightInstall,
} from '../../../packages/plugins/src/install.ts'
import type { InstallPreflightResult } from '../../../packages/plugins/src/install.ts'
import {
  buildProfileLock as assembleProfileLock,
} from '../../../packages/plugins/src/profile-lock.ts'
import type { ProfileLock } from '../../../packages/plugins/src/profile-lock.ts'
import {
  MARKETPLACE_ERROR_CODES,
  createInstall,
  deleteInstall,
  getInstall,
  getMarketPlugin,
  isPluginSlug,
  listInstalls,
  listVersions,
  storeErrorTag,
  updateInstall,
} from '../../../packages/store/src/index.ts'
import type { PluginInstall, PluginVersion } from '../../../packages/store/src/index.ts'
import {
  createApproval,
  getApproval,
  listApprovals,
} from '../../../packages/store/src/approvals.ts'
import type { Approval } from '../../../packages/store/src/approvals.ts'
import { StoreError } from '../../../packages/store/src/errors.ts'
import { newRoostId } from '../../../packages/store/src/ids.ts'
import {
  JOB_ERROR_CODES,
  advanceJob,
  createJob,
  deleteJob,
  getInstallTools,
  getJob,
  latestJobForInstall,
  listJobs,
  setInstallTools,
} from '../../../packages/store/src/marketplace-jobs.ts'
import type { PluginInstallJob } from '../../../packages/store/src/marketplace-jobs.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { approvalJson } from './bot-rooms-routes.ts'
import { DEFAULT_DSH_VERSION } from './marketplace-routes.ts'
import type { SessionRecord, StorePort, WorkspaceRole } from './port.ts'
import type { RateLimiter } from './rate-limit.ts'
import { authenticate, isPlainObject, readJsonBody, readText, sendError, sendJson } from './server.ts'

export const PLUGIN_INSTALL_APPROVAL_KIND = 'plugin_install'

/** 5.1.9：运行时安装禁 postinstall。更新与安装同一条命令。 */
export const INSTALL_COMMAND = 'pnpm install --frozen-lockfile --ignore-scripts'

/** 供应链冷却期默认 24h（可用 ROOST_PLUGIN_MIN_RELEASE_AGE_MS 覆盖）。 */
export const DEFAULT_MIN_RELEASE_AGE_MS = 24 * 60 * 60 * 1000

const MAX_ID_CHARS = 200
const MAX_VERSION_CHARS = 100

export interface MarketplaceInstallRouteContext {
  store: StorePort
  now: () => number
  /** 市场目录 / 安装行 / 作业表只在 SQLite 里。 */
  rawStore?: Store
  /** runtime token（未配置 = 内部接口 404）；默认读 ROOST_RUNTIME_TOKEN。 */
  runtimeToken?: string
  /** 每个 server 实例的写接口限流器（可选）。 */
  rateLimiter?: RateLimiter
  /** 镜像基线 DSH 版本；默认 DEFAULT_DSH_VERSION。 */
  dshVersion?: string
  /** ROOST_PLUGIN_ALLOWLIST 原文/数组；默认读环境变量（空 = 全部拒绝）。 */
  allowlist?: string | readonly string[] | null
  /** 最小发布时长；默认 env，再默认 24h。 */
  minReleaseAgeMs?: number | null
  /** profile 的基线 bundle 列表；默认空。 */
  baseBundles?: readonly string[]
}

type Ctx = MarketplaceInstallRouteContext

/** 命令与锁绑定：锁只用于审计「哪份锁用这条命令装的」，命令本身不可改。 */
export function installCommandFor(lock: unknown): string {
  void lock
  return INSTALL_COMMAND
}

// ---- 安装：预检 → job → 审批 -------------------------------------------------

export async function handleMarketplaceInstallStart(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  if (!requireStore(ctx, res)) return

  const slug = slugFromInstallPath(url.pathname)
  if (slug === null) return sendError(res, 404, 'not_found', 'malformed plugin install path')

  const retryAfter = ctx.rateLimiter?.consume('pluginInstall', auth.accountId, ctx.now()) ?? null
  if (retryAfter !== null) {
    return sendError(res, 429, 'rate_limited', `too many plugin install requests; retry after ${retryAfter}s`, {
      'retry-after': String(retryAfter),
    })
  }

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const body = parsed.value

  // 契约只写 {version}；安装必须落到某个 workspace，所以 workspaceId 从 body 或 query 取。
  const workspaceId =
    readText(body['workspaceId'], MAX_ID_CHARS) ?? readText(url.searchParams.get('workspaceId'), MAX_ID_CHARS)
  if (workspaceId === null) {
    return sendError(res, 400, 'invalid_body', 'workspaceId is required (non-empty string)')
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

  const requestedVersion = readText(body['version'], MAX_VERSION_CHARS) ?? plugin.latest
  const version = findVersion(store, slug, requestedVersion)
  if (version === null) {
    return sendError(res, 404, 'plugin.version_not_found', `plugin ${slug} has no version ${requestedVersion}`)
  }

  // 幂等：已经装了这个插件 → 返回安装行与最近作业，不重复审批。
  const existing = listInstalls(store, workspaceId).find((install) => install.slug === slug)
  if (existing !== undefined) {
    return sendJson(res, 200, {
      install: installJson(existing, getInstallTools(store, existing.id)),
      job: wrapJob(latestJobForInstall(store, existing.id)),
      alreadyInstalled: true,
    })
  }

  // 幂等：还在等审批的同 slug 作业 → 原样返回（不堆第二条审批）。
  const pending = listJobs(store, { workspaceId, slug })
    .filter((job) => job.state === 'preflight' || job.state === 'awaiting-approval')
    .pop()
  if (pending !== undefined) {
    return sendJson(res, 202, {
      job: jobJson(pending),
      approval: wrapApproval(pendingApprovalForJob(store, workspaceId, pending.id)),
      installId: pending.installId,
    })
  }

  const at = ctx.now()
  const preflight = runPreflight(ctx, plugin, version)
  if (!preflight.ok) return sendPreflightFailure(res, preflight)

  const installId = newRoostId('pli', at)
  const lock = profileLockFor(ctx, store, {
    workspaceId,
    at,
    extra: { slug, version: version.version, integrity: version.integrity },
  })
  const job = createJob(store, {
    installId,
    workspaceId,
    slug,
    version: version.version,
    state: 'preflight',
    lockJson: JSON.stringify(lock),
    snapshotJson: JSON.stringify(snapshotFor(null, 'install', at, { installId, workspaceId, slug })),
    permissionsJson: disclosureFor(preflight),
    at,
  })

  try {
    const approval = createApproval(store, {
      workspaceId,
      kind: PLUGIN_INSTALL_APPROVAL_KIND,
      requester: auth.accountId,
      requesterKind: 'user',
      payload: {
        jobId: job.id,
        installId: job.installId,
        workspaceId,
        slug,
        version: version.version,
        tier: preflight.tier,
        permissions: preflight.permissions,
        problems: preflight.problems,
        lock,
        command: installCommandFor(lock),
      },
      action: `安装插件 ${slug}@${version.version}`,
      target: slug,
      consequence: disclosureText(preflight.permissions),
      at,
    })
    const awaiting = advanceJob(store, { id: job.id, event: 'request-approval', at })
    sendJson(res, 202, { job: jobJson(awaiting), approval: approvalJson(approval), installId: job.installId })
  } catch (err) {
    // 审批写失败就把这条 job 收掉，不留「看得见但没人批」的悬空作业。
    deleteJob(store, job.id)
    sendInstallFailure(res, err)
  }
}

/**
 * 审批通过后的副作用：把 job 推到 installing，并写/推进安装行（5.1.3 ④）。
 *
 * Lead 的接线位置：apps/api/src/bot-rooms-routes.ts 的 handleDecideApproval，
 * 在 `decideApproval(store, {...})` 之后按 kind 调用：
 *
 *   if (approval.kind === PLUGIN_INSTALL_APPROVAL_KIND) {
 *     onInstallApproved(store, { approvalId, decision, by: auth.session.accountId, at: ctx.now() })
 *   }
 *
 * 幂等：重复调用（审批接口被重试）只返回当前 job，不再写行、不再推进。
 */
export function onInstallApproved(store: Store, input: {
  approvalId: string
  decision: 'approved' | 'rejected'
  by: string
  at?: number
}): { job: PluginInstallJob | null; install: PluginInstall | null } {
  const none = { job: null, install: null }
  if (typeof input !== 'object' || input === null) return none
  const decision = input.decision
  if (decision !== 'approved' && decision !== 'rejected') return none

  const approval = getApproval(store, input.approvalId)
  if (approval === null || approval.kind !== PLUGIN_INSTALL_APPROVAL_KIND) return none
  const jobId = typeof approval.payload['jobId'] === 'string' ? approval.payload['jobId'] : null
  if (jobId === null) return none
  // 审批行已经是终态时以行为准（Lead 在 decideApproval 之后调用；即使调用方传错，
  // 也不能把已被拒绝的审批装上去）。
  const effective =
    approval.status === 'approved' || approval.status === 'rejected' ? approval.status : decision

  let job = getJob(store, jobId)
  if (job === null) return none
  const at = typeof input.at === 'number' ? input.at : Date.now()
  const by = typeof input.by === 'string' && input.by.trim() !== '' ? input.by : 'system'

  if (job.state === 'preflight') {
    job = advanceJob(store, { id: job.id, event: 'request-approval', at })
  }
  if (job.state !== 'awaiting-approval') {
    // 已经处理过（job 已在 installing/installed/failed/…）：幂等返回。
    return { job, install: getInstall(store, job.installId) }
  }

  if (effective === 'rejected') {
    const failed = advanceJob(store, { id: job.id, event: 'reject', error: 'approval.rejected', at })
    return { job: failed, install: getInstall(store, failed.installId) }
  }

  const snapshot = decodeSnapshot(job.snapshotJson)
  const lockText = job.lockJson ?? '{}'
  try {
    if (snapshot !== null && snapshot.install !== null) {
      // 升级：版本/锁推进到新值，state 回到 installing 等沙箱确认。
      updateInstall(store, {
        id: job.installId,
        version: job.version,
        lock: lockText,
        preflight: job.permissionsJson,
        state: 'installing',
        by,
        at,
      })
    } else {
      // 全新安装：安装行在这里才出现（审批前不留幽灵行）。
      createInstall(store, {
        id: job.installId,
        workspaceId: job.workspaceId,
        slug: job.slug,
        version: job.version,
        lock: lockText,
        installedBy: by,
        installedAt: at,
        preflight: job.permissionsJson,
        state: 'installing',
      })
    }
  } catch (err) {
    const message = err instanceof StoreError ? err.message : String(err)
    const failed = advanceJob(store, {
      id: job.id,
      event: 'fail',
      error: `install apply failed: ${message}`.slice(0, 2000),
      at,
    })
    return { job: failed, install: getInstall(store, failed.installId) }
  }

  const installing = advanceJob(store, { id: job.id, event: 'approve', at })
  return { job: installing, install: getInstall(store, installing.installId) }
}

// ---- 已安装：列表 / 详情 ------------------------------------------------------

export async function handlePluginInstallList(
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
    const market = getMarketPlugin(store, install.slug)
    const latest = market === null ? null : market.latest
    return {
      ...installJson(install, getInstallTools(store, install.id)),
      latest,
      updateAvailable: latest !== null && latest !== install.version,
      job: jobSummary(latestJobForInstall(store, install.id)),
    }
  })

  // pending：还没审批完、所以还没有安装行的作业（安装页刷新后仍能接上进度）。
  const pending = listJobs(store, { workspaceId })
    .filter((job) => job.state === 'preflight' || job.state === 'awaiting-approval')
    .map((job) => jobJson(job))

  sendJson(res, 200, { installs, pending })
}

export async function handlePluginInstallGet(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  if (!requireStore(ctx, res)) return

  const target = installPathFrom(url.pathname)
  if (target === null || target.action !== null) {
    return sendError(res, 404, 'not_found', 'malformed plugin install path')
  }

  const store = storeOf(ctx)
  const install = getInstall(store, target.id)
  const job = latestJobForInstall(store, target.id)
  const workspaceId = install?.workspaceId ?? job?.workspaceId ?? null
  if (workspaceId === null) {
    return sendError(res, 404, 'plugin.install_not_found', `unknown plugin install ${target.id}`)
  }

  const role = await workspaceRole(ctx, auth.accountId, workspaceId)
  if (role === null) {
    return sendError(res, 403, 'forbidden', `account is not a member of workspace ${workspaceId}`)
  }

  sendJson(res, 200, {
    install: install === null ? null : installJson(install, getInstallTools(store, install.id)),
    job: wrapJob(job),
  })
}

// ---- 升级 / 停用 / 启用 / 卸载 / 回滚 -----------------------------------------

export async function handlePluginInstallUpdate(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  if (!requireStore(ctx, res)) return

  const target = installPathFrom(url.pathname)
  if (target === null || target.action !== 'update') {
    return sendError(res, 404, 'not_found', 'malformed plugin update path')
  }

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const versionText = readText(parsed.value['version'], MAX_VERSION_CHARS)
  if (versionText === null) {
    return sendError(res, 400, 'invalid_body', 'version is required (non-empty string)')
  }

  const store = storeOf(ctx)
  const current = getInstall(store, target.id)
  if (current === null) {
    return sendError(res, 404, 'plugin.install_not_found', `unknown plugin install ${target.id}`)
  }
  const role = await workspaceRole(ctx, auth.accountId, current.workspaceId)
  if (role === null || (role !== 'owner' && role !== 'admin')) {
    return sendError(res, 403, 'forbidden', `workspace ${current.workspaceId} requires owner/admin role`)
  }
  const busy = busyJob(store, target.id)
  if (busy !== null) {
    return sendError(res, 409, 'plugin.job_pending', `plugin install ${target.id} is busy (${busy.state})`)
  }

  const plugin = getMarketPlugin(store, current.slug)
  if (plugin === null) return sendError(res, 404, 'plugin.not_found', `unknown plugin ${current.slug}`)
  const version = findVersion(store, current.slug, versionText)
  if (version === null) {
    return sendError(res, 404, 'plugin.version_not_found', `plugin ${current.slug} has no version ${versionText}`)
  }
  if (version.version === current.version) {
    return sendJson(res, 200, {
      install: installJson(current, getInstallTools(store, current.id)),
      job: wrapJob(latestJobForInstall(store, current.id)),
      unchanged: true,
    })
  }

  const preflight = runPreflight(ctx, plugin, version)
  if (!preflight.ok) return sendPreflightFailure(res, preflight)

  const at = ctx.now()
  const lock = profileLockFor(ctx, store, {
    workspaceId: current.workspaceId,
    at,
    extra: { slug: current.slug, version: version.version, integrity: version.integrity },
  })
  const job = createJob(store, {
    installId: current.id,
    workspaceId: current.workspaceId,
    slug: current.slug,
    version: version.version,
    state: 'preflight',
    lockJson: JSON.stringify(lock),
    snapshotJson: JSON.stringify(
      snapshotFor(
        current,
        'update',
        at,
        { installId: current.id, workspaceId: current.workspaceId, slug: current.slug },
        getInstallTools(store, current.id),
      ),
    ),
    permissionsJson: disclosureFor(preflight),
    at,
  })

  try {
    const approval = createApproval(store, {
      workspaceId: current.workspaceId,
      kind: PLUGIN_INSTALL_APPROVAL_KIND,
      requester: auth.accountId,
      requesterKind: 'user',
      payload: {
        jobId: job.id,
        installId: current.id,
        workspaceId: current.workspaceId,
        slug: current.slug,
        version: version.version,
        previousVersion: current.version,
        tier: preflight.tier,
        permissions: preflight.permissions,
        problems: preflight.problems,
        lock,
        command: installCommandFor(lock),
      },
      action: `升级插件 ${current.slug} ${current.version} → ${version.version}`,
      target: current.slug,
      consequence: disclosureText(preflight.permissions),
      at,
    })
    const awaiting = advanceJob(store, { id: job.id, event: 'request-approval', at })
    sendJson(res, 202, { job: jobJson(awaiting), approval: approvalJson(approval), installId: current.id })
  } catch (err) {
    deleteJob(store, job.id)
    sendInstallFailure(res, err)
  }
}

export async function handlePluginInstallDisable(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  await setEnabled(ctx, req, res, url, false)
}

export async function handlePluginInstallEnable(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  await setEnabled(ctx, req, res, url, true)
}

async function setEnabled(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  enabled: boolean,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  if (!requireStore(ctx, res)) return

  const target = installPathFrom(url.pathname)
  if (target === null || target.action !== (enabled ? 'enable' : 'disable')) {
    return sendError(res, 404, 'not_found', 'malformed plugin install path')
  }

  const store = storeOf(ctx)
  const current = getInstall(store, target.id)
  if (current === null) {
    return sendError(res, 404, 'plugin.install_not_found', `unknown plugin install ${target.id}`)
  }
  const role = await workspaceRole(ctx, auth.accountId, current.workspaceId)
  if (role === null || (role !== 'owner' && role !== 'admin')) {
    return sendError(res, 403, 'forbidden', `workspace ${current.workspaceId} requires owner/admin role`)
  }

  const at = ctx.now()
  try {
    const updated = updateInstall(store, { id: target.id, enabled, by: auth.accountId, at })
    // 作业状态跟着走（installed ⇄ disabled）；没有作业的历史安装行只翻 enabled。
    const job = latestJobForInstall(store, target.id)
    if (job !== null) {
      const event = enabled ? 'enable' : 'disable'
      const reachable = enabled ? job.state === 'disabled' : job.state === 'installed'
      if (reachable) advanceJob(store, { id: job.id, event, at })
    }
    sendJson(res, 200, { install: installJson(updated, getInstallTools(store, target.id)) })
  } catch (err) {
    sendInstallFailure(res, err)
  }
}

export async function handlePluginInstallUninstall(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  if (!requireStore(ctx, res)) return

  const target = installPathFrom(url.pathname)
  if (target === null || target.action !== 'uninstall') {
    return sendError(res, 404, 'not_found', 'malformed plugin uninstall path')
  }

  const store = storeOf(ctx)
  const current = getInstall(store, target.id)
  if (current === null) {
    return sendError(res, 404, 'plugin.install_not_found', `unknown plugin install ${target.id}`)
  }
  const role = await workspaceRole(ctx, auth.accountId, current.workspaceId)
  if (role === null || (role !== 'owner' && role !== 'admin')) {
    return sendError(res, 403, 'forbidden', `workspace ${current.workspaceId} requires owner/admin role`)
  }
  const busy = busyJob(store, target.id)
  if (busy !== null) {
    return sendError(res, 409, 'plugin.job_pending', `plugin install ${target.id} is busy (${busy.state})`)
  }

  const at = ctx.now()
  // 卸载后的锁：把这个插件从 profile 里去掉。
  const lock = profileLockFor(ctx, store, {
    workspaceId: current.workspaceId,
    at,
    extra: { slug: current.slug, version: current.version },
    excludeSlug: current.slug,
  })
  const job = createJob(store, {
    installId: current.id,
    workspaceId: current.workspaceId,
    slug: current.slug,
    version: current.version,
    // 卸载没有审批（owner/admin 直接动作），作业从「执行中」开始。
    state: 'installing',
    lockJson: JSON.stringify(lock),
    snapshotJson: JSON.stringify(
      snapshotFor(
        current,
        'uninstall',
        at,
        { installId: current.id, workspaceId: current.workspaceId, slug: current.slug },
        getInstallTools(store, current.id),
      ),
    ),
    permissionsJson: { action: 'uninstall' },
    at,
  })

  try {
    updateInstall(store, { id: current.id, state: 'disabling', by: auth.accountId, at })
    sendJson(res, 202, { job: jobJson(job) })
  } catch (err) {
    deleteJob(store, job.id)
    sendInstallFailure(res, err)
  }
}

export async function handlePluginInstallRollback(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireAuth(ctx, req, res)
  if (auth === null) return
  if (!requireStore(ctx, res)) return

  const target = installPathFrom(url.pathname)
  if (target === null || target.action !== 'rollback') {
    return sendError(res, 404, 'not_found', 'malformed plugin rollback path')
  }

  const store = storeOf(ctx)
  const jobs = listJobs(store, { installId: target.id })
  // 只回滚「有快照、且已经不在执行中」的作业：快照是安装/升级/卸载前抓的那一份。
  const candidate = [...jobs]
    .reverse()
    .find(
      (job) =>
        job.snapshotJson !== null &&
        (job.state === 'failed' || job.state === 'installed' || job.state === 'disabled' || job.state === 'installing'),
    )
  if (candidate === undefined) {
    return sendError(res, 404, 'plugin.job_not_found', `no rollback snapshot for plugin install ${target.id}`)
  }

  const role = await workspaceRole(ctx, auth.accountId, candidate.workspaceId)
  if (role === null || (role !== 'owner' && role !== 'admin')) {
    return sendError(res, 403, 'forbidden', `workspace ${candidate.workspaceId} requires owner/admin role`)
  }

  const snapshot = decodeSnapshot(candidate.snapshotJson)
  const at = ctx.now()
  try {
    // 回滚要应用的锁 = 快照里的旧锁；运行时按它同步，成功后才写回安装行。
    const rolling = advanceJob(store, {
      id: candidate.id,
      event: 'rollback',
      ...(snapshot?.lock === null || snapshot?.lock === undefined
        ? {}
        : { lockJson: JSON.stringify(snapshot.lock) }),
      at,
    })
    sendJson(res, 202, { job: jobJson(rolling) })
  } catch (err) {
    sendInstallFailure(res, err)
  }
}

// ---- 内部：沙箱 sync 回报 -----------------------------------------------------

export async function handlePluginInstallSynced(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (!authorizeRuntime(ctx, req, res)) return
  if (!requireStore(ctx, res)) return

  const installId = syncedInstallIdFrom(url.pathname)
  if (installId === null) return sendError(res, 404, 'not_found', 'malformed plugin synced path')

  const parsed = await readJsonBody(req)
  if (!parsed.ok) return sendError(res, parsed.status, parsed.code, parsed.message)
  if (!isPlainObject(parsed.value)) {
    return sendError(res, 400, 'invalid_body', 'request body must be a JSON object')
  }
  const body = parsed.value
  if (typeof body['ok'] !== 'boolean') {
    return sendError(res, 400, 'invalid_body', 'ok is required (boolean)')
  }

  const store = storeOf(ctx)
  const job = latestJobForInstall(store, installId)
  if (job === null) {
    return sendError(res, 404, 'plugin.job_not_found', `unknown plugin install job for ${installId}`)
  }

  const at = ctx.now()
  const ok = body['ok']
  const errorText = readText(body['error'], 2000)
  // panels 目前没有归属列：冒烟的面板数由运行时自己核对 manifest（5.2.4），这里只收下不落库。
  void body['panels']

  try {
    if (ok) {
      if (job.state === 'rolling-back') {
        const restored = restoreSnapshot(store, job, at)
        const done = advanceJob(store, { id: job.id, event: 'rollback-ok', at })
        return sendJson(res, 200, {
          job: jobJson(done),
          install: restored === null ? null : installJson(restored, getInstallTools(store, restored.id)),
        })
      }
      if (job.state === 'installed' || job.state === 'rolled-back') {
        // 重复投递（sync-ok / rollback-ok 已经落过）：幂等返回，不改任何行。
        const install = getInstall(store, job.installId)
        return sendJson(res, 200, {
          job: jobJson(job),
          install: install === null ? null : installJson(install, getInstallTools(store, install.id)),
        })
      }
      if (job.state !== 'installing') {
        return sendError(res, 409, 'plugin.job_state', `job ${job.id} is ${job.state}, not installing`)
      }

      const snapshot = decodeSnapshot(job.snapshotJson)
      if (snapshot !== null && snapshot.action === 'uninstall') {
        // 卸载成功：安装行删掉（plugin.uninstall 事件），作业以 installed=同步成功收尾。
        const existed = getInstall(store, job.installId) !== null
        if (existed) deleteInstall(store, { id: job.installId, by: 'system', at })
        const done = advanceJob(store, { id: job.id, event: 'sync-ok', at })
        return sendJson(res, 200, { job: jobJson(done), install: null })
      }

      if (getInstall(store, job.installId) === null) {
        return sendError(res, 409, 'plugin.install_not_found', `install row ${job.installId} is missing`)
      }
      // 5.1.7：工具来源写进安装行（[{name, source}]，source 默认插件 slug）。
      const tools = setInstallTools(store, job.installId, body['tools'] ?? [], { source: job.slug })
      const installed = updateInstall(store, {
        id: job.installId,
        state: 'installed',
        by: 'system',
        at,
      })
      const done = advanceJob(store, { id: job.id, event: 'sync-ok', at })
      return sendJson(res, 200, { job: jobJson(done), install: installJson(installed, tools) })
    }

    // 失败路径
    if (job.state === 'failed') {
      const install = getInstall(store, job.installId)
      return sendJson(res, 200, {
        job: jobJson(job),
        install: install === null ? null : installJson(install, getInstallTools(store, install.id)),
      })
    }
    if (job.state !== 'installing' && job.state !== 'rolling-back') {
      return sendError(res, 409, 'plugin.job_state', `job ${job.id} is ${job.state}, not installing`)
    }
    const message = errorText ?? 'runtime sync failed'
    if (getInstall(store, job.installId) !== null) {
      updateInstall(store, { id: job.installId, state: 'failed', by: 'system', at })
    }
    const failed = advanceJob(store, {
      id: job.id,
      event: job.state === 'rolling-back' ? 'rollback-fail' : 'sync-fail',
      error: message,
      at,
    })
    const install = getInstall(store, job.installId)
    sendJson(res, 200, {
      job: jobJson(failed),
      install: install === null ? null : installJson(install, getInstallTools(store, install.id)),
    })
  } catch (err) {
    sendInstallFailure(res, err)
  }
}

// ---- 快照 --------------------------------------------------------------------

interface SnapshotInstallRow {
  version: string
  enabled: boolean
  lock: string
  preflight: Record<string, unknown> | null
  state: string
  /** 旧版本的工具来源（5.1.7）；回滚时一并写回，避免版本回退而工具列表还是新的。 */
  tools: { name: string; source: string }[]
}

interface SnapshotDocument {
  kind: 'roost.plugin-install-snapshot'
  version: 1
  at: number
  action: 'install' | 'update' | 'uninstall'
  installId: string | null
  workspaceId: string
  slug: string
  /** 安装前那一行；全新安装（之前没装过）为 null。 */
  install: SnapshotInstallRow | null
  /** 安装前的 profile 锁文档；全新安装为 null。 */
  lock: unknown | null
}

function snapshotFor(
  install: PluginInstall | null,
  action: SnapshotDocument['action'],
  at: number,
  identity: { installId: string | null; workspaceId: string; slug: string },
  tools: { name: string; source: string }[] = [],
): SnapshotDocument {
  let previousLock: unknown = null
  if (install !== null) {
    try {
      previousLock = JSON.parse(install.lock) as unknown
    } catch {
      previousLock = install.lock
    }
  }
  return {
    kind: 'roost.plugin-install-snapshot',
    version: 1,
    at,
    action,
    installId: identity.installId,
    workspaceId: identity.workspaceId,
    slug: identity.slug,
    install:
      install === null
        ? null
        : {
            version: install.version,
            enabled: install.enabled,
            lock: install.lock,
            preflight: install.preflight,
            state: install.state,
            tools,
          },
    lock: previousLock,
  }
}

function decodeSnapshot(raw: string | null): SnapshotDocument | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const doc = parsed as Record<string, unknown>
  if (doc['kind'] !== 'roost.plugin-install-snapshot') return null
  const action = doc['action']
  if (action !== 'install' && action !== 'update' && action !== 'uninstall') return null
  if (typeof doc['workspaceId'] !== 'string' || typeof doc['slug'] !== 'string') return null
  const install = doc['install']
  const row =
    typeof install === 'object' && install !== null && !Array.isArray(install)
      ? (install as Record<string, unknown>)
      : null
  const parsedRow: SnapshotInstallRow | null =
    row === null
      ? null
      : {
          version: typeof row['version'] === 'string' ? row['version'] : '',
          enabled: row['enabled'] === true,
          lock: typeof row['lock'] === 'string' ? row['lock'] : '{}',
          preflight:
            typeof row['preflight'] === 'object' && row['preflight'] !== null && !Array.isArray(row['preflight'])
              ? (row['preflight'] as Record<string, unknown>)
              : null,
          state: typeof row['state'] === 'string' ? row['state'] : 'installing',
          tools: Array.isArray(row['tools'])
            ? row['tools']
                .filter(
                  (tool): tool is { name: string; source: string } =>
                    typeof tool === 'object' &&
                    tool !== null &&
                    typeof (tool as Record<string, unknown>)['name'] === 'string' &&
                    typeof (tool as Record<string, unknown>)['source'] === 'string',
                )
                .map((tool) => ({ name: tool.name, source: tool.source }))
            : [],
        }
  if (parsedRow !== null && parsedRow.version === '') return null
  return {
    kind: 'roost.plugin-install-snapshot',
    version: 1,
    at: typeof doc['at'] === 'number' ? doc['at'] : 0,
    action,
    installId: typeof doc['installId'] === 'string' ? doc['installId'] : null,
    workspaceId: doc['workspaceId'],
    slug: doc['slug'],
    install: parsedRow,
    lock: doc['lock'] ?? null,
  }
}

/**
 * 回滚落地：把快照写回安装行。
 *   * 有旧行 → 恢复版本/锁/enabled/state（升级回滚）；
 *   * 旧行是 null（全新安装）→ 删掉安装行，回到「没装过」。
 * 返回恢复后的安装行；删掉/没有时返回 null。
 */
function restoreSnapshot(store: Store, job: PluginInstallJob, at: number): PluginInstall | null {
  const snapshot = decodeSnapshot(job.snapshotJson)
  if (snapshot === null) return null
  const existing = getInstall(store, job.installId)
  if (snapshot.install === null) {
    if (existing !== null) deleteInstall(store, { id: job.installId, by: 'system', at })
    return null
  }
  if (existing === null) {
    // 安装行没了（例如卸载成功后才回滚）：按快照重建，保持「回到旧版本」的语义。
    const recreated = createInstall(store, {
      id: job.installId,
      workspaceId: job.workspaceId,
      slug: job.slug,
      version: snapshot.install.version,
      enabled: snapshot.install.enabled,
      lock: snapshot.install.lock,
      installedBy: 'system',
      installedAt: at,
      preflight: snapshot.install.preflight,
      state: snapshot.install.state as PluginInstall['state'],
    })
    setInstallTools(store, recreated.id, snapshot.install.tools, { source: job.slug })
    return recreated
  }
  const restored = updateInstall(store, {
    id: job.installId,
    version: snapshot.install.version,
    enabled: snapshot.install.enabled,
    lock: snapshot.install.lock,
    preflight: snapshot.install.preflight,
    state: snapshot.install.state as PluginInstall['state'],
    by: 'system',
    at,
  })
  setInstallTools(store, restored.id, snapshot.install.tools, { source: job.slug })
  return restored
}

// ---- profile 锁 --------------------------------------------------------------

function profileLockFor(
  ctx: Ctx,
  store: Store,
  input: {
    workspaceId: string
    at: number
    extra: { slug: string; version: string; integrity?: string | null }
    excludeSlug?: string
  },
): ProfileLock {
  const plugins: { slug: string; version: string; integrity: string | null }[] = []
  for (const install of listInstalls(store, input.workspaceId)) {
    if (install.slug === input.extra.slug) continue
    if (install.slug === input.excludeSlug) continue
    plugins.push({
      slug: install.slug,
      version: install.version,
      integrity: integrityFor(store, install.slug, install.version),
    })
  }
  if (input.excludeSlug === undefined) {
    plugins.push({
      slug: input.extra.slug,
      version: input.extra.version,
      integrity: input.extra.integrity ?? null,
    })
  }
  const inputs = buildProfileLockInputs({
    dshVersion: ctx.dshVersion ?? DEFAULT_DSH_VERSION,
    baseBundles: ctx.baseBundles ?? [],
    plugins,
  })
  return assembleProfileLock({
    source: 'marketplace',
    packageJson: inputs.packageJson,
    patch: inputs.patchRows.join('\n'),
    lockfile: inputs.lockfile,
    generatedAt: input.at,
  })
}

function integrityFor(store: Store, slug: string, version: string): string | null {
  return listVersions(store, slug).find((entry) => entry.version === version)?.integrity ?? null
}

// ---- 预检 --------------------------------------------------------------------

function runPreflight(
  ctx: Ctx,
  plugin: { slug: string; publisherId: string },
  version: PluginVersion,
): InstallPreflightResult {
  return preflightInstall({
    plugin: { slug: plugin.slug, publisherId: plugin.publisherId },
    version: {
      version: version.version,
      integrity: version.integrity,
      engines: version.engines,
      manifest: version.manifest,
      permissions: version.permissions,
      publishedAt: version.publishedAt,
      // 市场 manifest 里可以带 provenance/attestations；没有就是 none（warning）。
      signature: version.manifest,
    },
    dshVersion: ctx.dshVersion ?? DEFAULT_DSH_VERSION,
    allowlist: allowlistOf(ctx),
    minReleaseAgeMs: minReleaseAgeOf(ctx),
    now: ctx.now(),
  })
}

/**
 * 409 plugin.preflight。契约的错误体是 `{ok:false,error:{code,message}}`；
 * 这里只在 error 里**追加** problems/tier/permissions，让市场详情页直接列出阻断项
 * （apps/web/lib/installs.js 的 preflightFromError 读 error.problems），
 * 不想解析细节的客户端仍然只看 code/message。
 */
function sendPreflightFailure(res: ServerResponse, result: InstallPreflightResult): void {
  sendJson(res, 409, {
    ok: false,
    error: {
      code: 'plugin.preflight',
      message: blockingSummary(result),
      tier: result.tier,
      problems: result.problems,
      permissions: result.permissions,
    },
  })
}

function blockingSummary(result: InstallPreflightResult): string {
  const blocking = result.problems.filter((problem) => problem.severity === 'blocking')
  const rendered = blocking.map((problem) => `${problem.code} (${problem.detail})`).join('; ')
  return `plugin preflight failed (tier ${result.tier}): ${rendered === '' ? 'unknown problem' : rendered}`
}

function disclosureFor(result: InstallPreflightResult): Record<string, unknown> {
  return {
    tier: result.tier,
    tierLabel: tierLabel(result.tier),
    permissions: result.permissions,
    problems: result.problems,
  }
}

function disclosureText(permissions: PluginCapabilities): string {
  const parts: string[] = []
  if (permissions.tools !== undefined && permissions.tools > 0) parts.push(`${permissions.tools} 个工具`)
  if (permissions.skills !== undefined && permissions.skills > 0) parts.push(`${permissions.skills} 个技能`)
  if (permissions.panels !== undefined && permissions.panels > 0) parts.push(`${permissions.panels} 个面板`)
  if (permissions.network !== undefined && permissions.network.length > 0) {
    parts.push(`网络 ${permissions.network.join(', ')}`)
  }
  if (permissions.credentials !== undefined && permissions.credentials.length > 0) {
    parts.push(`凭据 ${permissions.credentials.join(', ')}`)
  }
  if (permissions.diskBytes !== undefined && permissions.diskBytes > 0) {
    parts.push(`磁盘 ${Math.ceil(permissions.diskBytes / 1e6)}MB`)
  }
  if (permissions.dataMounts !== undefined && permissions.dataMounts.length > 0) {
    parts.push(`只读数据 ${permissions.dataMounts.join(', ')}`)
  }
  if (permissions.binaries !== undefined && permissions.binaries.length > 0) {
    parts.push(`可执行文件 ${permissions.binaries.join(', ')}`)
  }
  return parts.length === 0 ? '该插件未声明额外权限' : `将获得：${parts.join('；')}`
}

// ---- 序列化 ------------------------------------------------------------------

function installJson(install: PluginInstall, tools: { name: string; source: string }[]): Record<string, unknown> {
  return {
    id: install.id,
    workspaceId: install.workspaceId,
    slug: install.slug,
    version: install.version,
    enabled: install.enabled,
    lock: decodeJsonOrRaw(install.lock),
    installedBy: install.installedBy,
    installedAt: install.installedAt,
    preflight: install.preflight,
    state: install.state,
    tools,
  }
}

function jobJson(job: PluginInstallJob): Record<string, unknown> {
  const lock = decodeJsonOrRawOrNull(job.lockJson)
  return {
    id: job.id,
    installId: job.installId,
    workspaceId: job.workspaceId,
    slug: job.slug,
    version: job.version,
    state: job.state,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    permissions: job.permissionsJson,
    lock,
    lockId: lockObjectField(lock, 'id'),
    lockIntegrity: lockObjectField(lock, 'integrity'),
    snapshot: decodeJsonOrRawOrNull(job.snapshotJson),
    hasSnapshot: job.snapshotJson !== null,
    command: installCommandFor(lock),
  }
}

/** 列表里的作业只要进度，不要整份锁/快照（列表可能一次十几条）。 */
function jobSummary(job: PluginInstallJob | null): Record<string, unknown> | null {
  if (job === null) return null
  const json = jobJson(job)
  delete json['lock']
  delete json['snapshot']
  delete json['permissions']
  return json
}

function wrapJob(job: PluginInstallJob | null): Record<string, unknown> | null {
  return job === null ? null : jobJson(job)
}

function wrapApproval(approval: Approval | null): Record<string, unknown> | null {
  return approval === null ? null : approvalJson(approval)
}

function pendingApprovalForJob(store: Store, workspaceId: string, jobId: string): Approval | null {
  for (const approval of listApprovals(store, workspaceId, 'pending')) {
    if (approval.kind !== PLUGIN_INSTALL_APPROVAL_KIND) continue
    if (approval.payload['jobId'] === jobId) return approval
  }
  return null
}

/** 还在执行的作业（同一安装行不允许并发操作）。 */
function busyJob(store: Store, installId: string): PluginInstallJob | null {
  const job = latestJobForInstall(store, installId)
  if (job === null) return null
  return job.state === 'preflight' || job.state === 'awaiting-approval' || job.state === 'installing' || job.state === 'rolling-back'
    ? job
    : null
}

function lockObjectField(lock: unknown, key: string): string | null {
  if (typeof lock !== 'object' || lock === null || Array.isArray(lock)) return null
  const value = (lock as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

function decodeJsonOrRawOrNull(raw: string | null): unknown {
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function decodeJsonOrRaw(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

// ---- 鉴权 / 路径 / 输入 -----------------------------------------------------

async function requireAuth(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<SessionRecord | null> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
    return null
  }
  return auth.session
}

function requireStore(ctx: Ctx, res: ServerResponse): boolean {
  if (ctx.rawStore !== undefined) return true
  sendError(res, 503, 'runtime.not_configured', 'plugin installs need the SQLite store')
  return false
}

function storeOf(ctx: Ctx): Store {
  const store = ctx.rawStore
  if (store === undefined) throw new Error('plugin install store is not configured')
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

function allowlistOf(ctx: Ctx): string | readonly string[] {
  if (ctx.allowlist !== undefined) return ctx.allowlist ?? ''
  return process.env.ROOST_PLUGIN_ALLOWLIST ?? ''
}

function minReleaseAgeOf(ctx: Ctx): number {
  if (typeof ctx.minReleaseAgeMs === 'number' && Number.isFinite(ctx.minReleaseAgeMs)) {
    return ctx.minReleaseAgeMs
  }
  const raw = process.env.ROOST_PLUGIN_MIN_RELEASE_AGE_MS
  if (raw === undefined || raw.trim() === '') return DEFAULT_MIN_RELEASE_AGE_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_RELEASE_AGE_MS
}

/** `/api/marketplace/plugins/:slug/install` */
function slugFromInstallPath(pathname: string): string | null {
  const match = /^\/api\/marketplace\/plugins\/([^/]+)\/install\/?$/.exec(pathname)
  if (match === null) return null
  let slug: string
  try {
    slug = decodeURIComponent(match[1]!)
  } catch {
    return null
  }
  return isPluginSlug(slug) ? slug : null
}

/** `/api/plugin-installs/:id` 或 `/api/plugin-installs/:id/:action` */
function installPathFrom(pathname: string): { id: string; action: string | null } | null {
  const match = /^\/api\/plugin-installs\/([^/]+)(?:\/(update|disable|enable|uninstall|rollback))?\/?$/.exec(
    pathname,
  )
  if (match === null) return null
  let id: string
  try {
    id = decodeURIComponent(match[1]!)
  } catch {
    return null
  }
  if (id === '' || id.length > MAX_ID_CHARS) return null
  return { id, action: match[2] ?? null }
}

/** `/api/internal/plugin-installs/:id/synced` */
function syncedInstallIdFrom(pathname: string): string | null {
  const match = /^\/api\/internal\/plugin-installs\/([^/]+)\/synced\/?$/.exec(pathname)
  if (match === null) return null
  let id: string
  try {
    id = decodeURIComponent(match[1]!)
  } catch {
    return null
  }
  return id === '' || id.length > MAX_ID_CHARS ? null : id
}

// ---- runtime token ----------------------------------------------------------

function runtimeTokenOf(ctx: Ctx): string {
  if (ctx.runtimeToken !== undefined) return ctx.runtimeToken
  return process.env.ROOST_RUNTIME_TOKEN ?? ''
}

function runtimeTokenFrom(req: IncomingMessage): string | null {
  const header = (req.headers['x-runtime-token'] ?? '').toString()
  if (header !== '') return header
  const auth = (req.headers.authorization ?? '').trim()
  const match = /^Runtime[ ]+(\S+)$/.exec(auth)
  return match === null ? null : match[1]!
}

/** 未配置 = 404（不暴露内部接口）；错 token = 401。 */
function authorizeRuntime(ctx: Ctx, req: IncomingMessage, res: ServerResponse): boolean {
  const expected = runtimeTokenOf(ctx)
  if (expected === '') {
    sendError(res, 404, 'not_found', 'internal api is disabled')
    return false
  }
  const token = runtimeTokenFrom(req)
  if (token === null || token !== expected) {
    sendError(res, 401, 'unauthenticated', 'runtime token required')
    return false
  }
  return true
}

// ---- 错误映射 ----------------------------------------------------------------

function sendInstallFailure(res: ServerResponse, err: unknown): void {
  if (err instanceof StoreError) {
    switch (storeErrorTag(err)) {
      case JOB_ERROR_CODES.notFound:
        return sendError(res, 404, 'plugin.job_not_found', err.message)
      case JOB_ERROR_CODES.illegalTransition:
        return sendError(res, 409, 'plugin.job_state', err.message)
      case JOB_ERROR_CODES.invalid:
        return sendError(res, 400, 'plugin.job_invalid', err.message)
      case MARKETPLACE_ERROR_CODES.installNotFound:
        return sendError(res, 404, 'plugin.install_not_found', err.message)
      case MARKETPLACE_ERROR_CODES.installExists:
        return sendError(res, 409, 'plugin.already_installed', err.message)
      case MARKETPLACE_ERROR_CODES.invalidSlug:
        return sendError(res, 400, 'plugin.invalid_slug', err.message)
      default:
        break
    }
    if (err.code === 'WORKSPACE_NOT_FOUND') {
      return sendError(res, 404, 'workspace_not_found', err.message)
    }
  }
  console.error('roost api: plugin install store failure', err)
  sendError(res, 500, 'internal_error', 'plugin install store failure')
}
