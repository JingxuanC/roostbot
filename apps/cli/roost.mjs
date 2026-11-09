#!/usr/bin/env node
// roost CLI + roostd（P0）。
//
//   roost login --token <sessionToken> [--server URL]   # token: browser localStorage roost.sessionToken
//   roost setup [--token ...] [--name "MacBook Pro"] [--no-daemon]
//   roost computer list
//   roost bind <workspaceId> --bot <botId> --agent claude-code --path ./project
//   roost daemon start|stop|status|logs|run
//   roost status
//
// 本地 binding 的 workdir 只存在 ~/.roost/config.json，不上传云端。

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, chmodSync, renameSync, unlinkSync } from 'node:fs'
import { homedir, hostname, platform, arch, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_SERVER = 'http://127.0.0.1:8787'
const CONFIG_VERSION = 1
const DEFAULT_AGENT_COMMANDS = {
  'claude-code': ['claude', '--print'],
  codex: ['codex', 'exec'],
  'grok-build': ['grok', '-p'],
  dsh: ['dsh', 'exec'],
}

export function roostHome() {
  return (process.env.ROOST_HOME || join(homedir(), '.roost')).trim()
}

function configPath() {
  return join(roostHome(), 'config.json')
}

export function readConfig() {
  const path = configPath()
  if (!existsSync(path)) return { version: CONFIG_VERSION, bindings: {}, agentCommands: {} }
  try {
    return { version: CONFIG_VERSION, bindings: {}, agentCommands: {}, ...JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function writeConfig(config) {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...config, version: CONFIG_VERSION }, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
  try { chmodSync(path, 0o600) } catch {}
}

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break }
    if (arg.startsWith('--')) {
      const body = arg.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { flags[body] = next; i += 1 } else flags[body] = true
      continue
    }
    positional.push(arg)
  }
  return { positional, flags }
}

function serverUrl(flags, config) {
  return String(flags.server || process.env.ROOST_API || config.serverUrl || DEFAULT_SERVER).replace(/\/+$/, '')
}

function tokenOf(flags, config) {
  return String(flags.token || process.env.ROOST_SESSION_TOKEN || config.sessionToken || '').trim()
}

async function request(config, flags, method, path, body, token, signal) {
  const base = serverUrl(flags, config)
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  })
  const text = await response.text().catch(() => '')
  let json = null
  try { json = text === '' ? null : JSON.parse(text) } catch { json = { raw: text } }
  if (!response.ok) {
    const message = json && json.error && typeof json.error.message === 'string' ? json.error.message : `HTTP ${response.status}`
    const error = new Error(message)
    error.status = response.status
    error.body = json
    throw error
  }
  return json
}

function fingerprint() {
  try {
    return createHash('sha256').update(`${hostname()}:${userInfo().username}:${platform()}:${arch()}`).digest('hex').slice(0, 32)
  } catch {
    return createHash('sha256').update(`${hostname()}:${platform()}:${arch()}`).digest('hex').slice(0, 32)
  }
}

function computerName(flags) {
  return String(flags.name || process.env.ROOST_COMPUTER_NAME || hostname() || 'roost computer').slice(0, 80)
}

function pidPath() {
  return join(roostHome(), 'daemon.pid')
}

