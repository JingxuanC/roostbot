// 可观测性外壳：request id、结构化日志、/metrics、/healthz 扩展（M6-6.6）。
import assert from 'node:assert/strict'
import test from 'node:test'

import { createMemoryStore } from '../src/memory-store.ts'
import {
  REQUEST_ID_PATTERN,
  REDACTED,
  createHttpLogEntry,
  levelForStatus,
  redactForLog,
  redactRequestPath,
} from '../src/logger.ts'
import type { HttpLogEntry } from '../src/logger.ts'
import { startServer } from '../src/server.ts'
import { manualClock, startHarness, startSqliteHarness } from './helpers.ts'

async function waitForLogs(logs: HttpLogEntry[], count: number): Promise<void> {
  const deadline = Date.now() + 500
  while (logs.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('x-request-id：合法值沿用，非法/缺失时生成', async (t) => {
  const logs: HttpLogEntry[] = []
  const clock = manualClock()
  const started = await startServer({
    store: createMemoryStore(),
    now: clock.now,
    port: 0,
    host: '127.0.0.1',
    logSink: (entry) => logs.push(entry),
  })
  t.after(() => started.close())

  const valid = 'req_abc.123-XYZ'
  const echoed = await fetch(`${started.url}/healthz`, { headers: { 'x-request-id': valid } })
  assert.equal(echoed.status, 200)
  assert.equal(echoed.headers.get('x-request-id'), valid)

  const invalid = await fetch(`${started.url}/healthz`, { headers: { 'x-request-id': 'bad id!' } })
  const generated = invalid.headers.get('x-request-id') ?? ''
  assert.match(generated, REQUEST_ID_PATTERN)
  assert.notEqual(generated, 'bad id!')

  const missing = await fetch(`${started.url}/healthz`)
  assert.match(missing.headers.get('x-request-id') ?? '', REQUEST_ID_PATTERN)
})

test('完成日志：JSON 行字段、级别、query 凭据脱敏', async (t) => {
  const logs: HttpLogEntry[] = []
  const clock = manualClock()
  const started = await startServer({
    store: createMemoryStore(),
    now: clock.now,
    port: 0,
    host: '127.0.0.1',
    logSink: (entry) => logs.push(entry),
  })
  t.after(() => started.close())

  const requestId = 'req_observability_001'
  const response = await fetch(
    `${started.url}/api/config?access_token=secret-access&token=secret-token&foo=bar`,
    { headers: { 'x-request-id': requestId } },
  )
  assert.equal(response.status, 200)
  await waitForLogs(logs, 1)
  const entry = logs.find((line) => line.requestId === requestId)
  assert.ok(entry, '应记录该请求的完成日志')
  assert.equal(entry.level, 'info')
  assert.equal(entry.method, 'GET')
  assert.equal(entry.status, 200)
  assert.equal(typeof entry.durationMs, 'number')
  assert.ok(entry.durationMs >= 0)
  assert.ok(!entry.path.includes('secret-access'))
  assert.ok(!entry.path.includes('secret-token'))
  assert.ok(entry.path.includes('foo=bar'))
  assert.ok(decodeURIComponent(entry.path).includes(REDACTED))

  const missingId = 'req_observability_404'
  await fetch(`${started.url}/nope`, { headers: { 'x-request-id': missingId } })
  await waitForLogs(logs, 2)
  const warn = logs.find((line) => line.requestId === missingId)
  assert.equal(warn?.level, 'warn')
  assert.equal(warn?.status, 404)

  assert.equal(levelForStatus(500), 'error')
  const errorEntry = createHttpLogEntry({
    requestId: 'req_error',
    method: 'GET',
    path: '/x',
    status: 500,
    durationMs: 1,
    msg: 'request failed',
  })
  assert.equal(errorEntry.level, 'error')
  assert.equal(errorEntry.msg, 'request failed')
})

test('脱敏工具覆盖 headers 与普通对象', () => {
  assert.equal(
    redactRequestPath('/api/config?token=abc&access_token=def&keep=1'),
    '/api/config?token=[REDACTED]&access_token=[REDACTED]&keep=1',
  )
  assert.deepEqual(redactForLog({ authorization: 'Bearer x', cookie: 'a=b', nested: { token: 't' }, ok: 1 }), {
    authorization: REDACTED,
    cookie: REDACTED,
    nested: { token: REDACTED },
    ok: 1,
  })
})

test('/metrics：计数、路由模板基数与业务 gauge（内存 port = 0）', async (t) => {
  const harness = await startHarness()
  t.after(() => harness.close())

  await harness.call('GET', '/healthz')
  await harness.call('GET', '/healthz')
  await harness.call('GET', '/api/rooms/rm_secret_123/messages')
  await harness.call('GET', '/api/unknown/secret-id-999')

  const metrics = await harness.call('GET', '/metrics')
  assert.equal(metrics.status, 200)
  assert.match(metrics.headers.get('content-type') ?? '', /^text\/plain/)
  assert.match(metrics.text, /# TYPE roost_http_requests_total counter/)
  assert.match(metrics.text, /roost_http_requests_total\{method="GET",path="\/healthz",status="200"\} 2/)
  assert.match(
    metrics.text,
    /roost_http_requests_total\{method="GET",path="\/api\/rooms\/:id\/messages",status="401"\} 1/,
  )
  assert.match(metrics.text, /roost_http_requests_total\{method="GET",path="other",status="404"\} 1/)
  assert.equal(metrics.text.includes('rm_secret_123'), false)
  assert.equal(metrics.text.includes('secret-id-999'), false)
  assert.match(metrics.text, /roost_http_request_duration_seconds_bucket\{[^}]*le="0\.01"\}/)
  assert.match(metrics.text, /roost_http_request_duration_seconds_count\{method="GET",path="\/healthz"\} 2/)
  assert.match(metrics.text, /roost_pending_approvals 0/)
  assert.match(metrics.text, /roost_runs_queued 0/)
  assert.match(metrics.text, /roost_plugins_installing 0/)
})

test('/metrics 业务 gauge 从 SQLite 现查', async (t) => {
  const harness = await startSqliteHarness()
  t.after(() => harness.close())
  const store = harness.rawStore
  assert.ok(store)

  store.db
    .prepare(
      "INSERT INTO approvals (id, workspace_id, kind, requester, requester_kind, payload_json, status, created_at) VALUES ('apr_1', 'ws_1', 'share', 'bot', 'bot', '{}', 'pending', 1)",
    )
    .run()
  store.db
    .prepare(
      "INSERT INTO plugin_installs (id, workspace_id, slug, version, enabled, lock, installed_by, installed_at, state) VALUES ('pli_1', 'ws_1', 'demo', '1.0.0', 1, '{}', 'acc', 1, 'installing')",
    )
    .run()
  store.db
    .prepare(
      "INSERT INTO activations (id, kind, source, workspace_id, bot_id, room_id, idem, scheduled_for, payload, budget, done_when, created_at) VALUES ('act_1', 'manual', 'test', 'ws_1', 'bot_1', NULL, 'idem_1', NULL, '{}', '{}', NULL, 1)",
    )
    .run()
  store.db
    .prepare(
      "INSERT INTO runs (id, activation_id, status, executions, restarts, last_activity) VALUES ('run_1', 'act_1', 'queued', 0, 0, 1)",
    )
    .run()

  const metrics = await harness.call('GET', '/metrics')
  assert.equal(metrics.status, 200)
  assert.match(metrics.text, /roost_pending_approvals 1/)
  assert.match(metrics.text, /roost_runs_queued 1/)
  assert.match(metrics.text, /roost_plugins_installing 1/)

  const health = await harness.call('GET', '/healthz')
  assert.equal(health.status, 200)
  assert.equal(health.json.store, 'sqlite')
  assert.equal(typeof health.json.scheduler, 'boolean')
})

test('/healthz 保持向后兼容并带 dsh 端口形状', async (t) => {
  const plain = await startHarness()
  t.after(() => plain.close())
  const plainHealth = await plain.call('GET', '/healthz')
  assert.equal(plainHealth.status, 200)
  assert.equal(plainHealth.json.ok, true)
  assert.equal(typeof plainHealth.json.uptimeMs, 'number')
  assert.equal(plainHealth.json.store, 'memory')
  assert.equal(plainHealth.json.scheduler, false)
  assert.deepEqual(plainHealth.json.dsh, { webPort: 4099, proxyPort: null })

  const proxied = await startHarness({ dshWebPort: 4567, dshProxyPort: 0 })
  t.after(() => proxied.close())
  const health = await proxied.call('GET', '/healthz')
  assert.equal(health.json.dsh.webPort, 4567)
  assert.equal(typeof health.json.dsh.proxyPort, 'number')
  assert.ok(health.json.dsh.proxyPort > 0)
})
