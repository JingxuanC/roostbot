// 插件详情（plugin-marketplace.md §7）：兼容性徽章、权限清单、README、版本、预检与安装。
//
// 流程：选版本 → 预检 → 预检通过且 A/B 级才允许安装 → 二次确认（含权限清单）
//       → POST install → 显示「安装已记录（state=installing），等待沙箱同步」。
// 本批没有沙箱 sync，所以绝不显示「已安装成功」。
// 403 显示「仅 owner/admin 可安装插件」（发布者未验证单独说明）。

import { isAuthError } from '../lib/api-client.js'
import { el } from '../lib/dom.js'
import {
  INSTALL_SYNC_NOTE,
  pluginInstallBlockReason,
  pluginInstallResultMessage,
  pluginInstallableTier,
} from '../lib/plugins.js'
import * as ui from '../lib/ui.js'
import {
  isPluginForbidden,
  isPluginNotReady,
  pluginForbiddenMessage,
  pluginIcon,
  pluginNotReadyState,
  pluginPermissionList,
  pluginScreenshots,
  pluginStatusDetail,
  pluginTierPill,
} from './plugin-kit.js'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export async function mountPluginDetailPage(root, ctx, slug) {
  const safeSlug = typeof slug === 'string' ? slug.trim() : ''
  root.replaceChildren(ui.loading('正在载入插件…'))

  if (safeSlug === '') {
    root.replaceChildren(
      ui.pageHeader('插件详情', { back: { href: '#/plugins', label: '插件市场' } }),
      ui.errorState({
        title: '找不到这个插件',
        message: '地址里没有插件 slug。',
        onRetry: () => void mountPluginDetailPage(root, ctx, safeSlug),
      })
    )
    return
  }

  // workspaceId 只用于预检/安装；拿不到也先把详情显示出来，安装时再重试。
  let workspaceId = ''
  try {
    workspaceId = await ctx.ensureWorkspaceId()
  } catch (error) {
    if (isAuthError(error)) {
      ctx.requirePair()
      return
    }
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
          retry: () => void mountPluginDetailPage(root, ctx, safeSlug),
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
          action: ui.button('重试', {
            variant: 'ghost',
            onClick: () => void mountPluginDetailPage(root, ctx, safeSlug),
          }),
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
        onRetry: () => void mountPluginDetailPage(root, ctx, safeSlug),
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
  root.replaceChildren(detailView(ctx, root, safeSlug, workspaceId, plugin, versions))
  const main = root.closest('main')
  if (main) main.focus()
}

function detailView(ctx, root, slug, initialWorkspaceId, plugin, versions) {
  let workspaceId = initialWorkspaceId
  const latest = typeof plugin.latest === 'string' ? plugin.latest : ''
  let selectedVersion = versions.some((version) => version.version === latest)
    ? latest
    : (typeof versions[0]?.version === 'string' ? versions[0].version : '')
  let preflight = null
  let preflightVersion = ''
  let installRecorded = false

  const selectedData = () => versions.find((version) => version.version === selectedVersion) || null
  const title = typeof plugin.title === 'string' && plugin.title.trim() !== '' ? plugin.title : slug
  const publisher = isObject(plugin.publisher) ? plugin.publisher : null
  const publisherName =
    publisher && typeof publisher.name === 'string' && publisher.name.trim() !== ''
      ? publisher.name
      : (typeof plugin.publisherId === 'string' && plugin.publisherId.trim() !== '' ? plugin.publisherId : '未知发布者')
  const verified = publisher !== null && publisher.verified === true

  const header = ui.pageHeader(title, {
    back: { href: '#/plugins', label: '插件市场' },
    subtitle: [publisherName, plugin.category ? `分类 ${plugin.category}` : '', latest ? `最新 ${latest}` : '']
      .filter(Boolean)
      .join(' · '),
  })

  // ---- 概要 ---------------------------------------------------------------
  const hero = el('div', { class: 'page-card plugin-hero' })
  const heroTop = el('div', { class: 'plugin-hero-top' })
  heroTop.append(pluginIcon(plugin, 'is-large'))
  const heroMain = el('div', { class: 'plugin-hero-main' })
  const badges = el('div', { class: 'plugin-badges' })
  let tierPill = pluginTierPill(plugin.tier, plugin.tierLabel)
  let enginesPill = ui.badge(
    typeof plugin.engines === 'string' && plugin.engines.trim() !== ''
      ? `DSH ${plugin.engines}`
      : 'DSH 版本未知'
  )
  badges.append(tierPill, enginesPill, ui.badge(verified ? '已验证发布者' : '未验证发布者', verified ? 'ok' : 'warn'))
  heroMain.append(badges)
  if (typeof plugin.summary === 'string' && plugin.summary.trim() !== '') {
    heroMain.append(el('p', { class: 'plugin-summary', text: plugin.summary }))
  }
  heroTop.append(heroMain)
  hero.append(heroTop)
  const shots = pluginScreenshots(plugin.screenshots)
  if (shots !== null) hero.append(shots)

  // ---- 权限清单 -----------------------------------------------------------
  const permBody = el('div', { class: 'plugin-perm-body' })
  const permSection = ui.section('权限清单', [permBody], {
    description: '安装前必须看到它要什么；切换版本会显示该版本的声明。',
  })
  function refreshPermissions() {
    const version = selectedData()
    permBody.replaceChildren(
      pluginPermissionList({
        permissions: (version && version.permissions) || plugin.permissions,
        requirements: (version && version.requirements) || plugin.requirements,
      })
    )
  }

  // ---- README -------------------------------------------------------------
  const readme = typeof plugin.readme === 'string' ? plugin.readme.trim() : ''
  const readmeSection = ui.section(
    'README',
    [
      readme === ''
        ? el('p', { class: 'section-desc', text: '这个插件没有提供 README。' })
        : el('pre', { class: 'plugin-readme', text: readme }),
    ],
    { description: '纯文本展示；不执行 README 里的任何内容。' }
  )

  // ---- 版本 / 预检 / 安装 --------------------------------------------------
  const versionSelect = ui.select({
    id: 'plugin-version',
    options: versions.length === 0
      ? [{ value: '', label: '（没有可用版本）' }]
      : versions.map((version) => ({
          value: version.version,
          label: `${version.version}${version.tier ? ` · ${version.tier} 级` : ''}`,
        })),
    value: selectedVersion,
    disabled: versions.length === 0,
  })
  const preflightButton = ui.button('预检', {
    variant: 'outline',
    disabled: versions.length === 0,
    onClick: () => void runPreflight(),
  })
  const installButton = ui.button('安装', {
    variant: 'primary',
    disabled: true,
    onClick: () => showConfirm(),
  })
  const installHint = el('p', {
    class: 'field-hint',
    text: versions.length === 0 ? '这个插件没有可用版本，不能预检或安装。' : '先预检；预检通过且为 A/B 级才能安装。',
  })
  const preflightBox = el('div', { class: 'plugin-preflight' })
  const installStatus = ui.statusLine('')
  const installNote = el('p', { class: 'plugin-install-note', hidden: true })
  const confirmBox = el('div', { class: 'plugin-confirm', hidden: true })

  const versionSection = ui.section(
    '版本与预检',
    [
      el('div', { class: 'plugin-version-row' }, [versionSelect, preflightButton]),
      preflightBox,
      el('div', { class: 'plugin-install-row-actions' }, [installButton]),
      installHint,
      installStatus,
      installNote,
      confirmBox,
    ],
    { description: '预检会检查 DSH 版本、peer 依赖、路由/面板冲突与 tier；预检不通过就不能安装。' }
  )

  function refreshVersionBadges() {
    const version = selectedData()
    const tier = (version && version.tier) || plugin.tier
    const tierLabel = (version && version.tierLabel) || plugin.tierLabel
    const engines =
      (version && typeof version.engines === 'string' && version.engines) ||
      (typeof plugin.engines === 'string' ? plugin.engines : '')
    const nextTier = pluginTierPill(tier, tierLabel)
    const nextEngines = ui.badge(engines !== '' ? `DSH ${engines}` : 'DSH 版本未知')
    tierPill.replaceWith(nextTier)
    enginesPill.replaceWith(nextEngines)
    tierPill = nextTier
    enginesPill = nextEngines
  }

  function resetInstallState() {
    preflight = null
    preflightVersion = ''
    installRecorded = false
    preflightBox.replaceChildren()
    confirmBox.hidden = true
    confirmBox.replaceChildren()
    ui.setStatus(installStatus, '')
    installNote.hidden = true
    installNote.textContent = ''
    installButton.disabled = true
    installButton.textContent = '安装'
    installHint.classList.remove('is-ready')
    installHint.textContent = versions.length === 0 ? '这个插件没有可用版本，不能预检或安装。' : '先预检；预检通过且为 A/B 级才能安装。'
  }

  versionSelect.addEventListener('change', () => {
    selectedVersion = versionSelect.value
    resetInstallState()
    refreshPermissions()
    refreshVersionBadges()
    installHint.textContent = '版本已切换；请重新预检。'
  })

  function preflightReady() {
    return (
      preflight !== null &&
      preflight.ok === true &&
      pluginInstallableTier(preflight.tier) &&
      preflightVersion === selectedVersion &&
      selectedVersion !== ''
    )
  }

  async function runPreflight() {
    if (selectedVersion === '' || installRecorded) return
    resetInstallState()
    ui.setBusy(preflightButton, true, '预检中…')
    preflightBox.replaceChildren(ui.loading('正在预检…'))
    try {
      const body = { version: selectedVersion }
      if (workspaceId !== '') body.workspaceId = workspaceId
      const result = await ctx.api.post(
        `/api/marketplace/plugins/${encodeURIComponent(slug)}/preflight`,
        body
      )
      preflight = isObject(result) ? result : null
      preflightVersion = selectedVersion
      renderPreflight()
    } catch (error) {
      resetInstallState()
      if (isAuthError(error)) {
        ctx.requirePair()
        return
      }
      if (isPluginForbidden(error)) {
        preflightBox.replaceChildren(
          ui.emptyState({
            title: pluginForbiddenMessage(error, 'view'),
            body: '预检按工作区隔离；需要工作区成员身份。',
            action: ui.button('重试', { variant: 'ghost', onClick: () => void runPreflight() }),
          })
        )
        installHint.textContent = '预检被拒绝，不能安装。'
        return
      }
      if (isPluginNotReady(error)) {
        preflightBox.replaceChildren(pluginNotReadyState({ error, retry: () => void runPreflight() }))
        installHint.textContent = '插件接口未就绪，不能安装。'
        return
      }
      preflightBox.replaceChildren(
        ui.errorState({
          error,
          message: `预检失败：${error instanceof Error ? error.message : String(error)}`,
          onRetry: () => void runPreflight(),
        })
      )
      installHint.textContent = '预检失败，不能安装。'
    } finally {
      ui.setBusy(preflightButton, false)
    }
  }

  function renderPreflight() {
    const result = preflight
    if (result === null) {
      preflightBox.replaceChildren()
      installButton.disabled = true
      return
    }
    const ok = result.ok === true
    const tier = typeof result.tier === 'string' ? result.tier : ''
    const problems = (Array.isArray(result.problems) ? result.problems : []).filter(isObject)
    const reasons = (Array.isArray(result.reasons) ? result.reasons : []).filter(
      (reason) => typeof reason === 'string' && reason.trim() !== ''
    )

    const box = el('div', { class: 'plugin-preflight-result' })
    const top = el('div', { class: 'plugin-badges' })
    top.append(ui.badge(ok ? '预检通过' : '预检未通过', ok ? 'ok' : 'warn'))
    top.append(pluginTierPill(result.tier, result.tierLabel))
    if (typeof result.engines === 'string' && result.engines !== '') {
      top.append(ui.badge(`DSH ${result.engines}`))
    }
    if (typeof result.version === 'string' && result.version !== '') {
      top.append(ui.badge(`版本 ${result.version}`))
    }
    box.append(top)

    if (problems.length > 0) {
      box.append(el('h3', { class: 'plugin-subtitle', text: `阻断问题（${problems.length}）` }))
      const list = el('ul', { class: 'plugin-problem-list' })
      for (const problem of problems) {
        const code = typeof problem.code === 'string' && problem.code !== '' ? problem.code : 'problem'
        const detail = typeof problem.detail === 'string' ? problem.detail : ''
        list.append(el('li', { text: detail === '' ? code : `${code}：${detail}` }))
      }
      box.append(list)
    }

    if (reasons.length > 0) {
      box.append(el('h3', { class: 'plugin-subtitle', text: '判定依据' }))
      const list = el('ul', { class: 'plugin-reason-list' })
      for (const reason of reasons) list.append(el('li', { text: reason }))
      box.append(list)
    }

    box.append(el('h3', { class: 'plugin-subtitle', text: '预检确认的权限' }))
    box.append(pluginPermissionList(result))
    preflightBox.replaceChildren(box)

    installHint.classList.remove('is-ready')
    if (!pluginInstallableTier(tier)) {
      installButton.disabled = true
      installHint.textContent = pluginInstallBlockReason(tier)
      return
    }
    if (!ok) {
      installButton.disabled = true
      installHint.textContent =
        problems.length > 0 ? '预检有阻断问题，不能安装。' : '预检未通过，不能安装。'
      return
    }
    installButton.disabled = false
    installHint.classList.add('is-ready')
    installHint.textContent = '预检通过：可以安装。点击后会再确认一次权限清单。'
  }

  function showConfirm() {
    if (!preflightReady() || installRecorded) return
    confirmBox.replaceChildren()
    confirmBox.append(
      el('h3', { class: 'plugin-subtitle', text: `确认安装 ${title} ${preflightVersion}` }),
      el('p', {
        class: 'section-desc',
        text:
          '确认后控制面会写入安装记录。本批不会执行沙箱同步：安装完成后 state 会停在 installing，' +
          '界面不会把等待同步当成安装完成。',
      }),
      el('h3', { class: 'plugin-subtitle', text: '它将获得这些权限' }),
      pluginPermissionList(preflight),
      el('div', { class: 'plugin-confirm-actions' }, [
        ui.button('取消', {
          variant: 'ghost',
          onClick: () => {
            confirmBox.hidden = true
          },
        }),
        ui.button('确认安装', { variant: 'primary', onClick: () => void install() }),
      ])
    )
    confirmBox.hidden = false
    if (typeof confirmBox.scrollIntoView === 'function') confirmBox.scrollIntoView({ block: 'nearest' })
  }

  async function install() {
    if (!preflightReady() || installRecorded) return
    const ticketVersion = preflightVersion
    const buttons = confirmBox.querySelectorAll('button')
    const confirmButton = buttons[buttons.length - 1] || null
    ui.setStatus(installStatus, '')
    installNote.hidden = true
    if (confirmButton !== null) ui.setBusy(confirmButton, true, '安装中…')
    try {
      let targetWorkspace = workspaceId
      if (targetWorkspace === '') {
        targetWorkspace = await ctx.ensureWorkspaceId()
        workspaceId = targetWorkspace
      }
      const result = await ctx.api.post(
        `/api/marketplace/plugins/${encodeURIComponent(slug)}/install`,
        { workspaceId: targetWorkspace, version: ticketVersion }
      )
      const state = result && isObject(result.install) && typeof result.install.state === 'string'
        ? result.install.state
        : 'installing'
      installRecorded = true
      confirmBox.hidden = true
      ui.setStatus(installStatus, pluginInstallResultMessage(result))
      installNote.textContent = `state=${state}：${INSTALL_SYNC_NOTE}`
      installNote.hidden = false
      installButton.disabled = true
      installButton.textContent = '安装已记录'
      installHint.classList.remove('is-ready')
      installHint.textContent = '安装记录已写入；等待沙箱同步，界面不会把记录当成安装完成。'
    } catch (error) {
      if (isAuthError(error)) {
        ctx.requirePair()
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
      if (error && error.code === 'plugin.already_installed') {
        installRecorded = true
        confirmBox.hidden = true
        ui.setStatus(installStatus, pluginInstallResultMessage({ alreadyInstalled: true }))
        installButton.disabled = true
        installButton.textContent = '安装已记录'
        return
      }
      ui.setStatus(
        installStatus,
        `安装失败：${error instanceof Error ? error.message : String(error)}`,
        'error'
      )
    } finally {
      if (confirmButton !== null && confirmButton.isConnected) ui.setBusy(confirmButton, false)
    }
  }

  resetInstallState()
  refreshPermissions()
  refreshVersionBadges()
  return el('div', { class: 'stack' }, [header, hero, permSection, readmeSection, versionSection])
}
