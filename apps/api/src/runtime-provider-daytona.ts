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
  type RuntimeExecOptions,
  type RuntimeExecResult,
} from './runtime-provider.ts'

const ID = 'daytona' as const
const DEFAULT_API_URL = 'https://app.daytona.io/api'
const TERMINAL_FAILED = new Set(['error', 'build_failed'])
const STARTING = new Set([
  'creating', 'restoring', 'starting', 'pending_build', 'building_snapshot',
  'pulling_snapshot', 'resizing', 'forking', 'pausing', 'resuming',
])
const STOPPED = new Set(['stopped', 'paused', 'archived', 'destroying'])

// Snapshot 状态机与 LangAlpha 的 Daytona provider 对齐
// （ptc_agent/core/sandbox/providers/daytona.py 的 _SNAPSHOT_IN_PROGRESS / _SNAPSHOT_FAILED）：
//   * 构建中：pending / pulling / building / snapshotting / removing → 等待它 settle
//   * 失败：error / build_failed → 名字被占住，删除后重建（auto-create 时）
const SNAPSHOT_IN_PROGRESS = new Set(['pending', 'pulling', 'building', 'snapshotting', 'removing'])
const SNAPSHOT_FAILED = new Set(['error', 'build_failed'])

export interface DaytonaRuntimeProviderConfig {
  apiUrl?: string
  apiKey: string
  organizationId?: string
  /** Daytona snapshot built from the roost/agent image. */
  snapshot?: string
  /** Image used to build the snapshot when auto-create is enabled. */
  snapshotImage?: string
  snapshotAutoCreate?: boolean
  snapshotEntrypoint?: string[]
  snapshotSandboxClass?: 'linux-vm' | 'container'
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
    exec: true,
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
    // 429（Daytona 限流）与 5xx 都值得重试；LangAlpha 也把 429 当 transient 处理。
    return new RuntimeProviderError(code, message, { retryable: status === 429 || status >= 500 })
  }

  async function getSandbox(name: string): Promise<DaytonaSandbox | null> {
    const result = await call(`/sandbox/${encodeURIComponent(name)}`)
    if (result.status === 404) return null
    if (result.status < 200 || result.status >= 300) throw errorFor(result.status, 'sandbox', result.body)
    return result.body as DaytonaSandbox
  }

  function toolboxBase(sandbox: DaytonaSandbox): string {
    const url = typeof sandbox.toolboxProxyUrl === 'string' ? sandbox.toolboxProxyUrl.trim().replace(/\/+$/, '') : ''
    const id = typeof sandbox.id === 'string' ? sandbox.id : ''
    return url === '' || id === '' ? '' : `${url}/${encodeURIComponent(id)}`
  }

  async function toolboxExecute(sandbox: DaytonaSandbox, command: string, timeout = 10): Promise<{ code: number; stdout: string } | null> {
    const base = toolboxBase(sandbox)
    if (base === '') return null
    // The sandbox DTO points at the toolbox proxy; process execution is not on
    // the lifecycle API. Keep the same bearer and organization headers.
    let response: Response
    try {
      response = await fetchImpl(`${base}/process/execute`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
          ...(config.organizationId === undefined ? {} : { 'X-Daytona-Organization-ID': config.organizationId }),
        },
        body: JSON.stringify({ command, timeout }),
      })
    } catch {
      return null
    }
    const text = await response.text().catch(() => '')
    let body: unknown = {}
    try { body = text === '' ? {} : JSON.parse(text) } catch { body = { result: text } }
    if (!response.ok) return null
    const record = body && typeof body === 'object' ? body as { exitCode?: unknown; result?: unknown } : {}
    return {
      code: typeof record.exitCode === 'number' ? record.exitCode : 0,
      stdout: typeof record.result === 'string' ? record.result : '',
    }
  }

  /** Wait for the room-agent marker through the toolbox, like LangAlpha's tool check. */
  async function waitForMarker(name: string, timeoutMs: number, context?: RuntimeProviderContext): Promise<void> {
    const now = config.now ?? context?.now ?? Date.now
    const deadline = now() + Math.max(1, timeoutMs)
    while (now() < deadline) {
      const sandbox = await getSandbox(name)
      if (sandbox === null) throw new RuntimeProviderError('provider.provision_failed', `Daytona sandbox ${name} disappeared while checking readiness`)
      // Some Daytona API versions do not return toolboxProxyUrl; fall back to
      // the lifecycle state rather than inventing a failure. When the URL is
      // present, a transient toolbox failure is retried, not treated as ready.
      if (toolboxBase(sandbox) === '') return
      const probe = await toolboxExecute(sandbox, 'test -f /workspace/.roost/ready', 10)
      if (probe !== null && probe.code === 0) return
      await sleep(1000)
    }
    throw new RuntimeProviderError('provider.ready_timeout', `Daytona sandbox ${name} started but /workspace/.roost/ready never appeared`)
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

  interface DaytonaSnapshot {
    id?: string
    name?: string
    state?: string
    errorReason?: string
  }

  async function findSnapshot(name: string): Promise<DaytonaSnapshot | null> {
    const result = await call(`/snapshots?name=${encodeURIComponent(name)}&limit=100`)
    if (result.status !== 200) return null
    const body = result.body as { items?: unknown }
    const items = Array.isArray(body.items) ? body.items : []
    const found = items.find((item) => item && typeof item === 'object' && (item as DaytonaSnapshot).name === name)
    return found === undefined ? null : found as DaytonaSnapshot
  }


  /** 等 snapshot 离开“构建中”状态（inactive/active/失败都算 settle），返回最后一次观察到的快照。 */
  async function waitForSettledSnapshot(name: string, timeoutMs: number): Promise<DaytonaSnapshot | null> {
    const deadline = Date.now() + Math.max(1, timeoutMs)
    let last = await findSnapshot(name)
    while (Date.now() < deadline) {
      if (last === null) return null
      if (last.state === undefined || !SNAPSHOT_IN_PROGRESS.has(last.state)) return last
      await sleep(2000)
      last = await findSnapshot(name)
    }
    return last
  }

  /** 删除 snapshot 并等名字真正释放；失败不抛错（调用方决定后续如何报错）。 */
  async function deleteSnapshotForRebuild(snapshot: DaytonaSnapshot, name: string): Promise<void> {
    const id = typeof snapshot.id === 'string' && snapshot.id !== '' ? snapshot.id : name
    await call(`/snapshots/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined)
    for (let attempt = 0; attempt < 60; attempt++) {
      if ((await findSnapshot(name)) === null) return
      await sleep(2000)
    }
  }

  async function ensureSnapshot(spec: RuntimeSpec): Promise<string | null> {
    const name = (spec.image ?? config.snapshot ?? '').trim()
    if (name === '') throw new RuntimeProviderError('provider.provision_failed', 'Daytona provider needs a snapshot (spec.image or DAYTONA_SNAPSHOT)')
    if (config.snapshotAutoCreate !== true) return name
    const imageName = (config.snapshotImage ?? '').trim()
    if (imageName === '') {
      throw new RuntimeProviderError('provider.provision_failed', 'DAYTONA_SNAPSHOT_IMAGE is required when snapshot auto-create is enabled')
    }

    let snapshot = await findSnapshot(name)

    // 失败的 snapshot 会一直占住名字，必须先删掉再重建（与 LangAlpha 的 build_snapshot 一致）。
    if (snapshot !== null && snapshot.state !== undefined && SNAPSHOT_FAILED.has(snapshot.state)) {
      await deleteSnapshotForRebuild(snapshot, name)
      snapshot = null
    }

    if (snapshot === null) {
      const resources = spec.resources ?? {}
      const body: Record<string, unknown> = {
        name,
        imageName,
        entrypoint: config.snapshotEntrypoint ?? ['node', '/opt/roost/room-agent.mjs'],
        // 资源烘焙进 snapshot：Daytona 创建 sandbox 时不允许再覆盖 snapshot 的 cpu/memory/disk。
        cpu: Math.max(1, Math.round(resources.cpus ?? config.cpu ?? 2)),
        memory: Math.max(1, Math.ceil((resources.memoryMb ?? (config.memory ?? 2) * 1024) / 1024)),
        disk: Math.max(1, Math.round(config.disk ?? 10)),
        ...(config.snapshotSandboxClass === undefined ? {} : { sandboxClass: config.snapshotSandboxClass }),
      }
      const created = await call('/snapshots', { method: 'POST', body: JSON.stringify(body) })

      if (created.status === 409) {
        // 另一个构建抢到了同一个名字：等它 settle，只有 active 才可用。
        snapshot = await waitForSettledSnapshot(name, spec.readyTimeoutMs ?? 120_000)
        if (snapshot === null || snapshot.state !== 'active') {
          throw new RuntimeProviderError(
            'provider.provision_failed',
            `Daytona snapshot ${name} is held by another build and is not active (state=${snapshot?.state ?? 'missing'})`,
          )
        }
      } else if (created.status < 200 || created.status >= 300) {
        throw errorFor(created.status, 'snapshot create', created.body)
      } else {
        snapshot = created.body as DaytonaSnapshot
      }
    }

    const state = snapshot.state
    if (state === 'inactive') {
      const activated = await call(`/snapshots/${encodeURIComponent(snapshot.id ?? name)}/activate`, { method: 'POST' })
      if (activated.status < 200 || activated.status >= 300) throw errorFor(activated.status, 'snapshot activate', activated.body)
    } else if (state !== 'active') {
      // 构建中（或状态缺失）：等到 settle；settle 后仍不是 active 就报错，避免拿半成品创建 sandbox。
      const settled = await waitForSettledSnapshot(name, spec.readyTimeoutMs ?? 120_000)
      if (settled === null || settled.state !== 'active') {
        throw new RuntimeProviderError(
          'provider.ready_timeout',
          `Daytona snapshot ${name} was not active within the readiness window (state=${settled?.state ?? 'missing'})`,
        )
      }
    }

    return name
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
          await waitForMarker(name, spec.readyTimeoutMs ?? 120_000, context)
          const handle: RuntimeHandle = { ...status.handle, workspaceId: spec.workspaceId }
          return { handle, status: { ...status, handle }, created: false }
        }
        if (phase === 'stopped') {
          const started = await call(`/sandbox/${encodeURIComponent(name)}/start`, { method: 'POST' })
          if (started.status < 200 || started.status >= 300) throw errorFor(started.status, 'sandbox start', started.body)
          const status = await waitForSandbox(name, spec.readyTimeoutMs ?? 120_000, context)
          await waitForMarker(name, spec.readyTimeoutMs ?? 120_000, context)
          const handle: RuntimeHandle = { ...status.handle, workspaceId: spec.workspaceId }
          return { handle, status: { ...status, handle }, created: false }
        }
        throw new RuntimeProviderError('provider.conflict', `Daytona sandbox ${name} is in state ${existing.state ?? 'unknown'}`)
      }

      const snapshot = await ensureSnapshot(spec)
      if (snapshot === null) throw new RuntimeProviderError('provider.provision_failed', 'Daytona snapshot is not available')
      // Daytona sizes a sandbox from its snapshot: sending cpu/memory/disk together with a
      // snapshot is rejected with "Cannot specify Sandbox resources when using a snapshot".
      // The snapshot created by ensureSnapshot() already carries the requested resources, so
      // the snapshot is authoritative for existing snapshots too.
      const body: Record<string, unknown> = {
        name,
        snapshot,
        env: spec.env ?? {},
        labels: { app: 'roost', workspace: spec.workspaceId, ...(spec.labels ?? {}) },
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
      await waitForMarker(name, spec.readyTimeoutMs ?? 120_000, context)
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

    async exec(key: RuntimeKey, argv: string[], options?: RuntimeExecOptions): Promise<RuntimeExecResult> {
      const sandbox = await getSandbox(safeName(key.workspaceId))
      if (sandbox === null) throw new RuntimeProviderError('provider.not_found', `Daytona sandbox ${safeName(key.workspaceId)} not found`)
      const command = argv.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(' ')
      const result = await toolboxExecute(sandbox, command, Math.max(1, Math.ceil((options?.timeoutMs ?? 30_000) / 1000)))
      if (result === null) throw new RuntimeProviderError('provider.exec_failed', 'Daytona toolbox process API is unavailable')
      return { code: result.code, stdout: result.stdout, stderr: '' }
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
