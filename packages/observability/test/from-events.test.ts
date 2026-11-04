// 事件 → 指标：run / assignment / sandbox / budget / message / delivery 六族，
// 未知事件必须是 [], 标签只允许 kind/status/workspace（M6-6.6）。

import assert from 'node:assert/strict'
import test from 'node:test'

import { metricsFromEvent, type MetricPoint } from '../src/from-events.ts'

function names(points: MetricPoint[]): string[] {
  return points.map((point) => point.name)
}

function one(points: MetricPoint[], name: string): MetricPoint {
  const point = points.find((item) => item.name === name)
  assert.ok(point, `missing metric ${name} in ${names(points).join(',')}`)
  return point
}

test('run.started / schedule.run.settled：counter、耗时直方图与 workspace 标签', () => {
  const started = metricsFromEvent({ kind: 'run.started', payload: { workspaceId: 'ws_1' } })
  assert.equal(started.length, 1)
  assert.deepEqual(started[0], {
    name: 'roost_runs_total',
    kind: 'counter',
    value: 1,
    labels: { kind: 'run', status: 'started', workspace: 'ws_1' }
  })

  const settled = metricsFromEvent({
    kind: 'schedule.run.settled',
    payload: { workspaceId: 'ws_1', outcome: 'failed', durationMs: 1500 }
  })
  const total = one(settled, 'roost_runs_total')
  assert.equal(total.labels.status, 'failed')
  assert.equal(total.labels.workspace, 'ws_1')
  const duration = one(settled, 'roost_run_duration_seconds')
  assert.equal(duration.kind, 'histogram')
  assert.equal(duration.value, 1.5)
  assert.equal(one(settled, 'roost_run_failures_total').value, 1)
})

test('assignment：状态取 outcome，settled 带耗时', () => {
  const enqueued = metricsFromEvent({ kind: 'assignment.enqueued', payload: {} })
  assert.deepEqual(enqueued[0]?.labels, { kind: 'assignment', status: 'enqueued' })

  const settled = metricsFromEvent({
    kind: 'assignment.settled',
    payload: { outcome: 'done', durationMs: 250, workspaceId: 'ws_2' }
  })
  assert.equal(one(settled, 'roost_assignments_total').labels.status, 'done')
  assert.equal(one(settled, 'roost_assignment_duration_seconds').value, 0.25)
})

test('sandbox：ready 只计数，denied/failed 额外产 errors', () => {
  const ready = metricsFromEvent({ kind: 'sandbox.ready', payload: {} })
  assert.deepEqual(names(ready), ['roost_sandbox_events_total'])
  assert.equal(ready[0]?.labels.status, 'ready')

  const denied = metricsFromEvent({
    kind: 'sandbox.denied',
    payload: { workspaceId: 'ws_3', kind: 'network', host: 'example.com' }
  })
  assert.deepEqual(names(denied).sort(), ['roost_sandbox_errors_total', 'roost_sandbox_events_total'])
  assert.equal(one(denied, 'roost_sandbox_errors_total').labels.status, 'denied')
})

test('budget/billing：超限、cap 与用量单位', () => {
  const exceeded = metricsFromEvent({ kind: 'budget.exceeded', payload: { workspaceId: 'ws_4' } })
  assert.deepEqual(names(exceeded).sort(), ['roost_budget_events_total', 'roost_budget_exceeded_total'])

  const cap = metricsFromEvent({ kind: 'billing.cap', payload: {} })
  assert.equal(one(cap, 'roost_budget_exceeded_total').labels.status, 'cap')

  const usage = metricsFromEvent({ kind: 'billing.usage', payload: { amount: 120, metric: 'tokens' } })
  const units = one(usage, 'roost_budget_units_total')
  assert.equal(units.value, 120)
  assert.equal(units.labels.status, 'tokens')
  assert.equal(one(usage, 'roost_budget_events_total').labels.status, 'usage')
})

test('message / chat.message：按 role 或后缀记状态', () => {
  const sent = metricsFromEvent({ kind: 'message.sent', payload: {} })
  assert.equal(one(sent, 'roost_messages_total').labels.status, 'sent')

  const chat = metricsFromEvent({ kind: 'chat.message', payload: { role: 'bot' } })
  assert.deepEqual(chat[0]?.labels, { kind: 'message', status: 'bot' })
})

test('delivery：failed 额外产 failures', () => {
  const ok = metricsFromEvent({ kind: 'delivery.delivered', payload: { durationMs: 20 } })
  assert.deepEqual(one(ok, 'roost_deliveries_total').labels, { kind: 'delivery', status: 'delivered' })
  assert.equal(one(ok, 'roost_delivery_duration_seconds').value, 0.02)

  const failed = metricsFromEvent({ kind: 'delivery.failed', payload: { workspaceId: 'ws_5' } })
  assert.deepEqual(names(failed).sort(), ['roost_deliveries_total', 'roost_delivery_failures_total'])
})

test('未知/畸形事件返回 [] 且不抛错', () => {
  assert.deepEqual(metricsFromEvent({ kind: 'memory.written', payload: {} }), [])
  assert.deepEqual(metricsFromEvent({ kind: 'chat.unread', payload: {} }), [])
  assert.deepEqual(metricsFromEvent({ kind: '' }), [])
  assert.deepEqual(metricsFromEvent(null), [])
  assert.deepEqual(metricsFromEvent(undefined), [])
  assert.deepEqual(metricsFromEvent({ payload: {} }), [])
  assert.deepEqual(metricsFromEvent({ kind: 'run.started', payload: 'not-an-object' as never }), [
    { name: 'roost_runs_total', kind: 'counter', value: 1, labels: { kind: 'run', status: 'started' } }
  ])
})

test('标签只包含 kind/status/workspace，且 workspace 做长度截断', () => {
  const points = metricsFromEvent({
    kind: 'sandbox.ready',
    payload: { workspaceId: 'w'.repeat(500), userId: 'u_1', host: 'example.com' }
  })
  for (const point of points) {
    assert.deepEqual(Object.keys(point.labels).sort(), ['kind', 'status', 'workspace'])
    assert.equal(point.labels.workspace?.length, 200)
  }
})