function logPath() {
  return join(roostHome(), 'daemon.log')
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function daemonPid() {
  try {
    const raw = readFileSync(pidPath(), 'utf8').trim()
    return Number(raw)
  } catch { return 0 }
}

async function login(flags) {
  const token = tokenOf(flags, readConfig())
  if (token === '') throw new Error('需要 --token <sessionToken>（浏览器 localStorage 的 roost.sessionToken）或 ROOST_SESSION_TOKEN')
  const config = readConfig()
  config.sessionToken = token
  config.serverUrl = serverUrl(flags, config)
  writeConfig(config)
  console.log(`logged in: ${config.serverUrl}`)
}

async function registerComputer(flags, config, existing) {
  const computer = existing || null
  if (computer && computer.id && computer.token) return computer
  const payload = {
    name: computerName(flags),
    os: platform(),
    arch: arch(),
    fingerprint: fingerprint(),
    version: '0.1.0',
    capabilities: {},
  }
  const created = await request(config, flags, 'POST', '/api/computers', payload, tokenOf(flags, config))
  const value = { id: created.computer.id, token: created.token, name: created.computer.name }
  config.computer = value
  writeConfig(config)
  console.log(`computer registered: ${value.id} (${value.name})`)
  return value
}

async function setup(flags) {
  const config = readConfig()
  if (tokenOf(flags, config) === '') throw new Error('先执行 roost login --token ...')
  config.sessionToken = tokenOf(flags, config)
  config.serverUrl = serverUrl(flags, config)
  writeConfig(config)
  await registerComputer(flags, config, config.computer)
  if (flags['no-daemon'] !== true) await daemonStart(flags)
  if (flags.autostart === true) autostartCommand(flags, ['enable'])
}

async function computerList(flags) {
  const config = readConfig()
  const result = await request(config, flags, 'GET', '/api/computers', undefined, tokenOf(flags, config))
  const computers = Array.isArray(result.computers) ? result.computers : []
  if (flags.json) { console.log(JSON.stringify(computers, null, 2)); return }
  if (computers.length === 0) { console.log('no computers'); return }
  for (const computer of computers) {
    console.log(`${computer.id}\t${computer.status}\t${computer.name}\t${computer.lastSeenAt ? new Date(computer.lastSeenAt).toISOString() : ''}`)
  }
}

async function bind(flags, positional) {
  const workspaceId = positional[0]
  const botId = String(flags.bot || '')
  const agent = String(flags.agent || 'claude-code')
  const dir = resolve(String(flags.path || process.cwd()))
  if (!workspaceId || !botId) throw new Error('usage: roost bind <workspaceId> --bot <botId> --agent <kind> --path <dir>')
  const config = readConfig()
  const computer = await registerComputer(flags, config, config.computer)
  const label = String(flags.label || dir.split('/').filter(Boolean).pop() || 'project').slice(0, 80)
  const result = await request(config, flags, 'POST', `/api/workspaces/${encodeURIComponent(workspaceId)}/computer-bindings`, {
    computerId: computer.id,
    botId,
    agentKind: agent,
    workdirLabel: label,
  }, tokenOf(flags, config))
  const binding = result.binding
  config.bindings = { ...(config.bindings || {}), [binding.id]: { workspaceId, botId, agentKind: agent, workdir: dir } }
  writeConfig(config)
  console.log(`bound ${binding.id}: ${botId} -> ${dir}`)
}

async function bindingsList(flags) {
  const config = readConfig()
  const entries = Object.entries(config.bindings || {})
  if (flags.json) { console.log(JSON.stringify(Object.fromEntries(entries), null, 2)); return }
  for (const [id, value] of entries) console.log(`${id}\t${value.botId}\t${value.agentKind}\t${value.workdir}`)
}

function agentCommand(config, agentKind) {
  const configured = config.agentCommands && Array.isArray(config.agentCommands[agentKind]) ? config.agentCommands[agentKind] : null
  const command = configured || DEFAULT_AGENT_COMMANDS[agentKind]
  if (!Array.isArray(command) || command.length === 0) throw new Error(`no local command configured for agent ${agentKind}`)
  return command
}

function findExecutable(binary) {
  if (binary.includes('/') || binary.includes('\\')) {
    const absolute = resolve(binary)
    return existsSync(absolute) ? absolute : null
  }
  const finder = platform() === 'win32' ? 'where' : 'which'
  const found = spawnSync(finder, [binary], { encoding: 'utf8', timeout: 3000 })
  if (found.status !== 0) return null
  const first = String(found.stdout || '').split(/\r?\n/).find((line) => line.trim() !== '')
  return first === undefined ? null : first.trim()
}

function discoverAgents(config) {
  const result = []
  for (const kind of Object.keys(DEFAULT_AGENT_COMMANDS)) {
    let entry
    try { entry = agentCommand(config, kind) } catch { continue }
    const binary = findExecutable(entry[0])
    let version = ''
    if (binary !== null) {
      const probe = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 4000 })
      version = String(probe.stdout || probe.stderr || '').trim().split(/\r?\n/)[0]?.slice(0, 120) ?? ''
    }
    result.push({ kind, command: entry, binary: binary || entry[0], installed: binary !== null, version })
  }
  return result
}

