// Daytona provider console 只读客户端：消费自托管 fork 的 /provider/* API（issue #1 P1–P4）。
//
// 契约来源：daytona 仓库 apps/api/src/provider（节点、用量、定价/结算、告警）。
// 这里不依赖任何 SDK，只用 fetch，方便测试注入 fetchImpl。
//
// 语义：
//   * /provider/* 只存在于自托管 fork；Daytona Cloud 返回 404 → failure='not_supported'
//   * 401/403 → 'unauthorized'；网络/超时 → 'network'；其余非 2xx → 'bad_response'
//   * 请求鉴权 Bearer apiKey；组织 id 走 X-Daytona-Organization-ID（可选）

export type ProviderConsoleFailure = 'not_supported' | 'unauthorized' | 'network' | 'bad_response'

export class ProviderConsoleError extends Error {
  readonly failure: ProviderConsoleFailure
  readonly status: number | undefined

  constructor(failure: ProviderConsoleFailure, message: string, status?: number) {
    super(message)
    this.name = 'ProviderConsoleError'
    this.failure = failure
    this.status = status
  }
}

export interface ProviderConsoleConfig {
  /** Daytona API base，例如 https://app.daytona.io/api 或 http://127.0.0.1:3100/api */
  apiUrl: string
  /** 组织 API Key（dtn_...） */
  apiKey: string
  /** 可选：显式组织 id（API key 认证时可省略） */
  organizationId?: string
  /** 测试注入 */
  fetchImpl?: typeof fetch
  /** 单请求超时，默认 10s */
  timeoutMs?: number
}

export interface ProviderNode {
  runnerId: string
  name: string
  regionId: string
  regionName: string
  state: string
  unschedulable: boolean
  lastCheckedAt: string | null
  rttMs: number | null
  totalCpu: number
  totalMemoryGiB: number
  totalDiskGiB: number
  cpuUsagePct: number
  memoryUsagePct: number
  diskUsagePct: number
  allocatedCpu: number
  allocatedMemoryGiB: number
  allocatedDiskGiB: number
  startedSandboxes: number
  availabilityScore: number
  appVersion: string | null
  sandboxStarts7d: number
  sandboxStartFailures7d: number
  avgStartupSeconds7d: number | null
  openAlertCount: number
}

export interface ProviderNodeSandbox {
  sandboxId: string
  name: string
  state: string
  cpu: number
  memoryGiB: number
  diskGiB: number
  createdAt: string
  startedAt: string | null
}

export type ProviderUsageGranularity = 'day' | 'total'

export interface ProviderUsageQuery {
  from?: string
  to?: string
  granularity?: ProviderUsageGranularity
  runnerId?: string
}

export interface ProviderUsageItem {
  date: string | null
  runnerId: string | null
  runnerName: string
  cpuHours: number
  memoryGiBHours: number
  diskGiBHours: number
  gpuHours: number
  sandboxCount: number
}

export interface ProviderUsageResponse {
  from: string
  to: string
  currency: string
  items: ProviderUsageItem[]
  totals: {
    cpuHours: number
    memoryGiBHours: number
    diskGiBHours: number
    gpuHours: number
    sandboxCount: number
  }
}

export interface ProviderEarningsQuery {
  from?: string
  to?: string
  runnerId?: string
}

export interface ProviderEarningsItem {
  date: string
  runnerId: string | null
  runnerName: string
  cpuHours: number
  memoryGiBHours: number
  diskGiBHours: number
  gpuHours: number
  amountCents: number
  settlementStatus?: string | null
  settlementId?: string | null
}

export interface ProviderEarningsResponse {
  from: string
  to: string
  currency: string
  items: ProviderEarningsItem[]
  totals: {
    cpuHours: number
    memoryGiBHours: number
    diskGiBHours: number
    gpuHours: number
    amountCents: number
  }
}

export interface ProviderSettlementsQuery {
  status?: string
  from?: string
  to?: string
  runnerId?: string
  limit?: number
}

export type ProviderSettlementStatus = 'PENDING' | 'SETTLED' | 'WITHDRAWING' | 'WITHDRAWN'

export interface ProviderSettlement {
  id: string
  runnerId: string
  runnerName: string
  periodStart: string
  periodEnd: string
  status: ProviderSettlementStatus
  cpuHours: number
  memoryGiBHours: number
  diskGiBHours: number
  gpuHours: number
  amountCents: number
  currency: string
  settledAt: string | null
  withdrawnAt: string | null
  createdAt: string
}

export interface ProviderAlertsQuery {
  state?: 'open' | 'resolved' | 'all'
  runnerId?: string
  limit?: number
}

export interface ProviderAlert {
  id: string
  runnerId: string
  runnerName: string
  type: 'OFFLINE' | 'HEALTHCHECK_FAILED' | 'HIGH_LATENCY' | 'RESOURCE_PRESSURE'
  severity: 'WARNING' | 'CRITICAL'
  message: string
  details: Record<string, unknown> | null
  createdAt: string
  resolvedAt: string | null
}

export interface ProviderConsoleClient {
  readonly apiUrl: string
  /** 探测 /provider/nodes；Cloud 上返回 ok=false + 说明。 */
  probe(): Promise<{ ok: boolean; problems: string[] }>
  listNodes(): Promise<{ items: ProviderNode[] }>
  listNodeSandboxes(runnerId: string): Promise<{ items: ProviderNodeSandbox[] }>
  getUsage(query?: ProviderUsageQuery): Promise<ProviderUsageResponse>
  getEarnings(query?: ProviderEarningsQuery): Promise<ProviderEarningsResponse>
  listSettlements(query?: ProviderSettlementsQuery): Promise<{ items: ProviderSettlement[] }>
  listAlerts(query?: ProviderAlertsQuery): Promise<{ items: ProviderAlert[] }>
  resolveAlert(id: string): Promise<ProviderAlert>
}

