// 消息附件的纯逻辑：渲染模式、大小阈值、CSV/TSV 解析、代码折叠与下载名清理。
//
// 这是 packages/artifacts/src/types.ts 的等价重写：浏览器不能直接 import .ts，
// 所以规则只在这里维护一份，并用 test/artifacts.test.ts 锁住。
// 本文件不碰 DOM；文件名/内容如何进页面由 lib/attachments.js 负责（只走 textContent）。

export const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
export const PREVIEW_ROWS = 20
export const COLLAPSE_LINES = 20
export const MAX_TABLE_PREVIEW_BYTES = 20 * 1024 * 1024

const KINDS = new Set(['image', 'pdf', 'html', 'table', 'code', 'page'])

/** 渲染策略：与 packages/artifacts 的 renderModeOf 保持一致。 */
export function renderModeOf(kind, size, mime) {
  const bytes = Number(size)
  const safeSize = Number.isFinite(bytes) && bytes >= 0 ? bytes : 0
  const type = lowerMime(mime)
  if (kind === 'image') return safeSize > MAX_INLINE_IMAGE_BYTES ? 'card-download' : 'inline-image'
  if (kind === 'pdf') return 'card-preview'
  if (kind === 'html' || kind === 'page') return 'sandbox-frame'
  if (kind === 'table') return 'table-preview'
  if (kind === 'code') return 'code-block'
  // 未知类型：按 mime 兜底。
  if (type.startsWith('image/')) return 'inline-image'
  return 'card-download'
}

/** HTML/SVG 永远不能内联进聊天 DOM：它们是脚本。 */
export function requiresSandbox(kind, mime) {
  const type = lowerMime(mime)
  return (
    kind === 'html' ||
    kind === 'page' ||
    type === 'image/svg+xml' ||
    type === 'text/html' ||
    type === 'application/xhtml+xml'
  )
}

export function isImageMime(mime) {
  return lowerMime(mime).startsWith('image/')
}

/** 把后端附件对象收敛成前端可安全消费的形状。 */
export function normalizeAttachment(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const artifactId =
    typeof source.artifactId === 'string'
      ? source.artifactId
      : typeof source.id === 'string'
        ? source.id
        : ''
  const kind = KINDS.has(source.kind) ? source.kind : 'unknown'
  const size = Number(source.size)
  return {
    artifactId,
    kind,
    name: cleanDisplayName(source.name),
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    mime: typeof source.mime === 'string' ? source.mime : '',
    url: typeof source.url === 'string' ? source.url : '',
  }
}

export function kindLabel(kind) {
  switch (kind) {
    case 'image':
      return '图片'
    case 'pdf':
      return 'PDF'
    case 'html':
      return '网页'
    case 'table':
      return '表格'
    case 'code':
      return '代码'
    case 'page':
      return '页面'
    default:
      return '附件'
  }
}

/** 人类可读的大小；0 也显示成 0 B，不显示 NaN。 */
export function formatBytes(size) {
  const bytes = Number(size)
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  const text = value >= 10 ? value.toFixed(0) : value.toFixed(1)
  return `${text.replace(/\.0$/, '')} ${units[unit]}`
}

/** 下载文件名：去掉路径分隔符/控制字符，避免浏览器把名字当路径或渲染异常。 */
export function downloadName(name) {
  const base = cleanDisplayName(name).replace(/[\\/:*?"<>|]/g, '_').trim()
  if (base === '' || base === '.' || base === '..') return 'attachment'
  return base.length > 120 ? `${base.slice(0, 120)}…` : base
}

/** 强制下载：保留原有查询参数。 */
export function withRawQuery(url) {
  const text = String(url ?? '')
  if (text === '') return ''
  const hashIndex = text.indexOf('#')
  const head = hashIndex === -1 ? text : text.slice(0, hashIndex)
  const hash = hashIndex === -1 ? '' : text.slice(hashIndex)
  return `${head}${head.includes('?') ? '&' : '?'}raw=1${hash}`
}

const CODE_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'css', 'csv', 'go', 'h', 'hpp', 'html', 'ini', 'java', 'js', 'json', 'jsx',
  'kt', 'less', 'log', 'lua', 'md', 'mjs', 'php', 'pl', 'proto', 'py', 'rb', 'rs', 'scss', 'sh',
  'sql', 'swift', 'toml', 'ts', 'tsv', 'tsx', 'txt', 'vue', 'xml', 'yaml', 'yml', 'zsh',
])

