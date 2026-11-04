// /healthz/deep 路由：GET 三态映射、405、超时（M6-6.6）。

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { handleDeepHealth, type DeepHealthContext } from '../src/health-deep.ts'

const AT = Date.UTC(2026, 10, 4, 12, 0, 0)

async function withDeep(
  ctx: DeepHealthContext,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer((req, res) => {
    void handleDeepHealth(ctx, req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const allOk: DeepHealthContext = {
  now: AT,
  probes: {
    api: () => ({ ok: true }),
    store: () => ({ ok: true }),
    sandbox: () => ({ ok: true }),
    gateway: () => ({ ok: true })
  }
}

test('GET 全 ok：200 + {status,checks,at}', async () => {
  await withDeep(allOk, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz/deep`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
    const body = (await response.json()) as any
    assert.deepEqual(Object.keys(body).sort(), ['at', 'checks', 'status'])
    assert.equal(body.status, 'ok')
    assert.equal(body.at, new Date(AT).toISOString())
    assert.deepEqual(body.checks.map((check: any) => check.name), ['api', 'store', 'sandbox', 'gateway'])
    assert.equal(body.checks[0].status, 'ok')
  })
})

test('probe 返回 ok:false：degraded 仍 200', async () => {
  await withDeep(
    {
      now: AT,
      probes: {
        api: () => ({ ok: true }),
        store: () => ({ ok: false, detail: 'db locked' })
      }
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/healthz/deep`)
      assert.equal(response.status, 200)
      const body = (await response.json()) as any
      assert.equal(body.status, 'degraded')
      assert.equal(body.checks.find((check: any) => check.name === 'store').detail, 'db locked')
    }
  )
})

test('probe 抛错：down → 503', async () => {
  await withDeep(
    {
      now: AT,
      probes: {
        api: () => ({ ok: true }),
        gateway: () => {
          throw new Error('gateway unreachable')
        }
      }
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/healthz/deep`)
      assert.equal(response.status, 503)
      const body = (await response.json()) as any
      assert.equal(body.status, 'down')
      assert.equal(body.checks.find((check: any) => check.name === 'gateway').status, 'down')
    }
  )
})

test('超时 probe 按 down 返回 503', async () => {
  await withDeep(
    {
      now: AT,
      timeoutMs: 10,
      probes: { sandbox: () => new Promise(() => {}) }
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/healthz/deep`)
      assert.equal(response.status, 503)
      const body = (await response.json()) as any
      assert.equal(body.status, 'down')
      assert.match(body.checks[0].detail, /timed out/)
    }
  )
})

test('非 GET：405 + Allow: GET', async () => {
  await withDeep(allOk, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz/deep`, { method: 'POST' })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'GET')
    const body = (await response.json()) as any
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'method_not_allowed')
  })
})