function trimBaseUrl(apiUrl: string): string {
  return apiUrl.trim().replace(/\/+$/, '')
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

export function createProviderConsoleClient(config: ProviderConsoleConfig): ProviderConsoleClient {
  const apiUrl = trimBaseUrl(config.apiUrl)
  const fetchImpl = config.fetchImpl ?? fetch
  const timeoutMs = config.timeoutMs ?? 10_000

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${config.apiKey}`,
    }
    if (config.organizationId !== undefined && config.organizationId !== '') {
      headers['x-daytona-organization-id'] = config.organizationId
    }
    if (body !== undefined) headers['content-type'] = 'application/json'

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()

    let response: Response
    try {
      response = await fetchImpl(`${apiUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ProviderConsoleError('network', `provider console request failed: ${message}`)
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text().catch(() => '')
    let parsed: unknown = null
    if (text !== '') {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = { raw: text }
      }
    }

    if (response.status === 404) {
      throw new ProviderConsoleError(
        'not_supported',
        `provider console endpoint ${method} ${path} is not available on this Daytona deployment`,
        404,
      )
    }
    if (response.status === 401 || response.status === 403) {
      throw new ProviderConsoleError('unauthorized', `provider console rejected the credentials (${response.status})`, response.status)
    }
    if (!response.ok) {
      const message =
        parsed !== null && typeof parsed === 'object' && typeof (parsed as { message?: unknown }).message === 'string'
          ? String((parsed as { message: string }).message)
          : text.slice(0, 200)
      throw new ProviderConsoleError(
        'bad_response',
        `provider console returned ${response.status}${message === '' ? '' : `: ${message}`}`,
        response.status,
      )
    }

    return parsed
  }

  return {
    apiUrl,

    async probe() {
      const problems: string[] = []
      try {
        await request('GET', '/provider/nodes')
      } catch (error) {
        if (error instanceof ProviderConsoleError) problems.push(error.message)
        else problems.push(error instanceof Error ? error.message : String(error))
      }
      return { ok: problems.length === 0, problems }
    },

    async listNodes() {
      return (await request('GET', '/provider/nodes')) as { items: ProviderNode[] }
    },

    async listNodeSandboxes(runnerId: string) {
      return (await request('GET', `/provider/nodes/${encodeURIComponent(runnerId)}/sandboxes`)) as {
        items: ProviderNodeSandbox[]
      }
    },

    async getUsage(query: ProviderUsageQuery = {}) {
      const suffix = buildQuery({
        from: query.from,
        to: query.to,
        granularity: query.granularity,
        runnerId: query.runnerId,
      })
      return (await request('GET', `/provider/usage${suffix}`)) as ProviderUsageResponse
    },

    async getEarnings(query: ProviderEarningsQuery = {}) {
      const suffix = buildQuery({ from: query.from, to: query.to, runnerId: query.runnerId })
      return (await request('GET', `/provider/earnings${suffix}`)) as ProviderEarningsResponse
    },

    async listSettlements(query: ProviderSettlementsQuery = {}) {
      const suffix = buildQuery({
        status: query.status,
        from: query.from,
        to: query.to,
        runnerId: query.runnerId,
        limit: query.limit,
      })
      return (await request('GET', `/provider/settlements${suffix}`)) as { items: ProviderSettlement[] }
    },

    async listAlerts(query: ProviderAlertsQuery = {}) {
      const suffix = buildQuery({ state: query.state, runnerId: query.runnerId, limit: query.limit })
      return (await request('GET', `/provider/alerts${suffix}`)) as { items: ProviderAlert[] }
    },

    async resolveAlert(id: string) {
      return (await request('POST', `/provider/alerts/${encodeURIComponent(id)}/resolve`)) as ProviderAlert
    },
  }
}

/**
 * 从进程环境变量构造配置；未启用或缺 key 时返回 null。
 *
 *   ROOST_PROVIDER_CONSOLE=1                    启用（或设置 ROOST_PROVIDER_CONSOLE_URL 即启用）
 *   ROOST_PROVIDER_CONSOLE_URL                  API base，默认 DAYTONA_API_URL / Daytona Cloud
 *   ROOST_PROVIDER_CONSOLE_API_KEY              组织 API key，默认 DAYTONA_API_KEY
 *   DAYTONA_ORGANIZATION_ID                     可选组织 id
 */
export function providerConsoleConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderConsoleConfig | null {
  const explicitUrl = (env['ROOST_PROVIDER_CONSOLE_URL'] ?? '').trim()
  const enabled = (env['ROOST_PROVIDER_CONSOLE'] ?? '').trim() === '1' || explicitUrl !== ''
  if (!enabled) return null

  const apiKey = (
    (env['ROOST_PROVIDER_CONSOLE_API_KEY'] ?? '').trim() ||
    (env['DAYTONA_API_KEY'] ?? '').trim() ||
    (env['ROOST_DAYTONA_API_KEY'] ?? '').trim()
  ).trim()
  if (apiKey === '') return null

  const apiUrl =
    explicitUrl !== ''
      ? explicitUrl
      : (env['DAYTONA_API_URL'] ?? '').trim() || (env['ROOST_DAYTONA_API_URL'] ?? '').trim() || 'https://app.daytona.io/api'
  const organizationId = (env['DAYTONA_ORGANIZATION_ID'] ?? '').trim()

  return {
    apiUrl,
    apiKey,
    ...(organizationId === '' ? {} : { organizationId }),
  }
}
