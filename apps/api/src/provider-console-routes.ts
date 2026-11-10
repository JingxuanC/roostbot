// Provider console 只读路由：把 Daytona 自托管 fork 的 /provider/* 经济数据暴露给 Roost 控制面。
//
//   GET  /api/provider/nodes                     节点状态 + 7 日指标
//   GET  /api/provider/nodes/:runnerId/sandboxes 节点上的沙箱
//   GET  /api/provider/usage                     按节点×天的 vCPU·h / GiB·h
//   GET  /api/provider/earnings                  收益（已结算优先，未结算实时兜底）
//   GET  /api/provider/settlements               结算单
//   GET  /api/provider/alerts                    节点告警
//   POST /api/provider/alerts/:id/resolve        人工解除告警
//
// 鉴权：Bearer 会话（与 /api/quotas 一致）。provider console 未配置 → 501 provider.not_configured；
// Daytona Cloud 上没有 /provider/* → 上游 404 映射成 501 provider.not_supported；
// 凭据被拒 → 401；网络/上游异常 → 502。
//
// 设计源：daytona 仓库 issue #1 与 apps/api/src/provider 的契约；见 docs/design/provider-console.md。

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  ProviderConsoleError,
  type ProviderConsoleClient,
  type ProviderUsageGranularity,
} from './provider-console-client.ts'
import { authenticate, sendError, sendJson } from './server.ts'

type AuthenticateContext = Parameters<typeof authenticate>[0]

export type ProviderConsoleRouteContext = AuthenticateContext & {
  providerConsole?: ProviderConsoleClient
}

const USAGE_GRANULARITIES: readonly ProviderUsageGranularity[] = ['day', 'total']
const SETTLEMENT_STATUSES = ['PENDING', 'SETTLED', 'WITHDRAWING', 'WITHDRAWN'] as const
const ALERT_STATES = ['open', 'resolved', 'all'] as const

