// 附件卡片：PDF / HTML(沙箱) / 表格 / 代码 / 未知类型下载。
// 文件内容与文件名只进 textContent；HTML/SVG 只经 sandbox iframe。

import { isAuthError } from './api-client.js'
import { el } from './dom.js'
import {
  COLLAPSE_LINES,
  MAX_TABLE_PREVIEW_BYTES,
  PREVIEW_ROWS,
  collapseCode,
  delimiterFor,
  downloadName,
  isTextLike,
  parseTablePreview,
} from './artifacts.js'
import {
  cardShell,
  currentGeneration,
  fetchAttachment,
  isStale,
  openOverlay,
  releaseObjectUrl,
  runAction,
  showError,
  trackObjectUrl,
  triggerDownload,
  triggerOpen,
} from './attachment-runtime.js'
import * as ui from './ui.js'

export function renderPdfCard(att, ctx) {
  const { card, actions, error } = cardShell(att, 'attachment-pdf')
  const token = currentGeneration()
  const download = ui.button('下载', { size: 'sm', variant: 'ghost' })
  const open = ui.button('在新标签打开', { size: 'sm', variant: 'outline' })
  download.addEventListener('click', () =>
    runAction(download, '下载中…', ctx, error, async () => {
      const { blob } = await fetchAttachment(ctx, att, true)
      triggerDownload(blob, downloadName(att.name))
    })
  )
  open.addEventListener('click', () =>
    runAction(open, '打开中…', ctx, error, async () => {
      const { blob } = await fetchAttachment(ctx, att)
      if (isStale(token)) return
      triggerOpen(blob)
    })
  )
  actions.append(download, open)
  return card
}

export function renderSandboxCard(att, ctx) {
  const { card, actions, error } = cardShell(att, 'attachment-sandbox')
  const token = currentGeneration()
  card.append(el('p', { class: 'attachment-note muted', text: '网页在沙箱中打开，不注入聊天。' }))
  const open = ui.button('打开', { size: 'sm', variant: 'outline' })
  open.addEventListener('click', () =>
    runAction(open, '打开中…', ctx, error, async () => {
      const { blob } = await fetchAttachment(ctx, att)
      if (isStale(token)) return
      const url = trackObjectUrl(blob)
      if (!url) throw new Error('当前环境不能生成沙箱地址')
      const frame = el('iframe', {
        class: 'attachment-frame',
        sandbox: 'allow-scripts',
        referrerpolicy: 'no-referrer',
        src: url,
        title: att.name || '网页附件',
      })
      openOverlay({
        label: `打开：${att.name || '网页附件'}`,
        panelClass: 'attachment-sandbox-panel',
        content: frame,
        onClose: () => releaseObjectUrl(url),
      })
    })
  )
  actions.append(open, downloadButton(att, ctx, error))
  return card
}

export function renderTableCard(att, ctx) {
  const { card, actions, error } = cardShell(att, 'attachment-table')
  const delimiter = delimiterFor(att.mime, att.name)
  if (delimiter === '') {
    card.append(el('p', { class: 'attachment-note muted', text: '这个表格格式不能内联预览，请下载后用表格软件打开。' }))
    actions.append(downloadButton(att, ctx, error))
    return card
  }

  const body = el('div', { class: 'attachment-table-body' })
  body.append(el('p', { class: 'attachment-hint muted', text: '点击「预览前 20 行」读取内容。' }))
  card.append(body)
  const token = currentGeneration()
  const preview = ui.button('预览前 20 行', { size: 'sm', variant: 'ghost' })
  preview.addEventListener('click', () =>
    runAction(preview, '解析中…', ctx, error, async () => {
      const { blob } = await fetchAttachment(ctx, att)
      if (isStale(token)) return
      if (blob.size > MAX_TABLE_PREVIEW_BYTES) throw new Error('文件太大，建议直接下载')
      const text = await blob.text()
      const parsed = parseTablePreview(text, { delimiter, limit: PREVIEW_ROWS })
      if (parsed.totalRows === 0) throw new Error('文件里没有可解析的行')
      body.replaceChildren(renderTablePreview(parsed, att.name))
      preview.hidden = true
    })
  )
  actions.append(preview, downloadButton(att, ctx, error))
  return card
}

