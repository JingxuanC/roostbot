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
  /** 指定使用哪条 named connection；为空表示 workspace 默认连接。 */
  connectionId?: string
}

export interface ConnectorCall {
  workspaceId: string
  botId: string
  slug: string
  action: string
  args: unknown
  /** 幂等键：有副作用的动作必填，防止重复发信/重复下单。 */
  idem?: string
  /** 网关 named connection；由控制面按 workspace/account 生成。 */
  connectionAlias?: string
  /** 授权该连接的用户账号；用于审计/网关隔离。 */
  accountId?: string
}

export type CallResult =
  | { ok: true; data: unknown; bytes: number }
  | { ok: false; code: 'denied' | 'unavailable' | 'needs_reauth' | 'provider_error'; reason?: string }

/** OAuth 起点附加上下文；可选，兼容只传 slug 的旧调用方。 */
export interface ConnectorAuthorizeOptions {
  workspaceId?: string
  state?: string
  /** 发起授权的账号；网关用它创建 per-user named connection。 */
  accountId?: string
  /** 控制面生成的稳定 named connection 名称。 */
  connectionAlias?: string
}

/** 查询连接状态的附加上下文；可选，兼容只传 slug 的旧调用方。 */
export interface ConnectorStatusOptions {
  workspaceId?: string
  accountId?: string
  connectionAlias?: string
}

export interface ConnectorStatusDetails {
  status: ConnectionStatus
  accountLabel?: string
}

export interface GatewayBackend {
  id: GatewayBackendId
  listConnectors(): Promise<ConnectorSummary[]>
  authorize(slug: string, options?: ConnectorAuthorizeOptions): Promise<{ url: string }>
  call(call: ConnectorCall, grant: ConnectorGrant): Promise<CallResult>
  status(slug: string, options?: ConnectorStatusOptions): Promise<ConnectionStatus>
  /** 可选：同时返回展示用账号名；不支持的后端可只实现 status。 */
  statusDetails?(slug: string, options?: ConnectorStatusOptions): Promise<ConnectorStatusDetails>
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
