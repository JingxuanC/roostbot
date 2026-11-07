// Bot runtime 控制面 API（docs/design/agent-runtimes.md §10–§11）。
// 真 SQLite + store-adapter + 真 HTTP；覆盖 create/list/get/PATCH 的 runtime 字段、
// 默认 dsh、非法值拒绝和“从不回传 secret”。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pairDevice, startSqliteHarness } from './helpers.ts'
import type { Harness } from './helpers.ts'

interface BotBody {
  bot: {
    id: string
    name: string
    runtimeKind: string
    runtimeConfig?: Record<string, unknown>
    credentialRef?: string
    capabilities?: Record<string, unknown>
  }
}

interface Setup {
  harness: Harness
  token: string
  workspaceId: string
}

async function setup(): Promise<Setup> {
  const harness = await startSqliteHarness()
  const token = await pairDevice(harness)
  const workspace = await harness.call('POST', '/api/workspaces', {
    token,
    body: { name: 'runtime-api' },
  })
  assert.equal(workspace.status, 201, workspace.text)
  return { harness, token, workspaceId: workspace.json.workspace.id as string }
}

async function createBot(
  ctx: Setup,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<BotBody['bot']> {
  const response = await ctx.harness.call('POST', '/api/bots', {
    token: ctx.token,
    body: { workspaceId: ctx.workspaceId, name, model: 'deepseek-v3', ...extra },
  })
  assert.equal(response.status, 201, `create bot failed: ${response.status} ${response.text}`)
  return (response.json as BotBody).bot
}

function rawBot(ctx: Setup, botId: string): Record<string, unknown> {
  const row = ctx.harness.rawStore?.db
    .prepare('SELECT * FROM bots WHERE id = ?')
    .get(botId) as Record<string, unknown> | undefined
  assert.ok(row, `raw bot ${botId} missing`)
  return row
}

test('创建 Bot 默认 runtimeKind=dsh；list/get 都暴露 runtimeKind', async () => {
  const ctx = await setup()
  try {
    const bot = await createBot(ctx, '默认运行时')
    assert.equal(bot.runtimeKind, 'dsh')
    assert.equal(bot.runtimeConfig, undefined)
    assert.equal(bot.credentialRef, undefined)
    assert.equal(bot.capabilities, undefined)

    const detail = await ctx.harness.call('GET', `/api/bots/${bot.id}`, { token: ctx.token })
    assert.equal(detail.status, 200)
    assert.equal((detail.json as BotBody).bot.runtimeKind, 'dsh')

    const list = await ctx.harness.call('GET', `/api/bots?workspaceId=${ctx.workspaceId}`, { token: ctx.token })
    assert.equal(list.status, 200)
    const listed = (list.json as { bots: BotBody['bot'][] }).bots
    assert.equal(listed[0]?.runtimeKind, 'dsh')
    assert.ok(!JSON.stringify(listed).includes('runtime_config'))
  } finally {
    await ctx.harness.close()
  }
})

test('创建 Bot 可带 runtimeConfig/credentialRef/capabilities；落库且不回传 secret', async () => {
  const ctx = await setup()
  try {
    const capabilities = { streaming: true, tools: 'native', mcp: true }
    const bot = await createBot(ctx, '外部运行时', {
      runtimeKind: 'claude-code',
      runtimeConfig: { model: 'sonnet', apiKey: 'sk-super-secret', token: 'tok-secret' },
      credentialRef: 'vault://claude-code',
      capabilities,
    })
    assert.equal(bot.runtimeKind, 'claude-code')
    assert.equal(bot.credentialRef, 'vault://claude-code')
    assert.deepEqual(bot.capabilities, capabilities)
    assert.deepEqual(bot.runtimeConfig, { model: 'sonnet', apiKey: '[redacted]', token: '[redacted]' })

    // 安全：HTTP 响应（含 list/get）不能出现 secret 原文。
    const detail = await ctx.harness.call('GET', `/api/bots/${bot.id}`, { token: ctx.token })
    const list = await ctx.harness.call('GET', `/api/bots?workspaceId=${ctx.workspaceId}`, { token: ctx.token })
    for (const response of [detail, list]) {
      assert.equal(response.status, 200)
      assert.ok(!response.text.includes('sk-super-secret'), `secret leaked: ${response.text}`)
      assert.ok(!response.text.includes('tok-secret'), `secret leaked: ${response.text}`)
    }

    // 持久化：raw SQLite 的 runtime_config 是 JSON，capabilities 也是 JSON。
    const row = rawBot(ctx, bot.id)
    assert.equal(row['runtime_kind'], 'claude-code')
    assert.equal(row['credential_ref'], 'vault://claude-code')
    assert.match(String(row['runtime_config']), /sk-super-secret/)
    assert.deepEqual(JSON.parse(String(row['capabilities'])), capabilities)
  } finally {
    await ctx.harness.close()
  }
})

test('PATCH runtime 字段：替换/清空/保留 runtimeKind，默认 dsh 不被误改', async () => {
  const ctx = await setup()
  try {
    const bot = await createBot(ctx, '可改运行时')
    assert.equal(bot.runtimeKind, 'dsh')

    const patched = await ctx.harness.call('PATCH', `/api/bots/${bot.id}`, {
      token: ctx.token,
      body: {
        runtimeKind: 'codex',
        runtimeConfig: { model: 'o3', secret: 'hidden' },
        credentialRef: 'vault://codex',
        capabilities: { resume: true },
      },
    })
    assert.equal(patched.status, 200, patched.text)
    const updated = (patched.json as BotBody).bot
    assert.equal(updated.runtimeKind, 'codex')
    assert.equal(updated.credentialRef, 'vault://codex')
    assert.deepEqual(updated.runtimeConfig, { model: 'o3', secret: '[redacted]' })
    assert.deepEqual(updated.capabilities, { resume: true })
    assert.ok(!patched.text.includes('hidden'))

    const cleared = await ctx.harness.call('PATCH', `/api/bots/${bot.id}`, {
      token: ctx.token,
      body: { runtimeConfig: null, credentialRef: null, capabilities: null },
    })
    assert.equal(cleared.status, 200, cleared.text)
    const afterClear = (cleared.json as BotBody).bot
    assert.equal(afterClear.runtimeKind, 'codex')
    assert.equal(afterClear.runtimeConfig, undefined)
    assert.equal(afterClear.credentialRef, undefined)
    assert.equal(afterClear.capabilities, undefined)

    const row = rawBot(ctx, bot.id)
    assert.equal(row['runtime_kind'], 'codex')
    assert.equal(row['runtime_config'], null)
    assert.equal(row['credential_ref'], null)
    assert.equal(row['capabilities'], null)
  } finally {
    await ctx.harness.close()
  }
})

test('非法 runtimeKind/runtimeConfig/capabilities/credentialRef 都返回 bot.invalid', async () => {
  const ctx = await setup()
  try {
    for (const body of [
      { runtimeKind: 'grok' },
      { runtimeKind: null },
      { runtimeConfig: 'not-an-object' },
      { runtimeConfig: [1, 2] },
      { capabilities: [] },
      { capabilities: 'streaming' },
      { credentialRef: '' },
      { credentialRef: 42 },
    ]) {
      const response = await ctx.harness.call('POST', '/api/bots', {
        token: ctx.token,
        body: { workspaceId: ctx.workspaceId, name: `非法-${JSON.stringify(body).slice(0, 12)}`, model: 'deepseek-v3', ...body },
      })
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}: ${response.text}`)
      assert.equal((response.json as { error: { code: string } }).error.code, 'bot.invalid')
    }

    const bot = await createBot(ctx, 'PATCH 校验')
    for (const body of [
      { runtimeKind: 'dsh2' },
      { runtimeConfig: 'x' },
      { capabilities: [1] },
      { credentialRef: '' },
    ]) {
      const response = await ctx.harness.call('PATCH', `/api/bots/${bot.id}`, { token: ctx.token, body })
      assert.equal(response.status, 400, `expected 400 for PATCH ${JSON.stringify(body)}: ${response.text}`)
      assert.equal((response.json as { error: { code: string } }).error.code, 'bot.invalid')
    }
  } finally {
    await ctx.harness.close()
  }
})

test('PATCH 只改 runtime 字段时其它字段保持不变，且不再写入 secret', async () => {
  const ctx = await setup()
  try {
    const bot = await createBot(ctx, '只改运行时', {
      runtimeKind: 'hermes',
      runtimeConfig: { endpoint: 'http://127.0.0.1:9000' },
    })
    const patched = await ctx.harness.call('PATCH', `/api/bots/${bot.id}`, {
      token: ctx.token,
      body: { runtimeConfig: { endpoint: 'http://127.0.0.1:9001', apiToken: 'tok-2' } },
    })
    assert.equal(patched.status, 200)
    const updated = (patched.json as BotBody).bot
    assert.equal(updated.runtimeKind, 'hermes')
    assert.deepEqual(updated.runtimeConfig, { endpoint: 'http://127.0.0.1:9001', apiToken: '[redacted]' })
    assert.ok(!patched.text.includes('tok-2'))
    assert.equal(rawBot(ctx, bot.id)['runtime_kind'], 'hermes')
  } finally {
    await ctx.harness.close()
  }
})
