// 浅蓝主题与「打开就是房间」外壳的静态约束。
// 这里不跑浏览器，只锁住 index.html / styles-blue.css 里最容易回退的几件事。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const css = readFileSync(new URL('../styles-blue.css', import.meta.url), 'utf8')

test('移动端 viewport 允许缩放，且不再锁死深色', () => {
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1"/)
  assert.doesNotMatch(html, /maximum-scale\s*=\s*1/)
  assert.doesNotMatch(html, /name="color-scheme" content="dark"/)
  assert.match(html, /name="color-scheme" content="light"/)
})

test('浅蓝主题在 styles.css 之后加载，并且定义了完整色板', () => {
  const base = html.indexOf('styles.css')
  const blue = html.indexOf('styles-blue.css')
  assert.ok(base >= 0 && blue > base, 'styles-blue.css 必须在 styles.css 之后')
  for (const token of ['#f2f8fc', '#ffffff', '#d9e6f0', '#15232e', '#5f7485', '#1f5c86']) {
    assert.ok(css.toLowerCase().includes(token), `缺少 token ${token}`)
  }
})

test('外壳：抽屉 + 关闭态不可聚焦 + 管理入口都在设置里', () => {
  assert.match(css, /\.room\.sidebar-open \.sidebar/)
  assert.match(css, /transform: translateX\(-104%\)/)
  assert.match(html, /id="sidebar-toggle"/)
  assert.match(html, /class="drawer-manage"/)
  assert.match(html, /id="page-back"/)
  assert.match(css, /\.page-nav\s*\{\s*display: none/)
})

test('手机断点与触控尺寸', () => {
  assert.match(css, /@media \(max-width: 720px\)/)
  assert.match(css, /env\(safe-area-inset-bottom\)/)
  assert.match(css, /min-height: 44px|height: 44px/)
  assert.match(css, /font-size: 16px/)
})
