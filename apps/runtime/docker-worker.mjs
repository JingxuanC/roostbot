#!/usr/bin/env node
// Docker runtime worker: the only process allowed to talk to the Docker daemon.
//
// Control plane -> private HTTP + bearer token -> this worker -> docker CLI.
// One workspace = one long-lived container running room-agent (which starts DSH
// and the external harnesses). The container is the isolation boundary; this
// worker only owns lifecycle, readiness and logs.
//
// Env:
//   ROOST_DOCKER_WORKER_TOKEN     required shared secret
//   ROOST_DOCKER_WORKER_BIND      default 0.0.0.0
//   PORT                          default 8790
//   ROOST_DOCKER_HOST             default unix:///var/run/docker28/docker.sock
//   ROOST_DOCKER_WORKSPACE_ROOT   default /var/lib/roost/workspaces
//   ROOST_DOCKER_IMAGE            default roost/agent:multi-runtime
//   ROOST_DOCKER_NETWORK          default host
//   ROOST_DOCKER_MEMORY           default 2g
//   ROOST_DOCKER_CPUS             default 2
//   ROOST_DOCKER_PIDS             default 2048

import { createHash, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chownSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'

const PORT = Number(process.env.PORT ?? 8790)
const BIND = process.env.ROOST_DOCKER_WORKER_BIND ?? '0.0.0.0'
const TOKEN = process.env.ROOST_DOCKER_WORKER_TOKEN ?? ''
const DOCKER_HOST = process.env.ROOST_DOCKER_HOST ?? 'unix:///var/run/docker28/docker.sock'
const WORKSPACE_ROOT = process.env.ROOST_DOCKER_WORKSPACE_ROOT ?? '/var/lib/roost/workspaces'
const DEFAULT_IMAGE = process.env.ROOST_DOCKER_IMAGE ?? 'roost/agent:multi-runtime'
const DEFAULT_NETWORK = process.env.ROOST_DOCKER_NETWORK ?? 'host'
const DEFAULT_MEMORY = process.env.ROOST_DOCKER_MEMORY ?? '2g'
const DEFAULT_CPUS = process.env.ROOST_DOCKER_CPUS ?? '2'
const DEFAULT_PIDS = process.env.ROOST_DOCKER_PIDS ?? '2048'
const ALLOWED_IMAGES = String(process.env.ROOST_DOCKER_ALLOWED_IMAGES ?? DEFAULT_IMAGE).split(',').map((v) => v.trim()).filter(Boolean)
const HARDENED = (process.env.ROOST_DOCKER_HARDENED ?? '1') !== '0'
const COMMAND = ['node', '/opt/roost/room-agent.mjs']
const READY_PATH = '/workspace/.roost/ready'
const SANDBOX_UID = 1000
const SANDBOX_GID = 1000
const MAX_BODY = 1024 * 1024

if (TOKEN === '') {
  console.error('[docker-worker] ROOST_DOCKER_WORKER_TOKEN is required')
  process.exit(2)
}

function log(message, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), msg: message, ...fields }))
}

function sha(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function safeWorkspaceId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : null
}

function containerName(workspaceId) {
  return `roost-ws-${sha(workspaceId).slice(0, 12)}`
}

function workspaceDir(workspaceId) {
  return join(WORKSPACE_ROOT, sha(workspaceId).slice(0, 16))
}

function runDocker(args, options = {}) {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn('docker', args, {
      env: { ...process.env, DOCKER_HOST },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch {}
      resolve({ code: -1, stdout, stderr: `${stderr}\n[docker-worker] timeout` })
    }, Math.max(1000, options.timeoutMs ?? 30_000))
    if (typeof timer.unref === 'function') timer.unref()
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: `${stderr}\n${String(error)}` })
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

async function inspect(name) {
  const result = await runDocker(['inspect', '--format', '{{json .State}}', name], { timeoutMs: 10_000 })
  if (result.code !== 0) return null
  try {
    return JSON.parse(result.stdout.trim())
  } catch {
    return null
  }
}

async function isReady(name) {
  const result = await runDocker(['exec', name, 'test', '-f', READY_PATH], { timeoutMs: 10_000 })
  return result.code === 0
}

async function logsTail(name, tail = 80) {
  const result = await runDocker(['logs', '--tail', String(tail), name], { timeoutMs: 10_000 })
  return `${result.stdout}${result.stderr}`.slice(-8000)
}

async function removeContainer(name) {
  await runDocker(['rm', '-f', name], { timeoutMs: 15_000 })
}

function ensureWorkspaceDir(workspaceId) {
  const dir = workspaceDir(workspaceId)
  mkdirSync(dir, { recursive: true, mode: 0o755 })
  try { chownSync(dir, SANDBOX_UID, SANDBOX_GID) } catch {}
  return dir
}

function envFile(env) {
  const lines = []
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid env key: ${key}`)
    const text = String(value)
    if (text.includes('\n') || text.includes('\r') || text.includes('\0')) {
      throw new Error(`env ${key} contains a newline or NUL`)
    }
    lines.push(`${key}=${text}`)
  }
  const path = `/tmp/roost-ws-env-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 })
  return path
}

