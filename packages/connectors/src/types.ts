// 设计见 docs/design/connectors.md。凭据永不下发到沙箱或上下文。

export type GatewayBackendId = 'openconnector' | 'composio' | 'native-mcp'

export type ConnectionStatus = 'connected' | 'expired' | 'revoked'

export type ConnectorAccess = 'read' | 'write'

export interface ConnectorSummary {
  slug: string
  title: string
  backend: GatewayBackendId
  actions: { name: string; access: ConnectorAccess }[]
}

export interface ConnectorGrant {
  workspaceId: string
  botId: string
  slug: string
  access: ConnectorAccess
  /** 为空表示该 access 下的全部动作。 */
  actions?: string[]
}

export interface ConnectorCall {
  workspaceId: string
  botId: string
  slug: string
  action: string
  args: unknown
  /** 幂等键：有副作用的动作必填，防止重复发信/重复下单。 */
  idem?: string
}

export type CallResult =
  | { ok: true; data: unknown; bytes: number }
  | { ok: false; code: 'denied' | 'unavailable' | 'needs_reauth' | 'provider_error'; reason?: string }

/** OAuth 起点附加上下文；可选，兼容只传 slug 的旧调用方。 */
export interface ConnectorAuthorizeOptions {
  workspaceId?: string
  state?: string
}

/** 查询连接状态的附加上下文；可选，兼容只传 slug 的旧调用方。 */
export interface ConnectorStatusOptions {
  workspaceId?: string
}

export interface GatewayBackend {
  id: GatewayBackendId
  listConnectors(): Promise<ConnectorSummary[]>
  authorize(slug: string, options?: ConnectorAuthorizeOptions): Promise<{ url: string }>
  call(call: ConnectorCall, grant: ConnectorGrant): Promise<CallResult>
  status(slug: string, options?: ConnectorStatusOptions): Promise<ConnectionStatus>
}

/** 未授权的连接器不进上下文：工具名也不出现。 */
export function isActionGranted(grant: ConnectorGrant | undefined, action: string): boolean {
  if (grant === undefined) return false
  if (grant.actions === undefined || grant.actions.length === 0) return true
  return grant.actions.includes(action)
}

/** 有副作用的动作必须显式批准，且必须带幂等键。 */
export function requiresApprovalForWrite(access: ConnectorAccess, action: string): boolean {
  const outward = /send|create|update|delete|pay|charge|post|push|merge|upload/i
  return access === 'write' && outward.test(action)
}

export const CONNECTOR_TOOL_PREFIX = 'connector__'

/** 工具命名：connector__<slug>__<action>。 */
export function toolNameOf(slug: string, action: string): string {
  return `${CONNECTOR_TOOL_PREFIX}${slug}__${action}`
}
