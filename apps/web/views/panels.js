// 插件面板（ADR 0004 / plugin-marketplace.md §3 C 级、§12）。
//
// 流程：GET /api/config 取 dshBase → ensureWorkspaceId → POST /w/:ws/dsh/session 拿 cookie
// → GET /api/workspaces/:id/dsh/status 由控制面代探活 → 用 iframe 嵌 dshBase 上的 DSH Web。
// 反代跑在独立端口（独立 origin），iframe 才允许 allow-same-origin；插件代码仍碰不到主页面。
//
// iframe 的 src 只能由 lib/panels.js 生成（http(s) origin + 白名单路径），绝不接受外部 URL。
// 失败态：配置缺失、status 不可用、10s 未 load 都显示失败卡片。所有服务端文本只进 textContent。

import { isAuthError } from '../lib/api-client.js'
import { el } from '../lib/dom.js'
import {
  PANEL_NOT_CONFIGURED_MESSAGE,
  normalizeDshBase,
  panelFailureMessage,
  panelProxyUrl,
  panelStateLabel,
} from '../lib/panels.js'
import * as ui from '../lib/ui.js'
import { createPanelsCatalog } from './panels-catalog.js'

const PAGE_TITLE = '插件面板'
const PAGE_SUBTITLE = '插件面板由沙箱里的 DSH Web 渲染；Roost 的产品界面不变，面板只是容器里的一个标签页。'
const LOAD_TIMEOUT_MS = 10_000
const IFRAME_TITLE = '插件面板（DSH Web）'
const statusOf = (error) => (error && typeof error.status === 'number' ? error.status : 0)
const codeOf = (error) => (error && typeof error.code === 'string' ? error.code : '')

