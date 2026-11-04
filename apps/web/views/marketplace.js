// 插件市场详情（#/plugins/:slug，docs/build/wave1.md §B/§D、plugin-marketplace.md §7）。
//
// 安装流程按 wave 1 契约：
//   点击「安装」→ POST /api/marketplace/plugins/:slug/install {version}
//     · 409 plugin.preflight → 显示 problems + 权限清单，不安装
//     · 202 {job, approval?} → 等待批准 / 启动轮询
//     · 200 {install}        → 只显示接口给的 state
//   之后 GET /api/plugin-installs/:id 轮询 2s，最多 60s，页面隐藏时暂停。
//
// 详情载入的 404/403/503 降级沿用现有插件页；所有服务端文本只进 textContent。

import { isAuthError, isMissingRoute } from '../lib/api-client.js'
import { card } from '../lib/components.js'
import { el } from '../lib/dom.js'
import {
  installApprovalHref,
  installDetailPath,
  installIdFromResponse,
  installJobError,
  installResponsePlan,
  installStateBadge,
  installStateKind,
  isInstallTerminal,
  permissionDisclosure,
  pollDecision,
  preflightFromError,
  INSTALL_POLL_INTERVAL_MS,
  INSTALL_POLL_MAX_MS,
} from '../lib/installs.js'
import * as ui from '../lib/ui.js'
import {
  isPluginForbidden,
  isPluginNotReady,
  pluginForbiddenMessage,
  pluginIcon,
  pluginNotReadyState,
  pluginScreenshots,
  pluginStatusDetail,
  pluginTierPill,
} from './plugin-kit.js'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function permissionList(source) {
  const dl = el('dl', { class: 'need-meta plugin-perm-list' })
  for (const row of permissionDisclosure(source)) {
    const item = el('div')
    item.append(el('dt', { text: row.label }))
    item.append(el('dd', { class: row.missing ? 'muted' : '', text: row.text }))
    dl.append(item)
  }
  return dl
}

function problemsBox(preflight) {
  const box = el('div', { class: 'plugin-preflight-result' })
  box.append(el('h3', { class: 'plugin-subtitle', text: `预检未通过（409 · plugin.preflight）` }))
  if (preflight.problems.length === 0) {
    box.append(el('p', { class: 'section-desc', text: '服务端没有给出具体 problems；这次没有安装任何东西。' }))
  } else {
    const list = el('ul', { class: 'plugin-problem-list' })
    for (const problem of preflight.problems) {
      list.append(el('li', { text: problem.detail === '' ? problem.code : `${problem.code}：${problem.detail}` }))
    }
    box.append(list)
  }
  if (preflight.permissions !== null) {
    box.append(el('h3', { class: 'plugin-subtitle', text: '预检确认的权限' }))
    box.append(permissionList({ permissions: preflight.permissions }))
  }
  return box
}

