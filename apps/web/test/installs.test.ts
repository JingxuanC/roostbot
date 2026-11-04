import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ApiError } from '../lib/api-client.js'
import {
  INSTALL_POLL_MAX_MS,
  installActionPath,
  installActionRequest,
  installActions,
  installIdFromResponse,
  installJobError,
  installResponsePlan,
  installStateBadge,
  installStateLabel,
  installsListPath,
  isInstallTerminal,
  permissionDisclosure,
  pollDecision,
  preflightFromError,
  toolSourceRows,
} from '../lib/installs.js'

test('权限披露：固定顺序 network/credentials/disk/binaries/panels，缺省显示“无”', () => {
  const rows = permissionDisclosure({
    permissions: {
      network: ['api.tushare.pro', '*.eastmoney.com'],
      credentials: ['tushare'],
      diskBytes: 320_000_000,
      binaries: ['python3'],
      panels: 2,
    },
  })
  assert.deepEqual(rows.map((row) => row.key), ['network', 'credentials', 'disk', 'binaries', 'panels'])
  assert.equal(rows[0].text, 'api.tushare.pro、*.eastmoney.com')
  assert.equal(rows[1].text, 'tushare')
  assert.equal(rows[2].text, '320 MB')
  assert.equal(rows[3].text, 'python3')
  assert.equal(rows[4].text, '2 个')
  assert.deepEqual(rows.map((row) => row.missing), [false, false, false, false, false])
})

test('权限披露：requirements 优先于 permissions；全空时每项都是“无”且 missing', () => {
  const rows = permissionDisclosure({
    permissions: { network: ['old.example'], disk: '1 GB', panels: 1 },
    requirements: { network: ['new.example'], dataMounts: ['bars'] },
  })
  assert.equal(rows.find((row) => row.key === 'network')?.text, 'new.example')
  assert.equal(rows.find((row) => row.key === 'disk')?.text, '1 GB')
  assert.equal(rows.find((row) => row.key === 'panels')?.text, '1 个')
  assert.equal(rows.find((row) => row.key === 'dataMounts')?.text, 'bars')

  const empty = permissionDisclosure({})
  assert.equal(empty.length, 5)
  for (const row of empty) {
    assert.equal(row.text, '无')
    assert.equal(row.missing, true)
  }
})

test('409 plugin.preflight：取 problems / permissions / tier；其它错误返回 null', () => {
  const error = new ApiError('plugin.preflight', '预检未通过', {
    status: 409,
    body: {
      ok: false,
      error: { code: 'plugin.preflight', message: '预检未通过' },
      tier: 'D',
      permissions: { network: ['x.example'] },
      problems: [{ code: 'tier-unsupported', detail: '仅桌面' }, 'signature missing'],
    },
  })
  const preflight = preflightFromError(error)
  assert.ok(preflight)
  assert.equal(preflight?.tier, 'D')
  assert.deepEqual(preflight?.problems, [
    { code: 'tier-unsupported', detail: '仅桌面' },
    { code: 'problem', detail: 'signature missing' },
  ])
  assert.equal(preflight?.permissions?.network?.[0], 'x.example')
  assert.equal(preflightFromError(new ApiError('http_500', 'x', { status: 500 })), null)
  assert.equal(preflightFromError(new ApiError('other', 'x', { status: 409 })), null)
})

test('202/200 响应计划：approval / job / install / unknown', () => {
  assert.equal(installResponsePlan({ job: { state: 'awaiting-approval' } }).kind, 'approval')
  assert.equal(installResponsePlan({ job: { state: 'installing' }, approval: { id: 'a1' } }).kind, 'approval')
  assert.equal(installResponsePlan({ job: { state: 'installing' } }).kind, 'job')
  assert.equal(installResponsePlan({ install: { id: 'i1', state: 'installed' } }).kind, 'install')
  assert.equal(installResponsePlan({}).kind, 'unknown')
  assert.equal(installResponsePlan(null).kind, 'unknown')
})

test('installIdFromResponse：job.installId / install_id / install.id 都能用', () => {
  assert.equal(installIdFromResponse({ job: { installId: 'i1' } }), 'i1')
  assert.equal(installIdFromResponse({ job: { install_id: 'i2' } }), 'i2')
  assert.equal(installIdFromResponse({ install: { id: 'i3' } }), 'i3')
  assert.equal(installIdFromResponse({}), '')
})

