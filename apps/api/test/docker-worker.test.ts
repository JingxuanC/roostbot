// Docker worker lifecycle tests with a fake docker CLI.
//
// The worker is a separate process by design (it is the only process allowed to
// hold Docker credentials), so the test launches it with a fake `docker` on PATH
// and exercises the authenticated HTTP API end-to-end.

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const ROOT = resolve(import.meta.dirname, '..', '..', '..')

function fakeDocker(dir: string): void {
  const state = join(dir, 'state')
  writeFileSync(join(dir, 'state'), 'absent')
  const script = `#!/bin/sh
STATE="${state}"
case "$1" in
  inspect)
    if [ "$(cat "$STATE")" = "running" ]; then
      echo '{"Running":true,"Status":"running"}'
    else
      exit 1
    fi
    ;;
  run)
    echo running > "$STATE"
    exit 0
    ;;
  exec)
    exit 0
    ;;
  logs)
    echo 'fake docker logs'
    exit 0
    ;;
  stop|rm)
    echo absent > "$STATE"
    exit 0
    ;;
esac
exit 0
`
  const path = join(dir, 'docker')
  writeFileSync(path, script)
  chmodSync(path, 0o755)
}

function startWorker(): Promise<{ child: ChildProcess; base: string; token: string; dir: string; stop: () => Promise<void> }> {
  return new Promise((resolvePromise, reject) => {
    const dir = mkdtempSync(join(tmpdir(), 'roost-docker-worker-test-'))
    fakeDocker(dir)
    const token = 'worker_test_token_0123456789'
    const port = 19000 + Math.floor(Math.random() * 1000)
    const child = spawn(process.execPath, [join(ROOT, 'apps/runtime/docker-worker.mjs')], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        PORT: String(port),
        ROOST_DOCKER_WORKER_BIND: '127.0.0.1',
        ROOST_DOCKER_WORKER_TOKEN: token,
        ROOST_DOCKER_WORKSPACE_ROOT: join(dir, 'workspaces'),
        ROOST_DOCKER_IMAGE: 'fake/image',
        ROOST_DOCKER_ALLOWED_IMAGES: 'fake/image',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.on('data', (chunk) => { output += String(chunk) })
    child.stderr?.on('data', (chunk) => { output += String(chunk) })
    const base = `http://127.0.0.1:${port}`
    let attempts = 0
    const timer = setInterval(async () => {
      attempts += 1
      try {
        const response = await fetch(`${base}/healthz`)
        if (!response.ok) return
        clearInterval(timer)
        resolvePromise({
          child,
          base,
          token,
          dir,
          async stop() {
            child.kill('SIGTERM')
            await new Promise((resolve) => setTimeout(resolve, 300))
            rmSync(dir, { recursive: true, force: true })
          },
        })
      } catch {
        if (attempts > 80) {
          clearInterval(timer)
          child.kill('SIGKILL')
          rmSync(dir, { recursive: true, force: true })
          reject(new Error(`worker did not start: ${output}`))
        }
      }
    }, 50)
  })
}

async function call(base: string, token: string, path: string, method = 'GET', body?: unknown): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, json: await response.json() }
}

test('docker worker authenticates and manages a fake container lifecycle', async () => {
  const worker = await startWorker()
  try {
    assert.equal((await call(worker.base, 'wrong-token', '/v1/status?workspaceId=ws_1')).status, 401)
    assert.equal((await call(worker.base, worker.token, '/v1/status?workspaceId=ws_1')).json.status, null)

    const rejected = await call(worker.base, worker.token, '/v1/ensure', 'POST', { workspaceId: 'ws_evil', image: 'evil/image' })
    assert.equal(rejected.status, 500)

    const ensured = await call(worker.base, worker.token, '/v1/ensure', 'POST', {
      workspaceId: 'ws_1',
      image: 'fake/image',
      env: { ROOST_API: 'http://cp' },
    })
    assert.equal(ensured.status, 200)
    assert.equal(ensured.json.created, true)
    assert.equal(ensured.json.phase, 'ready')
    const name = ensured.json.sandbox as string
    assert.match(name, /^roost-ws-/)

    const status = await call(worker.base, worker.token, '/v1/status?workspaceId=ws_1')
    assert.equal(status.json.status.phase, 'ready')

    const reused = await call(worker.base, worker.token, '/v1/ensure', 'POST', { workspaceId: 'ws_1', image: 'fake/image' })
    assert.equal(reused.json.created, false)

    const stopped = await call(worker.base, worker.token, '/v1/stop', 'POST', { workspaceId: 'ws_1', remove: true })
    assert.equal(stopped.json.removed, true)
    assert.equal((await call(worker.base, worker.token, '/v1/status?workspaceId=ws_1')).json.status, null)
  } finally {
    await worker.stop()
  }
})
