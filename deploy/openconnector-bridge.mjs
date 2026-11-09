#!/usr/bin/env node
// Roost <-> OOMOL OpenConnector bridge.
//
// Roost's connector adapter expects a small custom contract:
//   GET  /connectors
//   POST /authorize  {slug, workspaceId, state}
//   GET  /status?slug=&workspaceId=
//   POST /call       {slug, action, args, idem}
// OOMOL OpenConnector exposes /v1/providers, /v1/actions, /v1/connections/*. This bridge maps
// between them and keeps the OpenConnector admin/runtime tokens on this host.
//
// Required env:
//   BRIDGE_TOKEN, OPENCONNECTOR_BASE, OPENCONNECTOR_ADMIN_TOKEN, OPENCONNECTOR_RUNTIME_TOKEN,
//   ROOST_PUBLIC_BASE. Optional: BRIDGE_PORT (3011), CATALOG_SERVICES, CATALOG_TTL_MS.

import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

const PORT = Number(process.env['BRIDGE_PORT'] ?? 3011)
const BASE = (process.env['OPENCONNECTOR_BASE'] ?? 'http://127.0.0.1:3010').replace(/\/+$/, '')
const ADMIN = process.env['OPENCONNECTOR_ADMIN_TOKEN'] ?? ''
const RUNTIME = process.env['OPENCONNECTOR_RUNTIME_TOKEN'] ?? ''
const BRIDGE_TOKEN = process.env['BRIDGE_TOKEN'] ?? ''
const ROOST_PUBLIC_BASE = (process.env['ROOST_PUBLIC_BASE'] ?? 'https://roostbots.com').replace(/\/+$/, '')
const CATALOG_TTL_MS = Number(process.env['CATALOG_TTL_MS'] ?? 10 * 60 * 1000)
const CATALOG_SERVICES = (process.env['CATALOG_SERVICES'] ?? [
  'github', 'gmail', 'googlesheets', 'googlecalendar', 'googledrive',
  'notion', 'slack', 'airtable', 'discord', 'telegram', 'linear', 'jira',
  'hackernews', 'arxiv'
].join(',')).split(',').map((s) => s.trim()).filter(Boolean)
const ACTIONS_PER_CONNECTOR = 60
const NO_AUTH = new Set(['hackernews', 'arxiv', 'appledb', 'allratestoday'])

if (BRIDGE_TOKEN === '' || ADMIN === '' || RUNTIME === '') {
  console.error('openconnector-bridge: BRIDGE_TOKEN, OPENCONNECTOR_ADMIN_TOKEN and OPENCONNECTOR_RUNTIME_TOKEN are required')
  process.exit(1)
}

function bearer(req) {
  const raw = req.headers['authorization']
  return typeof raw === 'string' && raw.startsWith('Bearer ') ? raw.slice(7).trim() : ''
}

function authorized(req) {
  const got = bearer(req)
  if (got === '' || got.length !== BRIDGE_TOKEN.length) return false
  return timingSafeEqual(Buffer.from(got), Buffer.from(BRIDGE_TOKEN))
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

async function gateway(path, { method = 'GET', token = RUNTIME, body, headers: extraHeaders } = {}) {
  const headers = { authorization: `Bearer ${token}`, ...(extraHeaders ?? {}) }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  })
  const text = await response.text()
  let data
  try { data = text === '' ? null : JSON.parse(text) } catch { data = { message: text.slice(0, 500) } }
  if (!response.ok) {
    const message = (data && (data.message || data.error)) || `OpenConnector HTTP ${response.status}`
    throw new Error(message)
  }
  if (data && data.success === false) {
    throw new Error(String(data.message || data.errorCode || 'OpenConnector request failed'))
  }
  return data && Object.prototype.hasOwnProperty.call(data, 'data') ? data.data : data
}

let catalogCache = { at: 0, value: null }
async function loadCatalog() {
  if (catalogCache.value !== null && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value
  const providers = await gateway('/v1/providers')
  const byService = new Map((Array.isArray(providers) ? providers : []).map((p) => [p.service, p]))
  const selected = CATALOG_SERVICES.map((service) => byService.get(service)).filter(Boolean)
  const rows = await Promise.all(selected.map(async (provider) => {
    const actions = await gateway(`/v1/actions?service=${encodeURIComponent(provider.service)}`)
    const names = (Array.isArray(actions) ? actions : [])
      .map((action) => action && ({ name: action.name, access: action.operationType === 'write' ? 'write' : 'read' }))
      .filter((action) => action && typeof action.name === 'string' && action.name !== '')
      .slice(0, ACTIONS_PER_CONNECTOR)
    return {
      slug: provider.service,
      title: typeof provider.displayName === 'string' && provider.displayName !== '' ? provider.displayName : provider.service,
      actions: names
    }
  }))
  catalogCache = { at: Date.now(), value: rows.filter((row) => row.actions.length > 0) }
  return catalogCache.value
}

async function statusFor(slug, connectionName = '') {
  if (NO_AUTH.has(slug)) return 'connected'
  const connections = await gateway('/v1/connections', { token: ADMIN })
  const match = (Array.isArray(connections) ? connections : []).find((item) =>
    item && item.service === slug && (connectionName === '' || item.alias === connectionName || item.connectionName === connectionName))
  if (!match) return 'revoked'
  if (match.status === 'active') return 'connected'
  if (match.status === 'expired') return 'expired'
  return 'revoked'
}

async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1_000_000) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

