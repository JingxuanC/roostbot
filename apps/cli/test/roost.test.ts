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
