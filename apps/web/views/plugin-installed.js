// 已安装插件（plugin-marketplace.md §7）：版本、state、enabled、更新与操作。
//
// 兼容旧入口：新的已安装页是 #/installs（views/installs.js）。
// 这个文件保留旧的 PATCH 形状，仅当外部还直接引用时使用；plugins.js 已改用新的 pane。
// 所有服务端文本只进 textContent。

import { isAuthError } from '../lib/api-client.js'
import { el } from '../lib/dom.js'
import {
  INSTALL_SYNC_NOTE,
  pluginDetailHref,
  pluginInstallStateBadge,
  pluginInstallStateKind,
  pluginUpdateAvailable,
} from '../lib/plugins.js'
import * as ui from '../lib/ui.js'
import {
  isPluginForbidden,
  isPluginNotReady,
  pluginForbiddenMessage,
  pluginNotReadyState,
  pluginStatusDetail,
} from './plugin-kit.js'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {object} ctx pageContext
 * @param {string} workspaceId
 * @param {{getTitle?: (slug: string) => string, onChanged?: () => void, onGoMarket?: () => void}} [options]
 */
export function createInstalledPane(ctx, workspaceId, options = {}) {
  const getTitle = typeof options.getTitle === 'function' ? options.getTitle : (slug) => slug
  const onChanged = typeof options.onChanged === 'function' ? options.onChanged : () => {}
  const onGoMarket = typeof options.onGoMarket === 'function' ? options.onGoMarket : () => {}

  const intro = el('p', { class: 'section-desc', text: INSTALL_SYNC_NOTE })
  const paneStatus = ui.statusLine('')
  const list = el('ul', { class: 'plugin-install-list' })
  const empty = ui.emptyState({
    title: '还没有安装任何插件',
    body: '安装记录会出现在这里。去「市场」挑一个插件，预检通过后再安装。',
    action: ui.button('去市场', { variant: 'primary', onClick: onGoMarket }),
  })
  const body = el('div', { class: 'plugin-install-body' }, [paneStatus, list, empty])
  const node = el('div', { class: 'stack' }, [intro, body])

  let current = []
  let loaded = false
  let loading = null

  function render() {
    list.replaceChildren()
    for (const install of current) list.append(installRow(install))
    list.hidden = current.length === 0
    empty.hidden = current.length > 0
  }

  function replaceInstall(updated) {
    current = current.map((install) => (install.id === updated.id ? updated : install))
    render()
  }

  function removeInstall(id) {
    current = current.filter((install) => install.id !== id)
    render()
  }

  function installRow(install) {
    const slug = typeof install.slug === 'string' ? install.slug : ''
    const title = getTitle(slug) || slug || '未命名插件'
    const row = el('li', { class: 'plugin-install-row' })

    const main = el('div', { class: 'plugin-install-main' })
    const top = el('div', { class: 'plugin-install-top' })
    top.append(
      el('a', {
        class: 'plugin-install-name',
        href: pluginDetailHref(slug),
        text: title,
      })
    )
    top.append(
      ui.badge(
        pluginInstallStateBadge(install.state),
        pluginInstallStateKind(install.state)
      )
    )
    const enabled = install.enabled !== false
    top.append(ui.badge(enabled ? '已启用' : '已停用', enabled ? 'ok' : 'warn'))
    if (pluginUpdateAvailable(install)) {
      top.append(ui.badge(`有更新 · ${install.latest}`, 'accent'))
    }
    main.append(top)

    const meta = [`版本 ${typeof install.version === 'string' && install.version.trim() !== '' ? install.version : '未知'}`]
    if (slug !== '') meta.push(`slug ${slug}`)
    if (typeof install.installedBy === 'string' && install.installedBy.trim() !== '') {
      meta.push(`安装人 ${install.installedBy}`)
    }
    main.append(el('p', { class: 'plugin-install-meta muted', text: meta.join(' · ') }))
    if (install.state === 'installing') {
      main.append(
        el('p', {
          class: 'plugin-install-note',
          text: '安装/升级已记录，等待沙箱同步（本批不执行 sync）。',
        })
      )
    }
    row.append(main)

    const actions = el('div', { class: 'plugin-install-actions' })
    const toggle = ui.button(enabled ? '停用' : '启用', {
      variant: 'ghost',
      size: 'sm',
      title: enabled ? '只改 enabled；不会删除安装记录' : '只改 enabled；不会推进 state',
      onClick: () => void toggleEnabled(install, toggle),
    })
    actions.append(toggle)
    if (pluginUpdateAvailable(install)) {
      actions.append(
        ui.button(`升级到 ${install.latest}`, {
          variant: 'outline',
          size: 'sm',
          title: '升级后等待沙箱同步',
          onClick: () => void upgrade(install),
        })
      )
    }
    const uninstall = ui.button('卸载', {
      variant: 'ghost',
      size: 'sm',
      title: '删除安装记录；不会立即改动沙箱',
      onClick: () => void uninstallInstall(install),
    })
    actions.append(uninstall)
    row.append(actions)
    return row
  }

  async function toggleEnabled(install, button) {
    ui.setStatus(paneStatus, '')
    const nextEnabled = install.enabled === false
    ui.setBusy(button, true, nextEnabled ? '启用中…' : '停用中…')
    try {
      const data = await ctx.api.patch(`/api/plugin-installs/${encodeURIComponent(install.id)}`, {
        enabled: nextEnabled,
      })
      const saved = data && isObject(data.install) ? data.install : null
      const updated = saved ? { ...install, ...saved } : { ...install, enabled: nextEnabled }
      replaceInstall(updated)
      ui.setStatus(paneStatus, nextEnabled ? '已启用这个插件（enabled=true）。' : '已停用这个插件（enabled=false）。')
      onChanged()
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      ui.setBusy(button, false)
      ui.setStatus(paneStatus, manageErrorMessage(cause, '启停'), 'error')
    }
  }

  async function upgrade(install) {
    const latest = typeof install.latest === 'string' ? install.latest : ''
    if (latest === '') return
    const title = getTitle(install.slug) || install.slug
    const prompt = `把「${title}」从 ${install.version} 升级到 ${latest}？升级后等待沙箱同步。`
    if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(prompt)) {
      return
    }
    ui.setStatus(paneStatus, '')
    try {
      const data = await ctx.api.patch(`/api/plugin-installs/${encodeURIComponent(install.id)}`, {
        version: latest,
      })
      const saved = data && isObject(data.install) ? data.install : null
      const updated = saved
        ? { ...install, ...saved, updateAvailable: false }
        : { ...install, version: latest, state: 'installing', updateAvailable: false }
      replaceInstall(updated)
      ui.setStatus(
        paneStatus,
        `升级已记录（state=${updated.state || 'installing'}），等待沙箱同步。`
      )
      onChanged()
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      ui.setStatus(paneStatus, manageErrorMessage(cause, '升级'), 'error')
    }
  }

  async function uninstallInstall(install) {
    const title = getTitle(install.slug) || install.slug
    const prompt = `卸载「${title}」？这会删除安装记录；沙箱同步由下一批处理。`
    if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(prompt)) {
      return
    }
    ui.setStatus(paneStatus, '')
    try {
      await ctx.api.del(`/api/plugin-installs/${encodeURIComponent(install.id)}`)
      removeInstall(install.id)
      ui.setStatus(paneStatus, '已卸载（安装记录已删除）。')
      onChanged()
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      ui.setStatus(paneStatus, manageErrorMessage(cause, '卸载'), 'error')
    }
  }

  function manageErrorMessage(error, action) {
    if (isPluginForbidden(error)) return pluginForbiddenMessage(error, 'manage')
    if (isPluginNotReady(error)) {
      return `插件接口未就绪（${pluginStatusDetail(error)}）：这次${action}没有成功，也没有发生任何状态变化。`
    }
    return `${action}失败：${error instanceof Error ? error.message : String(error)}`
  }

  async function load(force = false) {
    if (loading !== null && !force) return loading
    if (loaded && !force) return undefined
    const task = (async () => {
      body.replaceChildren(ui.loading('正在载入已安装插件…'))
      try {
        const data = await ctx.api.get(
          `/api/plugin-installs?workspaceId=${encodeURIComponent(workspaceId)}`
        )
        current = (Array.isArray(data?.installs) ? data.installs : []).filter(isObject)
        loaded = true
        body.replaceChildren(paneStatus, list, empty)
        render()
      } catch (error) {
        if (isAuthError(error)) {
          ctx.requirePair()
          return
        }
        if (isPluginForbidden(error)) {
          body.replaceChildren(
            ui.emptyState({
              title: pluginForbiddenMessage(error, 'manage'),
              body: '已安装插件按工作区隔离；需要 owner/admin 权限才能查看与操作。',
              action: ui.button('重试', { variant: 'ghost', onClick: () => void load(true) }),
            })
          )
          return
        }
        if (isPluginNotReady(error)) {
          body.replaceChildren(pluginNotReadyState({ error, retry: () => void load(true) }))
          return
        }
        body.replaceChildren(
          ui.errorState({
            error,
            message: `已安装插件载入失败：${error instanceof Error ? error.message : String(error)}`,
            onRetry: () => void load(true),
          })
        )
      }
    })()
    loading = task
    try {
      return await task
    } finally {
      if (loading === task) loading = null
    }
  }

  render()
  return {
    node,
    load,
    reload: () => load(true),
  }
}
