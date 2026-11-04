import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  isDshNotRunning,
  isPanelsListMissing,
  legacyPanelsListPath,
  panelFramePath,
  panelOpenFailure,
  panelWakePayload,
  panelsFromPayload,
  panelsListPath,
} from '../lib/panels.js'

test('panelsListPath：编码 workspaceId；空值走无 query', () => {
  assert.equal(panelsListPath('ws 1'), '/api/plugins/panels?workspaceId=ws%201')
  assert.equal(panelsListPath('ws_1'), '/api/plugins/panels?workspaceId=ws_1')
  assert.equal(panelsListPath(''), '/api/plugins/panels')
})

test('legacyPanelsListPath：新接口 404 时回退到旧控制面路径', () => {
  assert.equal(legacyPanelsListPath('ws 1'), '/api/workspaces/ws%201/panels')
  assert.equal(legacyPanelsListPath(''), '')
})

test('panelWakePayload：只带 workspaceId，不拼 URL', () => {
  assert.deepEqual(panelWakePayload('ws_1'), { workspaceId: 'ws_1' })
  assert.deepEqual(panelWakePayload(''), { workspaceId: '' })
})

test('panelFramePath：同源固定前缀 /w/<ws>/dsh/，非法 workspace 返回 null', () => {
  assert.equal(panelFramePath('ws_1'), '/w/ws_1/dsh/')
  assert.equal(panelFramePath('ws-1'), '/w/ws-1/dsh/')
  assert.equal(panelFramePath('ws/1'), null)
  assert.equal(panelFramePath(''), null)
})

test('panelsFromPayload：兼容 {panels} 与裸数组，忽略无名字项', () => {
  const rows = panelsFromPayload({
    panels: [
      { name: 'market', title: '行情面板', pluginSlug: 'market-center', slot: 'sidebar', path: 'market' },
      { title: '只有标题' },
      { id: 'id-only' },
      null,
      'nope',
      { name: '' },
    ],
  })
  assert.deepEqual(rows, [
    { name: 'market', title: '行情面板', pluginSlug: 'market-center', slot: 'sidebar', path: 'market' },
    { name: '只有标题', title: '只有标题', pluginSlug: '', slot: '', path: '' },
    { name: 'id-only', title: '', pluginSlug: '', slot: '', path: '' },
  ])
  assert.deepEqual(panelsFromPayload(null), [])
  assert.deepEqual(panelsFromPayload([{ name: 'a' }]), [
    { name: 'a', title: '', pluginSlug: '', slot: '', path: '' },
  ])
})

test('404/405/501 才算清单未上线；其它错误不降级成空清单', () => {
  assert.equal(isPanelsListMissing({ status: 404 }), true)
  assert.equal(isPanelsListMissing({ status: 405 }), true)
  assert.equal(isPanelsListMissing({ status: 501 }), true)
  assert.equal(isPanelsListMissing({ status: 500 }), false)
  assert.equal(isPanelsListMissing({ status: 403 }), false)
  assert.equal(isPanelsListMissing(null), false)
})

test('503 dsh.not_running：面板未运行，可重试且有明确说明', () => {
  const error = { status: 503, code: 'dsh.not_running' }
  assert.equal(isDshNotRunning(error), true)
  assert.equal(isDshNotRunning({ status: 503, code: 'other' }), false)
  assert.equal(isDshNotRunning({ status: 500, code: 'dsh.not_running' }), false)
  const failure = panelOpenFailure(error)
  assert.equal(failure.title, '面板未运行')
  assert.match(failure.message, /dsh\.not_running/)
  assert.equal(failure.retryable, true)
})

test('panelOpenFailure：404 / 403 / 超时 / 网络各自给原因', () => {
  assert.equal(panelOpenFailure({ status: 404 }).title, '面板接口未就绪')
  assert.equal(panelOpenFailure({ status: 403 }).retryable, false)
  assert.match(panelOpenFailure({ status: 0, code: 'timeout' }).message, /15 秒/)
  assert.match(panelOpenFailure({ status: 0, code: 'network' }).message, /连不上/)
})
