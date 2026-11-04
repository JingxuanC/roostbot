// 已安装插件（#/installs，docs/build/wave1.md §B/§D，plugin-marketplace.md §7）。
//
// 每个动作都是真实请求：
//   更新   POST /api/plugin-installs/:id/update {version}   → 202 {job}
//   停用   POST /api/plugin-installs/:id/disable            → 200 {install}
//   启用   POST /api/plugin-installs/:id/enable             → 200 {install}
//   卸载   POST /api/plugin-installs/:id/uninstall          → 202 {job}
//   回滚   POST /api/plugin-installs/:id/rollback           → 202 {job}
// 202 之后按 GET /api/plugin-installs/:id 轮询（2s，最多 60s，页面隐藏时暂停）。
// 失败原样显示；没有可回滚版本时按钮禁用，不假装能回滚。

import { isAuthError, isMissingRoute } from '../lib/api-client.js'
import { el } from '../lib/dom.js'
import {
  INSTALL_POLL_INTERVAL_MS,
  installActionRequest,
  installActions,
  installDetailPath,
  installIdFromResponse,
  installJobError,
  installResponsePlan,
  installStateBadge,
  installStateKind,
  installsListPath,
  isInstallTerminal,
  pollDecision,
  preflightFromError,
} from '../lib/installs.js'
import { pluginDetailHref } from '../lib/plugins.js'
import * as ui from '../lib/ui.js'
import { isPluginForbidden, pluginForbiddenMessage, pluginStatusDetail } from './plugin-kit.js'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function isNotReady(error) {
  if (!error) return false
  if (isMissingRoute(error)) return true
  if (error.status === 405 || error.status === 501) return true
  return error.status === 503 && error.code === 'runtime.not_configured'
}

function errorMessage(cause, action) {
  if (isPluginForbidden(cause)) return pluginForbiddenMessage(cause, 'manage')
  if (isNotReady(cause)) {
    return `${action}接口未就绪（${pluginStatusDetail(cause)}）：这次没有发生任何状态变化。`
  }
  if (cause && cause.code === 'plugin.preflight') {
    return `${action}被预检拒绝（409 · plugin.preflight）：${cause.message || '看下方的阻断问题。'}`
  }
  return `${action}失败：${cause instanceof Error ? cause.message : String(cause)}`
}

/**
 * @param {object} ctx pageContext
 * @param {string} workspaceId
 * @param {{getTitle?: (slug: string) => string, onChanged?: () => void, onGoMarket?: () => void}} [options]
 */
