// Docker runtime provider + the control-plane RuntimeManager that composes it.
//
// The control plane never talks to the Docker daemon. It talks to a small
// authenticated worker on the Docker host; the worker owns container lifecycle.
// This keeps Docker a provider, not a second control plane.

import { getWorkspaceModelCredential } from '../../../packages/store/src/model-credentials.ts'
import { issueRuntimeToken, revokeRuntimeToken } from '../../../packages/store/src/runtime-tokens.ts'
import type { IssuedRuntimeToken } from '../../../packages/store/src/runtime-tokens.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { fetchProfileLock } from './profile-lock.ts'
import { recordTrace } from './trace.ts'
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
import type { RuntimeEnsureResult, RuntimeManager } from './workspace-runtime.ts'

export const DOCKER_RUNTIME_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

export interface DockerRuntimeManagerConfig {
  workerUrl: string
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

function baseUrl(config: { workerUrl: string }): string {
  return config.workerUrl.replace(/\/+$/, '')
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

  async function call(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    let response: Response
    try {
      response = await fetchImpl(`${baseUrl(config)}${path}`, {
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
      try {
        const response = await fetchImpl(`${baseUrl(config)}/healthz`, { headers: { authorization: `Bearer ${config.workerToken}` } })
        return { ok: response.ok, problems: response.ok ? [] : [`healthz ${response.status}`], capabilities }
      } catch (error) {
        return { ok: false, problems: [error instanceof Error ? error.message : String(error)], capabilities }
      }
    },
    async ensure(spec: RuntimeSpec): Promise<RuntimeEnsureOutcome> {
      const body = await call('/v1/ensure', { method: 'POST', body: JSON.stringify(spec) })
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
      const body = await call(`/v1/status?workspaceId=${encodeURIComponent(key.workspaceId)}`)
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
      await call('/v1/stop', { method: 'POST', body: JSON.stringify({ workspaceId: key.workspaceId, remove: options?.remove === true }) })
    },
    async logs(key, options) {
      const body = await call(`/v1/logs?workspaceId=${encodeURIComponent(key.workspaceId)}&tail=${options?.tail ?? 80}`)
      return typeof body.logs === 'string' ? body.logs : ''
    },
  }
}

/** Control-plane orchestrator: token issuance + spec building + provider lifecycle. */
export function dockerRuntimeManager(config: DockerRuntimeManagerConfig): RuntimeManager {
  const provider = config.provider ?? dockerRuntimeProvider(config)
  const log = config.log ?? (() => {})
  const image = config.image ?? 'roost/agent:multi-runtime'

  function resolveStore(context?: { store?: Store }): Store | undefined {
    return context?.store ?? config.rawStore
  }

  function issue(store: Store | undefined, workspaceId: string): ResolvedToken {
    if (config.tokenIssuer !== undefined) {
      const issued = config.tokenIssuer(workspaceId)
      return { token: issued.token, id: issued.id }
    }
    if (store !== undefined) {
      const issued = issueRuntimeToken(store, {
        workspaceId,
        ttlMs: config.tokenTtlMs ?? DOCKER_RUNTIME_TOKEN_TTL_MS,
        ...(config.now === undefined ? {} : { at: config.now() }),
      })
      return { token: issued.token, id: issued.id }
    }
    return { token: config.runtimeToken }
  }

  function revoke(store: Store | undefined, token: ResolvedToken): void {
    if (store === undefined || token.id === undefined) return
    try { revokeRuntimeToken(store, { id: token.id }) } catch { /* token expires */ }
  }

  async function buildEnv(store: Store | undefined, workspaceId: string, token: ResolvedToken): Promise<Record<string, string>> {
    const workspaceModel = store === undefined ? undefined : getWorkspaceModelCredential(store, workspaceId)?.model
    const model = workspaceModel ?? ((process.env.ROOST_FREE_MODEL ?? '').trim() || 'deepseek-chat')
    const apiBase = `${config.cpScheme ?? 'http'}://${config.cpHost}:${config.cpPort}`
    const env: Record<string, string> = {
      ROOST_API: apiBase,
      ROOST_RUNTIME_TOKEN: token.token,
      ROOST_BOT_ID: config.botId ?? 'selector',
      ROOST_WORKSPACE_ID: workspaceId,
      ROOST_WORKDIR: '/workspace',
      CODEX_HOME: '/workspace/.codex',
      ROOST_CODEX_CONFIG_TEMPLATE: '/opt/roost/codex-home/config.toml',
      ROOST_STATE_FILE: '/workspace/.dsh/room-cursors.json',
      ROOST_READY_FILE: '/workspace/.roost/ready',
      ROOST_DSH_PROVIDER: 'deepseek-official',
      ROOST_DSH_MODEL: model,
      ROOST_DSH_PROFILE: process.env.ROOST_DSH_PROFILE ?? 'sdk',
      ROOST_DSH_WEB: '0',
      ROOST_MULTI_RUNTIME: process.env.ROOST_MULTI_RUNTIME ?? '1',
      ROOST_CLAUDE_BIN: process.env.ROOST_CLAUDE_BIN ?? 'claude',
      ROOST_CODEX_BIN: process.env.ROOST_CODEX_BIN ?? 'codex-acp',
      ROOST_GROK_BIN: process.env.ROOST_GROK_BIN ?? '/opt/agents/grok-build/bin/grok',
      DEEPSEEK_BASE_URL: apiBase,
      DEEPSEEK_API_KEY: token.token,
      DSH_PERMISSION_MODE: 'danger-full-access',
      ROOST_DSH_PERMISSION_MODE: 'danger-full-access',
      HOME: '/workspace',
      DSH_HOME: '/workspace/.dsh',
      ...externalRuntimeEnv(),
    }
    if (store !== undefined) {
      try {
        const lock = await fetchProfileLock({
          apiBase: config.lockApiBase ?? `http://127.0.0.1:${config.cpPort}`,
          runtimeToken: token.token,
          workspaceId,
          ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
        })
        env.ROOST_PROFILE_LOCK_ID = lock.id
        log(`profile lock ${lock.id}`)
      } catch (error) {
        // A profile lock failure is fatal for parity with the OpenShell path:
        // no runtime should boot with an unverified plugin state.
        throw error
      }
    }
    return env
  }

  return {
    async ensure(workspaceId, context): Promise<RuntimeEnsureResult> {
      const store = resolveStore(context)
      const existing = await provider.status({ workspaceId }).catch(() => null)
      if (existing !== null && existing.phase === 'ready') {
        return { sandbox: existing.handle.name, phase: 'ready' }
      }

      const token = issue(store, workspaceId)
      try {
        const env = await buildEnv(store, workspaceId, token)
        const spec: RuntimeSpec = {
          workspaceId,
          image,
          command: ['node', '/opt/roost/room-agent.mjs'],
          env,
          network: 'host',
          resources: { cpus: 2, memoryMb: 2048, pids: 2048 },
          readyTimeoutMs: 30_000,
          labels: { app: 'roost', workspace: workspaceId },
        }
        const startedAt = Date.now()
        let ensured: RuntimeEnsureOutcome
        try {
          ensured = await provider.ensure(spec)
        } catch (error) {
          recordTrace({
            traceId: `docker:${workspaceId}`,
            name: 'runtime.docker.ensure',
            at: startedAt,
            durationMs: Date.now() - startedAt,
            attrs: { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) },
          })
          throw error
        }
        recordTrace({
          traceId: `docker:${workspaceId}`,
          name: 'runtime.docker.ensure',
          at: startedAt,
          durationMs: Date.now() - startedAt,
          attrs: { ok: true, created: ensured.created !== false, sandbox: ensured.handle.name },
        })
        if (ensured.created === false) revoke(store, token)
        const out: RuntimeEnsureResult = { sandbox: ensured.handle.name, phase: mapProviderPhase(ensured.status.phase) }
        if (ensured.created !== false && token.id !== undefined) out.tokenId = token.id
        return out
      } catch (error) {
        revoke(store, token)
        throw error
      }
    },
    async status(workspaceId) {
      const current = await provider.status({ workspaceId }).catch(() => null)
      if (current === null) return null
      return { sandbox: current.handle.name, phase: mapProviderPhase(current.phase) }
    },
    async stop(workspaceId, context) {
      await provider.stop({ workspaceId }, { remove: true })
      const store = resolveStore(context)
      if (store !== undefined) {
        // revoke immediately; the route also revokes in stopWorkspaceRuntime.
        try {
          const { revokeRuntimeTokens } = await import('../../../packages/store/src/runtime-tokens.ts')
          revokeRuntimeTokens(store, { workspaceId })
        } catch { /* best effort */ }
      }
      return true
    },
    async logs(workspaceId, options) {
      return await provider.logs?.({ workspaceId }, { tail: options?.tail ?? 120 }) ?? ''
    },
  }
}
