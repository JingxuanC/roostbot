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
  /**
   * 显式的连接级放行。省略时必须给出 HTTP 方法；空 methods 不能再被当成 tcp。
   * tcp 规则不能带 credential_binding。
   */
  transport?: 'tcp'
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

export const METADATA_HOSTS: readonly string[] = [
  '169.254.169.254',
  '100.100.100.200',
  'fd00:ec2::254',
  'metadata.google.internal',
]

/** 比较和拦截前先规范化：小写、去掉末尾点、拆掉端口和 IPv6 方括号。 */
export function normalizeEgressHost(raw: string): string {
  let value = raw.trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end > 1) return value.slice(1, end)
  }
  value = value.replace(/\.$/, '')
  const withPort = /^(.*):(\d+)$/.exec(value)
  if (withPort !== null && !withPort[1]!.includes(':')) value = withPort[1]!
  return value.replace(/\.$/, '')
}

function ipv4Parts(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : NaN))
  if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return numbers
}

/** 云元数据：精确地址、link-local 169.254/16、以及文档里的阿里云地址。 */
export function isMetadataHost(raw: string): boolean {
  const host = normalizeEgressHost(raw)
  if (METADATA_HOSTS.includes(host)) return true
  if (host === '2852039166') return true
  const parts = ipv4Parts(host)
  if (parts !== null && parts[0] === 169 && parts[1] === 254) return true
  return false
}

/**
 * 默认拒绝：没有规则命中就是拒绝。
 * 按二进制匹配，避免“沙箱能连 github”这种整体放行。
 */
export function isEgressAllowed(policy: SandboxPolicy, request: EgressRequest): boolean {
  if (policy.network.default !== 'deny') return false
  if (isMetadataHost(request.host)) return false
  const host = normalizeEgressHost(request.host)
  return policy.network.allow.some((rule) =>
    rule.binary === request.binary &&
    normalizeEgressHost(rule.host) === host &&
    !isMetadataHost(rule.host) &&
    rule.methods.map((m) => m.toUpperCase()).includes(request.method.toUpperCase()))
}

/**
 * 哪些策略变更必须走“证明 + 人工批准”：
 * 新增带凭据的主机、扩大 HTTP 方法、触碰云元数据端点。
 */
export function requiresProof(before: NetworkRule | undefined, after: NetworkRule): string[] {
  const reasons: string[] = []
  if (after.credentials !== undefined) {
    if (before === undefined || before.credentials === undefined) {
      reasons.push('new credentialed host')
    } else if (normalizeEgressHost(before.host) !== normalizeEgressHost(after.host) || before.binary !== after.binary) {
      reasons.push('credentialed target changed')
    }
  }
  if (before !== undefined) {
    const added = after.methods.filter((m) => !before.methods.includes(m))
    if (added.length > 0) reasons.push(`new methods: ${added.join(',')}`)
  }
  if (isMetadataHost(after.host)) reasons.push('cloud metadata endpoint')
  return reasons
}

/** 沙箱内进程不得以 root 运行，也不应带 capabilities。 */
export function isProcessPolicySafe(policy: ProcessPolicy): boolean {
  return policy.user !== 0 && policy.caps.length === 0
}