export function createInstallsPane(ctx, workspaceId, options = {}) {
  const getTitle = typeof options.getTitle === 'function' ? options.getTitle : () => ''
  const onChanged = typeof options.onChanged === 'function' ? options.onChanged : () => {}
  const onGoMarket = typeof options.onGoMarket === 'function' ? options.onGoMarket : () => {}

  const paneStatus = ui.statusLine('')
  const list = el('ul', { class: 'plugin-install-list' })
  const empty = ui.emptyState({
    title: '还没有安装任何插件',
    body: '安装记录会出现在这里。去「市场」挑一个插件，安装后可以更新、停用、卸载或回滚。',
    action: ui.button('去市场', { variant: 'primary', onClick: onGoMarket }),
  })
  const body = el('div', { class: 'plugin-install-body' }, [paneStatus, list, empty])
  const node = el('div', { class: 'stack' }, [
    el('p', {
      class: 'section-desc',
      text: '安装/升级任务由控制面执行；这里只显示接口给出的 state，不把「已排队」说成「已安装」。',
    }),
    body,
  ])

  let current = []
  let loaded = false
  let loading = null
  /** @type {Map<string, {timer: ReturnType<typeof setTimeout>|null, startedAt: number, state: string}>} */
  const pollers = new Map()

  function render() {
    list.replaceChildren()
    for (const install of current) list.append(installRow(install))
    list.hidden = current.length === 0
    empty.hidden = current.length > 0
  }

  function replaceInstall(updated) {
    current = current.map((install) => (install.id === updated.id ? { ...install, ...updated } : install))
    render()
  }

  function removeInstall(id) {
    current = current.filter((install) => install.id !== id)
    render()
  }

  function installRow(install) {
    const slug = text(install.slug)
    const title = getTitle(slug) || text(install.title) || slug || '未命名插件'
    const row = el('li', { class: 'plugin-install-row' })
    const main = el('div', { class: 'plugin-install-main' })
    const top = el('div', { class: 'plugin-install-top' })
    top.append(
      el('a', {
        class: 'plugin-install-name',
        href: pluginDetailHref(slug),
        text: title,
      }),
      ui.badge(installStateBadge(install.state), installStateKind(install.state)),
      ui.badge(install.enabled === false ? '已停用' : '已启用', install.enabled === false ? 'warn' : 'ok')
    )
    const available = installActions(install)
    if (available.update) top.append(ui.badge(`有更新 · ${available.updateVersion}`, 'accent'))
    main.append(top)

    const meta = [`版本 ${text(install.version) || '未知'}`]
    if (slug !== '') meta.push(`slug ${slug}`)
    if (text(install.installedBy) !== '') meta.push(`安装人 ${install.installedBy}`)
    if (text(install.updatedAt) !== '') meta.push(`更新 ${install.updatedAt}`)
    main.append(el('p', { class: 'plugin-install-meta muted', text: meta.join(' · ') }))
    if (text(install.state) === 'installing') {
      main.append(
        el('p', {
          class: 'plugin-install-note',
          text: '安装/升级中：等待沙箱同步；完成后 state 会变成 installed。',
        })
      )
    }
    if (text(install.state) === 'awaiting-approval') {
      const note = el('p', { class: 'plugin-install-note' })
      note.append(el('span', { text: '等待批准：' }), el('a', { href: '#/approvals', text: '去「需要你」' }))
      main.append(note)
    }
    const rowStatus = ui.statusLine('')
    main.append(rowStatus)
    row.append(main)

    const actions = el('div', { class: 'plugin-install-actions' })
    if (available.update) {
      actions.append(
        ui.button(`更新到 ${available.updateVersion}`, {
          variant: 'outline',
          size: 'sm',
          onClick: () => void runAction(install, 'update', available.updateVersion, rowStatus, actions),
        })
      )
    }
    if (available.disable) {
      actions.append(
        ui.button('停用', {
          variant: 'ghost',
          size: 'sm',
          onClick: () => void runAction(install, 'disable', '', rowStatus, actions),
        })
      )
    }
    if (available.enable) {
      actions.append(
        ui.button('启用', {
          variant: 'ghost',
          size: 'sm',
          onClick: () => void runAction(install, 'enable', '', rowStatus, actions),
        })
      )
    }
    const rollback = ui.button('回滚', {
      variant: 'ghost',
      size: 'sm',
      disabled: !available.rollback,
      title: available.rollback ? '回滚到上一个版本（会创建任务）' : '没有可回滚的历史版本',
      onClick: () => void runAction(install, 'rollback', '', rowStatus, actions),
    })
    actions.append(rollback)
    actions.append(
      ui.button('卸载', {
        variant: 'ghost',
        size: 'sm',
        onClick: () => void runAction(install, 'uninstall', '', rowStatus, actions),
      })
    )
    row.append(actions)
    return row
  }

  function setRowBusy(actions, busy, label) {
    if (!actions) return
    for (const button of actions.querySelectorAll('button')) {
      if (busy) {
        if (button.dataset.wasDisabled === undefined) button.dataset.wasDisabled = button.disabled ? '1' : ''
        if (button.dataset.originalText === undefined) button.dataset.originalText = button.textContent
        button.disabled = true
      } else {
        button.disabled = button.dataset.wasDisabled === '1'
        if (button.dataset.originalText !== undefined) button.textContent = button.dataset.originalText
        delete button.dataset.wasDisabled
        delete button.dataset.originalText
      }
    }
    if (busy && label && actions.firstElementChild) actions.firstElementChild.textContent = label
  }

  async function runAction(install, action, version, rowStatus, actions) {
    const name = action === 'update' ? (version || '更新') : action === 'disable' ? '停用' : action === 'enable' ? '启用' : action === 'rollback' ? '回滚' : '卸载'
    if (action === 'uninstall') {
      const title = getTitle(install.slug) || install.slug || '这个插件'
      if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(`卸载「${title}」？控制面会创建卸载任务；失败会如实显示。`)) {
        return
      }
    }
    const request = installActionRequest(install, action, { version })
    if (request === null) {
      ui.setStatus(rowStatus, action === 'update' ? '没有可用的目标版本。' : '这个动作缺少安装 id，不能发请求。', 'error')
      return
    }
    ui.setStatus(paneStatus, '')
    ui.setStatus(rowStatus, `${name}中…`)
    setRowBusy(actions, true, `${name}中…`)
    try {
      const result = await ctx.api.post(request.path, request.body)
      if (action === 'disable' || action === 'enable') {
        const saved = result && isObject(result.install) ? result.install : null
        replaceInstall(saved || { ...install, enabled: action === 'enable' })
        ui.setStatus(rowStatus, action === 'enable' ? '已启用。' : '已停用。')
        onChanged()
        return
      }
      if (result === null) {
        removeInstall(install.id)
        ui.setStatus(paneStatus, '已卸载。')
        onChanged()
        return
      }
      const plan = installResponsePlan(result)
      if (plan.kind === 'approval') {
        ui.setStatus(rowStatus, '等待批准：任务已创建，批准后才会继续。')
        rowStatus.append(el('a', { href: '#/approvals', text: '去「需要你」' }))
      } else if (plan.kind === 'install') {
        replaceInstall(plan.install)
        ui.setStatus(rowStatus, `接口返回 state=${text(plan.install.state) || '未知'}。`)
        onChanged()
      } else if (plan.kind === 'job') {
        ui.setStatus(rowStatus, `${name}任务已创建（state=${text(plan.job.state) || '未知'}），等待沙箱同步。`)
      } else {
        ui.setStatus(rowStatus, `${name}请求已返回，但响应里没有 install 或 job；不做任何成功推断。`, 'error')
        return
      }
      const installId = installIdFromResponse(result) || install.id
      if (installId !== '') startPolling(installId, plan.kind === 'job' ? plan.job.state : '')
      onChanged()
    } catch (cause) {
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      ui.setStatus(rowStatus, errorMessage(cause, name), 'error')
    } finally {
      if (actions && actions.isConnected) setRowBusy(actions, false)
    }
  }

  function stopPolling(id) {
    const state = pollers.get(id)
    if (!state) return
    if (state.timer !== null) clearTimeout(state.timer)
    pollers.delete(id)
  }

  function schedulePolling(id) {
    const state = pollers.get(id)
    if (!state) return
    if (typeof document !== 'undefined' && document.hidden) return
    if (!node.isConnected) {
      stopPolling(id)
      return
    }
    const decision = pollDecision({
      visible: true,
      startedAt: state.startedAt,
      now: Date.now(),
      state: state.state,
    })
    if (decision === 'stop') {
      stopPolling(id)
      paneStatus.textContent = '已停止自动刷新（2 分钟上限或任务已结束）；可点「刷新」查看最新状态。'
      paneStatus.hidden = false
      return
    }
    state.timer = setTimeout(() => void tickPolling(id), INSTALL_POLL_INTERVAL_MS)
  }

  function startPolling(installId, initialState) {
    stopPolling(installId)
    pollers.set(installId, { timer: null, startedAt: Date.now(), state: text(initialState) })
    schedulePolling(installId)
  }

  async function tickPolling(id) {
    const state = pollers.get(id)
    if (!state) return
    if (typeof document !== 'undefined' && document.hidden) return
    if (!node.isConnected) {
      stopPolling(id)
      return
    }
    try {
      const data = await ctx.api.get(installDetailPath(id))
      const install = data && isObject(data.install) ? data.install : null
      const job = data && isObject(data.job) ? data.job : null
      if (install) replaceInstall(install)
      const nextState = text(job?.state) || text(install?.state) || state.state
      state.state = nextState
      if (isInstallTerminal(nextState)) {
        stopPolling(id)
        if (nextState === 'failed') {
          const detail = installJobError(job)
          ui.setStatus(paneStatus, `安装任务失败${detail === '' ? '' : `：${detail}`}`, 'error')
        } else {
          ui.setStatus(paneStatus, `任务已结束（state=${nextState}）。`)
        }
        onChanged()
        void load(true)
        return
      }
      ui.setStatus(paneStatus, `任务进行中（state=${nextState}）…`)
      schedulePolling(id)
    } catch (cause) {
      stopPolling(id)
      if (isAuthError(cause)) {
        ctx.requirePair()
        return
      }
      ui.setStatus(paneStatus, `进度查询失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error')
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!node.isConnected) return
      if (document.hidden) {
        for (const state of pollers.values()) {
          if (state.timer !== null) clearTimeout(state.timer)
          state.timer = null
        }
        return
      }
      for (const id of pollers.keys()) schedulePolling(id)
    })
  }

  async function load(force = false) {
    if (loading !== null && !force) return loading
    if (loaded && !force) return undefined
    const task = (async () => {
      body.replaceChildren(ui.loading('正在载入已安装插件…'))
      try {
        const data = await ctx.api.get(installsListPath(workspaceId))
        current = (Array.isArray(data?.installs) ? data.installs : []).filter(isObject)
        loaded = true
        body.replaceChildren(paneStatus, list, empty)
        render()
        ui.setStatus(paneStatus, current.length === 0 ? '' : `共 ${current.length} 个安装记录。`)
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
        if (isNotReady(error)) {
          body.replaceChildren(
            ui.emptyState({
              title: '安装接口未就绪',
              body:
                '控制面还没有 GET /api/plugin-installs（或返回 404/405/501/503 runtime.not_configured）。' +
                '界面不会假装有安装记录；接口上线后点「重试」即可。',
              action: ui.button('重试', { variant: 'ghost', onClick: () => void load(true) }),
            })
          )
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

export async function mountInstallsPage(root, ctx) {
  root.replaceChildren(ui.loading('正在载入已安装插件…'))
  let workspaceId = ''
  try {
    workspaceId = await ctx.ensureWorkspaceId()
  } catch (error) {
    if (isAuthError(error)) {
      ctx.requirePair()
      return
    }
    root.replaceChildren(
      ui.pageHeader('已安装插件'),
      ui.errorState({
        error,
        message: `工作区载入失败：${error instanceof Error ? error.message : String(error)}`,
        onRetry: () => void mountInstallsPage(root, ctx),
        onPair: typeof ctx.hasToken === 'function' && ctx.hasToken() ? undefined : true,
      })
    )
    return
  }

  const pane = createInstallsPane(ctx, workspaceId, {
    onGoMarket: () => ctx.navigate('#/plugins'),
  })
  const header = ui.pageHeader('已安装插件', {
    subtitle: '更新、停用、启用、卸载与回滚都走真实接口；失败原样显示，不假装成功。',
    actions: [
      ui.linkButton('去市场', '#/plugins', { variant: 'ghost' }),
      ui.button('刷新', { variant: 'outline', onClick: () => void pane.reload() }),
    ],
  })
  root.replaceChildren(el('div', { class: 'stack' }, [header, pane.node]))
  const main = root.closest('main')
  if (main) main.focus()
  void pane.load()
}
