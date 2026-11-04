// 网关后端选择（M6-6.1.1 / M6-6.1.7）。
//
//   ROOST_CONNECTOR_BACKEND = stub（默认）| openconnector | composio
//   ROOST_CONNECTOR_URL      = 网关 base URL（openconnector/composio 必填）
//   ROOST_CONNECTOR_TOKEN    = 网关 Bearer token（可选，敏感）
//   ROOST_CONNECTOR_TIMEOUT_MS = 单次请求超时（可选，默认 5000）
//
// 未选择或配置不完整时回退 StubGatewayBackend：目录为空、authorize/call 抛
// `connector.not_configured`，API 如实返回 501。回退只写日志，不回显 token。

import { HttpGatewayBackend } from './http.ts'
import { StubGatewayBackend } from './stub.ts'
import type { GatewayBackend, GatewayBackendId } from './types.ts'

export interface CreateGatewayBackendOptions {
  /** 回退/配置异常日志出口；默认 console.warn。测试可注入收集器。 */
  log?: (message: string) => void
}

/** 解析 `ROOST_CONNECTOR_BACKEND`；未配置时为 stub。 */
export function createGatewayBackend(
  env: Record<string, string | undefined> = process.env,
  options: CreateGatewayBackendOptions = {},
): GatewayBackend {
  const log = options.log ?? ((message: string) => console.warn(message))
  const requested = (env['ROOST_CONNECTOR_BACKEND'] ?? '').trim().toLowerCase()
  const name = requested === '' ? 'stub' : requested

  if (name === 'stub') return new StubGatewayBackend()

  if (name !== 'openconnector' && name !== 'composio') {
    log(`roost connectors: unknown ROOST_CONNECTOR_BACKEND=${name}; using stub backend`)
    return new StubGatewayBackend()
  }

  const baseUrl = (env['ROOST_CONNECTOR_URL'] ?? '').trim()
  if (baseUrl === '') {
    log(
      `roost connectors: ROOST_CONNECTOR_BACKEND=${name} requires ROOST_CONNECTOR_URL; ` +
        'using stub backend (connectors disabled)',
    )
    return new StubGatewayBackend()
  }

  const token = (env['ROOST_CONNECTOR_TOKEN'] ?? '').trim()
  const timeoutMs = parseTimeoutMs(env['ROOST_CONNECTOR_TIMEOUT_MS'])
  try {
    return new HttpGatewayBackend({
      baseUrl,
      backendId: name as GatewayBackendId,
      ...(token === '' ? {} : { token }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    })
  } catch {
    // 不回显 URL：它可能带查询参数或凭据。
    log(`roost connectors: invalid ROOST_CONNECTOR_URL for ${name} backend; using stub backend`)
    return new StubGatewayBackend()
  }
}

function parseTimeoutMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}
