// 默认网关后端：控制面框架（M6-6.1）还没接真实网关。
//
// 不写假数据接口：目录返回空；authorize/call 直接抛 `connector.not_configured`，
// 让上层（API）如实返回 501，而不是假装 OAuth 成功或调用成功。
// 测试通过 ServerOptions.connectorBackend 注入 fake，不走这里。

import type {
  CallResult,
  ConnectionStatus,
  ConnectorCall,
  ConnectorGrant,
  ConnectorSummary,
  GatewayBackend,
  GatewayBackendId,
} from './types.ts'

/** 未配置/未实现的网关错误；message 前缀是稳定契约，API 层按它映射 501。 */
export const CONNECTOR_NOT_CONFIGURED = 'connector.not_configured'

export class StubGatewayBackend implements GatewayBackend {
  readonly id: GatewayBackendId = 'openconnector'

  async listConnectors(): Promise<ConnectorSummary[]> {
    return []
  }

  async authorize(_slug: string): Promise<{ url: string }> {
    throw new Error(`${CONNECTOR_NOT_CONFIGURED}: no connector gateway is configured`)
  }

  async call(_call: ConnectorCall, _grant: ConnectorGrant): Promise<CallResult> {
    throw new Error(`${CONNECTOR_NOT_CONFIGURED}: no connector gateway is configured`)
  }

  async status(_slug: string): Promise<ConnectionStatus> {
    return 'revoked'
  }
}

/** 判定后端异常是否为「未配置」；API 层据此回 501 而不是 502。 */
export function isConnectorNotConfigured(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes(CONNECTOR_NOT_CONFIGURED)
}
