// 回归：DSH 的 Messages 请求也必须把 workspace 挂到代理上，否则代理会拒绝记账。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import { createWorkspace } from '../../../packages/store/src/workspaces.ts'
import { issueRuntimeToken } from '../../../packages/store/src/runtime-tokens.ts'
import { grantTokenCredit, getTokenCreditBalance } from '../../../packages/store/src/token-credits.ts'
import { createStorePort } from '../src/store-adapter.ts'
import { startServer } from '../src/server.ts'

test('/v1/messages：runtime token 鉴权 + workspace 归属 + 免费额度扣减', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-proxy-messages-'))
  const store = openStore(join(dir, 'db.sqlite'))
  const prevKey = process.env['ROOST_MODEL_API_KEY']
  process.env['ROOST_MODEL_API_KEY'] = 'sk-platform-test'
  let upstreamAuth = ''
  let upstreamModel = ''
  const started = await startServer({
    store: createStorePort(store),
    rawStore: store,
    now: () => 1_800_000_000_000,
    port: 0,
    host: '127.0.0.1',
    modelKeyMaster: Buffer.alloc(32, 3),
    modelTestFetch: async (_url, init) => {
      upstreamAuth = String((init?.headers as Record<string, string>).authorization ?? '')
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string }
      upstreamModel = body.model ?? ''
      return new Response(JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'PROXY_OK' }],
        usage: { input_tokens: 12, output_tokens: 8 }
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
  })
  try {
    const workspace = createWorkspace(store, { tenantId: 'acc_proxy', name: 'proxy', profileVersion: 'dev', createdAt: 1_800_000_000_000 })
    grantTokenCredit(store, { accountId: 'acc_proxy', amount: 1_000_000, at: 1_800_000_000_000 })
    const runtime = issueRuntimeToken(store, { workspaceId: workspace.id, ttlMs: 3_600_000, at: 1_800_000_000_000 })
    const response = await fetch(`${started.url}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': runtime.token,
        'x-roost-workspace-id': workspace.id
      },
      body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
    })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'PROXY_OK' }],
      usage: { input_tokens: 12, output_tokens: 8 }
    }))
    assert.equal(upstreamAuth, 'Bearer sk-platform-test')
    assert.equal(upstreamModel, 'deepseek-flash')
    assert.equal(getTokenCreditBalance(store, 'acc_proxy', 1_800_000_000_000).balance, 999_980)
  } finally {
    await started.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
    if (prevKey === undefined) delete process.env['ROOST_MODEL_API_KEY']
    else process.env['ROOST_MODEL_API_KEY'] = prevKey
  }
})