test('轮询计划：隐藏暂停、60s 停止、终态停止、否则等待', () => {
  const startedAt = 1_000
  assert.equal(pollDecision({ visible: false, startedAt, now: 2_000, state: 'installing' }), 'pause')
  assert.equal(pollDecision({ visible: true, startedAt: 0, now: 2_000, state: 'installing' }), 'wait')
  assert.equal(pollDecision({ visible: true, startedAt, now: startedAt + INSTALL_POLL_MAX_MS, state: 'installing' }), 'stop')
  assert.equal(pollDecision({ visible: true, startedAt, now: 2_000, state: 'installed' }), 'stop')
  assert.equal(pollDecision({ visible: true, startedAt, now: 2_000, state: 'installing' }), 'wait')
})

test('安装状态文案与终态：installing 不是“已安装”', () => {
  assert.equal(installStateLabel('installing'), '安装中')
  assert.match(installStateBadge('awaiting-approval'), /等待批准/)
  assert.equal(installStateLabel('weird'), 'weird')
  assert.equal(isInstallTerminal('installed'), true)
  assert.equal(isInstallTerminal('failed'), true)
  assert.equal(isInstallTerminal('installing'), false)
})

test('已安装动作：更新看 latest，启停互补，回滚只认历史版本/失败', () => {
  const update = installActions({ id: 'i1', version: '1.0.0', latest: '1.2.0', enabled: true })
  assert.equal(update.update, true)
  assert.equal(update.updateVersion, '1.2.0')
  assert.equal(update.disable, true)
  assert.equal(update.enable, false)
  assert.equal(update.uninstall, true)
  assert.equal(update.rollback, false)

  const disabled = installActions({ id: 'i2', version: '1.2.0', latest: '1.2.0', enabled: false, previousVersion: '1.0.0' })
  assert.equal(disabled.update, false)
  assert.equal(disabled.enable, true)
  assert.equal(disabled.rollback, true)
})

test('动作路径与请求体：update 必须带版本，其它动作不带 body', () => {
  assert.equal(installsListPath('ws 1'), '/api/plugin-installs?workspaceId=ws%201')
  assert.equal(installsListPath(''), '/api/plugin-installs')
  assert.equal(installActionPath('i 1', 'disable'), '/api/plugin-installs/i%201/disable')
  assert.equal(installActionPath('i1', 'nope'), '')
  assert.deepEqual(installActionRequest({ id: 'i1', latest: '2.0.0' }, 'update'), {
    path: '/api/plugin-installs/i1/update',
    body: { version: '2.0.0' },
  })
  assert.equal(installActionRequest({ id: 'i1', latest: '' }, 'update'), null)
  assert.deepEqual(installActionRequest({ id: 'i1' }, 'uninstall'), {
    path: '/api/plugin-installs/i1/uninstall',
    body: undefined,
  })
})

test('Bot 工具来源：bot.tools 自带 source 时直接显示', () => {
  const rows = toolSourceRows({
    bot: {
      tools: [
        { name: 'mcp__data__realtime', source: '行情中心' },
        'plain_tool',
        { name: 'report_engine.run', source: '报告引擎' },
      ],
    },
    installs: [],
  })
  assert.deepEqual(rows, [
    { name: 'mcp__data__realtime', source: '行情中心' },
    { name: 'report_engine.run', source: '报告引擎' },
  ])
})

test('Bot 工具来源：bot.tools 没有 source 时用 installs[].tools 反查', () => {
  const rows = toolSourceRows({
    bot: { tools: ['mcp__data__realtime', { name: 'report_engine.run' }] },
    installs: [
      { slug: 'market-center', title: '行情中心', tools: ['mcp__data__realtime'] },
      { slug: 'report-engine', tools: [{ name: 'report_engine.run', source: '报告引擎' }] },
    ],
  })
  assert.deepEqual(rows, [
    { name: 'mcp__data__realtime', source: '行情中心' },
    { name: 'report_engine.run', source: '报告引擎' },
  ])
})

test('Bot 工具来源：没有来源就不显示；bot 没 tools 时退回 installs[].tools', () => {
  assert.deepEqual(toolSourceRows({ bot: { tools: ['bash'] }, installs: [] }), [])
  assert.deepEqual(toolSourceRows({ bot: {}, installs: [] }), [])
  const fallback = toolSourceRows({
    bot: {},
    installs: [{ slug: 'market-center', title: '行情中心', tools: ['mcp__data__realtime'] }],
  })
  assert.deepEqual(fallback, [{ name: 'mcp__data__realtime', source: '行情中心' }])
})

test('安装任务错误原样带出，空值不编造原因', () => {
  assert.equal(installJobError({ error: 'pnpm install failed' }), 'pnpm install failed')
  assert.equal(installJobError({ message: 'boom' }), 'boom')
  assert.equal(installJobError({}), '')
})
