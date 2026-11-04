// 深度健康路由：GET /healthz/deep（M6-6.6、docs/design/slo.md §2）。
//
// /healthz 只看进程内状态；这个端点额外跑注入的 store / sandbox / gateway probe。
// 与 /healthz 一样不鉴权，但响应刻意只给 name/status/detail，不透错误堆栈。
// 探针本身由 server.ts 注入，本文件不 import DB 或 CLI，避免把启动依赖带进路由。
//
// Lead 接线（server.ts，放在 `path === '/healthz'` 分支旁边）：
//
//   if (path === '/healthz/deep') {
//     await handleDeepHealth({ probes: deepHealthProbes, now: ctx.now }, req, res)
//     return
//   }

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  runHealthChecks,
  type HealthCheck,
  type HealthProbes,
  type HealthReport,
  type HealthStatus
} from '../../../packages/observability/src/health.ts'
import { sendError, sendJson } from './server.ts'

export interface DeepHealthContext {
  probes: HealthProbes
  /** epoch 毫秒、Date 或返回毫秒的函数；默认当前时间。 */
  now?: number | Date | (() => number)
  /** 单个 probe 的超时；默认交给 runHealthChecks（2000ms）。 */
  timeoutMs?: number
}

/** 对外只暴露这三个字段（HealthReport 的稳定子集）。 */
export interface DeepHealthBody {
  status: HealthStatus
  checks: HealthCheck[]
  at: string
}

/**
 * 处理深度健康请求。
 * - GET：200 + {status,checks,at}；status=down 时 503。
 * - 其他方法：405 + Allow: GET。
 */
export async function handleDeepHealth(
  ctx: DeepHealthContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'GET') {
    req.resume()
    sendError(res, 405, 'method_not_allowed', 'deep health only supports GET', { allow: 'GET' })
    return
  }

  const report: HealthReport = await runHealthChecks({
    probes: ctx.probes,
    ...(ctx.now === undefined ? {} : { now: ctx.now }),
    ...(ctx.timeoutMs === undefined ? {} : { timeoutMs: ctx.timeoutMs })
  })
  const body: DeepHealthBody = { status: report.status, checks: report.checks, at: report.at }
  sendJson(res, report.status === 'down' ? 503 : 200, body)
}
