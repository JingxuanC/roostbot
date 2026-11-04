// 附件渲染的共享运行时：blob URL 生命周期、动作按钮、弹层与错误展示。
// 所有附件卡片都从这里取 helper，保证切房间/重建列表时只释放一次、不泄漏。

import { isAuthError } from './api-client.js'
import { el } from './dom.js'
import { formatBytes, kindLabel, withRawQuery } from './artifacts.js'
import * as ui from './ui.js'

let generation = 0
const trackedUrls = new Set()
const overlays = new Set()

/** 切房间 / 重建消息列表时调用：释放所有 blob URL，并关掉可能还开着的灯箱。 */
export function resetAttachmentUrls() {
  generation += 1
  for (const url of [...trackedUrls]) releaseObjectUrl(url)
  for (const close of [...overlays]) close()
}

export function currentGeneration() {
  return generation
}

export function isStale(token) {
  return token !== generation
}

export function trackObjectUrl(blob) {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return ''
  const url = URL.createObjectURL(blob)
  trackedUrls.add(url)
  return url
}

export function releaseObjectUrl(url) {
  if (!url) return
  trackedUrls.delete(url)
  try {
    URL.revokeObjectURL(url)
  } catch {
    // 已释放或环境不支持：忽略。
  }
}

export function hideError(node) {
  if (!node) return
  node.hidden = true
  node.textContent = ''
}

export function showError(node, error, ctx) {
  if (isAuthError(error)) {
    ctx.requirePair?.()
    return
  }
  if (!node) return
  node.textContent = error instanceof Error ? error.message : String(error)
  node.hidden = false
}

/** 动作按钮的忙碌态与错误落点；错误只显示在卡片内，不整屏报错。 */
export async function runAction(button, busyLabel, ctx, errorNode, task) {
  const label = button.textContent
  button.disabled = true
  button.textContent = busyLabel
  hideError(errorNode)
  try {
    await task()
  } catch (error) {
    showError(errorNode, error, ctx)
  } finally {
    button.disabled = false
    button.textContent = label
  }
}

export async function fetchAttachment(ctx, att, raw = false) {
  if (!att.url) throw new Error('附件地址缺失，无法读取')
  return ctx.api.getBlob(raw ? withRawQuery(att.url) : att.url)
}

export function triggerDownload(blob, name) {
  const url = trackObjectUrl(blob)
  if (!url) return
  const link = el('a', { href: url, download: name, hidden: true })
  document.body.append(link)
  link.click()
  link.remove()
  // 给浏览器留出开始下载的时间；切房间时也会统一释放，重复释放无副作用。
  setTimeout(() => releaseObjectUrl(url), 60_000)
}

export function triggerOpen(blob) {
  const url = trackObjectUrl(blob)
  if (!url) return
  const link = el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', hidden: true })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => releaseObjectUrl(url), 5 * 60_000)
}

export function openOverlay(options) {
  const overlay = el('div', {
    class: 'attachment-overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': options.label,
  })
  const panel = el('div', { class: `attachment-panel ${options.panelClass || ''}`.trim() })
  const head = el('div', { class: 'attachment-panel-head' })
  head.append(el('span', { class: 'attachment-panel-title', text: options.label }))
  const closeButton = ui.button('关闭', { size: 'sm', variant: 'ghost' })
  head.append(closeButton)
  const body = el('div', { class: 'attachment-panel-body' })
  for (const child of Array.isArray(options.content) ? options.content : [options.content]) {
    if (child) body.append(child)
  }
  panel.append(head, body)
  overlay.append(panel)

  function close() {
    document.removeEventListener('keydown', onKey)
    overlay.remove()
    overlays.delete(close)
    if (options.onClose) options.onClose()
  }
  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }
  closeButton.addEventListener('click', close)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  document.addEventListener('keydown', onKey)
  document.body.append(overlay)
  overlays.add(close)
  closeButton.focus()
  return { overlay, close }
}

export function metaRow(att) {
  const row = el('div', { class: 'attachment-meta' })
  row.append(el('span', { class: 'attachment-kind', text: kindLabel(att.kind) }))
  row.append(el('span', { class: 'attachment-name', text: att.name || '未命名附件' }))
  row.append(el('span', { class: 'attachment-size muted', text: formatBytes(att.size) }))
  return row
}

export function cardShell(att, extraClass) {
  const card = el('article', { class: `attachment attachment-card ${extraClass || ''}`.trim() })
  card.append(metaRow(att))
  const actions = el('div', { class: 'attachment-actions' })
  const error = el('p', { class: 'attachment-error', role: 'alert', hidden: true })
  card.append(actions, error)
  return { card, actions, error }
}
