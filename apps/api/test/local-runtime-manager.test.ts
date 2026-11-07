import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { localRuntimeManager } from '../src/runtime-manager-local.ts'

function fakeChild() {
  const child = new EventEmitter() as any
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.killed = false
  child.kills = []
  child.kill = (signal: string) => { child.kills.push(signal ?? 'SIGTERM'); child.killed = true; return true }
  child.emitExit = (code: number | null = 0) => { child.exitCode = code; child.emit('exit', code, null) }
  return child
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'roost-local-runtime-'))
  const children: any[] = []
  const spawnCalls: any[] = []
  const manager = localRuntimeManager({
    cpHost: '127.0.0.1',
    cpPort: 8799,
    dshBin: '/fake/dsh',
    nodeBin: '/fake/node',
    roomAgentPath: '/repo/apps/runtime/room-agent.mjs',
    workRoot: root,
    waitForReady: false,
    tokenIssuer: () => ({ id: 'rtk_1', token: 'rt_token', workspaceId: 'ws_1', expiresAt: 1 }),
    spawn: (command: string, args: string[], options: any) => {
      const child = fakeChild()
      children.push(child)
      spawnCalls.push({ command, args, options })
      return child
    },
    ...overrides,
  })
  return { manager, root, children, spawnCalls }
}

test('local manager spawns room-agent with control-plane env and reuses the process', async () => {
  const { manager, root, children, spawnCalls } = makeConfig()
  try {
    const first = await manager.ensure('ws_1')
    assert.equal(first.sandbox, 'local:ws_1')
    assert.equal(first.phase, 'ready')
    assert.equal(spawnCalls.length, 1)
    assert.equal(spawnCalls[0].command, '/fake/node')
    assert.deepEqual(spawnCalls[0].args, ['/repo/apps/runtime/room-agent.mjs'])
    assert.equal(spawnCalls[0].options.env.ROOST_API, 'http://127.0.0.1:8799')
    assert.equal(spawnCalls[0].options.env.ROOST_RUNTIME_TOKEN, 'rt_token')
    assert.equal(spawnCalls[0].options.env.ROOST_WORKSPACE_ID, 'ws_1')
    assert.equal(spawnCalls[0].options.env.ROOST_DSH_BIN, '/fake/dsh')
    assert.equal(spawnCalls[0].options.env.ROOST_WORKDIR, join(root, 'ws_1'))
    const second = await manager.ensure('ws_1')
    assert.equal(second.sandbox, 'local:ws_1')
    assert.equal(children.length, 1, 'reuses a live child')
    assert.deepEqual(await manager.status('ws_1'), { sandbox: 'local:ws_1', phase: 'ready' })
    children[0].emitExit(0)
    assert.equal(await manager.status('ws_1'), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('local manager waits for sdk ready and rejects a process that exits early', async () => {
  const { manager, root, children } = makeConfig({ waitForReady: true, readyTimeoutMs: 2_000 })
  try {
    const pending = manager.ensure('ws_ready')
    await new Promise((resolve) => setTimeout(resolve, 10))
    children[0].stdout.write('starting...\nsdk ready: deepseek-harness 0.2.1\n')
    const ensured = await pending
    assert.equal(ensured.phase, 'ready')

    const failing = manager.ensure('ws_early_exit')
    await new Promise((resolve) => setTimeout(resolve, 10))
    children[1].emitExit(1)
    await assert.rejects(failing, /exited before ready/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('local manager needs a token and revokes a failed start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'roost-local-runtime-'))
  try {
    let revoked = false
    const manager = localRuntimeManager({
      cpHost: '127.0.0.1',
      cpPort: 8799,
      dshBin: 'dsh',
      roomAgentPath: '/repo/room-agent.mjs',
      workRoot: root,
      runtimeToken: '',
      tokenIssuer: () => ({ id: 'rtk_bad', token: 't', workspaceId: 'ws', expiresAt: 1 }),
      spawn: () => { throw new Error('spawn denied') },
      waitForReady: false,
    })
    await assert.rejects(manager.ensure('ws_bad'), /spawn unavailable|spawn failed/)
    assert.equal(revoked, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