export async function mountMarketplacePage(root, ctx, slug) {
  const safeSlug = typeof slug === 'string' ? slug.trim() : ''
  root.replaceChildren(ui.loading('正在载入插件…'))
  if (safeSlug === '') {
    root.replaceChildren(
      ui.pageHeader('插件详情', { back: { href: '#/plugins', label: '插件市场' } }),
      ui.errorState({
        title: '找不到这个插件',
        message: '地址里没有插件 slug。',
        onRetry: () => void mountMarketplacePage(root, ctx, safeSlug),
      })
    )
    return
  }

  let data
  try {
    data = await ctx.api.get(`/api/marketplace/plugins/${encodeURIComponent(safeSlug)}`)
  } catch (error) {
    if (isAuthError(error)) {
      ctx.requirePair()
      return
    }
    if (isPluginNotReady(error)) {
      root.replaceChildren(
        ui.pageHeader('插件详情', { back: { href: '#/plugins', label: '插件市场' } }),
        pluginNotReadyState({
          error,
          retry: () => void mountMarketplacePage(root, ctx, safeSlug),
          backHref: '#/plugins',
        })
      )
      return
    }
    if (isPluginForbidden(error)) {
      root.replaceChildren(
        ui.pageHeader('插件详情', { back: { href: '#/plugins', label: '插件市场' } }),
        ui.emptyState({
          title: pluginForbiddenMessage(error, 'view'),
          body: '插件详情按工作区隔离；当前账号不是这个工作区的成员。',
          action: ui.button('重试', { variant: 'ghost', onClick: () => void mountMarketplacePage(root, ctx, safeSlug) }),
          secondary: ui.linkButton('回插件市场', '#/plugins', { variant: 'ghost' }),
        })
      )
      return
    }
    const notFound = error && error.code === 'plugin.not_found'
    root.replaceChildren(
      ui.pageHeader('插件详情', { back: { href: '#/plugins', label: '插件市场' } }),
      ui.errorState({
        error,
        title: notFound ? '找不到这个插件' : undefined,
        message: notFound
          ? `市场里没有 slug 为 ${safeSlug} 的插件。`
          : `插件详情载入失败：${error instanceof Error ? error.message : String(error)}`,
        onRetry: () => void mountMarketplacePage(root, ctx, safeSlug),
        onPair: typeof ctx.hasToken === 'function' && ctx.hasToken() ? undefined : true,
      })
    )
    return
  }

  const plugin = data && isObject(data.plugin) ? data.plugin : null
  if (plugin === null) {
    root.replaceChildren(
      ui.pageHeader('插件详情', { back: { href: '#/plugins', label: '插件市场' } }),
      ui.errorState({ title: '详情不完整', message: '接口没有返回 plugin 字段。' })
    )
    return
  }
  const versions = (Array.isArray(data?.versions) ? data.versions : []).filter(isObject)
  root.replaceChildren(detailView(ctx, root, safeSlug, plugin, versions))
  const main = root.closest('main')
  if (main) main.focus()
}

