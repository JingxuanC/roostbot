// workspace 模型设置：加密保存、掩码返回、测试连接、删除。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import { createStorePort } from '../src/store-adapter.ts'
import { startServer } from '../src/server.ts'

const NOW = 1_800_000_000_000

async function pair(base: string, accountId: string): Promise<string> {
  const code = await (await fetch(`${base}/api/pairing/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId })
  })).json() as { code: string }
  const claimed = await (await fetch(`${base}/api/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code.code })
  })).json() as { sessionToken: string }
  return claimed.sessionToken
}

test('PUT/GET/测试/删除 workspace 模型 Key，响应只回掩码', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-model-settings-'))
  const store = openStore(join(dir, 'db.sqlite'))
  let upstreamAuth = ''
  const started = await startServer({
    store: createStorePort(store),
    rawStore: store,
    now: () => NOW,
    port: 0,
    host: '127.0.0.1',
    modelKeyMaster: Buffer.alloc(32, 7),
    modelTestFetch: async (_url, init) => {
      upstreamAuth = String((init?.headers as Record<string, string>).authorization ?? '')
      return new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
  })
  try {
    const token = await pair(started.url, 'acc_model_settings')
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const ws = await (await fetch(`${started.url}/api/workspaces`, {
      method: 'POST', headers: auth, body: JSON.stringify({ name: '模型设置' })
    })).json() as { workspace: { id: string } }

    const put = await fetch(`${started.url}/api/workspaces/${ws.workspace.id}/model`, {
      method: 'PUT', headers: auth,
      body: JSON.stringify({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKey: 'sk-secret-1234' })
    })
    assert.equal(put.status, 200)
    const putBody = await put.json() as any
    assert.equal(putBody.byo.keyHint, '…1234')
    assert.equal(JSON.stringify(putBody).includes('sk-secret-1234'), false)

    const get = await (await fetch(`${started.url}/api/workspaces/${ws.workspace.id}/model`, { headers: auth })).json() as any
    assert.equal(get.byo.model, 'deepseek-v4-flash')
    assert.equal(JSON.stringify(get).includes('sk-secret-1234'), false)

    const tested = await (await fetch(`${started.url}/api/workspaces/${ws.workspace.id}/model/test`, {
      method: 'POST', headers: auth, body: JSON.stringify({})
    })).json() as any
    assert.equal(tested.ok, true)
    assert.equal(upstreamAuth, 'Bearer sk-secret-1234')

    const removed = await fetch(`${started.url}/api/workspaces/${ws.workspace.id}/model`, { method: 'DELETE', headers: auth })
    assert.equal(removed.status, 200)
    const after = await (await fetch(`${started.url}/api/workspaces/${ws.workspace.id}/model`, { headers: auth })).json() as any
    assert.equal(after.byo, null)
  } finally {
    await started.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
