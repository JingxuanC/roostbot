// 深度健康：ok/degraded/down 三态、超时与缺失 probe（M6-6.6）。

import assert from 'node:assert/strict'
import test from 'node:test'

import { aggregateHealth, runHealthChecks, type HealthCheck } from '../src/health.ts'

const AT = Date.UTC(2026, 10, 4, 12, 0, 0)

test('全部 probe ok → status ok，checks 按 api/store/sandbox/gateway 顺序', async () => {
  const report = await runHealthChecks({
    now: AT,
    probes: {
      api: () => ({ ok: true }),
      store: async () => ({ ok: true, detail: 'SELECT 1' }),
      sandbox: () => ({ ok: true }),
      gateway: () => ({ ok: true })
    }
  })
  assert.equal(report.status, 'ok')
  assert.equal(report.at, new Date(AT).toISOString())
  assert.deepEqual(report.checks.map((check) => check.name), ['api', 'store', 'sandbox', 'gateway'])
  assert.equal(report.checks[1]?.detail, 'SELECT 1')
  for (const check of report.checks) assert.equal(check.status, 'ok')
})

test('任一 ok:false → degraded，其余仍执行', async () => {
  let gatewayRan = false
  const report = await runHealthChecks({
    now: AT,
    probes: {
      api: () => ({ ok: true }),
      store: () => ({ ok: false, detail: 'db locked' }),
      gateway: () => {
        gatewayRan = true
        return { ok: true }
      }
    }
  })
  assert.equal(report.status, 'degraded')
  assert.equal(gatewayRan, true)
  const store = report.checks.find((check) => check.name === 'store')
  assert.equal(store?.status, 'failed')
  assert.equal(store?.detail, 'db locked')
})

test('probe 抛错 → down，且 down 优先于 failed', async () => {
  const report = await runHealthChecks({
    now: AT,
    probes: {
      api: () => ({ ok: false, detail: 'slow' }),
      store: () => {
        throw new Error('sqlite corrupt')
      }
    }
  })
  assert.equal(report.status, 'down')
  const store = report.checks.find((check) => check.name === 'store')
  assert.equal(store?.status, 'down')
  assert.ok(store?.detail?.includes('sqlite corrupt'))
})

test('超时的 probe 记 down，detail 说明超时', async () => {
  const report = await runHealthChecks({
    now: AT,
    timeoutMs: 10,
    probes: {
      api: () => ({ ok: true }),
      sandbox: () => new Promise(() => {})
    }
  })
  assert.equal(report.status, 'down')
  const sandbox = report.checks.find((check) => check.name === 'sandbox')
  assert.equal(sandbox?.status, 'down')
  assert.match(sandbox?.detail ?? '', /timed out/)
})

test('未配置的 probe 跳过；没有任何 probe 时 ok', async () => {
  const report = await runHealthChecks({ now: AT, probes: {} })
  assert.equal(report.status, 'ok')
  assert.deepEqual(report.checks, [])

  const partial = await runHealthChecks({ now: AT, probes: { gateway: () => ({ ok: true }) } })
  assert.deepEqual(partial.checks.map((check) => check.name), ['gateway'])
})

test('probe 返回非对象/undefined 按 failed 处理，durationMs 非负', async () => {
  const report = await runHealthChecks({
    now: AT,
    probes: {
      api: (() => undefined) as never,
      store: () => ({ ok: true })
    }
  })
  assert.equal(report.status, 'degraded')
  for (const check of report.checks) assert.ok(check.durationMs >= 0)
})

test('aggregateHealth 三态优先级', () => {
  const check = (status: HealthCheck['status']): HealthCheck => ({ name: 'api', status, durationMs: 0 })
  assert.equal(aggregateHealth([]), 'ok')
  assert.equal(aggregateHealth([check('ok'), check('ok')]), 'ok')
  assert.equal(aggregateHealth([check('ok'), check('failed')]), 'degraded')
  assert.equal(aggregateHealth([check('failed'), check('down')]), 'down')
})
