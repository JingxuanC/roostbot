// Prometheus 文本指标（M6-6.6）。零依赖，手写 exposition format。
//
// 基数控制：path 标签只允许路由模板；未识别的路径统一记为 other。
// 直方图 buckets 固定为 0.01/0.05/0.1/0.5/1/5 秒，另加 +Inf。
// 业务 gauge 每个 /metrics 抓取时从 rawStore 现查；没有 rawStore 输出 0。

import type { Store } from '../../../packages/store/src/types.ts'

export const DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.5, 1, 5] as const

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

/** 精确路由（不含路径参数）。 */
const EXACT_ROUTES = new Set([
  '/',
  '/healthz',
  '/metrics',
  '/api/config',
  '/api/audit',
  '/api/pairing/code',
  '/api/pairing/claim',
  '/api/devices',
  '/api/workspaces',
  '/api/rooms',
  '/api/internal/rooms',
  '/api/marketplace/plugins',
  '/api/plugin-installs',
  '/api/approvals',
  '/api/approval-grants',
  '/api/quotas',
  '/api/usage',
  '/api/runs',
  '/api/bots',
  '/api/attachments',
  '/api/internal/bot-rooms',
  '/api/internal/plugins/sync',
  '/api/internal/budget/reserve',
  '/api/internal/budget/settle',
  '/api/internal/usage',
  '/api/internal/scheduler/tick',
  '/api/internal/approvals',
  '/api/internal/artifacts',
  '/api/internal/attachments/gc'
])

const ROUTE_PATTERNS: Array<readonly [RegExp, string]> = [
  [/^\/w\/[^/]+\/dsh(?:\/.*)?$/, '/w/:workspaceId/dsh/*'],
  [/^\/api\/devices\/[^/]+$/, '/api/devices/:id'],
  [/^\/api\/workspaces\/[^/]+\/dsh\/status$/, '/api/workspaces/:id/dsh/status'],
  [/^\/api\/workspaces\/[^/]+\/panels$/, '/api/workspaces/:id/panels'],
  [/^\/api\/workspaces\/[^/]+\/members\/[^/]+$/, '/api/workspaces/:id/members/:accountId'],
  [/^\/api\/workspaces\/[^/]+\/members$/, '/api/workspaces/:id/members'],
  [/^\/api\/workspaces\/[^/]+\/(?:start|runtime|stop)$/, '/api/workspaces/:id/:action'],
  [/^\/api\/workspaces\/[^/]+\/logs$/, '/api/workspaces/:id/logs'],
  [/^\/api\/workspaces\/[^/]+\/schedules$/, '/api/workspaces/:id/schedules'],
  [/^\/api\/rooms\/[^/]+\/members\/[^/]+$/, '/api/rooms/:id/members/:memberId'],
  [/^\/api\/rooms\/[^/]+\/members$/, '/api/rooms/:id/members'],
  [/^\/api\/rooms\/[^/]+\/messages$/, '/api/rooms/:id/messages'],
  [/^\/api\/rooms\/[^/]+\/stream$/, '/api/rooms/:id/stream'],
  [/^\/api\/rooms\/[^/]+\/say$/, '/api/rooms/:id/say'],
  [/^\/api\/rooms\/[^/]+\/turns\/[^/]+\/stop$/, '/api/rooms/:id/turns/:turnId/stop'],
  [/^\/api\/rooms\/[^/]+$/, '/api/rooms/:id'],
  [/^\/api\/internal\/rooms\/[^/]+\/messages$/, '/api/internal/rooms/:id/messages'],
  [/^\/api\/internal\/rooms\/[^/]+\/assignments$/, '/api/internal/rooms/:id/assignments'],
  [/^\/api\/internal\/rooms\/[^/]+\/round$/, '/api/internal/rooms/:id/round'],
  [/^\/api\/internal\/rounds\/[^/]+\/advance$/, '/api/internal/rounds/:id/advance'],
  [/^\/api\/internal\/approvals\/[^/]+$/, '/api/internal/approvals/:id'],
  [/^\/api\/marketplace\/plugins\/[^/]+\/versions$/, '/api/marketplace/plugins/:slug/versions'],
  [/^\/api\/marketplace\/plugins\/[^/]+\/preflight$/, '/api/marketplace/plugins/:slug/preflight'],
  [/^\/api\/marketplace\/plugins\/[^/]+\/install$/, '/api/marketplace/plugins/:slug/install'],
  [/^\/api\/marketplace\/plugins\/[^/]+$/, '/api/marketplace/plugins/:slug'],
  [/^\/api\/plugin-installs\/[^/]+$/, '/api/plugin-installs/:id'],
  [/^\/api\/approvals\/[^/]+$/, '/api/approvals/:id'],
  [/^\/api\/approval-grants\/[^/]+$/, '/api/approval-grants/:id'],
  [/^\/api\/quotas\/[^/]+$/, '/api/quotas/:id'],
  [/^\/api\/schedules\/[^/]+\/run$/, '/api/schedules/:id/run'],
  [/^\/api\/schedules\/[^/]+$/, '/api/schedules/:id'],
  [/^\/api\/runs\/[^/]+\/stop$/, '/api/runs/:id/stop'],
  [/^\/api\/attachments\/[^/]+$/, '/api/attachments/:id'],
  [/^\/api\/messages\/[^/]+\/files\/[^/]+$/, '/api/messages/:seq/files/:artifactId'],
  [/^\/api\/bots\/[^/]+\/restore$/, '/api/bots/:id/restore'],
  [/^\/api\/bots\/[^/]+$/, '/api/bots/:id']
]

