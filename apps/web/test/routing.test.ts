import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  canonicalWorkspaceRoute,
  isKnownRoute,
  normalizeHash,
  routeMatch,
} from '../lib/routing.js'

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

test('设置页有独立路由，且不带参数', () => {
  assert.equal(routeMatch('#/settings').name, 'settings')
  assert.deepEqual(routeMatch('#/settings').params, {})
  assert.equal(routeMatch('#/settings/').name, 'settings')
  assert.equal(routeMatch('#/settings/x').name, 'notFound')
})

test('用量页有独立路由，且不带参数', () => {
  assert.equal(routeMatch('#/usage').name, 'usage')
  assert.deepEqual(routeMatch('#/usage').params, {})
  assert.equal(routeMatch('#/usage/').name, 'usage')
  assert.equal(routeMatch('usage').name, 'usage')
  assert.equal(routeMatch('#/usage/x').name, 'notFound')
})

test('定时任务页有独立路由，且不带参数', () => {
  assert.equal(routeMatch('#/home').name, 'home')
  assert.equal(routeMatch('#/routines').name, 'routines')
  assert.equal(routeMatch('#/schedules').name, 'schedules')
  assert.deepEqual(routeMatch('#/schedules').params, {})
  assert.equal(routeMatch('#/schedules/').name, 'schedules')
  assert.equal(routeMatch('schedules').name, 'schedules')
  assert.equal(routeMatch('#/schedules/x').name, 'notFound')
})

test('连接器页有独立路由，且不带参数', () => {
  assert.equal(routeMatch('#/connectors').name, 'connectors')
  assert.deepEqual(routeMatch('#/connectors').params, {})
  assert.equal(routeMatch('#/connectors/').name, 'connectors')
  assert.equal(routeMatch('connectors').name, 'connectors')
  assert.equal(routeMatch('#/connectors/x').name, 'notFound')
})

test('插件市场：列表与详情都带独立路由', () => {
  const list = routeMatch('#/plugins')
  assert.equal(list.name, 'plugins')
  assert.deepEqual(list.params, {})
  assert.equal(routeMatch('#/plugins/').name, 'plugins')
  assert.equal(routeMatch('plugins').name, 'plugins')

  const detail = routeMatch('#/plugins/market-center')
  assert.equal(detail.name, 'plugin')
  assert.equal(detail.params.slug, 'market-center')
  assert.equal(routeMatch('#/plugins/%E8%A1%8C%E6%83%85').params.slug, '行情')

  assert.equal(routeMatch('#/plugins/a/b').name, 'notFound')
  assert.equal(routeMatch('#/plugins/%E4').name, 'notFound')
})

test('插件面板：固定一层，不带参数', () => {
  const match = routeMatch('#/panels')
  assert.equal(match.name, 'panels')
  assert.deepEqual(match.params, {})
  assert.equal(routeMatch('#/panels/').name, 'panels')
  assert.equal(routeMatch('panels').name, 'panels')
  assert.equal(routeMatch('#/panels/market').name, 'notFound')
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

test('多端深链：解析 #/w/:ws/room/:id、#/w/:ws/bot/:id、#/w/:ws/approvals', () => {
  const room = routeMatch('#/w/ws_1/room/r_1')
  assert.equal(room.name, 'workspaceRoom')
  assert.deepEqual(room.params, { workspaceId: 'ws_1', id: 'r_1' })

  const bot = routeMatch('#/w/ws_1/bot/b_1')
  assert.equal(bot.name, 'workspaceBot')
  assert.deepEqual(bot.params, { workspaceId: 'ws_1', id: 'b_1' })

  const approvals = routeMatch('#/w/ws_1/approvals')
  assert.equal(approvals.name, 'workspaceApprovals')
  assert.deepEqual(approvals.params, { workspaceId: 'ws_1' })

  // 尾斜杠、不带 #、URL 编码都照常处理。
  assert.equal(routeMatch('#/w/ws_1/room/r_1/').name, 'workspaceRoom')
  assert.equal(routeMatch('w/ws_1/approvals').name, 'workspaceApprovals')
  assert.equal(routeMatch('#/w/ws%201/room/r%202').params.id, 'r 2')
})

test('多端深链：缺段、多段、坏编码都是 notFound', () => {
  for (const hash of [
    '#/w',
    '#/w/ws_1',
    '#/w/ws_1/room',
    '#/w/ws_1/bot',
    '#/w/ws_1/room/r_1/extra',
    '#/w/ws_1/settings',
    '#/w//room/r_1',
    '#/w/ws_1/room/%E4',
  ]) {
    assert.equal(routeMatch(hash).name, 'notFound', hash)
  }
})

test('深链规范化：workspace 一致 → 内部路由与 canonical hash', () => {
  const room = canonicalWorkspaceRoute(routeMatch('#/w/ws_1/room/r_1'), 'ws_1')
  assert.deepEqual(room, {
    status: 'ok',
    match: { name: 'room', params: { id: 'r_1' }, path: '/rooms/r_1' },
    hash: '#/rooms/r_1',
  })

  const bot = canonicalWorkspaceRoute(routeMatch('#/w/ws_1/bot/b_1'), 'ws_1')
  assert.deepEqual(bot, {
    status: 'ok',
    match: { name: 'bot', params: { id: 'b_1' }, path: '/bots/b_1' },
    hash: '#/bots/b_1',
  })

  const approvals = canonicalWorkspaceRoute(routeMatch('#/w/ws_1/approvals'), 'ws_1')
  assert.deepEqual(approvals, {
    status: 'ok',
    match: { name: 'approvals', params: {}, path: '/approvals' },
    hash: '#/approvals',
  })

  // id 进 hash 时重新编码，避免空格/中文破坏地址栏。
  assert.equal(
    canonicalWorkspaceRoute(routeMatch('#/w/ws_1/room/r%202'), 'ws_1')?.hash,
    '#/rooms/r%202'
  )
})

test('深链规范化：workspace 不一致 → mismatch，不静默跳转', () => {
  assert.deepEqual(canonicalWorkspaceRoute(routeMatch('#/w/ws_other/room/r_1'), 'ws_1'), {
    status: 'mismatch',
    workspaceId: 'ws_other',
  })
  // 当前 workspace 未知时也按不一致处理，绝不猜。
  assert.equal(canonicalWorkspaceRoute(routeMatch('#/w/ws_1/approvals'), '')?.status, 'mismatch')
  // 非深链路由返回 null。
  assert.equal(canonicalWorkspaceRoute(routeMatch('#/bots/b_1'), 'ws_1'), null)
})

test('isKnownRoute 只认路由表里的名字', () => {
  assert.equal(isKnownRoute('bots'), true)
  assert.equal(isKnownRoute('approvals'), true)
  assert.equal(isKnownRoute('plugins'), true)
  assert.equal(isKnownRoute('plugin'), true)
  assert.equal(isKnownRoute('panels'), true)
  assert.equal(isKnownRoute('settings'), true)
  assert.equal(isKnownRoute('usage'), true)
  assert.equal(isKnownRoute('schedules'), true)
  assert.equal(isKnownRoute('connectors'), true)
  assert.equal(isKnownRoute('workspaceRoom'), true)
  assert.equal(isKnownRoute('workspaceBot'), true)
  assert.equal(isKnownRoute('workspaceApprovals'), true)
  assert.equal(isKnownRoute('nope'), false)
})
