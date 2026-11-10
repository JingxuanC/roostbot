// Docker runtime provider + the control-plane RuntimeManager that composes it.
//
// The control plane never talks to the Docker daemon. It talks to a small
// authenticated worker on the Docker host; the worker owns container lifecycle.
// This keeps Docker a provider, not a second control plane.

import type { IssuedRuntimeToken } from '../../../packages/store/src/runtime-tokens.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { providerRuntimeManager } from './runtime-manager-provider.ts'
import {
  RuntimeProviderError,
  type RuntimeEnsureOutcome,
  type RuntimeHandle,
  type RuntimeKey,
  type RuntimeProvider,
  type RuntimeProviderCapabilities,
  type RuntimeProviderStatus,
  type RuntimeSpec,
} from './runtime-provider.ts'
import type { RuntimeManager } from './workspace-runtime.ts'

export const DOCKER_RUNTIME_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

export interface DockerRuntimeManagerConfig {
  workerUrl: string
  /** Optional multiple Docker workers; workspace placement is deterministic. */
  workerUrls?: string[]
  workerToken: string
  image?: string
  cpHost: string
  cpPort: number
  cpScheme?: 'http' | 'https'
  lockApiBase?: string
  runtimeToken: string
  rawStore?: Store
  tokenIssuer?: (workspaceId: string) => IssuedRuntimeToken
  tokenTtlMs?: number
  now?: () => number
  botId?: string
  /** Optional file mapping credentialRef -> vendor env. */
  credentialsFile?: string
  log?: (line: string) => void
  fetchImpl?: typeof fetch
  /** Provider injection for tests; defaults to the HTTP worker implementation. */
  provider?: RuntimeProvider
}

interface ResolvedToken {
  token: string
  id?: string
}

function externalRuntimeEnv(): Record<string, string> {
  const names = [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY',
    'XAI_API_KEY', 'XAI_BASE_URL', 'GROK_API_KEY', 'GROK_BASE_URL',
  ]
  const out: Record<string, string> = {}
  for (const name of names) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') out[name] = value
  }
  return out
}

function baseUrl(config: { workerUrl: string; workerUrls?: string[] }): string[] {
  const urls = Array.isArray(config.workerUrls) && config.workerUrls.length > 0 ? config.workerUrls : [config.workerUrl]
  return urls.map((url) => url.replace(/\/+$/, ''))
}

function chooseBase(config: { workerUrl: string; workerUrls?: string[] }, workspaceId: string): string {
  const urls = baseUrl(config)
  if (urls.length === 1) return urls[0]!
  let hash = 0
  for (const ch of workspaceId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return urls[hash % urls.length]!
}

function mapProviderPhase(phase: RuntimeProviderStatus['phase']): 'ready' | 'stopped' | 'error' | 'unknown' {
  switch (phase) {
    case 'ready': return 'ready'
    case 'stopped': return 'stopped'
    case 'error': return 'error'
    default: return 'unknown'
  }
}

export function dockerRuntimeProvider(config: DockerRuntimeManagerConfig): RuntimeProvider {
  const fetchImpl = config.fetchImpl ?? fetch
  const headers = { authorization: `Bearer ${config.workerToken}`, 'content-type': 'application/json' }
  const capabilities: RuntimeProviderCapabilities = {
    isolation: 'container',
    persistentWorkspace: true,
    logs: true,
    exec: false,
    suspend: false,
    resume: false,
    networkPolicy: false,
    resourceLimits: true,
    secrets: 'env',
  }

  async function call(path: string, workspaceId: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await fetchImpl(`${chooseBase(config, workspaceId)}${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers ?? {}) },
      })
    } catch (error) {
      throw new RuntimeProviderError('provider.not_available', `docker worker unreachable: ${error instanceof Error ? error.message : String(error)}`, { retryable: true })
    }
    const text = await response.text().catch(() => '')
    let body: Record<string, unknown> = {}
    try { body = text === '' ? {} : JSON.parse(text) as Record<string, unknown> } catch { body = { raw: text } }
    if (!response.ok) {
      const message = typeof body.error === 'string' ? body.error : `docker worker ${response.status}`
      const code = response.status === 401 ? 'provider.unauthorized'
        : response.status === 404 ? 'provider.not_found'
        : response.status === 409 ? 'provider.conflict'
        : response.status >= 500 ? 'provider.provision_failed'
        : 'provider.provision_failed'
      throw new RuntimeProviderError(code as never, message, { retryable: response.status >= 500 })
    }
    return body
  }

  return {
    id: 'docker',
    capabilities: () => capabilities,
    async probe() {
      const problems: string[] = []
      for (const url of baseUrl(config)) {
        try {
          const response = await fetchImpl(`${url}/healthz`, { headers: { authorization: `Bearer ${config.workerToken}` } })
          if (!response.ok) problems.push(`${url}: healthz ${response.status}`)
        } catch (error) {
          problems.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return { ok: problems.length === 0, problems, capabilities }
    },
    async ensure(spec: RuntimeSpec): Promise<RuntimeEnsureOutcome> {
      const body = await call('/v1/ensure', spec.workspaceId, { method: 'POST', body: JSON.stringify(spec) })
      const sandbox = typeof body.sandbox === 'string' ? body.sandbox : null
      const phase = body.phase === 'ready' ? 'ready' : 'error'
      if (sandbox === null || phase !== 'ready') {
        throw new RuntimeProviderError('provider.provision_failed', typeof body.error === 'string' ? body.error : 'docker worker did not return a ready runtime')
      }
      const handle: RuntimeHandle = { provider: 'docker', name: sandbox, workspaceId: spec.workspaceId }
      return {
        handle,
        status: { handle, phase: 'ready' },
        created: body.created !== false,
      }
    },
    async status(key: RuntimeKey): Promise<RuntimeProviderStatus | null> {
      const body = await call(`/v1/status?workspaceId=${encodeURIComponent(key.workspaceId)}`, key.workspaceId)
      const status = body.status
      if (status === null || typeof status !== 'object') return null
      const record = status as { sandbox?: unknown; phase?: unknown }
      if (typeof record.sandbox !== 'string') return null
      const handle: RuntimeHandle = { provider: 'docker', name: record.sandbox, workspaceId: key.workspaceId }
      const phase = record.phase === 'ready' || record.phase === 'starting' || record.phase === 'stopped' || record.phase === 'error'
        ? record.phase
        : 'unknown'
      return { handle, phase }
    },
    async stop(key, options) {
      await call('/v1/stop', key.workspaceId, { method: 'POST', body: JSON.stringify({ workspaceId: key.workspaceId, remove: options?.remove === true }) })
    },
    async logs(key, options) {
      const body = await call(`/v1/logs?workspaceId=${encodeURIComponent(key.workspaceId)}&tail=${options?.tail ?? 80}`, key.workspaceId)
      return typeof body.logs === 'string' ? body.logs : ''
    },
  }
}

/** Docker manager: shared orchestration with the Docker provider. */
export function dockerRuntimeManager(config: DockerRuntimeManagerConfig): RuntimeManager {
  const provider = config.provider ?? dockerRuntimeProvider(config)
  return providerRuntimeManager({ ...config, provider })
}
