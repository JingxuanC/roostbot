// 插件面板（ADR 0004 / plugin-marketplace.md §3 C 级、§12）。
//
// 流程：ensureWorkspaceId → POST /w/:ws/dsh/session 拿 HttpOnly cookie → 探测 /w/:ws/dsh/*
// → 用 sandbox="allow-scripts" 的 iframe 嵌 DSH Web。iframe 的 src 只能由 lib/panels.js
// 生成（固定前缀 + 白名单路径），绝不接受外部 URL。
//
// 失败态：401/403/404/502 由探测拿到；10s 未 load 按超时处理。iframe 的 opaque origin
// 读不到响应状态，所以先用同源 fetch（只带 cookie、不带 Bearer）探测；探测通过后 iframe
// 仍可能因为凭据差异拿不到内容。所有服务端文本只进 textContent。

import { isAuthError } from '../lib/api-client.js'
import { el } from '../lib/dom.js'
import { panelFailureMessage, panelProxyPath, panelStateLabel } from '../lib/panels.js'
import * as ui from '../lib/ui.js'
import { createPanelsCatalog } from './panels-catalog.js'

const PAGE_TITLE = '插件面板'
const PAGE_SUBTITLE = '插件面板由沙箱里的 DSH Web 渲染；Roost 的产品界面不变，面板只是容器里的一个标签页。'
const LOAD_TIMEOUT_MS = 10_000
const IFRAME_TITLE = '插件面板（DSH Web）'

function statusOf(error) {
  return error && typeof error.status === 'number' ? error.status : 0
}

function codeOf(error) {
  return error && typeof error.code === 'string' ? error.code : ''
}

/**
 * @param {HTMLElement} root
 * @param {object} ctx pageContext
 */
export async function mountPanelsPage(root, ctx) {
  root.replaceChildren(ui.loading('正在准备插件面板…'))

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

  const basePath = panelProxyPath(workspaceId)
  if (basePath === null) {
    root.replaceChildren(
      ui.pageHeader(PAGE_TITLE),
      ui.errorState({
        error: new Error('工作区标识不合法，无法生成面板地址'),
        message: '工作区标识不合法，无法生成面板地址；这里不会拼任何外部 URL。',
        onRetry: () => void mountPanelsPage(root, ctx),
      })
    )
    return
  }

  const view = createPanelsView(ctx, workspaceId, basePath)
  root.replaceChildren(view.node)
  const main = root.closest('main')
  if (main) main.focus()
  void view.start()
}

function createPanelsView(ctx, workspaceId, basePath) {
  let state = 'idle'
  let loadSeq = 0
  let currentPath
  let timeoutTimer = null
  let abortController = null
  let iframe = null

  const openButton = ui.button('在新标签打开', {
    variant: 'outline',
    disabled: true,
    title: 'cookie 已种在本站；新标签直接打开面板容器',
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
    if (abortController !== null) {
      abortController.abort()
      abortController = null
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
      sandbox: 'allow-scripts',
      referrerpolicy: 'no-referrer',
    })
    iframe.addEventListener('load', handleFrameLoad)
    renderStage('面板容器启动中…')
  }

  function openInNewTab() {
    // cookie 已经种在 Path=/w/<ws>/dsh/ 上，新标签直接可用。
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(basePath, '_blank', 'noopener')
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

    const src = panelProxyPath(workspaceId, panelPath)
    if (src === null) {
      showFailure(400, 'invalid_path')
      return
    }

    // 2. 探测：只带 cookie（不带 Bearer），尽量贴近 iframe 的请求；
    //    iframe 的 opaque origin 读不到状态码，所以先在这里判 401/403/404/502。
    const controller = new AbortController()
    abortController = controller
    let response
    try {
      response = await fetch(src, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
        headers: { accept: 'text/html' },
      })
    } catch {
      if (seq !== loadSeq || state !== 'loading') return
      if (controller.signal.aborted) showFailure(0, 'timeout')
      else showFailure(0, 'network')
      return
    }
    abortController = null
    if (seq !== loadSeq || state !== 'loading') return

    if (!response.ok) {
      let code = ''
      try {
        const body = await response.json()
        code = body && body.error && typeof body.error.code === 'string' ? body.error.code : ''
      } catch {
        code = ''
      }
      if (seq !== loadSeq || state !== 'loading') return
      showFailure(response.status, code)
      return
    }

    // 探测只用来判断状态；正文丢掉，iframe 会重新请求。
    try {
      if (response.body && typeof response.body.cancel === 'function') await response.body.cancel()
    } catch {
      // 已读/已关闭都无所谓。
    }
    if (seq !== loadSeq || state !== 'loading') return

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