/** @param {HTMLElement} root @param {object} ctx pageContext */
export async function mountPanelsPage(root, ctx) {
  root.replaceChildren(ui.loading('正在准备插件面板…'))

  // 1. 反代源由控制面下发；未启用独立端口时 dshBase=null，这里不猜地址。
  let config
  try {
    config = await ctx.api.get('/api/config')
  } catch (error) {
    configFailure(root, ctx, '面板配置载入失败', `读取 /api/config 失败：${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const rawBase = config && typeof config === 'object' ? config.dshBase : null
  const dshBase = normalizeDshBase(rawBase)
  if (dshBase === null) {
    const message =
      rawBase === null || rawBase === undefined
        ? PANEL_NOT_CONFIGURED_MESSAGE
        : `面板容器配置不合法（dshBase=${String(rawBase)}）。${PANEL_NOT_CONFIGURED_MESSAGE}`
    configFailure(root, ctx, '面板容器未配置', message)
    return
  }

  let workspaceId = ''
  try {
    workspaceId = await ctx.ensureWorkspaceId()
  } catch (error) {
    if (isAuthError(error)) {
      ctx.requirePair()
      return
    }
    root.replaceChildren(
      ui.pageHeader(PAGE_TITLE),
      ui.errorState({
        error,
        message: `工作区载入失败：${error instanceof Error ? error.message : String(error)}`,
        onRetry: () => void mountPanelsPage(root, ctx),
        onPair: typeof ctx.hasToken === 'function' && ctx.hasToken() ? undefined : true,
      })
    )
    return
  }

  if (panelProxyUrl(dshBase, workspaceId) === null) {
    configFailure(root, ctx, '工作区标识不合法', '工作区标识不合法，无法生成面板地址；这里不会拼任何外部 URL。')
    return
  }

  const view = createPanelsView(ctx, workspaceId, dshBase)
  root.replaceChildren(view.node)
  const main = root.closest('main')
  if (main) main.focus()
  void view.start()
}

/** 配置缺失/非法时的整页失败卡片（此时还没有 workspace，不渲染清单与容器）。 */
function configFailure(root, ctx, title, message) {
  root.replaceChildren(
    el('div', { class: 'stack' }, [
      ui.pageHeader(PAGE_TITLE),
      el('section', { class: 'page-card' }, [
        el('div', { class: 'panel-failure', role: 'alert' }, [
          ui.emptyState({
            title,
            body: message,
            action: ui.button('重试', { variant: 'primary', onClick: () => void mountPanelsPage(root, ctx) }),
            secondary: ui.linkButton('去插件市场', '#/plugins', { variant: 'ghost' }),
          }),
        ]),
      ]),
    ])
  )
}

function createPanelsView(ctx, workspaceId, dshBase) {
  let state = 'idle'
  let loadSeq = 0
  let currentPath
  let timeoutTimer = null
  let iframe = null

  const openButton = ui.button('在新标签打开', {
    variant: 'outline',
    disabled: true,
    title: 'cookie 已种在控制面；新标签直接打开独立源上的面板容器',
    onClick: openInNewTab,
  })
  const refreshButton = ui.button('刷新', {
    variant: 'ghost',
    onClick: () => {
      void catalog.load()
      void loadPanel(currentPath)
    },
  })
  const header = ui.pageHeader(PAGE_TITLE, {
    subtitle: PAGE_SUBTITLE,
    actions: [openButton, refreshButton],
  })

  const catalog = createPanelsCatalog(ctx, workspaceId, { onOpen: (path) => void loadPanel(path) })
  const stateBadge = ui.badge(panelStateLabel('idle'), 'warn')
  const stateText = el('p', { class: 'panel-state', role: 'status', text: panelStateLabel('idle') })
  const frameBody = el('div', { class: 'panel-frame-body' })
  const frameCard = el('section', { class: 'page-card panel-frame-card' }, [
    el('div', { class: 'section-head' }, [
      el('h2', { class: 'section-title', text: '面板容器' }),
      el('div', { class: 'section-actions' }, [stateBadge]),
    ]),
    stateText,
    frameBody,
  ])

  const node = el('div', { class: 'stack' }, [header, catalog.node, frameCard])
  function setState(next) {
    state = next
    stateBadge.textContent = panelStateLabel(next)
    stateBadge.className = `pill ${
      next === 'ready' ? 'pill-ok' : next === 'failed' ? 'pill-warn' : next === 'loading' ? 'pill-accent' : ''
    }`.trim()
    stateText.textContent = panelStateLabel(next)
  }

  function clearLoaders() {
    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer)
      timeoutTimer = null
    }
    if (iframe !== null) {
      iframe.removeEventListener('load', handleFrameLoad)
      iframe.remove()
      iframe = null
    }
  }

  function renderStage(message) {
    const overlay = el('div', { class: 'panel-frame-overlay', role: 'status' }, [
      el('span', { class: 'spinner', 'aria-hidden': 'true' }),
      el('span', { class: 'panel-frame-overlay-text', text: message }),
    ])
    const children = iframe === null ? [overlay] : [iframe, overlay]
    frameBody.replaceChildren(el('div', { class: 'panel-frame-stage' }, children))
  }

  function failureTitle(status) {
    if (status === 401) return '鉴权失败'
    if (status === 403) return '没有权限'
    if (status === 404) return '找不到面板'
    if (status === 502 || status === 0) return '插件面板未就绪'
    return '面板加载失败'
  }

  function showFailure(status, code) {
    clearLoaders()
    setState('failed')
    const retry = ui.button('重试', {
      variant: 'primary',
      onClick: () => void loadPanel(currentPath),
    })
    const secondary =
      status === 401 ? ui.button('重新配对', { variant: 'ghost', onClick: () => ctx.requirePair() }) : undefined
    frameBody.replaceChildren(
      el('div', { class: 'panel-failure', role: 'alert' }, [
        ui.emptyState({
          title: failureTitle(status),
          body: panelFailureMessage(status, code),
          action: retry,
          secondary,
        }),
      ])
    )
  }

  function handleFrameLoad() {
    if (state !== 'loading') return
    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer)
      timeoutTimer = null
    }
    setState('ready')
    const overlay = frameBody.querySelector('.panel-frame-overlay')
    if (overlay) overlay.remove()
  }

  function mountIframe(src) {
    iframe = el('iframe', {
      class: 'panel-iframe',
      src,
      title: IFRAME_TITLE,
      // 反代在独立端口（独立 origin）：允许同源脚本跑起来，同时仍碰不到主控制面页面。
      sandbox: 'allow-scripts allow-same-origin',
      referrerpolicy: 'no-referrer',
    })
    iframe.addEventListener('load', handleFrameLoad)
    renderStage('面板容器启动中…')
  }

  function openInNewTab() {
    // cookie 已经种在 Path=/w/<ws>/dsh/ 上；cookie 不区分端口，独立源的新标签也能用。
    const url = panelProxyUrl(dshBase, workspaceId)
    if (url !== null && typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(url, '_blank', 'noopener')
    }
  }

  async function loadPanel(panelPath) {
    const seq = ++loadSeq
    currentPath = panelPath
    clearLoaders()
    setState('loading')
    renderStage('面板容器启动中…')

    timeoutTimer = setTimeout(() => {
      if (seq !== loadSeq || state !== 'loading' || !node.isConnected) return
      showFailure(0, 'timeout')
    }, LOAD_TIMEOUT_MS)

    // 1. 签发短时 cookie（HttpOnly；前端拿不到也不需要）。
    try {
      await ctx.api.post(`/w/${encodeURIComponent(workspaceId)}/dsh/session`)
    } catch (error) {
      if (seq !== loadSeq || state !== 'loading') return
      if (isAuthError(error)) {
        clearLoaders()
        setState('failed')
        ctx.requirePair()
        return
      }
      showFailure(statusOf(error), codeOf(error))
      return
    }
    if (seq !== loadSeq || state !== 'loading') return
    openButton.disabled = false

    const src = panelProxyUrl(dshBase, workspaceId, panelPath)
    if (src === null) {
      showFailure(400, 'invalid_path')
      return
    }

    // 2. 探活由控制面代做（同源、带 Bearer）：前端不再跨源 fetch 反代端口。
    let status
    try {
      status = await ctx.api.get(`/api/workspaces/${encodeURIComponent(workspaceId)}/dsh/status`)
    } catch (error) {
      if (seq !== loadSeq || state !== 'loading') return
      if (isAuthError(error)) {
        clearLoaders()
        setState('failed')
        ctx.requirePair()
        return
      }
      showFailure(statusOf(error), codeOf(error))
      return
    }
    if (seq !== loadSeq || state !== 'loading') return
    if (status === null || typeof status !== 'object' || status.available !== true) {
      showFailure(502)
      return
    }

    mountIframe(src)
  }

  return {
    node,
    start() {
      void catalog.load()
      void loadPanel(undefined)
    },
  }
}