export interface MetricPoint {
  name: string
  kind: 'counter' | 'gauge' | 'histogram'
  value: number
  labels?: Record<string, string>
}

export interface MetricsRegistry {
  /** rawUrl 可带 query；内部只取 pathname 并归一成路由模板。 */
  record(method: string, rawUrl: string, status: number, durationMs: number): void
  /** 业务事件 → 指标（observability/from-events.ts 的产物）。 */
  ingest(points: readonly MetricPoint[]): void
  render(store?: Store): string
}

interface CounterSeries {
  method: string
  path: string
  status: string
  value: number
}

interface HistogramSeries {
  method: string
  path: string
  /** 每个固定 bucket 的增量计数（渲染时累加）。 */
  buckets: number[]
  sum: number
  count: number
}

function pathnameOf(rawUrl: string): string {
  try {
    return new URL(rawUrl, 'http://metrics.local').pathname
  } catch {
    return rawUrl.split('?')[0] ?? rawUrl
  }
}

/** 路由模板；未识别一律 other，防止用户可控 id 打爆 path 标签。 */
export function routeTemplate(rawUrl: string): string {
  let path = pathnameOf(rawUrl)
  path = path.replace(/\/+$/, '')
  if (path === '') path = '/'
  if (EXACT_ROUTES.has(path)) return path
  for (const [pattern, template] of ROUTE_PATTERNS) {
    if (pattern.test(path)) return template
  }
  return 'other'
}

