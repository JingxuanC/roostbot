#!/usr/bin/env node
// Local multi-runtime E2E: control plane + local room-agent + Claude Code CLI + fake Anthropic upstream.
//
// Usage:
//   ROOST_DSH_BIN=/path/to/dsh-0.2.1-rc.5 \
//     ROOST_CLAUDE_BIN=/path/to/claude \
//     ROOST_DSH_BIN=/path/to/dsh-0.2.1-rc.5 \
//     node --experimental-strip-types scripts/local-multi-e2e.mjs
//
// This is a development smoke test, not a production runtime. It creates a temp
// SQLite DB, a temp workspace, pairs a throwaway account, grants test credits and
// drives one real room turn through the local process runtime.
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = process.cwd()
const DSH = (process.env.ROOST_DSH_BIN ?? '').trim()
const apiPort = Number(process.env.ROOST_E2E_PORT ?? 8811)
const upstreamPort = Number(process.env.ROOST_E2E_UPSTREAM_PORT ?? 9911)
const root = mkdtempSync(join(tmpdir(), 'roost-local-e2e-'))
let api = null
let upstream = null

const CLAUDE = (process.env.ROOST_CLAUDE_BIN ?? '').trim()
if (DSH === '' || CLAUDE === '') {
  console.error('ROOST_DSH_BIN and ROOST_CLAUDE_BIN are required')
  process.exit(2)
}
if (!process.execPath) throw new Error('process.execPath is missing')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await sleep(200)
  }
  throw new Error(`timeout waiting for ${url}`)
}

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = {}
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await response.text()
  let json = null
  try { json = text === '' ? null : JSON.parse(text) } catch { json = { raw: text } }
  return { status: response.status, json }
}

async function startFakeUpstream() {
  upstream = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch {}
      const text = '本地 Claude 收到'
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        send('message_start', { type: 'message_start', message: { id: 'msg_local', type: 'message', role: 'assistant', content: [], model: 'deepseek-flash', usage: { input_tokens: 3, output_tokens: 0 } } })
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })
        send('message_stop', { type: 'message_stop' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_local', type: 'message', role: 'assistant', content: [{ type: 'text', text }], model: 'deepseek-flash', stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 } }))
    })
  })
  await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve))
}

async function grantCredits(accountId) {
  const { openStore } = await import(join(REPO, 'packages/store/src/index.ts'))
  const { grantTokenCredit } = await import(join(REPO, 'packages/store/src/token-credits.ts'))
  const db = openStore(join(root, 'roost.db'))
  try {
    grantTokenCredit(db, { accountId, amount: 1_000_000, reason: 'local-e2e', idem: `local-e2e:${accountId}` })
  } finally {
    db.close()
  }
}

async function main() {
  await startFakeUpstream()
  const env = {
    ...process.env,
    PORT: String(apiPort),
    ROOST_HOST: '127.0.0.1',
    ROOST_DB: join(root, 'roost.db'),
    ROOST_DSH_PROXY_PORT: '0',
    ROOST_SANDBOX: 'local',
    ROOST_DSH_BIN: DSH,
    ROOST_LOCAL_WORKSPACE_DIR: join(root, 'workspaces'),
    ROOST_MODEL_API_KEY: 'fake-key',
    ROOST_MODEL_UPSTREAM_BASE: `http://127.0.0.1:${upstreamPort}`,
    ROOST_FREE_MODEL: 'deepseek-flash',
    ROOST_DSH_MODEL: 'deepseek-flash',
    ROOST_MULTI_RUNTIME: '1',
    ROOST_CLAUDE_BIN: CLAUDE,
    ANTHROPIC_API_KEY: 'fake',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`
  }
  api = spawn(process.execPath, ['--experimental-strip-types', 'apps/api/src/main.ts'], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let apiLog = ''
  api.stdout.on('data', (chunk) => { apiLog += String(chunk) })
  api.stderr.on('data', (chunk) => { apiLog += String(chunk) })
  try { await waitFor(`http://127.0.0.1:${apiPort}/healthz`) } catch (error) { console.error('API START LOG', apiLog.slice(-3000)); throw error }
  console.log('API ready')

  const account = `acc_local_${Date.now()}`
  const mint = await call('/api/pairing/code', { method: 'POST', body: { accountId: account } })
  if (mint.status !== 200) throw new Error(`mint failed: ${mint.status} ${JSON.stringify(mint.json)}`)
  const claim = await call('/api/pairing/claim', { method: 'POST', body: { code: mint.json.code } })
  if (claim.status !== 200) throw new Error(`claim failed: ${claim.status} ${JSON.stringify(claim.json)}`)
  const token = claim.json.sessionToken
  await grantCredits(account)

  const workspace = await call('/api/workspaces', { method: 'POST', body: { name: 'Local E2E' }, token })
  if (workspace.status !== 201) throw new Error(`workspace failed: ${workspace.status} ${JSON.stringify(workspace.json)}`)
  const workspaceId = workspace.json.workspace?.id ?? workspace.json.id
  // Start the runtime before creating the Bot so the DM kickoff round has a live reader.
  const started = await call(`/api/workspaces/${encodeURIComponent(workspaceId)}/start`, { method: 'POST', body: {}, token })
  if (started.status !== 200 && started.status !== 201) throw new Error(`start failed: ${started.status} ${JSON.stringify(started.json)}`)
  console.log('runtime', JSON.stringify(started.json.runtime))

  const bot = await call('/api/bots', { method: 'POST', body: { workspaceId, name: '本地 Claude Bot', model: 'deepseek-flash', runtimeKind: 'claude-code' }, token })
  if (bot.status !== 201) throw new Error(`bot failed: ${bot.status} ${JSON.stringify(bot.json)}`)
  const botId = bot.json.bot?.id
  const rooms = await call('/api/rooms', { token })
  const room = (rooms.json?.rooms ?? []).find((item) => Array.isArray(item.members) && item.members.some((member) => (member.botId ?? member) === botId))
  if (room === undefined) throw new Error(`no DM room: ${JSON.stringify(rooms.json)}`)

  const sent = await call(`/api/rooms/${encodeURIComponent(room.id)}/messages`, { method: 'POST', body: { text: '你好，本地测试' }, token })
  if (sent.status !== 201) throw new Error(`send failed: ${sent.status} ${JSON.stringify(sent.json)}`)
  let reply = null
  for (let i = 0; i < 120; i++) {
    await sleep(500)
    const messages = await call(`/api/rooms/${encodeURIComponent(room.id)}/messages`, { token })
    reply = (messages.json?.messages ?? []).find((message) => message.actor?.kind === 'bot' && typeof message.text === 'string' && message.text.includes('本地 Claude 收到'))
    if (reply !== undefined && reply !== null) break
  }
  if (reply === null || reply === undefined) {
    console.error('NO REPLY')
    const all = await call(`/api/rooms/${encodeURIComponent(room.id)}/messages`, { token })
    console.error('MESSAGES', JSON.stringify(all.json).slice(0, 3000))
    console.error(apiLog.split('\n').filter((line) => line.includes('[local:') || /error|failed/i.test(line)).slice(-30).join('\n'))
    process.exitCode = 2
    return
  }
  console.log('REPLY', JSON.stringify(reply).slice(0, 500))
}

try {
  await main()
} catch (error) {
  console.error('E2E_FAIL', error)
  process.exitCode = 1
} finally {
  try { api?.kill('SIGTERM') } catch {}
  try { upstream?.close() } catch {}
  await sleep(300)
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}
