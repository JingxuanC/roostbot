// Daytona RuntimeProvider.
//
// Daytona is compute/lifecycle only, like Docker: the control plane still owns
// runtime tokens, workspace_runtime rows, rooms and SSE. A workspace maps to:
//   - one Daytona Volume (persistent /workspace)
//   - one Daytona Sandbox from a snapshot of the agent image
//
// Raw HTTP is used instead of the SDK so apps/api stays dependency-free. The
// provider only needs create/start/stop/delete/status; the room-agent itself
// is started by the snapshot entrypoint ([node, /opt/roost/room-agent.mjs]).
//
// Known limitation (explicit, not hidden): Daytona's control-plane API does not
// expose a cheap file/exec probe for /workspace/.roost/ready in the lifecycle
// endpoints, so this first version reports ready when the sandbox reaches
// `started`. The room round itself will still fail if room-agent never became
// ready; the next iteration should use Daytona's toolbox/PTY API for the marker.

import { createHash } from 'node:crypto'
import {
  RuntimeProviderError,
  type RuntimeEnsureOutcome,
  type RuntimeHandle,
  type RuntimeKey,
  type RuntimeProvider,
  type RuntimeProviderCapabilities,
  type RuntimeProviderContext,
  type RuntimeProviderProbe,
  type RuntimeProviderStatus,
  type RuntimeSpec,
} from './runtime-provider.ts'

const ID = 'daytona' as const
const DEFAULT_API_URL = 'https://app.daytona.io/api'
const TERMINAL_FAILED = new Set(['error', 'build_failed'])
const STARTING = new Set([
  'creating', 'restoring', 'starting', 'pending_build', 'building_snapshot',
  'pulling_snapshot', 'resizing', 'forking', 'pausing', 'resuming',
])
const STOPPED = new Set(['stopped', 'paused', 'archived', 'destroying'])

export interface DaytonaRuntimeProviderConfig {
  apiUrl?: string
  apiKey: string
  organizationId?: string
  /** Daytona snapshot built from the roost/agent image. */
  snapshot?: string
  /** If set, a persistent volume is created/reused and mounted at /workspace. */
  volumeName?: string
  /** Optional volume subpath prefix; the workspace id is appended. */
  volumeSubpathRoot?: string
  target?: string
  cpu?: number
  /** Memory in GiB for Daytona sandboxes. */
  memory?: number
  disk?: number
  /** 0 disables auto-stop; managed runtimes are long-lived. */
  autoStopInterval?: number
  autoArchiveInterval?: number
  /** Test/alternate transport. */
  fetchImpl?: typeof fetch
  now?: () => number
}

interface DaytonaSandbox {
  id?: string
  name?: string
  state?: string
  errorReason?: string
  toolboxProxyUrl?: string
}

interface DaytonaVolume {
  id?: string
  name?: string
  state?: string
}

function safeName(workspaceId: string): string {
  const hash = createHash('sha256').update(workspaceId).digest('hex').slice(0, 12)
  return `roost-ws-${hash}`
}

