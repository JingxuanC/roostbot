// 告警：默认四条规则、冷却窗口、severity 与 detail（M6-6.8）。

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_ALERT_COOLDOWN_MS,
  DEFAULT_ALERT_RULES,
  createAlertState,
  evaluateAlerts,
  healthStatusFromSnapshot,
  type AlertRule
} from '../src/alerts.ts'

const AT = Date.UTC(2026, 10, 4, 12, 0, 0)

test('默认规则一次命中四类异常', () => {
  const alerts = evaluateAlerts({
    snapshot: {
      sandbox_error: 2,
      budget_exceeded: 1,
      delivery_failed: 3,
      health: 'degraded'
    },
    now: AT,
    state: createAlertState()
  })
  assert.deepEqual(
    alerts.map((alert) => alert.rule),
    ['sandbox_error', 'budget_exceeded', 'delivery_failed', 'health_degraded']
  )
  assert.deepEqual(
    alerts.map((alert) => alert.severity),
    ['critical', 'warning', 'warning', 'critical']
  )
  assert.equal(alerts[0]?.at, new Date(AT).toISOString())
  assert.ok(alerts[0]?.detail.includes('2'))
  assert.ok(alerts[3]?.detail.includes('degraded'))
})

test('无异常快照返回 []；健康 ok 不算降级', () => {
  const state = createAlertState()
  assert.deepEqual(evaluateAlerts({ snapshot: {}, now: AT, state }), [])
  assert.deepEqual(evaluateAlerts({ snapshot: { health: 'ok' }, now: AT, state }), [])
  assert.deepEqual(evaluateAlerts({ snapshot: { health: { status: 'ok' } }, now: AT, state }), [])
  assert.equal(healthStatusFromSnapshot({ health: 'ok' }), 'ok')
  assert.equal(healthStatusFromSnapshot({ health: 'down' }), 'down')
  assert.equal(healthStatusFromSnapshot({ health_degraded: 1 }), 'degraded')
})

test('冷却窗口内重复触发被去重，窗口过后再次触发', () => {
  const state = createAlertState()
  const snapshot = { sandbox_error: 1 }
  const first = evaluateAlerts({ snapshot, now: AT, state, cooldownMs: 60_000 })
  assert.equal(first.length, 1)

  const suppressed = evaluateAlerts({ snapshot, now: AT + 1_000, state, cooldownMs: 60_000 })
  assert.deepEqual(suppressed, [])

  const again = evaluateAlerts({ snapshot, now: AT + 60_000, state, cooldownMs: 60_000 })
  assert.equal(again.length, 1)

  // 被冷却压住的求值不能延长冷却。
  const late = evaluateAlerts({ snapshot, now: AT + 120_000, state, cooldownMs: 60_000 })
  assert.equal(late.length, 1)
})

test('默认冷却常量与注入状态互相隔离', () => {
  assert.equal(DEFAULT_ALERT_COOLDOWN_MS, 5 * 60_000)
  const a = createAlertState()
  const b = createAlertState()
  assert.equal(evaluateAlerts({ snapshot: { delivery_failed: 1 }, now: AT, state: a }).length, 1)
  assert.equal(evaluateAlerts({ snapshot: { delivery_failed: 1 }, now: AT, state: b }).length, 1)
})

test('规则支持嵌套 counters/gauges 与布尔值', () => {
  const state = createAlertState()
  const nested = evaluateAlerts({
    snapshot: { counters: { sandbox_errors_total: 3 }, gauges: { budget_exceeded: 1 } },
    now: AT,
    state
  })
  assert.deepEqual(nested.map((alert) => alert.rule), ['sandbox_error', 'budget_exceeded'])

  const bool = evaluateAlerts({ snapshot: { budget_exceeded: true }, now: AT, state: createAlertState() })
  assert.equal(bool.length, 1)
})

test('健康 down 优先按 critical 报，degraded 也命中', () => {
  const down = evaluateAlerts({ snapshot: { health: 'down' }, now: AT, state: createAlertState() })
  assert.equal(down[0]?.rule, 'health_degraded')
  assert.equal(down[0]?.severity, 'critical')

  const warning = evaluateAlerts({ snapshot: { healthStatus: 'warning' }, now: AT, state: createAlertState() })
  assert.equal(warning[0]?.rule, 'health_degraded')
})

test('自定义规则按顺序求值，detail 可覆盖；抛错规则不影响其他规则', () => {
  const rules: AlertRule[] = [
    { id: 'always', severity: 'info', match: () => true, detail: () => 'always fires' },
    { id: 'broken', severity: 'critical', match: () => { throw new Error('bad rule') } },
    { id: 'never', severity: 'warning', match: () => false }
  ]
  const alerts = evaluateAlerts({ snapshot: {}, rules, now: AT, state: createAlertState() })
  assert.deepEqual(alerts, [
    { rule: 'always', severity: 'info', detail: 'always fires', at: new Date(AT).toISOString() }
  ])
})

test('detail 缺省时回落到规则 id', () => {
  const custom: AlertRule[] = [{ id: 'custom_alert', severity: 'info', match: () => true }]
  const alerts = evaluateAlerts({ snapshot: {}, rules: custom, now: AT, state: createAlertState() })
  assert.equal(alerts[0]?.detail, 'custom_alert')
})

test('DEFAULT_ALERT_RULES 四条都有 id/severity/match', () => {
  assert.deepEqual(
    DEFAULT_ALERT_RULES.map((rule) => rule.id),
    ['sandbox_error', 'budget_exceeded', 'delivery_failed', 'health_degraded']
  )
  for (const rule of DEFAULT_ALERT_RULES) {
    assert.equal(typeof rule.match, 'function')
    assert.ok(['info', 'warning', 'critical'].includes(rule.severity))
  }
})

test('快照可直接使用 from-events 的 roost_* 指标名与健康报告 status', () => {
  const alerts = evaluateAlerts({
    snapshot: {
      counters: {
        roost_sandbox_errors_total: 1,
        roost_budget_exceeded_total: 1,
        roost_delivery_failures_total: 2
      }
    },
    now: AT,
    state: createAlertState()
  })
  assert.deepEqual(alerts.map((alert) => alert.rule), [
    'sandbox_error',
    'budget_exceeded',
    'delivery_failed'
  ])

  const health = evaluateAlerts({
    snapshot: { status: 'degraded' },
    now: AT,
    state: createAlertState()
  })
  assert.deepEqual(health.map((alert) => alert.rule), ['health_degraded'])
})
