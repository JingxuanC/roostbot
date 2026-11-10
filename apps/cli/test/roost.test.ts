import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { pairDevice, startSqliteHarness } from '../../api/test/helpers.ts'

const CLI = resolve(import.meta.dirname, '..', 'roost.mjs')

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }))
  })
}

test('roost CLI registers a computer, binds a Bot and roostd posts a local Agent reply', async () => {
  const harness = await startSqliteHarness()
  const home = mkdtempSync(join(tmpdir(), 'roost-cli-'))
  const project = mkdtempSync(join(tmpdir(), 'roost-project-'))
  const env = { ROOST_HOME: home, ROOST_API: harness.baseUrl }
  let daemon: ReturnType<typeof spawn> | null = null
  try {
    const token = await pairDevice(harness)
    const workspace = await harness.call('POST', '/api/workspaces', { token, body: { name: 'CLI local' } })
    const workspaceId = workspace.json.workspace.id as string
    const bot = await harness.call('POST', '/api/bots', {
      token,
      body: { workspaceId, name: 'CliBot', model: 'deepseek-chat', runtimeKind: 'claude-code' },
    })
    const botId = bot.json.bot.id as string
    const room = await harness.call('POST', '/api/rooms', { token, body: { workspaceId, name: 'CLI Room' } })
    const roomId = room.json.room.id as string
    await harness.call('POST', `/api/rooms/${roomId}/members`, { token, body: { botIds: [botId] } })

    const cliToken = await harness.call('POST', '/api/cli/tokens', { token, body: { label: 'cli-test' } })
    const login = await runCli(['login', '--token', cliToken.json.token], env)
    assert.equal(login.code, 0, login.stderr)
    const setup = await runCli(['setup', '--no-daemon'], env)
    assert.equal(setup.code, 0, setup.stderr)
    const configPath = join(home, 'config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    config.agentCommands = { 'claude-code': ['node', '-e', 'console.log("LOCAL_CLI_OK")'] }
    writeFileSync(configPath, JSON.stringify(config, null, 2))
    const bind = await runCli(['bind', workspaceId, '--bot', botId, '--agent', 'claude-code', '--path', project], env)
    assert.equal(bind.code, 0, bind.stderr)

    daemon = spawn(process.execPath, [CLI, 'daemon', 'run'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let daemonLog = ''
    daemon.stdout?.on('data', (chunk) => { daemonLog += String(chunk) })

    const message = await harness.call('POST', `/api/rooms/${roomId}/messages`, { token, body: { text: '本地 CLI 请回答' } })
    assert.equal(message.status, 201, message.text)

    let posted = false
    for (let i = 0; i < 25 && !posted; i += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
      const messages = await harness.call('GET', `/api/rooms/${roomId}/messages`, { token })
      posted = Array.isArray(messages.json.messages) && messages.json.messages.some((item: { text: string }) => item.text === 'LOCAL_CLI_OK')
    }
    assert.equal(posted, true, `local agent did not reply\n${daemonLog}`)
  } finally {
    if (daemon !== null) {
      const child = daemon
      const closed = new Promise<void>((resolvePromise) => child.once('close', () => resolvePromise()))
      child.kill('SIGTERM')
      const exited = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), 3000)),
      ])
      if (!exited) {
        child.kill('SIGKILL')
        await closed
      }
    }
    await harness.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test('roost CLI can discover agents and report autostart status', async () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-cli-p1-'))
  try {
    const env = { ROOST_HOME: home }
    const discover = await runCli(['agent', 'discover', '--json'], env)
    assert.equal(discover.code, 0, discover.stderr)
    const agents = JSON.parse(discover.stdout)
    assert.ok(Array.isArray(agents))
    assert.ok(agents.some((agent: { kind: string }) => agent.kind === 'claude-code'))
    const autostart = await runCli(['daemon', 'autostart', 'status'], env)
    assert.equal(autostart.code, 0, autostart.stderr)
    assert.match(autostart.stdout, /installed|not installed/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('roost mcp serve speaks MCP and exposes binding/inspection tools', async () => {
  const home = mkdtempSync(join(tmpdir(), 'roost-cli-mcp-'))
  const child = spawn(process.execPath, [CLI, 'mcp', 'serve'], {
    env: { ...process.env, ROOST_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  const messages: any[] = []
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk)
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line !== '') messages.push(JSON.parse(line))
    }
  })
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'roost_projects', arguments: {} } })}\n`)
    for (let i = 0; i < 30 && messages.length < 3; i += 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    assert.equal(messages.length >= 3, true, JSON.stringify(messages))
    const tools = messages.find((message) => message.id === 2)?.result?.tools ?? []
    const names = tools.map((tool: { name: string }) => tool.name)
    assert.ok(names.includes('roost_bind_bot'))
    assert.ok(names.includes('roost_list_jobs'))
    assert.ok(names.includes('roost_check_workspace'))
    const projects = messages.find((message) => message.id === 3)?.result?.content?.[0]?.text
    assert.deepEqual(JSON.parse(projects), [])
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolvePromise) => child.once('close', resolvePromise))
    rmSync(home, { recursive: true, force: true })
  }
})

test('a Web-created project binding runs on roostd without a local bind command', async () => {
  const harness = await startSqliteHarness()
  const home = mkdtempSync(join(tmpdir(), 'roost-cli-web-'))
  const project = mkdtempSync(join(tmpdir(), 'roost-web-project-'))
  const env = { ROOST_HOME: home, ROOST_API: harness.baseUrl }
  let daemon: ReturnType<typeof spawn> | null = null
  try {
    const token = await pairDevice(harness)
    const workspace = await harness.call('POST', '/api/workspaces', { token, body: { name: 'Web binding' } })
    const workspaceId = workspace.json.workspace.id as string
    const bot = await harness.call('POST', '/api/bots', {
      token,
      body: { workspaceId, name: 'WebBot', model: 'deepseek-chat', runtimeKind: 'claude-code' },
    })
    const botId = bot.json.bot.id as string
    const room = await harness.call('POST', '/api/rooms', { token, body: { workspaceId, name: 'Web Room' } })
    const roomId = room.json.room.id as string
    await harness.call('POST', `/api/rooms/${roomId}/members`, { token, body: { botIds: [botId] } })
    const cliToken = await harness.call('POST', '/api/cli/tokens', { token, body: { label: 'web-test' } })
    assert.equal((await runCli(['login', '--token', cliToken.json.token], env)).code, 0)
    assert.equal((await runCli(['setup', '--no-daemon'], env)).code, 0)
    const projectResult = await runCli(['project', 'add', project, '--label', 'web-project'], env)
    assert.equal(projectResult.code, 0, projectResult.stderr)
    const configPath = join(home, 'config.json')
    let config = JSON.parse(readFileSync(configPath, 'utf8'))
    const projectId = Object.values(config.projects)[0].id as string
    config.agentCommands = { 'claude-code': ['node', '-e', 'console.log("WEB_BINDING_OK")'] }
    writeFileSync(configPath, JSON.stringify(config, null, 2))
    const computerId = config.computer.id as string

    const binding = await harness.call('POST', `/api/workspaces/${workspaceId}/computer-bindings`, {
      token,
      body: { computerId, botId, agentKind: 'claude-code', projectId, workdirLabel: 'web-project' },
    })
    assert.equal(binding.status, 201, binding.text)

    daemon = spawn(process.execPath, [CLI, 'daemon', 'run'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let daemonLog = ''
    daemon.stdout?.on('data', (chunk) => { daemonLog += String(chunk) })
    const message = await harness.call('POST', `/api/rooms/${roomId}/messages`, { token, body: { text: 'Web binding 请回答' } })
    assert.equal(message.status, 201, message.text)
    let posted = false
    for (let i = 0; i < 25 && !posted; i += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
      const messages = await harness.call('GET', `/api/rooms/${roomId}/messages`, { token })
      posted = Array.isArray(messages.json.messages) && messages.json.messages.some((item: { text: string }) => item.text === 'WEB_BINDING_OK')
    }
    assert.equal(posted, true, `web binding did not run\n${daemonLog}`)
  } finally {
    if (daemon !== null) {
      const child = daemon
      const closed = new Promise<void>((resolvePromise) => child.once('close', () => resolvePromise()))
      child.kill('SIGTERM')
      const exited = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), 3000)),
      ])
      if (!exited) { child.kill('SIGKILL'); await closed }
    }
    await harness.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})
