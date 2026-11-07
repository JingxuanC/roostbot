#!/usr/bin/env node
// Local real-runtime three-room E2E: DSH + Claude Code + Codex in one Roost room with real DeepSeek.
//
// Usage:
//   . ~/roost-local-agents/env.sh
//   ROOST_DSH_BIN=... ROOST_CLAUDE_BIN=~/roost-local-agents/bin/claude \
//     ROOST_CODEX_BIN=~/roost-local-agents/bin/codex-acp \
//     node --experimental-strip-types scripts/local-three-room-e2e.mjs
//
// Usage:
//   . ~/roost-local-agents/env.sh
//   ROOST_DSH_BIN=... ROOST_CLAUDE_BIN=~/roost-local-agents/bin/claude \
//     ROOST_CODEX_BIN=~/roost-local-agents/bin/codex-acp \
//     node --experimental-strip-types scripts/local-pair-room-e2e.mjs
//
// Usage:
//   . ~/roost-local-agents/env.sh
//   ROOST_DSH_BIN=... ROOST_CLAUDE_BIN=~/roost-local-agents/bin/claude \
//     ROOST_AGENT_RUNTIME=claude-code ROOST_E2E_EXPECT=LOCAL_CLAUDE_OK \
//     node --experimental-strip-types scripts/local-real-e2e.mjs
//
// For Codex use ROOST_AGENT_RUNTIME=codex and ROOST_CODEX_BIN=~/roost-local-agents/bin/codex-acp.
// Requires DEEPSEEK_API_KEY and a local DSH 0.2.1-rc.5.
//
// This is a development smoke test, not a production runtime. It creates a temp
// SQLite DB, a temp workspace, pairs a throwaway account, grants test credits and
// drives one real room turn through the local process runtime.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = process.cwd()
const DSH = (process.env.ROOST_DSH_BIN ?? '').trim()
const apiPort = Number(process.env.ROOST_E2E_PORT ?? 8811)
const root = mkdtempSync(join(tmpdir(), 'roost-local-e2e-'))
let api = null

const CLAUDE = (process.env.ROOST_CLAUDE_BIN ?? '').trim()
if (DSH === '' || CLAUDE === '' || (process.env.DEEPSEEK_API_KEY ?? '') === '') {
  console.error('ROOST_DSH_BIN, ROOST_CLAUDE_BIN and DEEPSEEK_API_KEY are required')
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
  const env = {
    ...process.env,
    PORT: String(apiPort),
    ROOST_HOST: '127.0.0.1',
    ROOST_DB: join(root, 'roost.db'),
    ROOST_DSH_PROXY_PORT: '0',
    ROOST_SANDBOX: 'local',
    ROOST_DSH_BIN: DSH,
    ROOST_LOCAL_WORKSPACE_DIR: join(root, 'workspaces'),
    ROOST_MODEL_API_KEY: process.env.DEEPSEEK_API_KEY ?? '',
    ROOST_MODEL_UPSTREAM_BASE: 'https://api.deepseek.com',
    ROOST_FREE_MODEL: 'deepseek-chat',
    ROOST_DSH_MODEL: 'deepseek-chat',
    ROOST_MULTI_RUNTIME: '1',
    ROOST_CLAUDE_BIN: CLAUDE,
    ROOST_CODEX_BIN: (process.env.ROOST_CODEX_BIN ?? process.env.HOME + '/roost-local-agents/bin/codex-acp')
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

  // Both bots get a DM + kickoff round; let those settle before the group room.
  const specs = [
    { name: 'ClaudeBot', runtimeKind: 'claude-code', token: 'CLAUDE_ROOM_OK' },
    { name: 'CodexBot', runtimeKind: 'codex', token: 'CODEX_ROOM_OK' },
    { name: 'DshBot', runtimeKind: 'dsh', token: 'DSH_ROOM_OK' }
  ]
  const bots = []
  for (const spec of specs) {
    const created = await call('/api/bots', { method: 'POST', body: { workspaceId, name: spec.name, model: 'deepseek-chat', runtimeKind: spec.runtimeKind }, token })
    if (created.status !== 201) throw new Error(`bot ${spec.name} failed: ${created.status} ${JSON.stringify(created.json)}`)
    bots.push({ ...spec, id: created.json.bot?.id })
    console.log('bot', spec.name, created.json.bot?.id)
  }
  await sleep(4000)
  const roomRes = await call('/api/rooms', { method: 'POST', body: { workspaceId, name: 'PairRoom', memberBotIds: bots.map((bot) => bot.id) }, token })
  if (roomRes.status !== 201) throw new Error(`room failed: ${roomRes.status} ${JSON.stringify(roomRes.json)}`)
  const room = roomRes.json.room ?? roomRes.json
  console.log('room', room.id, (room.members ?? []).map((member) => member.name ?? member.botId))
  const patched = await call(`/api/rooms/${encodeURIComponent(room.id)}`, { method: 'PATCH', body: { responder: { kind: 'mentions' } }, token })
  if (patched.status !== 200) throw new Error(`responder patch failed: ${patched.status} ${JSON.stringify(patched.json)}`)
  console.log('responder', JSON.stringify(patched.json.room?.responder))
  const sent = await call(`/api/rooms/${encodeURIComponent(room.id)}/messages`, { method: 'POST', body: { text: '@ClaudeBot 只回复 CLAUDE_ROOM_OK；@CodexBot 只回复 CODEX_ROOM_OK；@DshBot 只回复 DSH_ROOM_OK' }, token })
  if (sent.status !== 201) throw new Error(`send failed: ${sent.status} ${JSON.stringify(sent.json)}`)
  let messages = []
  for (let i = 0; i < 180; i++) {
    await sleep(500)
    const response = await call(`/api/rooms/${encodeURIComponent(room.id)}/messages`, { token })
    messages = response.json?.messages ?? []
    const gotClaude = messages.some((message) => message.actor?.kind === 'bot' && message.text?.includes('CLAUDE_ROOM_OK'))
    const gotCodex = messages.some((message) => message.actor?.kind === 'bot' && message.text?.includes('CODEX_ROOM_OK'))
    const gotDsh = messages.some((message) => message.actor?.kind === 'bot' && message.text?.includes('DSH_ROOM_OK'))
    if (gotClaude && gotCodex && gotDsh) break
  }
  console.log('MESSAGES', JSON.stringify(messages).slice(0, 2500))
  const gotClaude = messages.some((message) => message.actor?.kind === 'bot' && message.text?.includes('CLAUDE_ROOM_OK'))
  const gotCodex = messages.some((message) => message.actor?.kind === 'bot' && message.text?.includes('CODEX_ROOM_OK'))
  const gotDsh = messages.some((message) => message.actor?.kind === 'bot' && message.text?.includes('DSH_ROOM_OK'))
  if (!gotClaude || !gotCodex || !gotDsh) {
    console.error('ROOM FAILED', { gotClaude, gotCodex, gotDsh })
    console.error(apiLog.split('\n').filter((line) => line.includes('[local:') || /error|failed/i.test(line)).slice(-40).join('\n'))
    process.exitCode = 2
    return
  }
  console.log('THREE_ROOM_OK', { gotClaude, gotCodex, gotDsh })
}

try {
  await main()
} catch (error) {
  console.error('E2E_FAIL', error)
  process.exitCode = 1
} finally {
  try { api?.kill('SIGTERM') } catch {}

  await sleep(300)
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}