async function createContainer(spec) {
  const name = spec.name ?? containerName(spec.workspaceId)
  if (!/^roost-ws-[a-f0-9]+$/.test(name)) throw new Error('container name must be roost-ws-<hash>')
  const image = spec.image ?? DEFAULT_IMAGE
  if (!ALLOWED_IMAGES.includes(image)) throw new Error(`image not allowed: ${image}`)
  const dir = ensureWorkspaceDir(spec.workspaceId)
  const env = { ROOST_READY_FILE: READY_PATH, ...(spec.env ?? {}) }
  const file = envFile(env)
  // The worker only runs the room-agent entrypoint. This keeps a compromised
  // control-plane token from turning the Docker host into a generic executor.
  const command = COMMAND
  const args = [
    'run', '-d', '--name', name,
    '--network', DEFAULT_NETWORK,
    '--user', `${SANDBOX_UID}:${SANDBOX_GID}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(spec.resources?.pids ?? DEFAULT_PIDS),
    ...(HARDENED ? ['--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m', '--tmpfs', '/run:rw,nosuid,nodev,size=64m'] : []),
    '--memory', String(spec.resources?.memoryMb ? `${spec.resources.memoryMb}m` : DEFAULT_MEMORY),
    '--cpus', String(spec.resources?.cpus ?? DEFAULT_CPUS),
    '--label', 'roost.managed=true',
    '--label', `roost.workspace=${spec.workspaceId}`,
    '-v', `${dir}:/workspace`,
    '--env-file', file,
    image,
    ...command
  ]
  try {
    const result = await runDocker(args, { timeoutMs: 30_000 })
    if (result.code !== 0) {
      throw new Error(`docker run failed: ${result.stderr.slice(-2000)}`)
    }
    return { name, created: true }
  } finally {
    try { unlinkSync(file) } catch {}
  }
}

async function waitReady(name, timeoutMs = 30_000) {
  const deadline = Date.now() + Math.max(1000, timeoutMs)
  while (Date.now() < deadline) {
    const state = await inspect(name)
    if (state === null) throw new Error('container disappeared while waiting for readiness')
    if (state.Running !== true) {
      const status = String(state.Status ?? 'exited')
      const logs = await logsTail(name)
      throw new Error(`container ${status} before ready\n${logs}`)
    }
    if (await isReady(name)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const logs = await logsTail(name)
  throw new Error(`ready timeout after ${timeoutMs}ms\n${logs}`)
}

const inflight = new Map()

async function ensureRuntime(spec) {
  const workspaceId = safeWorkspaceId(spec.workspaceId)
  if (workspaceId === null) throw new Error('invalid workspaceId')
  const name = spec.name ?? containerName(workspaceId)
  const key = `${name}`
  const running = inflight.get(key)
  if (running !== undefined) return running
  const work = (async () => {
    const state = await inspect(name)
    if (state !== null && state.Running === true) {
      if (await isReady(name)) {
        return { sandbox: name, phase: 'ready', created: false }
      }
      await waitReady(name, spec.readyTimeoutMs)
      return { sandbox: name, phase: 'ready', created: false }
    }
    if (state !== null) await removeContainer(name)
    const created = await createContainer({ ...spec, workspaceId, name })
    try {
      await waitReady(created.name, spec.readyTimeoutMs)
    } catch (error) {
      const logs = await logsTail(created.name)
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs}`)
    }
    return { sandbox: created.name, phase: 'ready', created: true }
  })()
  inflight.set(key, work)
  try {
    return await work
  } finally {
    inflight.delete(key)
  }
}

async function statusRuntime(workspaceId) {
  const id = safeWorkspaceId(workspaceId)
  if (id === null) return null
  const name = containerName(id)
  const state = await inspect(name)
  if (state === null) return null
  if (state.Running === true) {
    return { sandbox: name, phase: (await isReady(name)) ? 'ready' : 'starting' }
  }
  if (state.Status === 'exited' || state.Status === 'dead') {
    return { sandbox: name, phase: 'stopped' }
  }
  return { sandbox: name, phase: 'unknown' }
}

async function stopRuntime(workspaceId, remove) {
  const id = safeWorkspaceId(workspaceId)
  if (id === null) return false
  const name = containerName(id)
  const state = await inspect(name)
  if (state === null) return false
  if (state.Running === true) {
    await runDocker(['stop', '-t', '10', name], { timeoutMs: 20_000 })
  }
  if (remove === true) await removeContainer(name)
  return true
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

function authorized(req) {
  const raw = req.headers.authorization ?? ''
  const expected = `Bearer ${TOKEN}`
  const a = Buffer.from(String(raw))
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('body too large')
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://worker')
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, dockerHost: DOCKER_HOST })
    if (!authorized(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' })
    if (req.method === 'POST' && url.pathname === '/v1/ensure') {
      const body = await readJson(req)
      const result = await ensureRuntime(body)
      return sendJson(res, 200, { ok: true, ...result })
    }
    if (req.method === 'GET' && url.pathname === '/v1/status') {
      const workspaceId = url.searchParams.get('workspaceId') ?? ''
      const result = await statusRuntime(workspaceId)
      return sendJson(res, 200, { ok: true, status: result })
    }
    if (req.method === 'POST' && url.pathname === '/v1/stop') {
      const body = await readJson(req)
      const removed = await stopRuntime(body.workspaceId, body.remove === true)
      return sendJson(res, 200, { ok: true, removed })
    }
    if (req.method === 'GET' && url.pathname === '/v1/logs') {
      const workspaceId = safeWorkspaceId(url.searchParams.get('workspaceId') ?? '')
      if (workspaceId === null) return sendJson(res, 400, { ok: false, error: 'invalid workspaceId' })
      const tail = Number.parseInt(url.searchParams.get('tail') ?? '80', 10)
      return sendJson(res, 200, { ok: true, logs: await logsTail(containerName(workspaceId), Number.isFinite(tail) ? tail : 80) })
    }
    return sendJson(res, 404, { ok: false, error: 'not found' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('request failed', { message })
    return sendJson(res, 500, { ok: false, error: message.slice(0, 4000) })
  }
})

server.listen(PORT, BIND, () => {
  log('docker worker listening', { bind: BIND, port: PORT, dockerHost: DOCKER_HOST })
})

function shutdown() {
  server.close(() => process.exit(0))
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
