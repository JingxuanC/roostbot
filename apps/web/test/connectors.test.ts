import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_ACTIONS,
  MAX_ACTION_CHARS,
  actionsText,
  canManageConnectors,
  connectButtonLabel,
  connectorActions,
  connectorErrorText,
  connectorGrantPayload,
  connectorStatusKind,
  connectorStatusLabel,
  grantAccessLabel,
  grantActionSelection,
  grantForBot,
  grantSummary,
  isConnectorConnected,
  isConnectorForbidden,
  isConnectorNotConfigured,
  isConnectorNotReady,
  isSafeAuthUrl,
  parseActionInput,
  validateGrantForm,
} from '../lib/connectors.js'

test('连接状态文案与徽章：已连接/过期/撤销/未连接，未知值原样显示', () => {
  assert.equal(connectorStatusLabel('connected'), '已连接')
  assert.equal(connectorStatusLabel('expired'), '已过期')
  assert.equal(connectorStatusLabel('revoked'), '已撤销')
  assert.equal(connectorStatusLabel(null), '未连接')
  assert.equal(connectorStatusLabel(''), '未连接')
  assert.equal(connectorStatusLabel('weird'), 'weird')

  assert.equal(connectorStatusKind('connected'), 'ok')
  assert.equal(connectorStatusKind('expired'), 'warn')
  assert.equal(connectorStatusKind('revoked'), 'danger')
  assert.equal(connectorStatusKind(null), '')
})

test('isConnectorConnected 优先看 connected 布尔，再看 status', () => {
  assert.equal(isConnectorConnected({ connected: true, status: null }), true)
  assert.equal(isConnectorConnected({ connected: false, status: 'connected' }), true)
  assert.equal(isConnectorConnected({ status: 'expired' }), false)
  assert.equal(isConnectorConnected(null), false)
})

test('未连接按钮：过期/撤销用「重新连接」，其余用「连接」', () => {
  assert.equal(connectButtonLabel('expired'), '重新连接')
  assert.equal(connectButtonLabel('revoked'), '重新连接')
  assert.equal(connectButtonLabel(null), '连接')
  assert.equal(connectButtonLabel('connected'), '连接')
})

test('动作展示：去空去重，空清单诚实写「无」', () => {
  assert.deepEqual(connectorActions({ actions: ['list', '', 'list', 'send'] }), ['list', 'send'])
  assert.deepEqual(connectorActions(['get', null, 3, 'get']), ['get'])
  assert.deepEqual(connectorActions(null), [])
  assert.equal(actionsText(['list', 'send']), 'list、send')
  assert.equal(actionsText([]), '无')
  assert.equal(actionsText(null), '无')
})

test('角色：只有 owner/admin（或未知角色）显示管理控件', () => {
  assert.equal(canManageConnectors('owner'), true)
  assert.equal(canManageConnectors('admin'), true)
  assert.equal(canManageConnectors(''), true)
  assert.equal(canManageConnectors('member'), false)
  assert.equal(canManageConnectors('viewer'), false)
})

test('授权回填：已知动作勾选，未知动作进逗号输入；null 不自动勾满', () => {
  assert.equal(grantAccessLabel('read'), '只读')
  assert.equal(grantAccessLabel('write'), '读写')
  assert.equal(grantAccessLabel(''), '未指定')
  assert.equal(grantAccessLabel('custom'), 'custom')

  assert.deepEqual(
    grantActionSelection(
      { actions: ['list_issues', 'delete_repo'] },
      ['list_issues', 'create_issue']
    ),
    { checked: ['list_issues'], extraText: 'delete_repo' }
  )
  assert.deepEqual(grantActionSelection(null, ['list_issues']), { checked: [], extraText: '' })
  assert.deepEqual(grantActionSelection({ actions: null }, ['list_issues']), {
    checked: [],
    extraText: '',
  })
})

test('grantForBot / grantSummary：按 Bot 找授权，null 不等于全部动作', () => {
  const grants = [
    { botId: 'b1', access: 'read', actions: null },
    { botId: 'b2', access: 'write', actions: ['list', 'send'] },
  ]
  assert.equal(grantForBot(grants, 'b2').access, 'write')
  assert.equal(grantForBot(grants, 'missing'), null)
  assert.equal(grantForBot(null, 'b1'), null)

  assert.equal(grantSummary(null), '当前没有这个 Bot 的授权。')
  assert.equal(grantSummary(grants[0]), '当前：只读 · 全部动作')
  assert.equal(grantSummary(grants[1]), '当前：读写 · 2 个动作')
  assert.equal(grantSummary({ access: 'read', actions: [] }), '当前：只读 · 全部动作')
})

