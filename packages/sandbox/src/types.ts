// 设计见 docs/design/sandboxing.md。只有类型与纯判定，不执行任何东西。

export interface FilesystemPolicy {
  /** 只读可见的镜像路径。 */
  read: string[]
  /** 本回合可写路径。 */
  write: string[]
}

export interface ProcessPolicy {
  /** 沙箱内进程身份；必须是非 root。 */
  user: number
  /** Linux capabilities；沙箱默认空。
   * 注意：`0` 不是空数组，写 `[]`。 */
  caps: string[]
}

/** 一条出站规则：按“二进制 → 目的地 → 方法”授权，而不是按沙箱整体。 */
export interface NetworkRule {
  /** 发起程序的绝对路径，取自受信观测，不是 agent 自称。 */
  binary: string
  /** 主机或 host:port。 */
  host: string
  methods: string[]
  /** 由可信侧注入的凭据引用名；沙箱内不可见。 */
  credentials?: string
}

export interface NetworkPolicy {
  default: 'deny'
  allow: NetworkRule[]
}

export interface SandboxPolicy {
  version: 1
  filesystem: FilesystemPolicy
  process: ProcessPolicy
  network: NetworkPolicy
}

/** 一次出站请求；判定输入。 */
export interface EgressRequest {
  binary: string
  host: string
  method: string
}

export const METADATA_HOSTS: readonly string[] = ['169.254.169.254', 'metadata.google.internal']

/**
 * 默认拒绝：没有规则命中就是拒绝。
 * 按二进制匹配，避免“沙箱能连 github”这种整体放行。
 */
export function isEgressAllowed(policy: SandboxPolicy, request: EgressRequest): boolean {
  if (policy.network.default !== 'deny') return false
  return policy.network.allow.some((rule) =>
    rule.binary === request.binary &&
    rule.host.toLowerCase() === request.host.toLowerCase() &&
    rule.methods.map((m) => m.toUpperCase()).includes(request.method.toUpperCase()))
}

/**
 * 哪些策略变更必须走“证明 + 人工批准”：
 * 新增带凭据的主机、扩大 HTTP 方法、触碰云元数据端点。
 */
export function requiresProof(before: NetworkRule | undefined, after: NetworkRule): string[] {
  const reasons: string[] = []
  if (after.credentials !== undefined && (before === undefined || before.credentials === undefined)) {
    reasons.push('new credentialed host')
  }
  if (before !== undefined) {
    const added = after.methods.filter((m) => !before.methods.includes(m))
    if (added.length > 0) reasons.push(`new methods: ${added.join(',')}`)
  }
  if (METADATA_HOSTS.includes(after.host)) reasons.push('cloud metadata endpoint')
  return reasons
}

/** 沙箱内进程不得以 root 运行，也不应带 capabilities。 */
export function isProcessPolicySafe(policy: ProcessPolicy): boolean {
  return policy.user !== 0 && policy.caps.length === 0
}
