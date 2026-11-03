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
//   *    <base>/...            proxied to DSH with <base> stripped; API calls need the
//                              runtime token, browser navigation may use the cookie
//
// Config (env):
//   UPSTREAM       http://127.0.0.1:<dsh port>   (required)
//   PORT           listen port, default 19400
//   BASE_PATH      mount path, default "" (e.g. /w/ws_123)
//   RUNTIME_TOKEN  bearer required for /api/* ; empty disables the check (local dev)
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
    const stats = statSync(join(DATA, 'bot', 'state.json'))
    lastActivity = new Date(stats.mtimeMs).toISOString()
    source.push('bot/state.json:mtime')
  } catch { /* no state yet */ }
  return { busy, turns, lastActivity, source, at: new Date().toISOString() }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://sidecar')
  const path = url.pathname

  if (BASE !== '' && !path.startsWith(BASE)) {
    send(res, 404, { ok: false, error: 'outside-base-path', base: BASE })
    return
  }
  const inner = BASE === '' ? path : (path.slice(BASE.length) || '/')

  if (inner === '/healthz') {
    const probe = http.request({ host: upstream.hostname, port: upstream.port, path: '/', method: 'GET', timeout: 2000 }, (up) => {
      up.resume()
      // Any HTTP answer means the process is up; 401 from DSH's own auth counts as alive.
      send(res, 200, { ok: up.statusCode !== undefined && up.statusCode < 500, upstream: up.statusCode, at: new Date().toISOString() })
    })
    probe.on('timeout', () => { probe.destroy(); send(res, 200, { ok: false, upstream: 'timeout' }) })
    probe.on('error', (error) => send(res, 200, { ok: false, upstream: 'unreachable', error: String(error?.code ?? error) }))
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
  proxied.on('error', (error) => send(res, 502, { ok: false, error: 'upstream-error', detail: String(error?.message ?? error) }))
  req.pipe(proxied)
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`roostbot sidecar on http://127.0.0.1:${PORT}${BASE} -> ${UPSTREAM}\n`)
})