async function proxyOAuthCallback(req, res, url) {
  // OpenConnector's browser callback is unauthenticated (state is validated by
  // the gateway). Keep it on the same public origin as Roost so the provider
  // OAuth app only needs one callback URL.
  const target = `${BASE}/oauth/callback${url.search}`
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name === 'host' || name === 'authorization' || name === 'content-length') continue
    headers[name] = Array.isArray(value) ? value.join(',') : value
  }
  let body
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    body = Buffer.concat(chunks)
    headers['content-length'] = String(body.length)
  }
  const response = await fetch(target, {
    method: req.method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000)
  })
  const responseHeaders = {}
  for (const name of ['location', 'content-type', 'cache-control', 'set-cookie']) {
    const value = response.headers.get(name)
    if (value !== null) responseHeaders[name] = value
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  res.writeHead(response.status, responseHeaders)
  res.end(buffer)
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://bridge.local')
    if (url.pathname === '/health') return json(res, 200, { ok: true })
    if (url.pathname === '/oauth/callback' && (req.method === 'GET' || req.method === 'POST')) {
      return await proxyOAuthCallback(req, res, url)
    }
    if (!authorized(req)) return json(res, 401, { error: 'unauthorized' })

    if (url.pathname === '/connectors' && req.method === 'GET') {
      return json(res, 200, await loadCatalog())
    }

    if (url.pathname === '/authorize' && req.method === 'POST') {
      const body = await readBody(req)
      const slug = typeof body.slug === 'string' ? body.slug.trim() : ''
      const state = typeof body.state === 'string' ? body.state.trim() : ''
      const connectionName = typeof body.connectionName === 'string' ? body.connectionName.trim() : ''
      if (slug === '') return json(res, 400, { error: 'slug is required' })
      if (NO_AUTH.has(slug)) {
        const callback = `${ROOST_PUBLIC_BASE}/api/connectors/callback/${encodeURIComponent(slug)}?state=${encodeURIComponent(state)}&status=connected`
        return json(res, 200, { url: callback })
      }
      const returnUri = `${ROOST_PUBLIC_BASE}/api/connectors/callback/${encodeURIComponent(slug)}?state=${encodeURIComponent(state)}&status=connected`
      const data = await gateway('/api/oauth/connection-requests', {
        method: 'POST',
        token: ADMIN,
        body: { service: slug, returnUri, ...(connectionName === '' ? {} : { connectionName }) }
      })
      const urlValue = data && (data.authorizationUrl || data.url || data.redirectUrl)
      if (typeof urlValue !== 'string' || urlValue === '') {
        return json(res, 502, { error: 'OpenConnector did not return an authorization URL' })
      }
      return json(res, 200, { url: urlValue })
    }

    if (url.pathname === '/status' && req.method === 'GET') {
      const slug = (url.searchParams.get('slug') ?? '').trim()
      const connectionName = (url.searchParams.get('connectionName') ?? '').trim()
      if (slug === '') return json(res, 400, { error: 'slug is required' })
      return json(res, 200, { status: await statusFor(slug, connectionName) })
    }

    if (url.pathname === '/call' && req.method === 'POST') {
      const body = await readBody(req)
      const slug = typeof body.slug === 'string' ? body.slug.trim() : ''
      const action = typeof body.action === 'string' ? body.action.trim() : ''
      if (slug === '' || action === '') return json(res, 400, { error: 'slug and action are required' })
      const idem = typeof body.idem === 'string' ? body.idem : ''
      const connectionName = typeof body.connectionName === 'string' ? body.connectionName.trim() : ''
      const extraHeaders = {
        ...(idem === '' ? {} : { 'Idempotency-Key': idem }),
        ...(connectionName === '' ? {} : { 'x-oo-connector-alias': connectionName })
      }
      const result = await gateway(`/v1/actions/${encodeURIComponent(slug)}.${encodeURIComponent(action)}`, {
        method: 'POST',
        body: { input: body.args ?? {} },
        ...(Object.keys(extraHeaders).length === 0 ? {} : { headers: extraHeaders })
      })
      return json(res, 200, { ok: true, result })
    }

    return json(res, 404, { error: 'not found' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const status = /administrator bearer token|unauthorized/i.test(message) ? 502 : 502
    return json(res, status, { error: message.slice(0, 500) })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : PORT
  console.log(`openconnector-bridge listening on :${actualPort}`)
})
