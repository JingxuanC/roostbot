import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isKnownRoute, normalizeHash, routeMatch } from '../lib/routing.js'

test('空 hash / # / #/ 都是配对页', () => {
  for (const hash of ['', '#', '#/', '#//', '   ']) {
    assert.deepEqual(routeMatch(hash), { name: 'pair', params: {}, path: '/' })
  }
})

test('兼容旧的 #room（房间预览）', () => {
  assert.equal(routeMatch('#room').name, 'room')
  assert.equal(routeMatch('#room').params.id, null)
})

test('#/bots 与新建入口', () => {
  assert.equal(routeMatch('#/bots').name, 'bots')
  assert.equal(routeMatch('#/bots/new').name, 'botNew')
})

test('#/bots/:id 取到 id', () => {
  const match = routeMatch('#/bots/bot_01HTEST')
  assert.equal(match.name, 'bot')
  assert.equal(match.params.id, 'bot_01HTEST')
})

test('房间路由：新建 / 房间 / 设置', () => {
  assert.equal(routeMatch('#/rooms/new').name, 'roomNew')
  const room = routeMatch('#/rooms/r_quant')
  assert.equal(room.name, 'room')
  assert.equal(room.params.id, 'r_quant')
  const settings = routeMatch('#/rooms/r_quant/settings')
  assert.equal(settings.name, 'roomSettings')
  assert.equal(settings.params.id, 'r_quant')
})

test('需要你 / 审批页有独立路由，且不带参数', () => {
  const match = routeMatch('#/approvals')
  assert.equal(match.name, 'approvals')
  assert.deepEqual(match.params, {})
  assert.equal(routeMatch('#/approvals/').name, 'approvals')
  assert.equal(routeMatch('#/approvals/x').name, 'notFound')
})

test('尾斜杠与不带 # 的写法都能解析', () => {
  assert.equal(routeMatch('#/bots/').name, 'bots')
  assert.equal(routeMatch('bots/bot_1').name, 'bot')
  assert.equal(normalizeHash('#/rooms/r1/settings/'), '/rooms/r1/settings')
})

test('id 会做 URL 解码', () => {
  assert.equal(routeMatch('#/bots/bot%20one').params.id, 'bot one')
  assert.equal(routeMatch('#/bots/%E9%80%89%E8%82%A1').params.id, '选股')
})

test('未知路径与坏编码都是 notFound，不抛异常', () => {
  assert.equal(routeMatch('#/nope').name, 'notFound')
  assert.equal(routeMatch('#/bots/%E4').name, 'notFound')
  assert.equal(routeMatch('#/rooms/a/settings/extra').name, 'notFound')
})

test('isKnownRoute 只认路由表里的名字', () => {
  assert.equal(isKnownRoute('bots'), true)
  assert.equal(isKnownRoute('approvals'), true)
  assert.equal(isKnownRoute('nope'), false)
})
