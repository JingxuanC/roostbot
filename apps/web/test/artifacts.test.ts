import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  COLLAPSE_LINES,
  MAX_INLINE_IMAGE_BYTES,
  PREVIEW_ROWS,
  collapseCode,
  delimiterFor,
  downloadName,
  formatBytes,
  isImageMime,
  isTextLike,
  kindLabel,
  normalizeAttachment,
  parseDelimited,
  parseTablePreview,
  renderModeOf,
  requiresSandbox,
  withRawQuery,
} from '../lib/artifacts.js'

test('renderModeOf：六种 kind 与未知类型兜底', () => {
  assert.equal(renderModeOf('image', 1024, 'image/png'), 'inline-image')
  assert.equal(renderModeOf('pdf', 2048, 'application/pdf'), 'card-preview')
  assert.equal(renderModeOf('html', 10, 'text/html'), 'sandbox-frame')
  assert.equal(renderModeOf('page', 10, 'text/html'), 'sandbox-frame')
  assert.equal(renderModeOf('table', 10, 'text/csv'), 'table-preview')
  assert.equal(renderModeOf('code', 10, 'text/plain'), 'code-block')
  assert.equal(renderModeOf('unknown', 10, 'image/jpeg'), 'inline-image')
  assert.equal(renderModeOf('unknown', 10, 'application/zip'), 'card-download')
})

test('图片阈值：正好 8MB 内联，超过 1 字节就只给下载', () => {
  assert.equal(renderModeOf('image', MAX_INLINE_IMAGE_BYTES, 'image/png'), 'inline-image')
  assert.equal(renderModeOf('image', MAX_INLINE_IMAGE_BYTES + 1, 'image/png'), 'card-download')
  assert.equal(renderModeOf('image', Number.NaN, 'image/png'), 'inline-image')
})

test('requiresSandbox：HTML/SVG 永远是脚本', () => {
  assert.equal(requiresSandbox('html', 'text/html'), true)
  assert.equal(requiresSandbox('page', 'text/html'), true)
  assert.equal(requiresSandbox('image', 'image/svg+xml'), true)
  assert.equal(requiresSandbox('unknown', 'application/xhtml+xml'), true)
  assert.equal(requiresSandbox('image', 'image/png'), false)
  assert.equal(requiresSandbox('pdf', 'application/pdf'), false)
})

test('normalizeAttachment：坏字段收敛成稳定形状', () => {
  const att = normalizeAttachment({
    artifactId: 'a1',
    kind: 'image',
    name: '  chart.png  ',
    size: '2048',
    mime: 'image/png',
    url: '/api/messages/7/files/a1',
  })
  assert.deepEqual(att, {
    artifactId: 'a1',
    kind: 'image',
    name: 'chart.png',
    size: 2048,
    mime: 'image/png',
    url: '/api/messages/7/files/a1',
  })
  assert.equal(normalizeAttachment(null).kind, 'unknown')
  assert.equal(normalizeAttachment({ kind: 'exe', size: -1 }).size, 0)
  assert.equal(normalizeAttachment({ name: 'a\u0000b' }).name, 'ab')
})

test('formatBytes 的边界与单位', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1024), '1 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(8 * 1024 * 1024), '8 MB')
  assert.equal(formatBytes(Number.NaN), '0 B')
})

test('downloadName 去掉路径分隔符与控制字符', () => {
  assert.equal(downloadName('../../etc/passwd'), '.._.._etc_passwd')
  assert.equal(downloadName('a:b*c?.pdf'), 'a_b_c_.pdf')
  assert.equal(downloadName('   '), 'attachment')
  assert.equal(downloadName('..'), 'attachment')
})

test('withRawQuery 保留原查询参数', () => {
  assert.equal(withRawQuery('/api/messages/7/files/a1'), '/api/messages/7/files/a1?raw=1')
  assert.equal(withRawQuery('/x?a=1'), '/x?a=1&raw=1')
  assert.equal(withRawQuery(''), '')
})

