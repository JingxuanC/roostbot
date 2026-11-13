// utils 单元测试：mock 掉 wx 全局，用 node:test 直接跑，不需要微信开发者工具。
//   node --test apps/miniprogram/test/utils.test.js
const test = require('node:test')
const assert = require('node:assert/strict')

const store = new Map()
let lastRequest = null
let responder = null

global.wx = {
  getStorageSync: (key) => (store.has(key) ? store.get(key) : ''),
  setStorageSync: (key, value) => store.set(key, value),
  removeStorageSync: (key) => store.delete(key),
  request: (opts) => {
    lastRequest = opts
    if (responder) responder(opts)
  },
  stopPullDownRefresh: () => {}
}

const auth = require('../utils/auth.js')
const api = require('../utils/api.js')
const { createPoller } = require('../utils/poll.js')

function reset() {
  store.clear()
  lastRequest = null
  responder = null
}

test('auth: 保存与读取 sessionToken', () => {
  reset()
  assert.equal(auth.isLoggedIn(), false)
  auth.saveSession('a'.repeat(64), Date.now() + 60000)
  assert.equal(auth.getToken(), 'a'.repeat(64))
  assert.equal(auth.isLoggedIn(), true)
})

test('auth: 过期 token 自动清理', () => {
  reset()
  auth.saveSession('b'.repeat(64), Date.now() - 1000)
  assert.equal(auth.getToken(), '')
  assert.equal(store.has(auth.TOKEN_KEY), false)
})

test('auth: clearToken 清掉两个键', () => {
  reset()
  auth.saveSession('c'.repeat(64), Date.now() + 60000)
  auth.clearToken()
  assert.equal(auth.isLoggedIn(), false)
  assert.equal(store.has(auth.EXPIRES_KEY), false)
})

test('auth: 缺少 sessionToken 时抛错，不写入假数据', () => {
  reset()
  assert.throws(() => auth.saveSession('', Date.now()), /sessionToken/)
})

test('normalizeError: 归一后端 { error: { code, message } }', () => {
  const err = api.normalizeError(401, { ok: false, error: { code: 'unauthenticated', message: '请先登录' } })
  assert.equal(err.code, 'unauthenticated')
  assert.equal(err.status, 401)
  assert.match(err.message, /请先登录/)
})

test('normalizeError: 非标准响应也有兜底', () => {
  const err = api.normalizeError(500, null)
  assert.equal(err.code, 'http_error')
  assert.equal(err.status, 500)
})

test('request: 带 Bearer 头，成功返回响应体', async () => {
  reset()
  auth.saveSession('d'.repeat(64), Date.now() + 60000)
  responder = (opts) => opts.success({ statusCode: 200, data: { rooms: [] } })
  const res = await api.getRooms()
  assert.deepEqual(res, { rooms: [] })
  assert.equal(lastRequest.method, 'GET')
  assert.equal(lastRequest.url, 'http://127.0.0.1:8787/api/rooms')
  assert.equal(lastRequest.header['Authorization'], `Bearer ${'d'.repeat(64)}`)
})

test('request: 未登录时不带 Authorization（claim 场景）', async () => {
  reset()
  responder = (opts) => opts.success({ statusCode: 200, data: { sessionToken: 'x' } })
  await api.claimPairing('123456')
  assert.equal(lastRequest.header['Authorization'], undefined)
  assert.equal(lastRequest.data.code, '123456')
  assert.equal(lastRequest.data.platform, 'web')
})

test('request: 401 清 token 并抛出可判定错误', async () => {
  reset()
  auth.saveSession('e'.repeat(64), Date.now() + 60000)
  responder = (opts) => opts.success({ statusCode: 401, data: { ok: false, error: { code: 'unauthenticated', message: '会话已过期' } } })
  await assert.rejects(api.getRooms(), (err) => {
    assert.equal(err.status, 401)
    assert.equal(err.code, 'unauthenticated')
    return true
  })
  assert.equal(auth.isLoggedIn(), false)
})

test('request: 网络失败归一为 network_error', async () => {
  reset()
  responder = (opts) => opts.fail({ errMsg: 'request:fail' })
  await assert.rejects(api.getRooms(), (err) => {
    assert.equal(err.code, 'network_error')
    return true
  })
})

test('claimPairing: 非 6 位数字直接拒绝，不发请求', async () => {
  reset()
  await assert.rejects(api.claimPairing('12ab'), /6 位数字/)
  assert.equal(lastRequest, null)
})

test('getMessages: after 游标拼进 query', async () => {
  reset()
  responder = (opts) => opts.success({ statusCode: 200, data: { messages: [] } })
  await api.getMessages('room-1', 42)
  assert.equal(lastRequest.url, 'http://127.0.0.1:8787/api/rooms/room-1/messages?after=42')
})

test('poll: start 后执行，pause 后停止', async () => {
  let count = 0
  const poller = createPoller(() => { count += 1 }, { interval: 10 })
  poller.start()
  await new Promise((resolve) => setTimeout(resolve, 45))
  poller.pause()
  const afterPause = count
  assert.ok(afterPause >= 1, 'start 后应至少执行一次')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(count, afterPause, 'pause 后不应再执行')
  poller.stop()
  assert.equal(poller.isRunning(), false)
})
