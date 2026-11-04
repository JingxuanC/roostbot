// createGatewayBackend：默认 stub、按 env 选 openconnector/composio、缺失 URL 回退。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONNECTOR_NOT_CONFIGURED,
  HttpGatewayBackend,
  StubGatewayBackend,
  createGatewayBackend,
  isConnectorNotConfigured,
} from '../src/index.ts'

test('未配置时默认 stub：目录为空，authorize 抛 not_configured', async () => {
  const backend = createGatewayBackend({})
  assert.ok(backend instanceof StubGatewayBackend)
  assert.deepEqual(await backend.listConnectors(), [])
  await assert.rejects(() => backend.authorize('github'), (err: unknown) => {
    assert.equal(isConnectorNotConfigured(err), true)
    assert.match((err as Error).message, /connector\.not_configured/)
    return true
  })
})

test('openconnector/composio 配置 URL 后使用 HttpGatewayBackend，id 跟随选择', () => {
  const open = createGatewayBackend({
    ROOST_CONNECTOR_BACKEND: 'openconnector',
    ROOST_CONNECTOR_URL: 'http://127.0.0.1:8090/',
    ROOST_CONNECTOR_TOKEN: 'tok_123',
  })
  assert.ok(open instanceof HttpGatewayBackend)
  assert.equal(open.id, 'openconnector')

  const composio = createGatewayBackend({
    ROOST_CONNECTOR_BACKEND: 'composio',
    ROOST_CONNECTOR_URL: 'https://gateway.example',
  })
  assert.ok(composio instanceof HttpGatewayBackend)
  assert.equal(composio.id, 'composio')
})

test('缺少 ROOST_CONNECTOR_URL 回退 stub，并写日志说明', async () => {
  const logs: string[] = []
  const backend = createGatewayBackend(
    { ROOST_CONNECTOR_BACKEND: 'openconnector', ROOST_CONNECTOR_TOKEN: 'tok_secret' },
    { log: (message) => logs.push(message) },
  )
  assert.ok(backend instanceof StubGatewayBackend)
  assert.match(logs.join('\n'), /ROOST_CONNECTOR_URL/)
  // token 不得出现在日志里。
  assert.equal(logs.join('\n').includes('tok_secret'), false)
  await assert.rejects(() => backend.authorize('github'), new RegExp(CONNECTOR_NOT_CONFIGURED))
})

test('未知后端值回退 stub 并写日志', () => {
  const logs: string[] = []
  const backend = createGatewayBackend(
    { ROOST_CONNECTOR_BACKEND: 'native-mcp', ROOST_CONNECTOR_URL: 'http://127.0.0.1:8090' },
    { log: (message) => logs.push(message) },
  )
  assert.ok(backend instanceof StubGatewayBackend)
  assert.match(logs.join('\n'), /unknown ROOST_CONNECTOR_BACKEND=native-mcp/)
})

test('非法 URL 回退 stub，日志不回显 URL', () => {
  const logs: string[] = []
  const backend = createGatewayBackend(
    { ROOST_CONNECTOR_BACKEND: 'openconnector', ROOST_CONNECTOR_URL: 'ftp://gateway.example' },
    { log: (message) => logs.push(message) },
  )
  assert.ok(backend instanceof StubGatewayBackend)
  assert.match(logs.join('\n'), /invalid ROOST_CONNECTOR_URL/)
  assert.equal(logs.join('\n').includes('ftp://gateway.example'), false)
})
