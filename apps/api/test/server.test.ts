// HTTP 外壳：健康检查、JSON 错误形状、缓存头、body 限制、Origin 校验。
import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_BODY_BYTES } from '../src/server.ts'
import { startHarness } from './helpers.ts'

test('GET /healthz 返回 ok 与 uptimeMs', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const first = await harness.call('GET', '/healthz')
  assert.equal(first.status, 200)
  assert.equal(first.json.ok, true)
  assert.equal(typeof first.json.uptimeMs, 'number')
  assert.ok(first.json.uptimeMs >= 0)
  assert.match(first.headers.get('content-type') ?? '', /^application\/json/)
  assert.equal(first.headers.get('cache-control'), 'no-store')

  harness.clock.advance(1500)
  const second = await harness.call('GET', '/healthz')
  assert.equal(second.status, 200)
  assert.ok(second.json.uptimeMs >= first.json.uptimeMs + 1500, 'uptime 跟着注入的时钟走')
})

test('每个响应都带 cache-control: no-store', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const health = await harness.call('GET', '/healthz')
  const missing = await harness.call('GET', '/nope')
  const unauthorized = await harness.call('GET', '/api/workspaces')

  for (const result of [health, missing, unauthorized]) {
    assert.equal(result.headers.get('cache-control'), 'no-store')
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff')
  }
})

test('未知路由返回 JSON 404', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const result = await harness.call('GET', '/api/does-not-exist')
  assert.equal(result.status, 404)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error.code, 'not_found')
  assert.equal(typeof result.json.error.message, 'string')
  assert.ok(result.json.error.message.includes('/api/does-not-exist'))
})

test('已知路径上的错误方法也是 404（不是 405，也不是崩溃）', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  for (const [method, path] of [
    ['DELETE', '/healthz'],
    ['PUT', '/api/workspaces'],
    ['GET', '/api/pairing/claim']
  ] as const) {
    const result = await harness.call(method, path)
    assert.equal(result.status, 404, `${method} ${path}`)
    assert.equal(result.json.error.code, 'not_found')
  }
})

test('非法 JSON body → 400 invalid_json', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const result = await harness.call('POST', '/api/pairing/code', { rawBody: '{not json' })
  assert.equal(result.status, 400)
  assert.equal(result.json.error.code, 'invalid_json')
})

test('空 body → 400 invalid_body', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const result = await harness.call('POST', '/api/pairing/code', { rawBody: '' })
  assert.equal(result.status, 400)
  assert.equal(result.json.error.code, 'invalid_body')
})

test('缺 accountId → 400 invalid_body', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const result = await harness.call('POST', '/api/pairing/code', { body: { workspaceId: 'ws_x' } })
  assert.equal(result.status, 400)
  assert.equal(result.json.error.code, 'invalid_body')
  assert.match(result.json.error.message, /accountId/)
})

test('超大 body → 413 payload_too_large', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const result = await harness.call('POST', '/api/pairing/code', {
    body: { accountId: 'a'.repeat(MAX_BODY_BYTES + 1024) }
  })
  assert.equal(result.status, 413)
  assert.equal(result.json.error.code, 'payload_too_large')
})

test('写操作：非回环 Origin 被拒，回环 Origin 放行', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  const crossOrigin = await harness.call('POST', '/api/pairing/code', {
    body: { accountId: 'acc' },
    headers: { origin: 'https://evil.example' }
  })
  assert.equal(crossOrigin.status, 403)
  assert.equal(crossOrigin.json.error.code, 'forbidden_origin')

  const loopback = await harness.call('POST', '/api/pairing/code', {
    body: { accountId: 'acc' },
    headers: { origin: 'http://127.0.0.1:5173' }
  })
  assert.equal(loopback.status, 200)

  const noOrigin = await harness.call('POST', '/api/pairing/code', { body: { accountId: 'acc' } })
  assert.equal(noOrigin.status, 200)
})