export async function handleProviderConsole(
  ctx: ProviderConsoleRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) {
    sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
    return
  }

  const client = ctx.providerConsole
  if (client === undefined) {
    sendError(
      res,
      501,
      'provider.not_configured',
      'provider console is not configured; set ROOST_PROVIDER_CONSOLE=1 and DAYTONA_API_KEY',
    )
    return
  }

  const method = req.method ?? 'GET'
  const path = url.pathname

  try {
    if (path === '/api/provider/nodes') {
      if (method !== 'GET') {
        sendError(res, 405, 'method_not_allowed', 'GET required')
        return
      }
      sendJson(res, 200, await client.listNodes())
      return
    }

    const nodeSandboxes = /^\/api\/provider\/nodes\/([^/]+)\/sandboxes$/.exec(path)
    if (nodeSandboxes !== null) {
      if (method !== 'GET') {
        sendError(res, 405, 'method_not_allowed', 'GET required')
        return
      }
      sendJson(res, 200, await client.listNodeSandboxes(decodeURIComponent(nodeSandboxes[1])))
      return
    }

    if (path === '/api/provider/usage') {
      if (method !== 'GET') {
        sendError(res, 405, 'method_not_allowed', 'GET required')
        return
      }
      const granularity = readParam(url, 'granularity')
      if (granularity !== null && !USAGE_GRANULARITIES.includes(granularity as ProviderUsageGranularity)) {
        sendError(res, 400, 'invalid_query', `granularity must be one of ${USAGE_GRANULARITIES.join(', ')}`)
        return
      }
      const runnerId = readParam(url, 'runnerId')
      const from = readParam(url, 'from')
      const to = readParam(url, 'to')
      sendJson(
        res,
        200,
        await client.getUsage({
          ...(from === null ? {} : { from }),
          ...(to === null ? {} : { to }),
          ...(runnerId === null ? {} : { runnerId }),
          ...(granularity === null ? {} : { granularity: granularity as ProviderUsageGranularity }),
        }),
      )
      return
    }

    if (path === '/api/provider/earnings') {
      if (method !== 'GET') {
        sendError(res, 405, 'method_not_allowed', 'GET required')
        return
      }
      const from = readParam(url, 'from')
      const to = readParam(url, 'to')
      const runnerId = readParam(url, 'runnerId')
      sendJson(
        res,
        200,
        await client.getEarnings({
          ...(from === null ? {} : { from }),
          ...(to === null ? {} : { to }),
          ...(runnerId === null ? {} : { runnerId }),
        }),
      )
      return
    }

    if (path === '/api/provider/settlements') {
      if (method !== 'GET') {
        sendError(res, 405, 'method_not_allowed', 'GET required')
        return
      }
      const status = readParam(url, 'status')
      if (status !== null && !SETTLEMENT_STATUSES.includes(status as (typeof SETTLEMENT_STATUSES)[number])) {
        sendError(res, 400, 'invalid_query', `status must be one of ${SETTLEMENT_STATUSES.join(', ')}`)
        return
      }
      const limit = readLimit(url, 200)
      if (limit === 'invalid') {
        sendError(res, 400, 'invalid_query', 'limit must be a positive integer <= 200')
        return
      }
      const from = readParam(url, 'from')
      const to = readParam(url, 'to')
      const runnerId = readParam(url, 'runnerId')
      sendJson(
        res,
        200,
        await client.listSettlements({
          ...(status === null ? {} : { status }),
          ...(from === null ? {} : { from }),
          ...(to === null ? {} : { to }),
          ...(runnerId === null ? {} : { runnerId }),
          ...(limit === null ? {} : { limit }),
        }),
      )
      return
    }

    if (path === '/api/provider/alerts') {
      if (method !== 'GET') {
        sendError(res, 405, 'method_not_allowed', 'GET required')
        return
      }
      const state = readParam(url, 'state')
      if (state !== null && !ALERT_STATES.includes(state as (typeof ALERT_STATES)[number])) {
        sendError(res, 400, 'invalid_query', `state must be one of ${ALERT_STATES.join(', ')}`)
        return
      }
      const limit = readLimit(url, 200)
      if (limit === 'invalid') {
        sendError(res, 400, 'invalid_query', 'limit must be a positive integer <= 200')
        return
      }
      const runnerId = readParam(url, 'runnerId')
      sendJson(
        res,
        200,
        await client.listAlerts({
          ...(state === null ? {} : { state: state as (typeof ALERT_STATES)[number] }),
          ...(runnerId === null ? {} : { runnerId }),
          ...(limit === null ? {} : { limit }),
        }),
      )
      return
    }

    const resolveAlert = /^\/api\/provider\/alerts\/([^/]+)\/resolve$/.exec(path)
    if (resolveAlert !== null) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', 'POST required')
        return
      }
      sendJson(res, 200, await client.resolveAlert(decodeURIComponent(resolveAlert[1])))
      return
    }

    sendError(res, 404, 'not_found', `${method} ${path} not found`)
  } catch (error) {
    sendProviderConsoleFailure(res, error)
  }
}

/** 统一把上游失败映射成明确的 HTTP 语义，避免前端看到笼统的 500。 */
function sendProviderConsoleFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof ProviderConsoleError) {
    switch (error.failure) {
      case 'not_supported':
        sendError(res, 501, 'provider.not_supported', error.message)
        return
      case 'unauthorized':
        sendError(res, 401, 'provider.unauthorized', error.message)
        return
      case 'network':
        sendError(res, 502, 'provider.unreachable', error.message)
        return
      default:
        sendError(res, 502, 'provider.bad_response', error.message)
        return
    }
  }

  sendError(res, 500, 'internal', error instanceof Error ? error.message : String(error))
}

function readParam(url: URL, name: string): string | null {
  const value = url.searchParams.get(name)
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** 返回 null = 未提供；返回数字 = 合法；'invalid' = 非法。 */
function readLimit(url: URL, max: number): number | null | 'invalid' {
  const raw = readParam(url, 'limit')
  if (raw === null) return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > max) return 'invalid'
  return value
}