function detailView(ctx, root, slug, plugin, versions) {
  const latest = text(plugin.latest)
  let selectedVersion = versions.some((version) => version.version === latest)
    ? latest
    : text(versions[0]?.version)
  let installing = false
  let poll = { id: '', timer: null, startedAt: 0, state: '' }

  const title = text(plugin.title) || slug
  const publisher = isObject(plugin.publisher) ? plugin.publisher : null
  const publisherName =
    (publisher && text(publisher.name)) ||
    text(plugin.publisherId) ||
    '未知发布者'
  const verified = publisher !== null && publisher.verified === true

  const header = ui.pageHeader(title, {
    back: { href: '#/plugins', label: '插件市场' },
    subtitle: [publisherName, text(plugin.category) ? `分类 ${plugin.category}` : '', latest ? `最新 ${latest}` : '']
      .filter(Boolean)
      .join(' · '),
  })

  const hero = card({ className: 'plugin-hero' })
  const heroTop = el('div', { class: 'plugin-hero-top' })
  heroTop.append(pluginIcon(plugin, 'is-large'))
  const heroMain = el('div', { class: 'plugin-hero-main' })
  const badges = el('div', { class: 'plugin-badges' })
  let tierPill = pluginTierPill(plugin.tier, plugin.tierLabel)
  let enginesPill = ui.badge(
    text(plugin.engines) !== '' ? `DSH ${plugin.engines}` : 'DSH 版本未知'
  )
  badges.append(
    tierPill,
    enginesPill,
    ui.badge(verified ? '已验证发布者' : '未验证发布者', verified ? 'ok' : 'warn')
  )
  heroMain.append(badges)
  if (text(plugin.summary) !== '') heroMain.append(el('p', { class: 'plugin-summary', text: plugin.summary }))
  heroTop.append(heroMain)
  hero.append(heroTop)
  const shots = pluginScreenshots(plugin.screenshots)
  if (shots !== null) hero.append(shots)

  const selectedData = () => versions.find((version) => version.version === selectedVersion) || null
  const permissionSource = () => {
    const version = selectedData()
    return {
      permissions: (version && version.permissions) || plugin.permissions,
      requirements: (version && version.requirements) || plugin.requirements,
    }
  }
  const permissionBody = el('div', { class: 'plugin-perm-body' })
  function refreshPermissions() {
    permissionBody.replaceChildren(permissionList(permissionSource()))
  }

  const versionSelect = ui.select({
    id: 'plugin-version',
    ariaLabel: '选择插件版本',
    options:
      versions.length === 0
        ? [{ value: '', label: '（没有可用版本）' }]
        : versions.map((version) => ({
            value: version.version,
            label: `${version.version}${version.tier ? ` · ${version.tier} 级` : ''}`,
          })),
    value: selectedVersion,
    disabled: versions.length === 0,
  })
  const installButton = ui.button('安装', {
    variant: 'primary',
    disabled: versions.length === 0,
    onClick: () => void startInstall(),
  })
  const refreshButton = ui.button('刷新状态', {
    variant: 'ghost',
    disabled: true,
    onClick: () => {
      if (poll.id === '') return
      // 手动刷新重新计时，避免 60s 上限后永远只能看旧状态。
      poll.startedAt = Date.now()
      if (poll.timer !== null) clearTimeout(poll.timer)
      poll.timer = null
      refreshButton.disabled = true
      void tickPolling()
    },
  })
  const installStatus = ui.statusLine('')
  const installExtra = el('div', { class: 'plugin-install-extra' })
  const problemHost = el('div', { class: 'plugin-preflight' })
  const installHint = el('p', {
    class: 'field-hint',
    text:
      versions.length === 0
        ? '这个插件没有可用版本，不能安装。'
        : '点击安装直接调 POST install；预检问题会以 409 plugin.preflight 返回并显示在这里。',
  })

  const versionSection = ui.section(
    '安装',
    [
      el('div', { class: 'plugin-version-row' }, [versionSelect, installButton, refreshButton]),
      installHint,
      installStatus,
      installExtra,
      problemHost,
    ],
    { description: '安装由控制面执行；这里只显示接口给出的 state，不把“已排队”说成“已安装”。' }
  )

  function refreshBadges() {
    const version = selectedData()
    const tier = (version && version.tier) || plugin.tier
    const tierLabel = (version && version.tierLabel) || plugin.tierLabel
    const engines = text(version && version.engines) || text(plugin.engines)
    const nextTier = pluginTierPill(tier, tierLabel)
    const nextEngines = ui.badge(engines !== '' ? `DSH ${engines}` : 'DSH 版本未知')
    tierPill.replaceWith(nextTier)
    enginesPill.replaceWith(nextEngines)
    tierPill = nextTier
    enginesPill = nextEngines
  }

  versionSelect.addEventListener('change', () => {
    selectedVersion = versionSelect.value
    refreshPermissions()
    refreshBadges()
    stopPolling()
    ui.setStatus(installStatus, '')
    installExtra.replaceChildren()
    problemHost.replaceChildren()
    installHint.textContent = '版本已切换；安装时会由服务端重新预检。'
  })

  function stopPolling() {
    if (poll.timer !== null) clearTimeout(poll.timer)
    poll = { id: '', timer: null, startedAt: 0, state: '' }
    refreshButton.disabled = true
  }

  function schedulePolling() {
    if (poll.id === '') return
    if (typeof document !== 'undefined' && document.hidden) return
    if (!root.isConnected) {
      stopPolling()
      return
    }
    const decision = pollDecision({
      visible: true,
      startedAt: poll.startedAt,
      now: Date.now(),
      state: poll.state,
    })
    if (decision === 'stop') {
      if (poll.timer !== null) clearTimeout(poll.timer)
      poll.timer = null
      refreshButton.disabled = false
      ui.setStatus(
        installStatus,
        `已停止自动刷新（上限 ${Math.round(INSTALL_POLL_MAX_MS / 1000)}s 或任务已结束）；可点「刷新状态」查看最新进度。`
      )
      return
    }
    poll.timer = setTimeout(() => void tickPolling(), INSTALL_POLL_INTERVAL_MS)
  }

  function startPolling(installId, initialState) {
    stopPolling()
    if (installId === '') return
    poll = { id: installId, timer: null, startedAt: Date.now(), state: text(initialState) }
    refreshButton.disabled = false
    schedulePolling()
  }

  function renderJob(job, install) {
    const state = text(job?.state) || text(install?.state)
    installExtra.replaceChildren()
    if (state !== '') {
      const line = el('p', { class: 'plugin-install-note' })
      line.append(ui.badge(installStateBadge(state), installStateKind(state)))
      installExtra.append(line)
    }
    if (state === 'awaiting-approval') {
      const line = el('p', { class: 'plugin-install-note' })
      line.append(el('span', { text: '等待批准：批准后才会继续安装。' }), el('a', { href: installApprovalHref(), text: '去「需要你」' }))
      installExtra.append(line)
      ui.setStatus(installStatus, '安装任务已创建，正在等待批准（awaiting-approval）。')
      return
    }
    if (state === 'installed') {
      ui.setStatus(installStatus, '已安装（state=installed）。')
      return
    }
    if (state === 'failed') {
      const detail = installJobError(job)
      ui.setStatus(installStatus, `安装失败（state=failed）${detail === '' ? '' : `：${detail}`}`, 'error')
      const rollback = ui.button('回滚', {
        variant: 'ghost',
        onClick: () => void runRollback(install),
      })
      installExtra.append(el('div', { class: 'plugin-confirm-actions' }, [rollback]))
      return
    }
    if (state === 'rolling-back' || state === 'rolled-back') {
      ui.setStatus(installStatus, `回滚状态：${state}。`)
      return
    }
    if (state !== '') ui.setStatus(installStatus, `安装进行中（state=${state}）…`)
  }

  async function tickPolling() {
    if (poll.id === '') return
    if (typeof document !== 'undefined' && document.hidden) return
    if (!root.isConnected) {
      stopPolling()
      return
    }
    try {
      const data = await ctx.api.get(installDetailPath(poll.id))
      const install = data && isObject(data.install) ? data.install : null
      const job = data && isObject(data.job) ? data.job : null
      const state = text(job?.state) || text(install?.state) || poll.state
      poll.state = state
      renderJob(job, install)
      if (isInstallTerminal(state)) {
        if (poll.timer !== null) clearTimeout(poll.timer)
        poll.timer = null
        refreshButton.disabled = true
        return
      }
      schedulePolling()
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      ui.setStatus(installStatus, `进度查询失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error')
      if (poll.timer !== null) clearTimeout(poll.timer)
      poll.timer = null
      refreshButton.disabled = false
    }
  }

  async function runRollback(install) {
    const id = text(install?.id) || poll.id
    const path = `/api/plugin-installs/${encodeURIComponent(id)}/rollback`
    ui.setStatus(installStatus, '回滚中…')
    try {
      const result = await ctx.api.post(path)
      const plan = installResponsePlan(result)
      const nextId = installIdFromResponse(result) || id
      if (plan.kind === 'job') {
        ui.setStatus(installStatus, '回滚任务已创建，等待沙箱同步。')
        startPolling(nextId, plan.job.state)
      } else {
        ui.setStatus(installStatus, '回滚请求已返回；界面只显示接口给的 state。')
        startPolling(nextId, '')
      }
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      ui.setStatus(installStatus, `回滚失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error')
    }
  }

  async function startInstall() {
    if (installing || selectedVersion === '') return
    installing = true
    ui.setStatus(installStatus, '')
    installExtra.replaceChildren()
    problemHost.replaceChildren()
    ui.setBusy(installButton, true, '安装中…')
    try {
      // wave 1 契约只要 {version}；旧控制面还要求 workspaceId。多带一个字段不影响新接口。
      const body = { version: selectedVersion }
      try {
        const workspaceId = await ctx.ensureWorkspaceId()
        if (typeof workspaceId === 'string' && workspaceId !== '') body.workspaceId = workspaceId
      } catch (cause) {
        if (isAuthError(cause)) {
          ctx.requirePair()
          return
        }
      }
      const result = await ctx.api.post(
        `/api/marketplace/plugins/${encodeURIComponent(slug)}/install`,
        body
      )
      const plan = installResponsePlan(result)
      if (plan.kind === 'approval') {
        ui.setStatus(installStatus, '等待批准：安装任务已创建（approval）。')
        const line = el('p', { class: 'plugin-install-note' })
        line.append(el('span', { text: '批准后才会继续安装：' }), el('a', { href: installApprovalHref(), text: '去「需要你」' }))
        installExtra.append(line)
      } else if (plan.kind === 'install') {
        const state = text(plan.install.state)
        ui.setStatus(
          installStatus,
          state === 'installed'
            ? '已安装（state=installed）。'
            : `安装记录已写入（state=${state || '未知'}）；等待沙箱同步。`
        )
        if (state === 'failed') {
          ui.setStatus(installStatus, '安装失败（state=failed）；看服务端 error，不要重试成“成功”。', 'error')
        }
      } else if (plan.kind === 'job') {
        ui.setStatus(installStatus, `安装任务已创建（state=${text(plan.job.state) || '未知'}）；等待沙箱同步。`)
      } else {
        ui.setStatus(installStatus, '安装请求已返回，但响应里没有 install 或 job；不做任何成功推断。', 'error')
      }
      const installId = installIdFromResponse(result)
      if ((plan.kind === 'job' || plan.kind === 'approval') && installId !== '') {
        startPolling(installId, plan.job?.state || plan.install?.state || '')
      } else if (plan.kind === 'job' || plan.kind === 'approval') {
        const line = el('p', { class: 'plugin-install-note' })
        line.append(el('span', { text: '没有 install id，不能自动轮询：' }), el('a', { href: '#/installs', text: '去已安装页查看' }))
        installExtra.append(line)
      }
    } catch (error) {
      if (isAuthError(error)) {
        ctx.requirePair()
        return
      }
      const preflight = preflightFromError(error)
      if (preflight !== null) {
        problemHost.replaceChildren(problemsBox(preflight))
        ui.setStatus(installStatus, '预检未通过：这次没有安装任何东西。', 'error')
        return
      }
      if (isPluginForbidden(error)) {
        ui.setStatus(installStatus, pluginForbiddenMessage(error, 'install'), 'error')
        return
      }
      if (isPluginNotReady(error)) {
        ui.setStatus(
          installStatus,
          `插件接口未就绪（${pluginStatusDetail(error)}）：这次没有写入安装记录。`,
          'error'
        )
        return
      }
      ui.setStatus(installStatus, `安装失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      installing = false
      if (installButton.isConnected) ui.setBusy(installButton, false)
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!root.isConnected || poll.id === '') return
      if (!document.hidden) schedulePolling()
    })
  }

  refreshPermissions()
  refreshBadges()
  return el('div', { class: 'stack' }, [
    header,
    hero,
    ui.section('权限披露', [permissionBody], {
      description: '网络域、凭据、磁盘、二进制、面板——安装前必须看到它要什么；没有声明的项显示“无”。',
    }),
    versionSection,
    ui.section(
      'README',
      [
        text(plugin.readme) === ''
          ? el('p', { class: 'section-desc', text: '这个插件没有提供 README。' })
          : el('pre', { class: 'plugin-readme', text: plugin.readme }),
      ],
      { description: '纯文本展示；不执行 README 里的任何内容。' }
    ),
  ])
}
