// 消息附件入口：正文下方按 kind 派发到缩略图 / 卡片渲染。
//
// 安全边界：
//   * 文件名与内容只进 textContent（走 el 的 text 属性），不拼 HTML 字符串。
//   * HTML/SVG/page 只进 sandbox="allow-scripts" 的 iframe（不带 allow-same-origin），
//     绝不注入聊天 DOM；iframe 加 referrerpolicy="no-referrer"。
//   * 受保护内容先用 api.getBlob 带 Bearer 读取，再生成 blob URL；blob URL 统一登记，
//     切房间或重建消息列表时由 resetAttachmentUrls() 释放。
//   * 预览模式（无后端）由调用方传 live:false，这里直接返回 null。

import { isAuthError } from './api-client.js'
import { el } from './dom.js'
import {
  MAX_INLINE_IMAGE_BYTES,
  formatBytes,
  isImageMime,
  normalizeAttachment,
  renderModeOf,
  requiresSandbox,
} from './artifacts.js'
import {
  downloadButton,
  renderCodeCard,
  renderDownloadCard,
  renderPdfCard,
  renderSandboxCard,
  renderTableCard,
} from './attachment-cards.js'
import {
  currentGeneration,
  fetchAttachment,
  isStale,
  metaRow,
  openOverlay,
  releaseObjectUrl,
  trackObjectUrl,
} from './attachment-runtime.js'
import * as ui from './ui.js'

export { resetAttachmentUrls } from './attachment-runtime.js'

/**
 * @param {unknown} attachments 消息 JSON 的 attachments
 * @param {{live: boolean, api: {getBlob: Function}, requirePair?: Function}} ctx
 * @returns {HTMLElement|null}
 */
export function renderAttachmentList(attachments, ctx) {
  if (!ctx || ctx.live !== true) return null
  const items = (Array.isArray(attachments) ? attachments : []).map(normalizeAttachment)
  if (items.length === 0) return null
  const wrap = el('div', { class: 'msg-attachments', role: 'group', 'aria-label': '附件' })
  for (const item of items) wrap.append(renderAttachment(item, ctx))
  return wrap
}

function renderAttachment(att, ctx) {
  if (requiresSandbox(att.kind, att.mime)) return renderSandboxCard(att, ctx)
  let mode = renderModeOf(att.kind, att.size, att.mime)
  // renderModeOf 对未知 kind + image mime 仍返回 inline-image；这里补上大小/类型判断。
  if (mode === 'inline-image' && (att.size > MAX_INLINE_IMAGE_BYTES || !isImageMime(att.mime))) {
    mode = 'card-download'
  }
  switch (mode) {
    case 'inline-image':
      return renderImage(att, ctx)
    case 'card-preview':
      return renderPdfCard(att, ctx)
    case 'sandbox-frame':
      return renderSandboxCard(att, ctx)
    case 'table-preview':
      return renderTableCard(att, ctx)
    case 'code-block':
      return renderCodeCard(att, ctx)
    default:
      return renderDownloadCard(att, ctx)
  }
}

function renderImage(att, ctx) {
  const card = el('div', { class: 'attachment attachment-image' })
  const frame = el('div', { class: 'attachment-image-frame' })
  const token = currentGeneration()
  let loading = false

  const fail = (message) => {
    if (isStale(token)) return
    const error = el('p', { class: 'attachment-error', role: 'alert', hidden: true })
    const actions = el('div', { class: 'attachment-actions' }, [
      ui.button('重试', { size: 'sm', variant: 'ghost', onClick: () => start() }),
      downloadButton(att, ctx, error),
    ])
    frame.replaceChildren(
      el('div', { class: 'attachment-fail' }, [
        el('p', { class: 'attachment-fail-text', text: `图片加载失败：${message}` }),
        actions,
        error,
      ])
    )
  }

  async function load() {
    loading = true
    frame.replaceChildren(el('p', { class: 'attachment-hint muted', text: '图片加载中…' }))
    try {
      const { blob } = await fetchAttachment(ctx, att)
      if (isStale(token)) return
      const url = trackObjectUrl(blob)
      if (!url) throw new Error('当前环境不能生成图片地址')
      const image = el('img', {
        class: 'attachment-thumb',
        src: url,
        alt: att.name || '图片附件',
        loading: 'lazy',
        decoding: 'async',
        tabindex: '0',
        role: 'button',
        'aria-haspopup': 'dialog',
        'aria-label': `查看图片：${att.name || '图片附件'}`,
      })
      image.addEventListener('click', () => openLightbox(att, url))
      image.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          openLightbox(att, url)
        }
      })
      image.addEventListener('error', () => {
        releaseObjectUrl(url)
        fail('图片无法解码')
      })
      frame.replaceChildren(image)
    } catch (error) {
      if (isAuthError(error)) {
        ctx.requirePair?.()
        return
      }
      fail(error instanceof Error ? error.message : String(error))
    } finally {
      loading = false
    }
  }

  function start() {
    if (isStale(token) || loading) return
    void load()
  }

  const observer =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer.disconnect()
            start()
          }
        })
      : null
  if (observer) observer.observe(frame)
  else start()
  frame.replaceChildren(el('p', { class: 'attachment-hint muted', text: '图片加载中…' }))

  card.append(frame, metaRow(att))
  return card
}

function openLightbox(att, url) {
  openOverlay({
    label: `查看图片：${att.name || '图片附件'}`,
    panelClass: 'attachment-lightbox',
    content: [
      el('img', { class: 'attachment-lightbox-img', src: url, alt: att.name || '图片附件' }),
      el('p', {
        class: 'attachment-lightbox-caption muted',
        text: `${att.name || '图片附件'} · ${formatBytes(att.size)}`,
      }),
    ],
  })
}
