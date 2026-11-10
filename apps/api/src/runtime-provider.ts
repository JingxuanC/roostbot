// RuntimeProvider: the compute/lifecycle boundary beneath the control plane.
//
// This is intentionally NOT the AgentAdapter interface:
//   RuntimeProvider  — where the workspace runtime runs (Docker, OpenShell, local, k8s)
//   AgentAdapter     — which harness runs inside it (dsh, claude-code, codex, grok-build)
//
// The control-plane RuntimeManager keeps its public shape (ensure/status) and
// composes: token issuance + RuntimeSpec builder + RuntimeProvider.
// Adding Docker, Kubernetes, gVisor or a microVM provider must not touch rooms,
// SSE, events, bot APIs or the AgentAdapter contract.

export const RUNTIME_PROVIDER_IDS = ['local', 'openshell', 'docker', 'kubernetes', 'daytona'] as const

export type RuntimeProviderId = (typeof RUNTIME_PROVIDER_IDS)[number]

export function isRuntimeProviderId(value: unknown): value is RuntimeProviderId {
  return typeof value === 'string' && (RUNTIME_PROVIDER_IDS as readonly string[]).includes(value)
}

export type RuntimeProviderPhase = 'starting' | 'ready' | 'stopped' | 'error' | 'unknown'

export type RuntimeIsolation = 'process' | 'container' | 'microvm' | 'remote'

export interface RuntimeProviderCapabilities {
  /** What the provider can actually promise, not what the deployment wishes. */
  isolation: RuntimeIsolation
  /** Workspace files survive stop/recreate. */
  persistentWorkspace: boolean
  /** Provider can stream/tail logs for diagnostics. */
  logs: boolean
  /** Provider can run a one-off command inside the runtime. */
  exec: boolean
  suspend: boolean
  resume: boolean
  /** Provider can enforce an egress allowlist. */
  networkPolicy: boolean
  resourceLimits: boolean
  /** How secrets reach the runtime. */
  secrets: 'env' | 'ref' | 'none'
}

export interface RuntimeProviderProbe {
  ok: boolean
  version?: string
  problems: string[]
  capabilities: RuntimeProviderCapabilities
}

export interface RuntimeProviderContext {
  signal?: AbortSignal
  now?: () => number
  /** Provider diagnostics; never log secret values here. */
  log?: (line: string) => void
}

export interface RuntimeResources {
  cpus?: number
  memoryMb?: number
  pids?: number
}

export interface RuntimeSpec {
  workspaceId: string
  /** Provider-owned stable name; may be derived from workspaceId. */
  name?: string
  image?: string
  command?: string[]
  /** Plain, non-secret environment. Does not include model keys. */
  env?: Record<string, string>
  /** References resolved by the provider/secret store; first version may be empty. */
  secrets?: Array<{ name: string; ref: string }>
  resources?: RuntimeResources
  network?: 'none' | 'host' | 'bridge' | 'private'
  labels?: Record<string, string>
  /** A provider must not report ready before the room-agent marker exists. */
  readyTimeoutMs?: number
}

export interface RuntimeKey {
  workspaceId: string
}

export interface RuntimeHandle {
  provider: RuntimeProviderId
  /** Stable provider-owned runtime name, e.g. roost-ws-<hash>. */
  name: string
  workspaceId: string
  createdAt?: number
  metadata?: Record<string, string>
}

export interface RuntimeProviderStatus {
  handle: RuntimeHandle
  phase: RuntimeProviderPhase
  readyAt?: number
  message?: string
  errorCode?: string
}

export interface RuntimeEnsureOutcome {
  handle: RuntimeHandle
  status: RuntimeProviderStatus
  /** false = an existing runtime was reused; its env was not rewritten. */
  created: boolean
}

export interface RuntimeStopOptions {
  /** Keep the workspace data; default true. */
  keepWorkspace?: boolean
  /** Remove the container/instance after stop; default provider-specific. */
  remove?: boolean
}

export interface RuntimeExecOptions {
  cwd?: string
  timeoutMs?: number
  stdin?: string
}

export interface RuntimeExecResult {
  code: number
  stdout: string
  stderr: string
}

export type RuntimeProviderErrorCode =
  | 'provider.not_available'
  | 'provider.unauthorized'
  | 'provider.provision_failed'
  | 'provider.ready_timeout'
  | 'provider.conflict'
  | 'provider.not_found'
  | 'provider.exec_failed'

export class RuntimeProviderError extends Error {
  readonly code: RuntimeProviderErrorCode
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(
    code: RuntimeProviderErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RuntimeProviderError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.details = options.details
  }
}

/**
 * A RuntimeProvider is a stateless capability. It owns compute lifecycle only;
 * it never issues room/runtime tokens, persists workspace runtime rows or talks
 * to model providers.
 */
export interface RuntimeProvider {
  readonly id: RuntimeProviderId
  capabilities(): RuntimeProviderCapabilities
  probe(context?: RuntimeProviderContext): Promise<RuntimeProviderProbe>
  ensure(spec: RuntimeSpec, context?: RuntimeProviderContext): Promise<RuntimeEnsureOutcome>
  status(key: RuntimeKey, context?: RuntimeProviderContext): Promise<RuntimeProviderStatus | null>
  stop(key: RuntimeKey, options?: RuntimeStopOptions, context?: RuntimeProviderContext): Promise<void>
  logs?(key: RuntimeKey, options?: { tail?: number }, context?: RuntimeProviderContext): Promise<string>
  exec?(key: RuntimeKey, argv: string[], options?: RuntimeExecOptions, context?: RuntimeProviderContext): Promise<RuntimeExecResult>
}

export type RuntimeProviderFactory<TConfig = unknown> = (config: TConfig) => RuntimeProvider

/**
 * Optional registry for deployments that compose providers from env.
 * Kept as a small map rather than a dependency-injection framework.
 */
export function createRuntimeProviderRegistry(): Map<RuntimeProviderId, RuntimeProviderFactory> {
  return new Map()
}
