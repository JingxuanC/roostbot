// 插件面板（#/panels，docs/build/wave1.md §C/§D、plugin-marketplace.md §3 C 级）。
//
// 新链路：
//   1. GET  /api/plugins/panels?workspaceId=   列面板；404/405/501 降级为整页面板
//   2. 打开前 POST /api/panels/wake {workspaceId}，让 workspace runtime + 本地转发起来
//   3. 成功后 iframe 指向 /w/<workspaceId>/dsh/（同源反代）
//
// 503 dsh.not_running → 「面板未运行」+ 重试，不白屏；所有服务端文本只进 textContent。

import { isAuthError } from '../lib/api-client.js'
import { el } from '../lib/dom.js'
import {
  panelFramePath,
  panelOpenFailure,
  panelStateLabel,
  panelWakePath,
  panelWakePayload,
} from '../lib/panels.js'
import * as ui from '../lib/ui.js'
import { createPanelsCatalog } from './panels-catalog.js'

const PAGE_TITLE = '插件面板'
const PAGE_SUBTITLE = '插件面板由沙箱里的 DSH Web 渲染；打开前先唤醒工作区，失败就显示原因。'
const LOAD_TIMEOUT_MS = 15_000
const IFRAME_TITLE = '插件面板（DSH Web）'

function statusOf(error) {
  return error && typeof error.status === 'number' ? error.status : 0
}

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

  if (panelFramePath(workspaceId) === null) {
    root.replaceChildren(
      ui.pageHeader(PAGE_TITLE),
      ui.errorState({
        title: '工作区标识不合法',
        message: '工作区标识不合法，无法生成面板地址；这里不会拼任何外部 URL。',
      })
    )
    return
  }

  const view = createPanelsView(ctx, workspaceId)
  root.replaceChildren(view.node)
  const main = root.closest('main')
  if (main) main.focus()
  void view.start()
}

function createPanelsView(ctx, workspaceId) {
  let state = 'idle'
  let loadSeq = 0
  let currentPanel = undefined
  let timeoutTimer = null
  let iframe = null

  const openButton = ui.button('在新标签打开', {
    variant: 'outline',
    disabled: true,
    onClick: openInNewTab,
  })
  const refreshButton = ui.button('刷新', {
    variant: 'ghost',
    onClick: () => {
      void catalog.load()
      void loadPanel(currentPanel)
    },
  })
  const header = ui.pageHeader(PAGE_TITLE, {
    subtitle: PAGE_SUBTITLE,
    actions: [openButton, refreshButton],
  })

  const catalog = createPanelsCatalog(ctx, workspaceId, {
    onOpen: (panel) => void loadPanel(panel),
  })
  const stateBadge = ui.badge(panelStateLabel('idle'), 'warn')
  const stateText = el('p', { class: 'panel-state', role: 'status', text: panelStateLabel('idle') })
  const selectedText = el('p', { class: 'section-desc', text: '还没有选择面板；默认打开整页面板容器。' })
  const frameBody = el('div', { class: 'panel-frame-body' })
  const frameCard = el('section', { class: 'page-card panel-frame-card' }, [
    el('div', { class: 'section-head' }, [
      el('h2', { class: 'section-title', text: '面板容器' }),
      el('div', { class: 'section-actions' }, [stateBadge]),
    ]),
    selectedText,
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

  function showFailure(kind, error) {
    clearLoaders()
    setState('failed')
    const failure = panelOpenFailure(error)
    const retry = ui.button('重试', {
      variant: 'primary',
      onClick: () => void loadPanel(currentPanel),
    })
    const secondary =
      statusOf(error) === 401
        ? ui.button('重新登录', { variant: 'ghost', onClick: () => ctx.requirePair() })
        : undefined
    frameBody.replaceChildren(
      el('div', { class: 'panel-failure', role: 'alert' }, [
        ui.emptyState({
          title: kind || failure.title,
          body: failure.message,
          action: failure.retryable ? retry : undefined,
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
      // 同源反代：允许面板脚本在同源 iframe 内跑，但仍碰不到主页面 DOM 之外的存储。
      sandbox: 'allow-scripts allow-same-origin',
      referrerpolicy: 'no-referrer',
    })
    iframe.addEventListener('load', handleFrameLoad)
    renderStage('面板容器启动中…')
  }

  function openInNewTab() {
    const path = panelFramePath(workspaceId)
    if (path !== null && typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(path, '_blank', 'noopener')
    }
  }

  async function loadPanel(panel) {
    const seq = ++loadSeq
    currentPanel = panel
    clearLoaders()
    setState('loading')
    selectedText.textContent =
      panel && (panel.title || panel.name)
        ? `正在打开：${panel.title || panel.name}`
        : '正在打开整页面板容器。'
    renderStage('正在唤醒工作区…')
    openButton.disabled = true

    timeoutTimer = setTimeout(() => {
      if (seq !== loadSeq || state !== 'loading' || !node.isConnected) return
      showFailure('面板加载超时', { code: 'timeout', status: 0 })
    }, LOAD_TIMEOUT_MS)

    try {
      await ctx.api.post(panelWakePath(), panelWakePayload(workspaceId))
    } catch (error) {
      if (seq !== loadSeq || state !== 'loading') return
      if (isAuthError(error)) {
        clearLoaders()
        setState('failed')
        ctx.requirePair()
        return
      }
      showFailure('', error)
      return
    }
    if (seq !== loadSeq || state !== 'loading') return
    openButton.disabled = false

    const src = panelFramePath(workspaceId)
    if (src === null) {
      showFailure('工作区标识不合法', { status: 400 })
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
