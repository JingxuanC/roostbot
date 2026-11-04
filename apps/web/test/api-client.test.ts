import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ApiError, createApiClient, isAuthError, isMissingRoute } from '../lib/api-client.js'

function fakeResponse(status, bodyText, statusText = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => bodyText,
  }
}

function recordingFetch(response, calls) {
  return async (url, init) => {
    calls.push({ url, init })
    return response
  }
}

test('GET 带 Bearer token、credentials，并解析 JSON', async () => {
  const calls = []
  const api = createApiClient({
    getToken: () => 'tok_123',
    fetchImpl: recordingFetch(fakeResponse(200, JSON.stringify({ ok: true, bots: [] })), calls),
  })
  const body = await api.get('/api/bots?workspaceId=w1')
  assert.deepEqual(body, { ok: true, bots: [] })
  assert.equal(calls[0].url, '/api/bots?workspaceId=w1')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok_123')
  assert.equal(calls[0].init.credentials, 'include')
  assert.equal(calls[0].init.body, undefined)
})

test('base 会拼在前面，且没有 token 时不带 Authorization', async () => {
  const calls = []
  const api = createApiClient({
    base: 'http://127.0.0.1:8787/',
    fetchImpl: recordingFetch(fakeResponse(200, '{}'), calls),
  })
  await api.get('/api/rooms')
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/api/rooms')
  assert.equal(calls[0].init.headers.authorization, undefined)
})

test('POST/PATCH/DELETE 的正文与方法', async () => {
  const calls = []
  const api = createApiClient({ fetchImpl: recordingFetch(fakeResponse(200, '{"ok":true}'), calls) })
  await api.post('/api/bots', { name: '选股师' })
  await api.patch('/api/bots/b1', { name: '数据官' })
  await api.del('/api/bots/b1')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.equal(calls[0].init.body, JSON.stringify({ name: '选股师' }))
  assert.equal(calls[1].init.method, 'PATCH')
  assert.equal(calls[2].init.method, 'DELETE')
  assert.equal(calls[2].init.body, undefined)
})

test('{ok:false,error} 抛 ApiError，中文 message 原样保留', async () => {
  const api = createApiClient({
    fetchImpl: recordingFetch(
      fakeResponse(409, JSON.stringify({ ok: false, error: { code: 'bot.name_taken', message: '已经有同名 Bot 了' } })),
      []
    ),
  })
  await assert.rejects(api.post('/api/bots', {}), (error) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'bot.name_taken')
    assert.equal(error.message, '已经有同名 Bot 了')
    assert.equal(error.status, 409)
    return true
  })
})

test('HTTP 500 + 非 JSON 也能给出可读错误', async () => {
  const api = createApiClient({ fetchImpl: recordingFetch(fakeResponse(500, 'boom', 'Internal Server Error'), []) })
  await assert.rejects(api.get('/api/bots'), (error) => {
    assert.equal(error.code, 'http_500')
    assert.match(error.message, /HTTP 500/)
    return true
  })
})

test('网络失败是 network 错误，不假装成功', async () => {
  const api = createApiClient({
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch')
    },
  })
  await assert.rejects(api.get('/api/bots'), (error) => {
    assert.equal(error.code, 'network')
    assert.match(error.message, /连不上 API/)
    return true
  })
})

test('204 / 空 body 返回 null', async () => {
  const api = createApiClient({ fetchImpl: recordingFetch(fakeResponse(204, ''), []) })
  assert.equal(await api.del('/api/rooms/r1'), null)
})

test('isAuthError 认 401 与会话类 code，其他错误不算', () => {
  assert.equal(isAuthError(new ApiError('unauthenticated', '请先配对', { status: 401 })), true)
  assert.equal(isAuthError(new ApiError('session_expired', '过期', { status: 401 })), true)
  assert.equal(isAuthError(new ApiError('http_500', '坏了', { status: 500 })), false)
  assert.equal(isAuthError(new Error('nope')), false)
})

test('isMissingRoute 只认 404 not_found', () => {
  assert.equal(isMissingRoute(new ApiError('not_found', 'no route', { status: 404 })), true)
  assert.equal(isMissingRoute(new ApiError('http_404', 'nope', { status: 404 })), true)
  assert.equal(isMissingRoute(new ApiError('internal_error', '坏了', { status: 500 })), false)
})
