// Kubernetes RuntimeProvider.
//
// One workspace maps to one PVC (mounted at /workspace) and one long-lived Pod
// running room-agent. The control plane still owns runtime tokens, rounds and
// SSE; this provider only creates/reads/stops that Pod.
//
// Readiness is the room-agent marker: the Pod has a readinessProbe exec'ing
// `test -f /workspace/.roost/ready`, so a Ready Pod means the provider may
// report `ready` without inventing a second readiness contract.
//
// `exec` is intentionally not implemented in this first version: the exec API
// is a WebSocket protocol and belongs in a follow-up. Diagnostics use Pod logs.

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

const ID = 'kubernetes' as const

export interface KubernetesRuntimeProviderConfig {
  apiUrl: string
  token: string
  namespace?: string
  image?: string
  imagePullSecrets?: string[]
  serviceAccountName?: string
  storageClassName?: string
  storageSize?: string
  cpuRequest?: string
  cpuLimit?: string
  memoryRequest?: string
  memoryLimit?: string
  /** Test/alternate transport. */
  fetchImpl?: typeof fetch
  now?: () => number
}

interface KubePod {
  metadata?: { name?: string; deletionTimestamp?: string }
  spec?: { nodeName?: string }
  status?: {
    phase?: string
    conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>
    containerStatuses?: Array<{ ready?: boolean; state?: { waiting?: { reason?: string; message?: string } } }>
  }
}

function safeName(workspaceId: string): string {
  const hash = createHash('sha256').update(workspaceId).digest('hex').slice(0, 10)
  return `roost-ws-${hash}`
}

function claimName(workspaceId: string): string {
  return `${safeName(workspaceId)}-workspace`
}

function podReady(pod: KubePod | null): boolean {
  if (pod === null) return false
  const condition = pod.status?.conditions?.find((item) => item.type === 'Ready')
  return condition?.status === 'True'
}

function podFailure(pod: KubePod): string | null {
  if (pod.status?.phase === 'Failed') {
    const condition = pod.status.conditions?.find((item) => item.type === 'Ready')
    return condition?.message || condition?.reason || 'Pod failed'
  }
  for (const status of pod.status?.containerStatuses ?? []) {
    const waiting = status.state?.waiting
    if (waiting?.reason === 'CrashLoopBackOff' || waiting?.reason === 'ImagePullBackOff' || waiting?.reason === 'ErrImagePull') {
      return `${waiting.reason}: ${waiting.message ?? ''}`.trim()
    }
  }
  return null
}

