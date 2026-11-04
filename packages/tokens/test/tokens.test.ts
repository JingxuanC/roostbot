// packages/tokens 的 token 树、CSS 文本与 apps/web/styles.css 的手写同步。
// 零构建：styles.css 的 :root 是手写复制的，这个测试是两边唯一的一致性保障。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  color,
  cssVarEntries,
  cssVariables,
  cssVars,
  flattenTokens,
  fontSize,
  lineHeight,
  radius,
  shadow,
  space,
  tokens,
  zIndex,
} from '../src/index.ts'

const STYLES = fileURLToPath(new URL('../../../apps/web/styles.css', import.meta.url))

const DARK_CSS = `--roost-bg: #0B0C0E;
--roost-surface: #141619;
--roost-border: #24272C;
--roost-ink: #E8EAEF;
--roost-muted: #8B93A3;
--roost-accent: #D8AB52;
--roost-ok: #7FB37F;
--roost-warn: #D9A441;
--roost-danger: #D2726A;
--roost-font-size-xs: 12px;
--roost-font-size-sm: 13px;
--roost-font-size-md: 14px;
--roost-font-size-lg: 16px;
--roost-font-size-xl: 20px;
--roost-font-size-xxl: 24px;
--roost-font-size-display: 32px;
--roost-leading-body: 1.5;
--roost-leading-title: 1.3;
--roost-space-xs: 4px;
--roost-space-sm: 8px;
--roost-space-md: 12px;
--roost-space-lg: 16px;
--roost-space-xl: 24px;
--roost-space-xxl: 32px;
--roost-space-xxxl: 48px;
--roost-radius-sm: 6px;
--roost-radius-md: 10px;
--roost-radius-lg: 14px;
--roost-radius-full: 999px;
--roost-shadow-none: none;
--roost-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.24);
--roost-shadow-md: 0 12px 32px rgba(0, 0, 0, 0.36);
--roost-shadow-lg: 0 24px 64px rgba(0, 0, 0, 0.5);
--roost-z-base: 0;
--roost-z-raised: 5;
--roost-z-sticky: 10;
--roost-z-header: 30;
--roost-z-nav: 40;
--roost-z-overlay: 1000;
--roost-z-skip-link: 2000;
--roost-font-sans: -apple-system, "SF Pro Text", "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
--roost-font-mono: ui-monospace, "SF Mono", Menlo, monospace;
--roost-motion-fast: 120ms;
--roost-motion-base: 180ms;
--roost-motion-slow: 240ms;
--roost-motion-reduced: 0ms;
--roost-easing: cubic-bezier(0.2, 0.8, 0.2, 1);`

function rootDeclarations() {
  const css = readFileSync(STYLES, 'utf8')
  const start = css.indexOf(':root')
  assert.notEqual(start, -1, 'styles.css 里必须有 :root')
  const end = css.indexOf('}', start)
  assert.notEqual(end, -1, ':root 必须有闭合括号')
  const block = css.slice(start, end)
  const declarations = new Map()
  for (const match of block.matchAll(/(--roost-[a-z0-9-]+):\s*([^;]+);/g)) {
    declarations.set(match[1], match[2].trim())
  }
  return declarations
}

test('token 树包含颜色/字号/行高/间距/圆角/阴影/层叠，外加字体与动效', () => {
  assert.deepEqual(Object.keys(tokens), [
    'color',
    'fontSize',
    'lineHeight',
    'space',
    'radius',
    'shadow',
    'zIndex',
    'font',
    'motion',
  ])
  assert.equal(Object.keys(color.dark).length, 9)
  assert.equal(Object.keys(color.light).length, 9)
  assert.deepEqual(Object.keys(fontSize), ['xs', 'sm', 'md', 'lg', 'xl', 'xxl', 'display'])
  assert.deepEqual(Object.keys(lineHeight), ['body', 'title'])
  assert.deepEqual(Object.keys(space), ['xs', 'sm', 'md', 'lg', 'xl', 'xxl', 'xxxl'])
  assert.deepEqual(Object.keys(radius), ['sm', 'md', 'lg', 'full'])
  assert.deepEqual(Object.keys(shadow), ['none', 'sm', 'md', 'lg'])
  assert.deepEqual(Object.keys(zIndex), ['base', 'raised', 'sticky', 'header', 'nav', 'overlay', 'skipLink'])
})