test('isTextLike / delimiterFor：文本与表格格式判定', () => {
  assert.equal(isTextLike('text/plain', 'x'), true)
  assert.equal(isTextLike('application/json', 'x'), true)
  assert.equal(isTextLike('application/vnd.ms-excel', 'x.csv'), true)
  assert.equal(isTextLike('application/zip', 'x.zip'), false)
  assert.equal(delimiterFor('text/csv', 'x'), ',')
  assert.equal(delimiterFor('application/csv', 'x'), ',')
  assert.equal(delimiterFor('text/tab-separated-values', 'x'), '\t')
  assert.equal(delimiterFor('text/plain', 'x.txt'), '\t')
  assert.equal(delimiterFor('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x.xlsx'), '')
})

test('parseDelimited：引号、逗号、换行、"" 转义与 CRLF', () => {
  assert.deepEqual(parseDelimited('a,b\n1,2\n'), [['a', 'b'], ['1', '2']])
  assert.deepEqual(parseDelimited('"a,b",c\n"x""y",z'), [['a,b', 'c'], ['x"y', 'z']])
  assert.deepEqual(parseDelimited('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']])
  assert.deepEqual(parseDelimited('"line1\nline2",x'), [['line1\nline2', 'x']])
  assert.deepEqual(parseDelimited('a\tb\n1\t2', '\t'), [['a', 'b'], ['1', '2']])
  assert.deepEqual(parseDelimited('\uFEFFa,b\n1,2'), [['a', 'b'], ['1', '2']])
  assert.deepEqual(parseDelimited('\n\n'), [])
  assert.deepEqual(parseDelimited(''), [])
})

test('parseTablePreview：只取前 20 行并给出总行数', () => {
  const text = ['name,value', ...Array.from({ length: 24 }, (_, i) => `r${i},${i}`)].join('\n')
  const parsed = parseTablePreview(text, { delimiter: ',' })
  assert.equal(PREVIEW_ROWS, 20)
  assert.equal(parsed.totalRows, 25)
  assert.equal(parsed.rows.length, 20)
  assert.equal(parsed.body.length, 19)
  assert.equal(parsed.truncated, true)
  assert.deepEqual(parsed.header, ['name', 'value'])
  assert.deepEqual(parsed.body[0], ['r0', '0'])
  assert.equal(parsed.columns, 2)
})

test('collapseCode：超过 20 行折叠，末尾换行不计数', () => {
  assert.equal(COLLAPSE_LINES, 20)
  const twenty = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n') + '\n'
  const exact = collapseCode(twenty)
  assert.equal(exact.total, 20)
  assert.equal(exact.collapsed, false)
  assert.equal(exact.visibleLines.length, 20)

  const many = Array.from({ length: 23 }, (_, i) => `line${i}`).join('\r\n')
  const folded = collapseCode(many)
  assert.equal(folded.total, 23)
  assert.equal(folded.collapsed, true)
  assert.equal(folded.visibleLines.length, 20)
  assert.equal(folded.lines[22], 'line22')
})

test('kindLabel / isImageMime', () => {
  assert.equal(kindLabel('image'), '图片')
  assert.equal(kindLabel('pdf'), 'PDF')
  assert.equal(kindLabel('unknown'), '附件')
  assert.equal(isImageMime('IMAGE/PNG'), true)
  assert.equal(isImageMime('image/svg+xml'), true)
  assert.equal(isImageMime('application/pdf'), false)
})

test('附件 DOM 渲染只走 textContent，不拼 innerHTML', () => {
  const files = ['../lib/attachments.js', '../lib/attachment-cards.js', '../lib/attachment-runtime.js']
  const sources = files.map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
  for (const source of sources) {
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML/.test(source), false)
  }
  assert.match(sources[2], /textContent/)
})