export function metricMethod(method: string): string {
  const upper = method.toUpperCase()
  return HTTP_METHODS.has(upper) ? upper : 'OTHER'
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function labels(fields: Record<string, string>): string {
  const parts = Object.entries(fields).map(([key, value]) => `${key}="${escapeLabel(value)}"`)
  return parts.length === 0 ? '' : `{${parts.join(',')}}`
}

function gauge(store: Store | undefined, sql: string): number {
  if (store === undefined) return 0
  try {
    const row = store.db.prepare(sql).get() as { n?: number | bigint } | undefined
    if (row === undefined || row === null || row.n === undefined) return 0
    const parsed = Number(row.n)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  } catch {
    return 0
  }
}

export function createMetrics(): MetricsRegistry {
  const counters = new Map<string, CounterSeries>()
  const business = new Map<string, { kind: MetricPoint['kind']; labels: Record<string, string>; value: number }>()
  const histograms = new Map<string, HistogramSeries>()

  return {
    record(method, rawUrl, status, durationMs) {
      const metric = metricMethod(method)
      const path = routeTemplate(rawUrl)
      const statusLabel = String(status)
      const counterKey = `${metric}\0${path}\0${statusLabel}`
      const counter = counters.get(counterKey)
      if (counter === undefined) {
        counters.set(counterKey, { method: metric, path, status: statusLabel, value: 1 })
      } else {
        counter.value += 1
      }

      const histogramKey = `${metric}\0${path}`
      let histogram = histograms.get(histogramKey)
      if (histogram === undefined) {
        histogram = {
          method: metric,
          path,
          buckets: DURATION_BUCKETS.map(() => 0),
          sum: 0,
          count: 0
        }
        histograms.set(histogramKey, histogram)
      }
      const seconds = (Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0) / 1000
      histogram.sum += seconds
      histogram.count += 1
      // 只记第一个命中的 bucket；渲染时做累计，避免重复累加。
      const bucketIndex = DURATION_BUCKETS.findIndex((bucket) => seconds <= bucket)
      if (bucketIndex >= 0) histogram.buckets[bucketIndex] = histogram.buckets[bucketIndex]! + 1
    },

    ingest(points) {
      for (const point of points) {
        if (typeof point?.name !== 'string' || point.name === '') continue
        const labelKey = JSON.stringify(point.labels ?? {})
        const key = `${point.name}|${labelKey}`
        const current = business.get(key)
        if (point.kind === 'counter') {
          business.set(key, { kind: 'counter', labels: point.labels ?? {}, value: (current?.value ?? 0) + point.value })
        } else if (point.kind === 'gauge') {
          business.set(key, { kind: 'gauge', labels: point.labels ?? {}, value: point.value })
        } else {
          business.set(key, { kind: 'histogram', labels: point.labels ?? {}, value: (current?.value ?? 0) + point.value })
        }
      }
    },
    render(store) {
      const lines: string[] = []
      lines.push('# HELP roost_http_requests_total Total HTTP requests.')
      lines.push('# TYPE roost_http_requests_total counter')
      const counterRows = [...counters.values()].sort(
        (a, b) => a.method.localeCompare(b.method) || a.path.localeCompare(b.path) || a.status.localeCompare(b.status)
      )
      for (const row of counterRows) {
        lines.push(
          `roost_http_requests_total${labels({ method: row.method, path: row.path, status: row.status })} ${row.value}`
        )
      }

      lines.push('# HELP roost_http_request_duration_seconds HTTP request duration in seconds.')
      lines.push('# TYPE roost_http_request_duration_seconds histogram')
      const histogramRows = [...histograms.values()].sort(
        (a, b) => a.method.localeCompare(b.method) || a.path.localeCompare(b.path)
      )
      for (const row of histogramRows) {
        let cumulative = 0
        for (let index = 0; index < DURATION_BUCKETS.length; index += 1) {
          cumulative += row.buckets[index]!
          lines.push(
            `roost_http_request_duration_seconds_bucket${labels({
              method: row.method,
              path: row.path,
              le: String(DURATION_BUCKETS[index])
            })} ${cumulative}`
          )
        }
        lines.push(
          `roost_http_request_duration_seconds_bucket${labels({ method: row.method, path: row.path, le: '+Inf' })} ${row.count}`
        )
        lines.push(
          `roost_http_request_duration_seconds_sum${labels({ method: row.method, path: row.path })} ${row.sum}`
        )
        lines.push(
          `roost_http_request_duration_seconds_count${labels({ method: row.method, path: row.path })} ${row.count}`
        )
      }

      lines.push('# HELP roost_pending_approvals Pending approvals.')
      lines.push('# TYPE roost_pending_approvals gauge')
      lines.push(
        `roost_pending_approvals ${gauge(store, "SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'")}`
      )
      lines.push('# HELP roost_runs_queued Queued scheduled runs.')
      lines.push('# TYPE roost_runs_queued gauge')
      lines.push(`roost_runs_queued ${gauge(store, "SELECT COUNT(*) AS n FROM runs WHERE status = 'queued'")}`)
      lines.push('# HELP roost_plugins_installing Plugin installs waiting for sync.')
      lines.push('# TYPE roost_plugins_installing gauge')
      lines.push(
        `roost_plugins_installing ${gauge(store, "SELECT COUNT(*) AS n FROM plugin_installs WHERE state = 'installing'")}`
      )
      return `${lines.join('\n')}\n`
    }
  }
}
