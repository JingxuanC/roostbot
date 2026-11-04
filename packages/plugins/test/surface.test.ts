import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DSH_WEB_PORT, canEmbedPanel, dshWebBasePath, iframeAttrs, panelProxyUrl } from '../src/index.ts'

test('反代路径按 workspace 拼，特殊字符被替换', () => {
  assert.equal(dshWebBasePath('ws_01ABC'), '/w/ws_01ABC/dsh/')
  assert.equal(dshWebBasePath('ws/../x'), '/w/ws____x/dsh/') // 路径穿越被吃掉
})

test('面板 URL 带 panel 查询参数，空 panel 回根', () => {
  assert.equal(panelProxyUrl('ws_1', 'market-board'), '/w/ws_1/dsh/?panel=market-board')
  assert.equal(panelProxyUrl('ws_1'), '/w/ws_1/dsh/')
})

test('iframe 必须独立源且不给 same-origin', () => {
  const attrs = iframeAttrs()
  assert.doesNotMatch(attrs.sandbox, /same-origin/)
  assert.match(attrs.sandbox, /allow-scripts/)
})

test('D 级不能嵌；没有面板的插件不需要嵌', () => {
  assert.equal(canEmbedPanel('C', true), true)
  assert.equal(canEmbedPanel('A', true), true)
  assert.equal(canEmbedPanel('D', true), false)
  assert.equal(canEmbedPanel('C', false), false)
})

test('端口是约定值', () => {
  assert.equal(DSH_WEB_PORT, 4099)
})