test('flattenTokens：深浅两套颜色 + 全部基础 token，共 56 个且键唯一', () => {
  const flat = flattenTokens()
  const keys = Object.keys(flat)
  assert.equal(keys.length, 56)
  assert.equal(new Set(keys).size, keys.length)
  for (const theme of ['dark', 'light']) {
    for (const key of Object.keys(color[theme])) {
      assert.equal(typeof flat[`color.${theme}.${key}`], 'string')
    }
  }
})

test('flattenTokens：数值按组补单位，行高/层级/行高保持无单位', () => {
  const flat = flattenTokens()
  assert.equal(flat['space.md'], '12px')
  assert.equal(flat['radius.full'], '999px')
  assert.equal(flat['fontSize.display'], '32px')
  assert.equal(flat['motion.fast'], '120ms')
  assert.equal(flat['motion.reduced'], '0ms')
  assert.equal(flat['lineHeight.body'], '1.5')
  assert.equal(flat['zIndex.overlay'], '1000')
  assert.equal(flat['color.dark.bg'], '#0B0C0E')
  assert.match(flat['font.sans'], /PingFang SC/)
  assert.equal(flat['motion.easing'], 'cubic-bezier(0.2, 0.8, 0.2, 1)')
})

test('cssVariables：每行都是 --roost-*: value;，没有 undefined/NaN/空值', () => {
  const lines = cssVariables('dark').split('\n')
  assert.ok(lines.length >= 40)
  for (const line of lines) {
    assert.match(line, /^--roost-[a-z0-9-]+: .+;$/)
    assert.ok(!line.includes('undefined'), `坏值：${line}`)
    assert.ok(!line.includes('NaN'), `坏值：${line}`)
  }
})

test('cssVariables：深色主题全文快照', () => {
  assert.equal(cssVariables('dark'), DARK_CSS)
})

test('cssVariables：变量名唯一（快照之外再防一次重复键）', () => {
  const names = cssVarEntries('dark').map(([name]) => name)
  assert.equal(new Set(names).size, names.length)
  const lightNames = cssVarEntries('light').map(([name]) => name)
  assert.deepEqual(lightNames, names, '深浅主题的变量名集合必须一致')
})

test('cssVariables：浅色主题只换颜色，其余 token 不变', () => {
  const dark = new Map(cssVarEntries('dark'))
  const light = new Map(cssVarEntries('light'))
  assert.equal(light.get('--roost-bg'), color.light.bg)
  assert.equal(light.get('--roost-ink'), color.light.ink)
  assert.notEqual(light.get('--roost-bg'), dark.get('--roost-bg'))
  for (const [name, value] of dark) {
    if (name === '--roost-bg' || name === '--roost-surface' || name === '--roost-border' ||
        name === '--roost-ink' || name === '--roost-muted' || name === '--roost-accent' ||
        name === '--roost-ok' || name === '--roost-warn' || name === '--roost-danger') continue
    assert.equal(light.get(name), value, `${name} 不该跟着主题变`)
  }
})

test('cssVars 旧 API 与 cssVariables 同源', () => {
  const vars = cssVars('dark')
  assert.deepEqual(Object.fromEntries(cssVarEntries('dark')), vars)
  assert.equal(vars['--roost-space-md'], '12px')
  assert.equal(vars['--roost-font-sans'], tokens.font.sans)
})

test('styles.css 的 :root 与 cssVariables("dark") 逐条一致', () => {
  const declarations = rootDeclarations()
  const entries = cssVarEntries('dark')
  assert.equal(declarations.size, entries.length, ':root 的 --roost-* 数量与 tokens 不一致')
  for (const [name, value] of entries) {
    assert.equal(declarations.get(name), value, `${name} 在 styles.css 与 tokens 中不一致`)
  }
  const tokenNames = new Set(entries.map(([name]) => name))
  for (const name of declarations.keys()) {
    assert.ok(tokenNames.has(name), `${name} 在 styles.css 里有，但 tokens 没有`)
  }
})