test('逗号输入：中英文逗号与换行都认，去空去重', () => {
  assert.deepEqual(parseActionInput('a, b，c\nd'), { ok: true, actions: ['a', 'b', 'c', 'd'] })
  assert.deepEqual(parseActionInput(' a ,, a '), { ok: true, actions: ['a'] })
  assert.deepEqual(parseActionInput(''), { ok: true, actions: [] })
  assert.deepEqual(parseActionInput(null), { ok: true, actions: [] })

  const tooLong = parseActionInput('x'.repeat(MAX_ACTION_CHARS + 1))
  assert.equal(tooLong.ok, false)
  const tooMany = parseActionInput(
    Array.from({ length: MAX_ACTIONS + 1 }, (_, index) => `a${index}`).join(',')
  )
  assert.equal(tooMany.ok, false)
})

test('授权表单校验：access 只能是 read/write，动作空 = 全部', () => {
  assert.deepEqual(validateGrantForm({ access: 'read' }), { ok: true, access: 'read', actions: null })
  assert.deepEqual(
    validateGrantForm({ access: 'write', selectedActions: ['a', 'b'], extraActions: 'b, c' }),
    { ok: true, access: 'write', actions: ['a', 'b', 'c'] }
  )
  const invalid = validateGrantForm({ access: 'admin' })
  assert.equal(invalid.ok, false)
  assert.match((invalid as { error: string }).error, /read/)

  const longAction = validateGrantForm({ access: 'read', selectedActions: ['x'.repeat(MAX_ACTION_CHARS + 1)] })
  assert.equal(longAction.ok, false)
})

test('PUT 请求体：actions 为空时省略；workspace/bot/access 缺失返回 null', () => {
  assert.deepEqual(connectorGrantPayload({ workspaceId: 'w', botId: 'b', access: 'read' }), {
    workspaceId: 'w',
    botId: 'b',
    access: 'read',
  })
  assert.deepEqual(
    connectorGrantPayload({ workspaceId: 'w', botId: 'b', access: 'write', actions: ['send', 'send'] }),
    { workspaceId: 'w', botId: 'b', access: 'write', actions: ['send'] }
  )
  assert.equal(connectorGrantPayload({ workspaceId: '', botId: 'b', access: 'read' }), null)
  assert.equal(connectorGrantPayload({ workspaceId: 'w', botId: 'b', access: 'bad' }), null)
})

test('降级判定：403 / 未配置 / 未就绪只认确定的状态码', () => {
  assert.equal(isConnectorForbidden({ status: 403 }), true)
  assert.equal(isConnectorForbidden({ code: 'forbidden' }), true)
  assert.equal(isConnectorForbidden({ status: 401 }), false)

  assert.equal(isConnectorNotConfigured({ status: 501 }), true)
  assert.equal(isConnectorNotConfigured({ code: 'connector.not_configured' }), true)
  assert.equal(isConnectorNotConfigured({ status: 503 }), false)

  assert.equal(isConnectorNotReady({ status: 405 }), true)
  assert.equal(isConnectorNotReady({ status: 501 }), true)
  assert.equal(isConnectorNotReady({ status: 503, code: 'runtime.not_configured' }), true)
  assert.equal(isConnectorNotReady({ status: 404, code: 'not_found' }), true)
  assert.equal(isConnectorNotReady({ status: 404, code: 'connector.not_found' }), false)
  assert.equal(isConnectorNotReady({ status: 400 }), false)
})

test('错误文案：401 回配对、403 按操作区分、501/503 说明未就绪', () => {
  assert.match(connectorErrorText({ status: 401 }, 'view'), /重新配对/)
  assert.match(connectorErrorText({ status: 403 }, 'connect'), /owner\/admin 可发起连接/)
  assert.match(connectorErrorText({ status: 403 }, 'save'), /owner\/admin 可修改连接器授权/)
  assert.match(connectorErrorText({ status: 501, code: 'connector.not_configured' }, 'connect'), /网关未配置/)
  assert.match(connectorErrorText({ status: 503, code: 'runtime.not_configured' }, 'view'), /接口未就绪/)
  assert.match(connectorErrorText({ status: 404, code: 'not_found' }, 'view'), /接口未就绪/)
  assert.equal(connectorErrorText({ status: 400, message: 'bad input' }, 'save'), 'bad input')
  assert.equal(connectorErrorText(null), '操作失败，请重试。')
})

test('授权地址只放行 http/https，阻止 javascript:/data: 等', () => {
  assert.equal(isSafeAuthUrl('https://auth.example.com/oauth?x=1'), true)
  assert.equal(isSafeAuthUrl('http://localhost:8080/callback'), true)
  assert.equal(isSafeAuthUrl('javascript:alert(1)'), false)
  assert.equal(isSafeAuthUrl('data:text/html,hello'), false)
  assert.equal(isSafeAuthUrl('ftp://example.com/a'), false)
  assert.equal(isSafeAuthUrl('not a url'), false)
  assert.equal(isSafeAuthUrl(null), false)
})