function renderTablePreview(parsed, name) {
  const wrap = el('div', { class: 'attachment-table-wrap' })
  const table = el('table', { class: 'attachment-table-preview' })
  table.append(el('caption', { class: 'sr-only', text: name || '附件表格预览' }))
  const head = el('thead')
  const headRow = el('tr')
  for (const cell of parsed.header) headRow.append(el('th', { scope: 'col', text: cell === '' ? '—' : cell }))
  head.append(headRow)
  table.append(head)
  const tbody = el('tbody')
  for (const row of parsed.body) {
    const tr = el('tr')
    for (let index = 0; index < parsed.columns; index += 1) {
      tr.append(el('td', { text: row[index] === undefined ? '' : row[index] }))
    }
    tbody.append(tr)
  }
  table.append(tbody)
  wrap.append(table)
  wrap.append(
    el('p', {
      class: 'attachment-hint muted',
      text: parsed.truncated
        ? `共 ${parsed.totalRows} 行，预览前 ${parsed.rows.length} 行（含表头）`
        : `共 ${parsed.totalRows} 行`,
    })
  )
  return wrap
}

export function renderCodeCard(att, ctx) {
  const { card, actions, error } = cardShell(att, 'attachment-code')
  if (!isTextLike(att.mime, att.name)) {
    card.append(el('p', { class: 'attachment-note muted', text: '这个代码文件不是文本格式，请下载查看。' }))
    actions.append(downloadButton(att, ctx, error))
    return card
  }

  const body = el('div', { class: 'attachment-code-body' })
  body.append(el('p', { class: 'attachment-hint muted', text: '代码加载中…' }))
  card.append(body)
  const token = currentGeneration()
  const copy = ui.button('复制', { size: 'sm', variant: 'ghost' })
  copy.disabled = true
  actions.append(copy, downloadButton(att, ctx, error))

  let fullText = ''
  void (async () => {
    try {
      const { blob } = await fetchAttachment(ctx, att)
      if (isStale(token)) return
      fullText = await blob.text()
      const result = collapseCode(fullText, COLLAPSE_LINES)
      const paint = (expanded) => {
        const pre = el('pre', { class: 'attachment-pre' })
        pre.append(el('code', { text: (expanded ? result.lines : result.visibleLines).join('\n') }))
        body.replaceChildren(pre)
        if (result.collapsed) {
          body.append(
            ui.button(expanded ? '收起' : `展开全部（共 ${result.total} 行）`, {
              size: 'sm',
              variant: 'ghost',
              onClick: () => paint(!expanded),
            })
          )
        }
      }
      paint(false)
      copy.disabled = false
    } catch (cause) {
      if (isStale(token)) return
      if (isAuthError(cause)) {
        ctx.requirePair?.()
        return
      }
      body.replaceChildren(
        el('p', {
          class: 'attachment-fail-text',
          text: `代码加载失败：${cause instanceof Error ? cause.message : String(cause)}`,
        })
      )
      showError(error, cause, ctx)
    }
  })()

  copy.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('浏览器不允许写剪贴板')
      }
      await navigator.clipboard.writeText(fullText)
      copy.textContent = '已复制'
      setTimeout(() => {
        if (copy.isConnected) copy.textContent = '复制'
      }, 1500)
    } catch (cause) {
      showError(error, `复制失败：${cause instanceof Error ? cause.message : String(cause)}`, ctx)
    }
  })
  return card
}

export function downloadButton(att, ctx, error) {
  const button = ui.button('下载', { size: 'sm', variant: 'ghost' })
  button.addEventListener('click', () =>
    runAction(button, '下载中…', ctx, error, async () => {
      const { blob } = await fetchAttachment(ctx, att, true)
      triggerDownload(blob, downloadName(att.name))
    })
  )
  return button
}

export function renderDownloadCard(att, ctx) {
  const { card, actions, error } = cardShell(att, 'attachment-download')
  if (!att.url) {
    card.append(el('p', { class: 'attachment-note', text: '附件地址缺失，无法下载。' }))
    return card
  }
  actions.append(downloadButton(att, ctx, error))
  return card
}