function shellWords(text) {
  const words = []
  let current = ''
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== '') {
      if (ch === quote) quote = ''
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) current += text[++i]
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (/\s/.test(ch)) { if (current !== '') { words.push(current); current = '' }; continue }
    current += ch
  }
  if (current !== '') words.push(current)
  return words
}

function agentsCommand(flags, positional) {
  const config = readConfig()
  const sub = positional[0]
  if (sub === 'set') {
    const kind = positional[1]
    const command = typeof flags.command === 'string' ? shellWords(flags.command) : []
    if (kind === undefined || command.length === 0) throw new Error('usage: roost agent set <kind> --command "claude --print"')
    config.agentCommands = { ...(config.agentCommands || {}), [kind]: command }
    writeConfig(config)
    console.log(`${kind}: ${command.join(' ')}`)
    return
  }
  const agents = discoverAgents(config)
  if (flags.json) { console.log(JSON.stringify(agents, null, 2)); return }
  for (const agent of agents) {
    console.log(`${agent.installed ? 'ok ' : '-- '}${agent.kind}\t${agent.installed ? agent.binary : 'not found'}\t${agent.version || ''}`)
  }
}

function plistEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function autostartInfo() {
  const node = process.execPath
  const cli = resolve(process.argv[1])
  const home = roostHome()
  if (platform() === 'darwin') {
    const path = join(homedir(), 'Library', 'LaunchAgents', 'com.roost.daemon.plist')
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.roost.daemon</string>
  <key>ProgramArguments</key><array><string>${plistEscape(node)}</string><string>${plistEscape(cli)}</string><string>daemon</string><string>run</string></array>
  <key>EnvironmentVariables</key><dict><key>ROOST_HOME</key><string>${plistEscape(home)}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${plistEscape(join(home, 'daemon.log'))}</string>
  <key>StandardErrorPath</key><string>${plistEscape(join(home, 'daemon.log'))}</string>
</dict></plist>
`
    return { platform: 'launchd', path, content: plist, enable: ['launchctl', ['load', '-w', path]], disable: ['launchctl', ['unload', '-w', path]] }
  }
  if (platform() === 'linux') {
    const path = join(homedir(), '.config', 'systemd', 'user', 'roost.service')
    const content = `[Unit]
Description=Roost local computer daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${node} ${cli} daemon run
Environment=ROOST_HOME=${home}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`
    return { platform: 'systemd', path, content, enable: ['systemctl', ['--user', 'enable', '--now', 'roost.service']], disable: ['systemctl', ['--user', 'disable', '--now', 'roost.service']] }
  }
  const path = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'roost.cmd')
  const content = `@echo off
set ROOST_HOME=${home}
"${node}" "${cli}" daemon run
`
  return { platform: 'windows-startup', path, content, enable: null, disable: null }
}

function autostartCommand(flags, positional) {
  const action = positional[0] || 'status'
  const info = autostartInfo()
  if (action === 'status') {
    console.log(`${info.platform}\t${existsSync(info.path) ? 'installed' : 'not installed'}\t${info.path}`)
    return
  }
  if (action === 'enable') {
    mkdirSync(dirname(info.path), { recursive: true, mode: 0o700 })
    writeFileSync(info.path, info.content, { mode: 0o600 })
    if (info.enable) {
      const result = spawnSync(info.enable[0], info.enable[1], { encoding: 'utf8', timeout: 15000 })
      if (result.status !== 0) throw new Error(`autostart enable failed: ${(result.stderr || result.stdout || '').trim()}`)
    }
    console.log(`autostart enabled: ${info.platform} ${info.path}`)
    return
  }
  if (action === 'disable') {
    if (info.disable) spawnSync(info.disable[0], info.disable[1], { encoding: 'utf8', timeout: 15000 })
    if (existsSync(info.path)) unlinkSync(info.path)
    console.log('autostart disabled')
    return
  }
  throw new Error('usage: roost daemon autostart enable|disable|status')
}

function runAgent(command, prompt, cwd, timeoutMs = 240_000, onStdout = () => {}) {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(command[0], [...command.slice(1), prompt], {
        cwd,
        env: { ...process.env, ROOST_LOCAL_AGENT: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({ code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(result)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch {}
      setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 2000).unref?.()
      finish({ code: 124, stdout, stderr: `${stderr}\nagent timeout` })
    }, Math.max(1000, timeoutMs))
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk)
      stdout = (stdout + text).slice(-1_000_000)
      try { onStdout(text) } catch {}
    })
    child.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-200_000) })
    child.once('error', (error) => finish({ code: -1, stdout, stderr: error.message }))
    child.once('close', (code) => finish({ code: code ?? -1, stdout, stderr }))
  })
}

async function postHeartbeat(config, flags, body, signal) {
  if (!config.computer) return
  try {
    await request(config, flags, 'POST', `/api/computers/${encodeURIComponent(config.computer.id)}/heartbeat`, body, config.computer.token, signal)
  } catch (error) {
    console.error(`[roostd] heartbeat failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function runJob(config, flags, job) {
  const local = config.bindings && config.bindings[job.bindingId]
  let result
  if (!local) {
    result = { kind: 'failed', code: 'binding_not_local', message: `binding ${job.bindingId} is not configured on this computer` }
  } else {
    const agentKind = job.payload?.binding?.agentKind || local.agentKind || 'claude-code'
    let command
    try { command = agentCommand(config, agentKind) } catch (error) {
      result = { kind: 'failed', code: 'agent_unconfigured', message: error instanceof Error ? error.message : String(error) }
    }
    if (command) {
      let deltaChain = Promise.resolve()
      const postDelta = (delta) => {
        deltaChain = deltaChain.then(async () => {
          try {
            await request(config, flags, 'POST', `/api/computers/${encodeURIComponent(config.computer.id)}/jobs/${encodeURIComponent(job.id)}/events`, { delta: delta.slice(0, 8000) }, config.computer.token)
          } catch { /* final result is still authoritative */ }
        })
      }
      const ran = await runAgent(command, String(job.payload?.prompt || ''), local.workdir, 240_000, postDelta)
      await deltaChain
      if (ran.code === 0 && ran.stdout.trim() !== '') result = { kind: 'posted', text: ran.stdout.trim() }
      else result = { kind: 'failed', code: 'agent_exit', message: (ran.stderr || ran.stdout || `agent exited ${ran.code}`).trim().slice(0, 2000) }
    }
  }
  try {
    await request(config, flags, 'POST', `/api/computers/${encodeURIComponent(config.computer.id)}/jobs/${encodeURIComponent(job.id)}/result`, { result }, config.computer.token)
    console.log(`[roostd] job ${job.id} -> ${result.kind}`)
  } catch (error) {
    console.error(`[roostd] result failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function daemonRun(flags) {
  let config = readConfig()
  if (!config.computer || typeof config.computer.token !== 'string') throw new Error('computer not registered; run roost setup')
  const base = serverUrl(flags, config)
  config.serverUrl = base
  const log = (message) => console.log(`${new Date().toISOString()} ${message}`)
  log(`roostd started for ${config.computer.id} (${base})`)
  const agents = discoverAgents(config)
  log(`local agents: ${agents.map((agent) => `${agent.kind}${agent.installed ? '' : '(missing)'}`).join(', ')}`)
  let heartbeatAt = 0
  let stopped = false
  const abort = new AbortController()
  const stop = () => { stopped = true; abort.abort(); log('stopping') }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  while (!stopped) {
    // Pick up a binding added while the daemon was already installed.
    config = { ...readConfig(), serverUrl: base }
    if (Object.keys(config.bindings || {}).length === 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000))
      continue
    }
    if (heartbeatAt === 0 || Date.now() - heartbeatAt > 25_000) {
      heartbeatAt = Date.now()
      await postHeartbeat(config, flags, { version: '0.1.0', capabilities: { agents } }, abort.signal)
    }
    try {
      const result = await request(config, flags, 'GET', `/api/computers/${encodeURIComponent(config.computer.id)}/jobs?wait=20`, undefined, config.computer.token, abort.signal)
      const job = result && result.job
      if (job) {
        log(`job ${job.id} ${job.roomId}`)
        const claimed = await request(config, flags, 'POST', `/api/computers/${encodeURIComponent(config.computer.id)}/jobs/${encodeURIComponent(job.id)}/claim`, undefined, config.computer.token, abort.signal)
        const active = claimed.job || job
        await runJob(config, flags, active)
      }
    } catch (error) {
      if (stopped) break
      log(`poll failed: ${error instanceof Error ? error.message : String(error)}`)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000))
    }
  }
  log('roostd stopped')
}

async function daemonStart(flags) {
  const config = readConfig()
  if (!config.computer || typeof config.computer.token !== 'string') throw new Error('computer not registered; run roost setup')
  const existing = daemonPid()
  if (isPidAlive(existing)) { console.log(`daemon already running (pid ${existing})`); return }
  mkdirSync(roostHome(), { recursive: true, mode: 0o700 })
  const fd = openSync(logPath(), 'a', 0o600)
  let child
  try {
    child = spawn(process.execPath, [process.argv[1], 'daemon', 'run'], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, ROOST_HOME: roostHome() },
    })
  } finally {
    closeSync(fd)
  }
  child.unref()
  writeFileSync(pidPath(), `${child.pid}\n`, { mode: 0o600 })
  console.log(`daemon started (pid ${child.pid}), log ${logPath()}`)
}

async function daemonStop() {
  const pid = daemonPid()
  if (!isPidAlive(pid)) { console.log('daemon not running'); try { unlinkSync(pidPath()) } catch {}; return }
  process.kill(pid, 'SIGTERM')
  console.log(`stopping daemon ${pid}`)
  try { unlinkSync(pidPath()) } catch {}
}

async function daemonStatus() {
  const pid = daemonPid()
  if (isPidAlive(pid)) console.log(`running pid=${pid}`)
  else console.log('not running')
}

function daemonLogs(flags) {
  const path = logPath()
  if (!existsSync(path)) { console.log(`no log at ${path}`); return }
  const lines = readFileSync(path, 'utf8').split('\n')
  console.log(lines.slice(-Math.max(1, Number(flags.tail || 80))).join('\n'))
}

function usage() {
  console.log(`roost - local computer agent connector

  roost login --token <sessionToken> [--server URL]   # token: browser localStorage roost.sessionToken
  roost setup [--token <sessionToken>] [--name <name>] [--no-daemon] [--autostart]
  roost computer list [--json]
  roost bind <workspaceId> --bot <botId> --agent <kind> --path <dir> [--label <name>]
  roost bindings [--json]
  roost agent discover [--json]
  roost agent set <kind> --command "claude --print"
  roost daemon autostart enable|disable|status
  roost daemon start|stop|status|logs|run
  roost status

Env: ROOST_API, ROOST_HOME, ROOST_SESSION_TOKEN
`)
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv)
  const [command, sub] = positional
  if (command === undefined || command === 'help' || flags.help) { usage(); return }
  try {
    if (command === 'login') return await login(flags)
    if (command === 'setup') return await setup(flags)
    if (command === 'status') {
      const config = readConfig()
      console.log(JSON.stringify({ server: serverUrl(flags, config), computer: config.computer || null, bindings: config.bindings || {} }, null, 2))
      return
    }
    if (command === 'computer') {
      if (sub === 'list' || sub === undefined) return await computerList(flags)
      throw new Error(`unknown computer command ${sub}`)
    }
    if (command === 'bind') return await bind(flags, positional.slice(1))
    if (command === 'bindings') return await bindingsList(flags)
    if (command === 'agent') return agentsCommand(flags, positional.slice(1))
    if (command === 'daemon') {
      if (sub === 'start') return await daemonStart(flags)
      if (sub === 'stop') return await daemonStop()
      if (sub === 'status') return await daemonStatus()
      if (sub === 'logs') return daemonLogs(flags)
      if (sub === 'run') return await daemonRun(flags)
      if (sub === 'autostart') return autostartCommand(flags, positional.slice(2))
      throw new Error(`unknown daemon command ${sub || ''}`)
    }
    throw new Error(`unknown command ${command}`)
  } catch (error) {
    console.error(`roost: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
