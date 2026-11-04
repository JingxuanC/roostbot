// workspace-client：只做 HTTP 封装与错误规范化，不自动执行后续动作。

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { WorkspaceApiError, startWorkspace, workspaceRuntime } from '../workspace-client.mjs'

interface SeenRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

async function fakeApi(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string) => void
): Promise<{ base: string; requests: SeenRequest[]; close: () => Promise<void> }> {
  const requests: SeenRequest[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : (value ?? '')])
        ),
        body
      })
      handler(req, res, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
  }
}

test('startWorkspace：POST /api/workspaces/:id/start，Bearer + JSON，返回解析后的 body', async () => {
  const api = await fakeApi((_req, res) => {
    res.statusCode = 202
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, runtime: { status: 'starting' } }))
  })
  try {
    const result = await startWorkspace(api.base, 'tok_1', 'ws_1')
    assert.equal(api.requests.length, 1, '只发一个请求，不自动查询 runtime')
    const [seen] = api.requests
    assert.equal(seen.method, 'POST')
    assert.equal(seen.url, '/api/workspaces/ws_1/start')
    assert.equal(seen.headers.authorization, 'Bearer tok_1')
    assert.match(seen.headers['content-type'], /application\/json/)
    assert.deepEqual(JSON.parse(seen.body), {})
    assert.deepEqual(result, { ok: true, runtime: { status: 'starting' } })
  } finally {
    await api.close()
  }
})

test('workspaceRuntime：GET /api/workspaces/:id/runtime，id 做 URL 编码', async () => {
  const api = await fakeApi((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, runtime: { status: 'ready', sandbox: 'user-abcd1234' } }))
  })
  try {
    const result = await workspaceRuntime(api.base, 'tok_2', 'ws 1/x')
    assert.equal(api.requests[0].method, 'GET')
    assert.equal(api.requests[0].url, '/api/workspaces/ws%201%2Fx/runtime')
    assert.equal(api.requests[0].headers.authorization, 'Bearer tok_2')
    assert.equal(result.runtime.status, 'ready')
  } finally {
    await api.close()
  }
})

test('错误规范化：控制面 {ok:false,error} 的 code/message/status 原样保留', async () => {
  const api = await fakeApi((_req, res) => {
    res.statusCode = 404
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: false, error: { code: 'workspace_not_found', message: 'no such workspace' } }))
  })
  try {
    await assert.rejects(
      () => workspaceRuntime(api.base, 'tok', 'ws_missing'),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceApiError)
        assert.equal(error.name, 'WorkspaceApiError')
        assert.equal(error.code, 'workspace_not_found')
        assert.equal(error.status, 404)
        assert.equal(error.message, 'no such workspace')
        return true
      }
    )
  } finally {
    await api.close()
  }
})

test('错误规范化：2xx 里的 ok:false 也算失败', async () => {
  const api = await fakeApi((_req, res) => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: false, error: { code: 'workspace_locked', message: 'home is migrating' } }))
  })
  try {
    await assert.rejects(
      () => startWorkspace(api.base, 'tok', 'ws_1'),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceApiError)
        assert.equal(error.code, 'workspace_locked')
        assert.equal(error.message, 'home is migrating')
        return true
      }
    )
  } finally {
    await api.close()
  }
})

test('错误规范化：非 JSON 网关错误变成 http_<status>', async () => {
  const api = await fakeApi((_req, res) => {
    res.statusCode = 502
    res.end('bad gateway')
  })
  try {
    await assert.rejects(
      () => startWorkspace(api.base, 'tok', 'ws_1'),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceApiError)
        assert.equal(error.code, 'http_502')
        assert.equal(error.status, 502)
        assert.equal(error.message, 'HTTP 502')
        assert.equal(error.body, 'bad gateway')
        return true
      }
    )
  } finally {
    await api.close()
  }
})

test('空 body 的 2xx 返回 {}（不编造字段）', async () => {
  const api = await fakeApi((_req, res) => {
    res.statusCode = 204
    res.end()
  })
  try {
    assert.deepEqual(await startWorkspace(api.base, 'tok', 'ws_1'), {})
  } finally {
    await api.close()
  }
})

test('网络不可达规范化为 network_error', async () => {
  const api = await fakeApi((_req, res) => res.end())
  const base = api.base
  await api.close()
  await assert.rejects(
    () => workspaceRuntime(base, 'tok', 'ws_1'),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceApiError)
      assert.equal(error.code, 'network_error')
      assert.equal(error.status, 0)
      return true
    }
  )
})
