// Provider console 接入测试：客户端契约（含 Cloud 404 降级）+ /api/provider/* 路由接线。
//
// 客户端用注入 fetchImpl 测协议语义；路由用真实 HTTP + 真实 SQLite + Bearer 会话，
// provider console 客户端用 stub 注入（不打真实 Daytona）。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openStore } from '../../../packages/store/src/index.ts'
import {
  ProviderConsoleError,
  createProviderConsoleClient,
  providerConsoleConfigFromEnv,
} from '../src/provider-console-client.ts'
import type { ProviderConsoleClient } from '../src/provider-console-client.ts'
import type { StorePort } from '../src/port.ts'
import { createStorePort } from '../src/store-adapter.ts'
import { hashSessionToken, startServer } from '../src/server.ts'

const TOKEN = 'f'.repeat(64)
const ACCOUNT = 'acc_provider_console'
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)

interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string | undefined
}

function mockClient(handler: (request: RecordedRequest) => { status: number; body?: unknown }) {
  const requests: RecordedRequest[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    requests.push(request)
    const result = handler(request)
    return new Response(result.body === undefined ? '' : JSON.stringify(result.body), { status: result.status })
  }) as typeof fetch
  return { requests, fetchImpl }
}

test('客户端带上 Bearer 与组织头，并解析节点数据', async () => {
  const { requests, fetchImpl } = mockClient(() => ({
    status: 200,
    body: { items: [{ runnerId: 'runner-1', name: 'node-1', state: 'ready' }] },
  }))
  const client = createProviderConsoleClient({
    apiUrl: 'https://daytona.test/api/',
    apiKey: 'dtn_test',
    organizationId: 'org-1',
    fetchImpl,
  })

  const nodes = await client.listNodes()

  assert.equal(nodes.items[0].runnerId, 'runner-1')
  assert.equal(requests[0].url, 'https://daytona.test/api/provider/nodes')
  assert.equal(requests[0].headers.authorization, 'Bearer dtn_test')
  assert.equal(requests[0].headers['x-daytona-organization-id'], 'org-1')
})

test('客户端把 Cloud 上的 404 映射成 not_supported', async () => {
  const { fetchImpl } = mockClient(() => ({
    status: 404,
    body: { message: 'Cannot GET /api/provider/nodes' },
  }))
  const client = createProviderConsoleClient({ apiUrl: 'https://app.daytona.io/api', apiKey: 'dtn_test', fetchImpl })

  await assert.rejects(client.listNodes(), (error: unknown) => {
    assert.ok(error instanceof ProviderConsoleError)
    assert.equal(error.failure, 'not_supported')
    return true
  })

  const probe = await client.probe()
  assert.equal(probe.ok, false)
  assert.match(probe.problems[0] ?? '', /not available/)
})