function mapPhase(pod: KubePod | null): RuntimeProviderStatus['phase'] {
  if (pod === null) return 'unknown'
  if (pod.status?.phase === 'Failed') return 'error'
  if (pod.status?.phase === 'Succeeded') return 'stopped'
  if (podReady(pod)) return 'ready'
  if (pod.status?.phase === 'Pending' || pod.status?.phase === 'Running') return 'starting'
  return 'unknown'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function kubernetesRuntimeProvider(config: KubernetesRuntimeProviderConfig): RuntimeProvider {
  const fetchImpl = config.fetchImpl ?? fetch
  const apiUrl = config.apiUrl.replace(/\/+$/, '')
  const namespace = (config.namespace ?? 'roost').trim()
  const capabilities: RuntimeProviderCapabilities = {
    isolation: 'container',
    persistentWorkspace: true,
    logs: true,
    exec: false,
    suspend: true,
    resume: true,
    networkPolicy: false,
    resourceLimits: true,
    secrets: 'env',
  }

  async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown; text: string }> {
    let response: Response
    try {
      response = await fetchImpl(`${apiUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${config.token}`,
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.headers ?? {}),
        },
      })
    } catch (error) {
      throw new RuntimeProviderError('provider.not_available', `Kubernetes API unreachable: ${error instanceof Error ? error.message : String(error)}`, { retryable: true })
    }
    const text = await response.text().catch(() => '')
    let body: unknown = {}
    try { body = text === '' ? {} : JSON.parse(text) } catch { body = { raw: text } }
    return { status: response.status, body, text }
  }

  function errorFor(status: number, path: string, body: unknown): RuntimeProviderError {
    const record = body !== null && typeof body === 'object' ? body as { message?: unknown; reason?: unknown } : {}
    const message = typeof record.message === 'string' ? record.message : `Kubernetes ${status} for ${path}`
    const code = status === 401 || status === 403 ? 'provider.unauthorized'
      : status === 404 ? 'provider.not_found'
      : status === 409 ? 'provider.conflict'
      : 'provider.provision_failed'
    return new RuntimeProviderError(code, message, {
      retryable: status >= 500,
      details: typeof record.reason === 'string' ? { reason: record.reason } : undefined,
    })
  }

  function podPath(workspaceId: string): string {
    return `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(safeName(workspaceId))}`
  }

  function pvcPath(workspaceId: string): string {
    return `/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims/${encodeURIComponent(claimName(workspaceId))}`
  }

  async function getPod(workspaceId: string): Promise<KubePod | null> {
    const result = await call(podPath(workspaceId))
    if (result.status === 404) return null
    if (result.status < 200 || result.status >= 300) throw errorFor(result.status, 'pod', result.body)
    return result.body as KubePod
  }

  async function ensurePvc(spec: RuntimeSpec): Promise<void> {
    const current = await call(pvcPath(spec.workspaceId))
    if (current.status === 200) return
    if (current.status !== 404) throw errorFor(current.status, 'pvc', current.body)
    const body = {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: claimName(spec.workspaceId),
        namespace,
        labels: { app: 'roost', workspace: spec.workspaceId },
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: config.storageSize ?? '10Gi' } },
        volumeMode: 'Filesystem',
        ...(config.storageClassName === undefined ? {} : { storageClassName: config.storageClassName }),
      },
    }
    const created = await call(`/api/v1/namespaces/${encodeURIComponent(namespace)}/persistentvolumeclaims`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (created.status === 409) return
    if (created.status < 200 || created.status >= 300) throw errorFor(created.status, 'pvc create', created.body)
  }

  function envArray(env: Record<string, string> | undefined): Array<{ name: string; value: string }> {
    if (env === undefined) return []
    return Object.entries(env)
      .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      .map(([name, value]) => ({ name, value: String(value) }))
  }

  function podBody(spec: RuntimeSpec): Record<string, unknown> {
    const resources = spec.resources ?? {}
    const cpu = resources.cpus ?? 2
    const memoryMb = resources.memoryMb ?? 2048
    const image = (spec.image ?? config.image ?? '').trim()
    if (image === '') throw new RuntimeProviderError('provider.provision_failed', 'Kubernetes provider needs an image')
    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: safeName(spec.workspaceId),
        namespace,
        labels: { app: 'roost', workspace: spec.workspaceId, ...(spec.labels ?? {}) },
      },
      spec: {
        restartPolicy: 'Always',
        terminationGracePeriodSeconds: 20,
        ...(config.serviceAccountName === undefined ? {} : { serviceAccountName: config.serviceAccountName }),
        ...(config.imagePullSecrets === undefined || config.imagePullSecrets.length === 0
          ? {}
          : { imagePullSecrets: config.imagePullSecrets.map((name) => ({ name })) }),
        securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{
          name: 'room-agent',
          image,
          imagePullPolicy: 'IfNotPresent',
          command: spec.command ?? ['node', '/opt/roost/room-agent.mjs'],
          workingDir: '/workspace',
          env: envArray(spec.env),
          resources: {
            requests: {
              cpu: config.cpuRequest ?? String(Math.max(1, Math.round(cpu / 2))),
              memory: config.memoryRequest ?? `${Math.max(256, Math.round(memoryMb / 2))}Mi`,
            },
            limits: {
              cpu: config.cpuLimit ?? String(Math.max(1, Math.round(cpu))),
              memory: config.memoryLimit ?? `${memoryMb}Mi`,
            },
          },
          volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
          readinessProbe: {
            exec: { command: ['test', '-f', '/workspace/.roost/ready'] },
            initialDelaySeconds: 1,
            periodSeconds: 2,
            timeoutSeconds: 1,
            failureThreshold: 12,
          },
          securityContext: { allowPrivilegeEscalation: false },
        }],
        volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: claimName(spec.workspaceId) } }],
      },
    }
  }

  async function waitForPod(workspaceId: string, timeoutMs: number, context?: RuntimeProviderContext): Promise<RuntimeProviderStatus> {
    const now = config.now ?? context?.now ?? Date.now
    const deadline = now() + Math.max(1, timeoutMs)
    let last: KubePod | null = null
    while (now() < deadline) {
      last = await getPod(workspaceId)
      if (last === null) throw new RuntimeProviderError('provider.provision_failed', `Kubernetes pod ${safeName(workspaceId)} disappeared while starting`)
      if (podReady(last)) {
        const handle: RuntimeHandle = { provider: ID, name: safeName(workspaceId), workspaceId }
        return { handle, phase: 'ready' }
      }
      const failure = podFailure(last)
      if (failure !== null) throw new RuntimeProviderError('provider.provision_failed', failure)
      await sleep(1000)
    }
    throw new RuntimeProviderError('provider.ready_timeout', `Kubernetes pod ${safeName(workspaceId)} was not ready within ${timeoutMs}ms (phase=${last?.status?.phase ?? 'unknown'})`)
  }

  return {
    id: ID,
    capabilities: () => capabilities,

    async probe(): Promise<RuntimeProviderProbe> {
      const problems: string[] = []
      try {
        const result = await call(`/api/v1/namespaces/${encodeURIComponent(namespace)}`)
        if (result.status === 401 || result.status === 403) problems.push('Kubernetes rejected the service-account token')
        else if (result.status === 404) problems.push(`Kubernetes namespace ${namespace} does not exist`)
        else if (result.status < 200 || result.status >= 300) problems.push(`Kubernetes API returned ${result.status}`)
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error))
      }
      return { ok: problems.length === 0, problems, capabilities }
    },

    async ensure(spec: RuntimeSpec, context?: RuntimeProviderContext): Promise<RuntimeEnsureOutcome> {
      await ensurePvc(spec)
      const existing = await getPod(spec.workspaceId)
      if (existing !== null) {
        if (existing.status?.phase === 'Succeeded' || existing.status?.phase === 'Failed') {
          const deleted = await call(`${podPath(spec.workspaceId)}?gracePeriodSeconds=0`, { method: 'DELETE' })
          if (deleted.status !== 404 && (deleted.status < 200 || deleted.status >= 300)) throw errorFor(deleted.status, 'pod delete', deleted.body)
        } else if (existing.metadata?.deletionTimestamp === undefined) {
          const phase = mapPhase(existing)
          if (phase === 'ready') {
            const handle: RuntimeHandle = { provider: ID, name: safeName(spec.workspaceId), workspaceId: spec.workspaceId }
            return { handle, status: { handle, phase: 'ready' }, created: false }
          }
          const status = await waitForPod(spec.workspaceId, spec.readyTimeoutMs ?? 120_000, context)
          return { handle: status.handle, status, created: false }
        }
      }
      const created = await call(`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`, {
        method: 'POST',
        body: JSON.stringify(podBody(spec)),
      })
      if (created.status === 409) {
        const status = await waitForPod(spec.workspaceId, spec.readyTimeoutMs ?? 120_000, context)
        return { handle: status.handle, status, created: false }
      }
      if (created.status < 200 || created.status >= 300) throw errorFor(created.status, 'pod create', created.body)
      const status = await waitForPod(spec.workspaceId, spec.readyTimeoutMs ?? 120_000, context)
      return { handle: status.handle, status, created: true }
    },

    async status(key: RuntimeKey): Promise<RuntimeProviderStatus | null> {
      const pod = await getPod(key.workspaceId)
      if (pod === null) return null
      const handle: RuntimeHandle = { provider: ID, name: safeName(key.workspaceId), workspaceId: key.workspaceId }
      const failure = podFailure(pod)
      return {
        handle,
        phase: mapPhase(pod),
        ...(failure === null ? {} : { message: failure }),
      }
    },

    async stop(key, options): Promise<void> {
      const pod = await getPod(key.workspaceId)
      if (pod !== null) {
        const deleted = await call(`${podPath(key.workspaceId)}?gracePeriodSeconds=0`, { method: 'DELETE' })
        if (deleted.status !== 404 && (deleted.status < 200 || deleted.status >= 300)) throw errorFor(deleted.status, 'pod delete', deleted.body)
      }
      // The PVC is deliberately kept, like Docker volumes: stop is not delete.
      // A future explicit workspace-delete path removes both.
      void options
    },

    async logs(key, options): Promise<string> {
      const result = await call(`${podPath(key.workspaceId)}/log?tailLines=${Math.max(1, Math.min(5000, options?.tail ?? 120))}`)
      if (result.status === 404) return ''
      if (result.status < 200 || result.status >= 300) throw errorFor(result.status, 'pod log', result.body)
      return result.text
    },
  }
}
