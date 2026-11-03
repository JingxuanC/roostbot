#!/usr/bin/env node
// roostbot runtime sidecar — the part of docs/runtime-contract.md that DSH does not
// provide yet.
//
// Today DSH exposes no /healthz, no /activity, no per-workspace runtime token and no
// base-path mount (probed: 404, 404, cookie-only, 404). Rather than change the kernel,
// this sidecar sits in front of one DSH process and adds them:
//
//   GET  <base>/healthz        liveness: is the DSH answering?
//   GET  <base>/activity       busy + last activity, from ds-bot's inflight.json and
//                              the newest session file mtime (the only in-process signals
//                              available without kernel changes)
//   *    <base>/...            proxied to DSH with <base> stripped; every proxied
//                              call needs the runtime token or the DSH cookie
//
// Config (env):
//   UPSTREAM       http://127.0.0.1:<dsh port>   (required)
//   PORT           listen port, default 19400 (0 = OS-assigned, logged on start)
//   BASE_PATH      mount path, default "" (e.g. /w/ws_123)
//   RUNTIME_TOKEN  bearer required by the proxy; empty disables the check (local dev)
//   DSH_DATA_DIR   data dir holding bot/inflight.json, default $HOME/.dsh/alpha-desk
import http from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const UPSTREAM = process.env.UPSTREAM ?? ''
const PORT = Number(process.env.PORT ?? 19400)
const BASE = (process.env.BASE_PATH ?? '').replace(/\/+$/, '')
const TOKEN = process.env.RUNTIME_TOKEN ?? ''
const DATA = process.env.DSH_DATA_DIR ?? join(homedir(), '.dsh', 'alpha-desk')

if (UPSTREAM === '') {
  console.error('sidecar: UPSTREAM is required (e.g. http://127.0.0.1:65471)')
  process.exit(2)
}
const upstream = new URL(UPSTREAM)

const send = (res, status, body, headers = {}) => {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(payload)
}

function authorized(req) {
  if (TOKEN === '') return true
  const header = req.headers.authorization ?? ''
  if (header === `Bearer ${TOKEN}`) return true
  // Browser navigation after pairing: the DSH cookie is host-scoped, so it still arrives.
  return typeof req.headers.cookie === 'string' && req.headers.cookie !== ''
}

/** Busy and last-activity from the signals DSH already writes on disk. */
function activity() {
  let busy = false
  let turns = 0
  let lastActivity = null
  let source = []
  try {
    const inflight = JSON.parse(readFileSync(join(DATA, 'bot', 'inflight.json'), 'utf8'))
    turns = Object.keys(inflight.turns ?? {}).length
    busy = turns > 0
    source.push('bot/inflight.json')
  } catch { /* ds-bot not installed, or idle with no file */ }
  try {
    // state.json mtime is the cheapest "last activity" signal available today.
    const stats = statSync(join(DATA, 'bot', 'state.json'))
    lastActivity = new Date(stats.mtimeMs).toISOString()
    source.push('bot/state.json:mtime')
  } catch { /* no state yet */ }
  return { busy, turns, lastActivity, source, at: new Date().toISOString() }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://sidecar')
  const path = url.pathname

  // Boundary-aware: /w/ws_1 must not match /w/ws_10.
  if (BASE !== '' && path !== BASE && !path.startsWith(`${BASE}/`)) {
    send(res, 404, { ok: false, error: 'outside-base-path', base: BASE })
    return
  }
  const inner = BASE === '' ? path : (path.slice(BASE.length) || '/')

  if (inner === '/healthz') {
    // A timeout destroys the probe, which also emits 'error'; answer only once.
    let settled = false
    const reply = (body) => {
      if (settled) return
      settled = true
      send(res, 200, body)
    }
    const probe = http.request({ host: upstream.hostname, port: upstream.port, path: '/', method: 'GET', timeout: 2000 }, (up) => {
      up.resume()
      // Any HTTP answer means the process is up; 401 from DSH's own auth counts as alive.
      reply({ ok: up.statusCode !== undefined && up.statusCode < 500, upstream: up.statusCode, at: new Date().toISOString() })
    })
    probe.on('timeout', () => { probe.destroy(); reply({ ok: false, upstream: 'timeout' }) })
    probe.on('error', (error) => reply({ ok: false, upstream: 'unreachable', error: String(error?.code ?? error) }))
    probe.end()
    return
  }

  if (inner === '/activity') {
    send(res, 200, activity())
    return
  }

  if (!authorized(req)) {
    send(res, 401, { ok: false, error: 'runtime-token-required' }, { 'www-authenticate': 'Bearer' })
    return
  }

  const headers = { ...req.headers, host: upstream.host }
  delete headers.connection
  // The runtime token authenticates the caller to the sidecar, not to DSH.
  // Never forward it: DSH has its own auth and must not see (or log) the token.
  if (TOKEN !== '' && headers.authorization === `Bearer ${TOKEN}`) delete headers.authorization
  const proxied = http.request({
    host: upstream.hostname,
    port: upstream.port,
    method: req.method,
    path: inner + url.search,
    headers,
  }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers)
    up.pipe(res)
  })
  proxied.on('error', (error) => {
    // If headers already went out, the only honest move is to cut the response.
    if (res.headersSent) {
      res.destroy()
      return
    }
    send(res, 502, { ok: false, error: 'upstream-error', detail: String(error?.message ?? error) })
  })
  req.pipe(proxied)
})

server.listen(PORT, '127.0.0.1', () => {
  // PORT=0 lets the OS pick a free port (tests, parallel workspaces); report the
  // real one so the caller does not have to guess.
  const address = server.address()
  const boundPort = address !== null && typeof address === 'object' ? address.port : PORT
  process.stdout.write(`roostbot sidecar on http://127.0.0.1:${boundPort}${BASE} -> ${UPSTREAM}\n`)
})

// Graceful shutdown: stop accepting, let in-flight requests finish, then exit.
// SIGKILL is the container runtime's last resort, never this process's first move.
let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write(`roostbot sidecar: ${signal} received, draining\n`)
  const force = setTimeout(() => {
    process.stderr.write('roostbot sidecar: drain timed out, closing remaining connections\n')
    server.closeAllConnections?.()
    process.exit(1)
  }, 5000)
  force.unref()
  server.close((error) => {
    clearTimeout(force)
    process.exit(error ? 1 : 0)
  })
  server.closeIdleConnections?.()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