function mapPhase(state: string | undefined): RuntimeProviderStatus['phase'] {
  if (state === 'started') return 'ready'
  if (state !== undefined && STARTING.has(state)) return 'starting'
  if (state !== undefined && STOPPED.has(state)) return 'stopped'
  if (state !== undefined && TERMINAL_FAILED.has(state)) return 'error'
  return 'unknown'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function daytonaRuntimeProvider(config: DaytonaRuntimeProviderConfig): RuntimeProvider {
  const fetchImpl = config.fetchImpl ?? fetch
  const apiUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '')
  const capabilities: RuntimeProviderCapabilities = {
    isolation: 'container',
    persistentWorkspace: Boolean(config.volumeName && config.volumeName.trim() !== ''),
    logs: false,
    exec: false,
    suspend: true,
    resume: true,
    // We don't forward a network policy yet; don't claim it in capabilities.
    networkPolicy: false,
    resourceLimits: true,
    secrets: 'env',
  }

  async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    let response: Response
    try {
      response = await fetchImpl(`${apiUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
          ...(config.organizationId === undefined ? {} : { 'X-Daytona-Organization-ID': config.organizationId }),
          ...(init.headers ?? {}),
        },
      })
    } catch (error) {
      throw new RuntimeProviderError('provider.not_available', `Daytona API unreachable: ${error instanceof Error ? error.message : String(error)}`, { retryable: true })
    }
    const text = await response.text().catch(() => '')
    let body: unknown = {}
    try { body = text === '' ? {} : JSON.parse(text) } catch { body = { raw: text } }
    return { status: response.status, body }
  }

  function errorFor(status: number, path: string, body: unknown): RuntimeProviderError {
    const message =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? String((body as { error: string }).error)
        : body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
          ? String((body as { message: string }).message)
          : `Daytona ${status} for ${path}`
    const code =
      status === 401 || status === 403 ? 'provider.unauthorized'
        : status === 404 ? 'provider.not_found'
        : status === 409 ? 'provider.conflict'
        : 'provider.provision_failed'
    return new RuntimeProviderError(code, message, { retryable: status >= 500 })
  }

  async function getSandbox(name: string): Promise<DaytonaSandbox | null> {
    const result = await call(`/sandbox/${encodeURIComponent(name)}`)
    if (result.status === 404) return null
    if (result.status < 200 || result.status >= 300) throw errorFor(result.status, 'sandbox', result.body)
    return result.body as DaytonaSandbox
  }

  async function waitForSandbox(name: string, timeoutMs: number, context?: RuntimeProviderContext): Promise<RuntimeProviderStatus> {
    const now = config.now ?? context?.now ?? Date.now
    const deadline = now() + Math.max(1, timeoutMs)
    let last: DaytonaSandbox | null = null
    while (now() < deadline) {
      last = await getSandbox(name)
      if (last === null) throw new RuntimeProviderError('provider.provision_failed', `Daytona sandbox ${name} disappeared while starting`)
      const phase = mapPhase(last.state)
      if (phase === 'ready' || phase === 'error') {
        const handle: RuntimeHandle = { provider: ID, name: last.name ?? name, workspaceId: '' }
        return { handle, phase, ...(last.errorReason === undefined ? {} : { message: last.errorReason }) }
      }
      await sleep(1000)
    }
    throw new RuntimeProviderError('provider.ready_timeout', `Daytona sandbox ${name} was not ready within ${timeoutMs}ms${last?.state === undefined ? '' : ` (state=${last.state})`}`)
  }

  async function ensureVolume(): Promise<{ id: string; name: string } | null> {
    const name = (config.volumeName ?? '').trim()
    if (name === '') return null
    const get = await call(`/volumes/by-name/${encodeURIComponent(name)}`)
    if (get.status === 200) {
      const volume = get.body as DaytonaVolume
      if (typeof volume.id !== 'string' || volume.id === '') throw new RuntimeProviderError('provider.provision_failed', `Daytona volume ${name} has no id`)
      return { id: volume.id, name: volume.name ?? name }
    }
    if (get.status !== 404) throw errorFor(get.status, 'volume', get.body)
    const created = await call('/volumes', { method: 'POST', body: JSON.stringify({ name }) })
    if (created.status < 200 || created.status >= 300) throw errorFor(created.status, 'volume create', created.body)
    const volume = created.body as DaytonaVolume
    if (typeof volume.id !== 'string' || volume.id === '') throw new RuntimeProviderError('provider.provision_failed', `Daytona volume ${name} was created without an id`)
    return { id: volume.id, name: volume.name ?? name }
  }

  function volumeMount(volume: { id: string; name: string } | null, workspaceId: string): Array<Record<string, unknown>> | undefined {
    if (volume === null) return undefined
    const root = (config.volumeSubpathRoot ?? '').trim().replace(/^\/+|\/+$/g, '')
    const subpath = root === '' ? workspaceId : `${root}/${workspaceId}`
    return [{ volumeId: volume.id, mountPath: '/workspace', subpath }]
  }

  return {
    id: ID,
    capabilities: () => capabilities,

    async probe(): Promise<RuntimeProviderProbe> {
      const problems: string[] = []
      try {
        const result = await call('/sandbox?limit=1')
        if (result.status === 401 || result.status === 403) problems.push('Daytona rejected the API key')
        else if (result.status < 200 || result.status >= 300) problems.push(`Daytona health returned ${result.status}`)
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error))
      }
      return { ok: problems.length === 0, problems, capabilities }
    },

    async ensure(spec: RuntimeSpec, context?: RuntimeProviderContext): Promise<RuntimeEnsureOutcome> {
      const name = spec.name ?? safeName(spec.workspaceId)
      const existing = await getSandbox(name)
      const volume = await ensureVolume()
      const volumes = volumeMount(volume, spec.workspaceId)

      if (existing !== null) {
        const phase = mapPhase(existing.state)
        if (phase === 'ready') {
          const handle: RuntimeHandle = { provider: ID, name: existing.name ?? name, workspaceId: spec.workspaceId }
          return { handle, status: { handle, phase: 'ready' }, created: false }
        }
        if (phase === 'starting') {
          const status = await waitForSandbox(name, spec.readyTimeoutMs ?? 120_000, context)
          const handle: RuntimeHandle = { ...status.handle, workspaceId: spec.workspaceId }
          return { handle, status: { ...status, handle }, created: false }
        }
        if (phase === 'stopped') {
          const started = await call(`/sandbox/${encodeURIComponent(name)}/start`, { method: 'POST' })
          if (started.status < 200 || started.status >= 300) throw errorFor(started.status, 'sandbox start', started.body)
          const status = await waitForSandbox(name, spec.readyTimeoutMs ?? 120_000, context)
          const handle: RuntimeHandle = { ...status.handle, workspaceId: spec.workspaceId }
          return { handle, status: { ...status, handle }, created: false }
        }
        throw new RuntimeProviderError('provider.conflict', `Daytona sandbox ${name} is in state ${existing.state ?? 'unknown'}`)
      }

      const snapshot = (spec.image ?? config.snapshot ?? '').trim()
      if (snapshot === '') throw new RuntimeProviderError('provider.provision_failed', 'Daytona provider needs a snapshot (spec.image or DAYTONA_SNAPSHOT)')
      const resources = spec.resources ?? {}
      const body: Record<string, unknown> = {
        name,
        snapshot,
        env: spec.env ?? {},
        labels: { app: 'roost', workspace: spec.workspaceId, ...(spec.labels ?? {}) },
        cpu: Math.max(1, Math.round(resources.cpus ?? config.cpu ?? 2)),
        memory: Math.max(1, Math.ceil((resources.memoryMb ?? (config.memory ?? 2) * 1024) / 1024)),
        disk: Math.max(1, Math.round(config.disk ?? 10)),
        autoStopInterval: config.autoStopInterval ?? 0,
        autoPauseInterval: 0,
        autoDeleteInterval: -1,
        autoArchiveInterval: config.autoArchiveInterval ?? 0,
        ttlMinutes: 0,
        ...(volumes === undefined ? {} : { volumes }),
        ...(config.target === undefined ? {} : { target: config.target }),
      }
      const created = await call('/sandbox', { method: 'POST', body: JSON.stringify(body) })
      if (created.status < 200 || created.status >= 300) throw errorFor(created.status, 'sandbox create', created.body)
      const status = await waitForSandbox(name, spec.readyTimeoutMs ?? 120_000, context)
      const handle: RuntimeHandle = { ...status.handle, workspaceId: spec.workspaceId }
      return { handle, status: { ...status, handle }, created: true }
    },

    async status(key: RuntimeKey): Promise<RuntimeProviderStatus | null> {
      const sandbox = await getSandbox(safeName(key.workspaceId))
      if (sandbox === null) return null
      const handle: RuntimeHandle = { provider: ID, name: sandbox.name ?? safeName(key.workspaceId), workspaceId: key.workspaceId }
      return {
        handle,
        phase: mapPhase(sandbox.state),
        ...(sandbox.errorReason === undefined ? {} : { message: sandbox.errorReason }),
      }
    },

    async stop(key, options): Promise<void> {
      const name = safeName(key.workspaceId)
      const sandbox = await getSandbox(name)
      if (sandbox === null) return
      if (options?.remove === true) {
        const deleted = await call(`/sandbox/${encodeURIComponent(name)}`, { method: 'DELETE' })
        if (deleted.status !== 404 && (deleted.status < 200 || deleted.status >= 300)) throw errorFor(deleted.status, 'sandbox delete', deleted.body)
        return
      }
      const stopped = await call(`/sandbox/${encodeURIComponent(name)}/stop`, { method: 'POST' })
      if (stopped.status !== 404 && (stopped.status < 200 || stopped.status >= 300)) throw errorFor(stopped.status, 'sandbox stop', stopped.body)
    },
  }
}