/** code 附件是否值得按文本读取；二进制（zip/png 等）退回下载卡片。 */
export function isTextLike(mime, name) {
  const type = lowerMime(mime)
  if (type.startsWith('text/')) return true
  if (
    type === 'application/json' ||
    type === 'application/xml' ||
    type === 'application/javascript' ||
    type === 'application/x-javascript' ||
    type === 'application/sql' ||
    type === 'application/x-sh' ||
    type === 'application/yaml' ||
    type === 'application/x-yaml'
  ) {
    return true
  }
  if (type.endsWith('+json') || type.endsWith('+xml')) return true
  return CODE_EXTENSIONS.has(codeExtension(name))
}

/**
 * table 附件的分隔符：CSV 逗号、TSV/TXT 制表符；XLSX 等二进制返回 ''（退下载）。
 * 纯文本也按制表符解析：没有制表符时就是单列表格。
 */
export function delimiterFor(mime, name) {
  const type = lowerMime(mime)
  const ext = codeExtension(name)
  if (ext === 'csv' || type === 'text/csv' || type === 'application/csv') return ','
  if (ext === 'tsv' || type === 'text/tab-separated-values') return '\t'
  if (ext === 'txt' || type === 'text/plain') return '\t'
  return ''
}

/**
 * 零依赖分隔符解析：支持引号包裹、字段内逗号/换行、"" 转义、CRLF。
 * 空行与末尾换行不产生记录。
 */
export function parseDelimited(text, delimiter = ',') {
  // 有些导出器会带 BOM；不剥掉的话第一个表头会变成不可见字符。
  const source = String(text ?? '').replace(/^\uFEFF/, '')
  if (source === '') return []
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === delimiter) {
      row.push(field)
      field = ''
      continue
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1
      row.push(field)
      field = ''
      if (!(row.length === 1 && row[0] === '')) rows.push(row)
      row = []
      continue
    }
    field += char
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
  }
  return rows
}

/** 表格预览：第一行当表头，最多 PREVIEW_ROWS 行；同时返回总行数。 */
export function parseTablePreview(text, options = {}) {
  const delimiter = options.delimiter || ','
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : PREVIEW_ROWS
  const rows = parseDelimited(text, delimiter)
  const previewRows = rows.slice(0, limit)
  let columns = 0
  for (const row of previewRows) columns = Math.max(columns, row.length)
  return {
    delimiter,
    rows: previewRows,
    header: previewRows[0] || [],
    body: previewRows.slice(1),
    columns,
    totalRows: rows.length,
    truncated: rows.length > previewRows.length,
  }
}

/** 代码折叠：超过 maxLines 行才折叠；末尾换行不算一行。 */
export function collapseCode(text, maxLines = COLLAPSE_LINES) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const limit = Number.isSafeInteger(maxLines) && maxLines > 0 ? maxLines : COLLAPSE_LINES
  return {
    lines,
    visibleLines: lines.slice(0, limit),
    total: lines.length,
    collapsed: lines.length > limit,
  }
}

function lowerMime(mime) {
  return typeof mime === 'string' ? mime.split(';', 1)[0].trim().toLowerCase() : ''
}

function codeExtension(name) {
  const text = typeof name === 'string' ? name : ''
  const index = text.lastIndexOf('.')
  return index === -1 || index === text.length - 1 ? '' : text.slice(index + 1).toLowerCase()
}

function cleanDisplayName(name) {
  const text = typeof name === 'string' ? name : ''
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code >= 32 && code !== 127) out += char
  }
  return out.trim()
}