test('客户端区分 unauthorized / bad_response / network', async () => {
  const unauthorized = createProviderConsoleClient({
    apiUrl: 'https://daytona.test/api',
    apiKey: 'bad',
    fetchImpl: mockClient(() => ({ status: 401, body: {} })).fetchImpl,
  })
  await assert.rejects(unauthorized.listNodes(), (error: unknown) => {
    assert.equal((error as ProviderConsoleError).failure, 'unauthorized')
    return true
  })

  const bad = createProviderConsoleClient({
    apiUrl: 'https://daytona.test/api',
    apiKey: 'k',
    fetchImpl: mockClient(() => ({ status: 500, body: { message: 'boom' } })).fetchImpl,
  })
  await assert.rejects(bad.listNodes(), (error: unknown) => {
    assert.equal((error as ProviderConsoleError).failure, 'bad_response')
    return true
  })

  const offline = createProviderConsoleClient({
    apiUrl: 'https://daytona.test/api',
    apiKey: 'k',
    fetchImpl: (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch,
  })
  await assert.rejects(offline.listNodes(), (error: unknown) => {
    assert.equal((error as ProviderConsoleError).failure, 'network')
    return true
  })
})

test('用量查询参数正确编码，缺省参数不发送', async () => {
  const { requests, fetchImpl } = mockClient(() => ({
    status: 200,
    body: { from: '2026-11-01', to: '2026-11-09', currency: 'CNY', items: [], totals: {} },
  }))
  const client = createProviderConsoleClient({ apiUrl: 'https://daytona.test/api', apiKey: 'k', fetchImpl })

  await client.getUsage({ from: '2026-11-01', to: '2026-11-09', granularity: 'day', runnerId: 'runner 1' })

  const url = new URL(requests[0].url)
  assert.equal(url.pathname, '/api/provider/usage')
  assert.equal(url.searchParams.get('from'), '2026-11-01')
  assert.equal(url.searchParams.get('granularity'), 'day')
  assert.equal(url.searchParams.get('runnerId'), 'runner 1')
})

test('环境变量未启用或缺 key 时返回 null', () => {
  assert.equal(providerConsoleConfigFromEnv({}), null)
  assert.equal(providerConsoleConfigFromEnv({ ROOST_PROVIDER_CONSOLE: '1' }), null)
  assert.equal(providerConsoleConfigFromEnv({ DAYTONA_API_KEY: 'dtn_x' }), null)
  const enabled = providerConsoleConfigFromEnv({ ROOST_PROVIDER_CONSOLE: '1', DAYTONA_API_KEY: 'dtn_x' })
  assert.equal(enabled?.apiUrl, 'https://app.daytona.io/api')
  const config = providerConsoleConfigFromEnv({
    ROOST_PROVIDER_CONSOLE: '1',
    DAYTONA_API_KEY: 'dtn_x',
    DAYTONA_API_URL: 'http://127.0.0.1:3100/api',
    DAYTONA_ORGANIZATION_ID: 'org-1',
  })
  assert.equal(config?.apiUrl, 'http://127.0.0.1:3100/api')
  assert.equal(config?.apiKey, 'dtn_x')
  assert.equal(config?.organizationId, 'org-1')
})

function stubClient(overrides: Partial<ProviderConsoleClient> = {}): ProviderConsoleClient {
  const base: ProviderConsoleClient = {
    apiUrl: 'https://daytona.test/api',
    probe: async () => ({ ok: true, problems: [] }),
    listNodes: async () => ({ items: [] }),
    listNodeSandboxes: async () => ({ items: [] }),
    getUsage: async () => ({
      from: '2026-11-01',
      to: '2026-11-09',
      currency: 'CNY',
      items: [],
      totals: { cpuHours: 0, memoryGiBHours: 0, diskGiBHours: 0, gpuHours: 0, sandboxCount: 0 },
    }),
    getEarnings: async () => ({
      from: '2026-11-01',
      to: '2026-11-09',
      currency: 'CNY',
      items: [],
      totals: { cpuHours: 0, memoryGiBHours: 0, diskGiBHours: 0, gpuHours: 0, amountCents: 0 },
    }),
    listSettlements: async () => ({ items: [] }),
    listAlerts: async () => ({ items: [] }),
    resolveAlert: async () => {
      throw new Error('not implemented in stub')
    },
  }
  return { ...base, ...overrides }
}

interface ApiResult {
  status: number
  json: any
}

async function withProviderApi(
  providerConsole: ProviderConsoleClient | undefined,
  fn: (call: (method: string, path: string, token?: string) => Promise<ApiResult>) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'roost-provider-console-'))
  const store = openStore(join(dir, 'workspace.db'))
  const port = createStorePort(store)
  let started: Awaited<ReturnType<typeof startServer>> | null = null

  try {
    const ws = await port.createWorkspace({ accountId: ACCOUNT, name: '算力工作区', now: NOW })
    void ws
    await port.createSession({
      accountId: ACCOUNT,
      tokenHash: hashSessionToken(TOKEN),
      now: NOW,
      expiresAt: NOW + 3_600_000,
    })

    started = await startServer({
      store: port,
      rawStore: store,
      now: () => NOW,
      port: 0,
      host: '127.0.0.1',
      ...(providerConsole === undefined ? {} : { providerConsole }),
    })

    async function call(method: string, path: string, token?: string): Promise<ApiResult> {
      const headers: Record<string, string> = {}
      if (token !== undefined) headers.authorization = `Bearer ${token}`
      const response = await fetch(`${started?.url ?? ''}${path}`, { method, headers })
      const text = await response.text()
      return { status: response.status, json: text === '' ? null : JSON.parse(text) }
    }

    await fn(call)
  } finally {
    if (started !== null) await started.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('路由：未登录 401，未配置 501，配置后透传节点数据', async () => {
  await withProviderApi(undefined, async (call) => {
    const anonymous = await call('GET', '/api/provider/nodes')
    assert.equal(anonymous.status, 401)

    const unconfigured = await call('GET', '/api/provider/nodes', TOKEN)
    assert.equal(unconfigured.status, 501)
    assert.equal(unconfigured.json.error.code, 'provider.not_configured')
  })

  await withProviderApi(
    stubClient({
      listNodes: async () => ({
        items: [
          {
            runnerId: 'runner-1',
            name: 'worker-a',
            regionId: 'us',
            regionName: 'us',
            state: 'ready',
            unschedulable: false,
            lastCheckedAt: '2026-11-04T11:59:00.000Z',
            rttMs: 12.4,
            totalCpu: 8,
            totalMemoryGiB: 16,
            totalDiskGiB: 100,
            cpuUsagePct: 45.5,
            memoryUsagePct: 60.2,
            diskUsagePct: 35.8,
            allocatedCpu: 4,
            allocatedMemoryGiB: 8,
            allocatedDiskGiB: 50,
            startedSandboxes: 2,
            availabilityScore: 9.2,
            appVersion: 'v0.190.0',
            sandboxStarts7d: 10,
            sandboxStartFailures7d: 1,
            avgStartupSeconds7d: 8.4,
            openAlertCount: 2,
          },
        ],
      }),
    }),
    async (call) => {
      const nodes = await call('GET', '/api/provider/nodes', TOKEN)
      assert.equal(nodes.status, 200)
      assert.equal(nodes.json.items[0].runnerId, 'runner-1')
      assert.equal(nodes.json.items[0].rttMs, 12.4)
    },
  )
})

test('路由：用量参数校验与上游错误映射', async () => {
  await withProviderApi(
    stubClient({
      getUsage: async (query) => {
        assert.equal(query.granularity, 'day')
        return {
          from: '2026-11-01',
          to: '2026-11-09',
          currency: 'CNY',
          items: [
            {
              date: '2026-11-04',
              runnerId: 'runner-1',
              runnerName: 'worker-a',
              cpuHours: 24,
              memoryGiBHours: 48,
              diskGiBHours: 120,
              gpuHours: 0,
              sandboxCount: 2,
            },
          ],
          totals: { cpuHours: 24, memoryGiBHours: 48, diskGiBHours: 120, gpuHours: 0, sandboxCount: 2 },
        }
      },
    }),
    async (call) => {
      const invalid = await call('GET', '/api/provider/usage?granularity=week', TOKEN)
      assert.equal(invalid.status, 400)

      const usage = await call('GET', '/api/provider/usage?granularity=day&from=2026-11-01&to=2026-11-09', TOKEN)
      assert.equal(usage.status, 200)
      assert.equal(usage.json.totals.cpuHours, 24)
    },
  )

  await withProviderApi(
    stubClient({
      listNodes: async () => {
        throw new ProviderConsoleError('not_supported', 'endpoint missing', 404)
      },
    }),
    async (call) => {
      const response = await call('GET', '/api/provider/nodes', TOKEN)
      assert.equal(response.status, 501)
      assert.equal(response.json.error.code, 'provider.not_supported')
    },
  )

  await withProviderApi(
    stubClient({
      listAlerts: async () => ({ items: [] }),
    }),
    async (call) => {
      const alerts = await call('GET', '/api/provider/alerts?state=open', TOKEN)
      assert.equal(alerts.status, 200)
      const badState = await call('GET', '/api/provider/alerts?state=foo', TOKEN)
      assert.equal(badState.status, 400)
      const notFound = await call('GET', '/api/provider/unknown', TOKEN)
      assert.equal(notFound.status, 404)
    },
  )
})
