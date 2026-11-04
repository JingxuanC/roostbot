// 写接口限流（M6-6.6）：令牌桶、429 rate_limited、Retry-After、注入时钟回填。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  upsertMarketPlugin,
  upsertPublisher,
  upsertVersion,
} from '../../../packages/store/src/index.ts'
import { RATE_LIMITS } from '../src/rate-limit.ts'
import { pairDevice, startHarness, startSqliteHarness } from './helpers.ts'

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)

test('发消息：30/分钟/账号，超限 429 + Retry-After，注入时钟回填', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())
  const token = await pairDevice(harness)

  const workspace = await harness.call('POST', '/api/workspaces', {
    token,
    body: { name: '限流房间' },
  })
  const workspaceId = workspace.json.workspace.id as string
  const room = await harness.call('POST', '/api/rooms', {
    token,
    body: { workspaceId, name: '限流房间' },
  })
  assert.equal(room.status, 201)
  const roomId = room.json.room.id as string

  const capacity = RATE_LIMITS.messages.capacity
  for (let index = 0; index < capacity; index += 1) {
    const posted = await harness.call('POST', `/api/rooms/${roomId}/messages`, {
      token,
      body: { text: `消息 ${index}` },
    })
    assert.equal(posted.status, 201, `第 ${index + 1} 条应放行`)
  }

  const limited = await harness.call('POST', `/api/rooms/${roomId}/messages`, {
    token,
    body: { text: '超限' },
  })
  assert.equal(limited.status, 429)
  assert.equal(limited.json.error.code, 'rate_limited')
  const retryAfter = Number(limited.headers.get('retry-after'))
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1)

  // 桶按时间匀速回填：一个窗口后恢复完整容量。
  harness.clock.advance(RATE_LIMITS.messages.windowMs)
  const recovered = await harness.call('POST', `/api/rooms/${roomId}/messages`, {
    token,
    body: { text: '恢复' },
  })
  assert.equal(recovered.status, 201)
})

test('插件安装：10/小时/账号，超限 429；未认证请求不消耗桶', async (t) => {
  const savedAllow = process.env['ROOST_PLUGIN_ALLOWLIST']
  process.env['ROOST_PLUGIN_ALLOWLIST'] = 'rate-plugin'
  const harness = await startSqliteHarness()
  t.after(() => { if (savedAllow === undefined) delete process.env['ROOST_PLUGIN_ALLOWLIST']; else process.env['ROOST_PLUGIN_ALLOWLIST'] = savedAllow })
  t.after(() => harness.close())
  const token = await pairDevice(harness)
  const workspace = await harness.call('POST', '/api/workspaces', {
    token,
    body: { name: '插件限流' },
  })
  const workspaceId = workspace.json.workspace.id as string
  const store = harness.rawStore
  assert.ok(store)

  upsertPublisher(store, { id: 'pub_rate', name: 'Rate', verified: true, registry: 'roost', at: NOW })
  upsertMarketPlugin(store, {
    slug: 'rate-plugin',
    title: '限流插件',
    publisherId: 'pub_rate',
    category: '工具',
    tier: 'A',
    summary: '测试用',
    latest: '1.0.0',
    updatedAt: NOW,
  })
  upsertVersion(store, {
    slug: 'rate-plugin',
    version: '1.0.0',
    integrity: 'sha512-rate',
    engines: '^0.2.1-alpha.2',
    manifest: { engines: '^0.2.1-alpha.2' },
    permissions: {},
    publishedAt: NOW - 2 * 86_400_000,
  })

  const installPath = '/api/marketplace/plugins/rate-plugin/install'
  const body = { workspaceId, version: '1.0.0' }

  // 401 在鉴权阶段就返回，不进入令牌桶。
  const anonymous = await harness.call('POST', installPath, { body })
  assert.equal(anonymous.status, 401)

  const capacity = RATE_LIMITS.pluginInstall.capacity
  for (let index = 0; index < capacity; index += 1) {
    const installed = await harness.call('POST', installPath, { token, body })
    assert.ok(installed.status === 202 || installed.status === 200, `第 ${index + 1} 次应放行`)
  }

  const limited = await harness.call('POST', installPath, { token, body })
  assert.equal(limited.status, 429)
  assert.equal(limited.json.error.code, 'rate_limited')
  const retryAfter = Number(limited.headers.get('retry-after'))
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1)

  // 10/小时 = 每 6 分钟回填 1 个令牌。
  harness.clock.advance(RATE_LIMITS.pluginInstall.windowMs / RATE_LIMITS.pluginInstall.capacity)
  const recovered = await harness.call('POST', installPath, { token, body })
  assert.ok(recovered.status === 202 || recovered.status === 200, `recovered got ${recovered.status}`)
})
