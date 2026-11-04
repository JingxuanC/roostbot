import assert from 'node:assert/strict'
import { test } from 'node:test'

import { panelFailureMessage, panelProxyPath, panelStateLabel } from '../lib/panels.js'

test('panelProxyPath：固定前缀，根路径与面板子路径', () => {
  assert.equal(panelProxyPath('ws_1'), '/w/ws_1/dsh/')
  assert.equal(panelProxyPath('ws-1', ''), '/w/ws-1/dsh/')
  assert.equal(panelProxyPath('ws-1', 'market'), '/w/ws-1/dsh/market')
  assert.equal(panelProxyPath('ws-1', 'plugins/market/index.html'), '/w/ws-1/dsh/plugins/market/index.html')
})

test('panelProxyPath：workspaceId 非法时返回 null', () => {
  for (const value of ['', 'ws 1', 'ws/1', 'ws?x=1', '../ws', 'ws.1', 'ws:1', null, undefined, 42]) {
    assert.equal(panelProxyPath(value as unknown as string), null, String(value))
  }
})

test('panelProxyPath：拒绝路径穿越与非法字符', () => {
  const bad = [
    '..',
    '../secret',
    'a/../../b',
    'a/..',
    './a',
    'a//b',
    '/etc/passwd',
    '//evil.example/x',
    'a?b=1',
    'a#frag',
    'a%2e%2e%2fb',
    'a b',
    'a\\b',
    'a:b',
    'a'.repeat(513),
  ]
  for (const value of bad) assert.equal(panelProxyPath('ws_1', value), null, value)
})

test('panelStateLabel：idle/loading/ready/failed 与未知状态', () => {
  assert.equal(panelStateLabel('idle'), '等待启动')
  assert.equal(panelStateLabel('loading'), '面板容器启动中…')
  assert.equal(panelStateLabel('ready'), '面板已就绪')
  assert.equal(panelStateLabel('failed'), '面板未就绪')
  assert.equal(panelStateLabel('whatever'), '状态未知')
})

test('panelFailureMessage：401/403/404/502/503 与超时、网络', () => {
  assert.match(panelFailureMessage(401), /401/)
  assert.match(panelFailureMessage(401), /重新配对/)
  assert.match(panelFailureMessage(403), /没有权限/)
  assert.match(panelFailureMessage(404), /找不到/)
  assert.match(panelFailureMessage(502), /插件面板未就绪/)
  assert.match(panelFailureMessage(502), /沙箱可能未启动/)
  assert.match(panelFailureMessage(503), /未就绪/)
  assert.match(panelFailureMessage(0, 'timeout'), /超时/)
  assert.match(panelFailureMessage(0, 'timeout'), /沙箱可能未启动/)
  assert.match(panelFailureMessage(0, 'network'), /连不上控制面/)
  assert.match(panelFailureMessage(418), /HTTP 418/)
})
