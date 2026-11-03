// Integration tests for the runtime sidecar (apps/runtime/sidecar/proxy.mjs).
//
// No dependencies: a fake upstream (node:http) and a real sidecar child process,
// both on OS-assigned ports so the suite can run next to other things.
//
// Run from the repo root:
//   node --experimental-strip-types --test apps/runtime/test/*.test.ts
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = '/w/ws_test'
const TOKEN = 'rt_test_secret'
const HERE = dirname(fileURLToPath(import.meta.url))
const PROXY = join(HERE, '..', 'sidecar', 'proxy.mjs')

let upstream
let sidecar
let tmpDir
const seen = []

function startUpstream() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        // Any answer proves the proxy reached upstream; 401 mirrors DSH's own auth.
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('upstream-401')
      })
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

function startSidecar(upstreamPort) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROXY], {
      env: {
        ...process.env,
        UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
        PORT: '0',
        BASE_PATH: BASE,
        RUNTIME_TOKEN: TOKEN,
        DSH_DATA_DIR: join(tmpDir, 'missing-data'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    let ready = false
    let timer
    const fail = (error) => {
      if (ready) return
      ready = true
      clearTimeout(timer)
      child.kill('SIGTERM')
      reject(error)
    }

    timer = setTimeout(() => fail(new Error(`sidecar not ready in 5s; output:\n${output}`)), 5000)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      output += chunk
      const match = output.match(/roostbot sidecar on http:\/\/127\.0\.0\.1:(\d+)/)
      if (!match || ready) return
      ready = true
      clearTimeout(timer)
      resolve({ child, port: Number(match[1]) })
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('error', fail)
    child.once('exit', (code, signal) => {
      if (!ready) fail(new Error(`sidecar exited before ready (code=${code}, signal=${signal}):\n${output}`))
    })
  })
}

async function call(pathname, init = undefined) {
  const response = await fetch(`http://127.0.0.1:${sidecar.port}${pathname}`, init)
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // Plain-text responses (the upstream 401) are asserted as text.
  }
  return { response, text, json }
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    // SIGTERM first; SIGKILL only if the process ignores the graceful path.
    const force = setTimeout(() => child.kill('SIGKILL'), 4000)
    child.once('exit', () => {
      clearTimeout(force)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'roostbot-sidecar-test-'))
  upstream = await startUpstream()
  sidecar = await startSidecar(upstream.port)
})

after(async () => {
  if (sidecar) await stopChild(sidecar.child)
  if (upstream) {
    await new Promise((resolve) => upstream.server.close(resolve))
  }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

test('GET <base>/healthz returns 200 and an upstream field', async () => {
  const { response, json } = await call(`${BASE}/healthz`)
  assert.equal(response.status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.upstream, 401)
  assert.equal(typeof json.at, 'string')
})

test('GET <base>/activity returns 200 and a boolean busy', async () => {
  const { response, json } = await call(`${BASE}/activity`)
  assert.equal(response.status, 200)
  assert.equal(typeof json.busy, 'boolean')
  assert.equal(json.busy, false)
  assert.equal(typeof json.turns, 'number')
  assert.ok(Array.isArray(json.source))
})

test('a path outside the base path is 404', async () => {
  const { response, json } = await call('/healthz')
  assert.equal(response.status, 404)
  assert.equal(json.error, 'outside-base-path')

  // A sibling prefix (/w/ws_testextra) must not be treated as inside /w/ws_test.
  const sibling = await call(`${BASE}extra/healthz`)
  assert.equal(sibling.response.status, 404)
  assert.equal(sibling.json.error, 'outside-base-path')
})

test('POST <base>/api/x without a token is rejected by the sidecar', async () => {
  const before = seen.length
  const { response, json } = await call(`${BASE}/api/x`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(response.status, 401)
  assert.equal(json.error, 'runtime-token-required')
  assert.equal(response.headers.get('www-authenticate'), 'Bearer')
  assert.equal(seen.length, before, 'rejected request must not reach upstream')
})

test('POST <base>/api/x with a token is proxied and the upstream 401 is returned verbatim', async () => {
  const { response, text } = await call(`${BASE}/api/x`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: '{"hello":"world"}',
  })
  assert.equal(response.status, 401)
  assert.equal(text, 'upstream-401')

  const forwarded = [...seen].reverse().find((entry) => entry.method === 'POST' && entry.url === '/api/x')
  assert.ok(forwarded, 'POST /api/x should reach upstream')
  assert.equal(forwarded.body, '{"hello":"world"}')
  // The runtime token is for the sidecar, not for DSH; it must not leak upstream.
  assert.equal(forwarded.authorization, undefined)
})

test('SIGTERM stops the sidecar cleanly', async () => {
  // A second, independent instance: this test must not depend on test ordering
  // or take the shared sidecar down before the other assertions run.
  const extra = await startSidecar(upstream.port)
  const startedAt = Date.now()
  await stopChild(extra.child)
  const elapsed = Date.now() - startedAt

  assert.equal(extra.child.signalCode, null, 'sidecar should exit on its own, not be SIGKILLed')
  assert.equal(extra.child.exitCode, 0)
  assert.ok(elapsed < 4000, `graceful stop took ${elapsed}ms`)
})

