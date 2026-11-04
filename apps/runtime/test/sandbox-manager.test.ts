// 用户沙箱：固定名字、可复用、策略放行控制面。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ensureUserSandbox, sandboxNameFor, userSandboxPolicy } from '../sandbox-manager.mjs'

const BASE = {
  version: 1,
  filesystem: { read: ['/usr'], write: ['/workspace'] },
  process: { user: 1000, caps: [] },
  network: { default: 'deny', allow: [] }
}

test('沙箱名固定为 user-<8hex>，且不超过 19 字符', () => {
  const name = sandboxNameFor('ws_01M6HF3JGXV0K491MB1ME8BZZG')
  assert.match(name, /^user-[0-9a-f]{8}$/)
  assert.equal(name, sandboxNameFor('ws_01M6HF3JGXV0K491MB1ME8BZZG'))
  assert.ok(name.length <= 19)
  assert.notEqual(name, sandboxNameFor('ws_other'))
})

test('策略放行控制面：host:port + tcp（无方法）', () => {
  const yaml = userSandboxPolicy({ host: 'host.openshell.internal', port: 8792 })
  assert.match(yaml, /host: host\.openshell\.internal/)
  assert.match(yaml, /port: 8792/)
  assert.match(yaml, /protocol: tcp/)
  // 除了控制面，不应该有任何其他端点
  assert.equal((yaml.match(/- host:/g) ?? []).length, 1)
})

test('已有同名沙箱：start 复用，不 create', async () => {
  const calls: string[] = []
  const backend = {
    id: 'openshell',
    isolated: true,
    available: async () => true,
    list: async () => [{ name: 'user-abc12345', phase: 'Stopped' }],
    start: async (handle: { name: string }) => { calls.push(`start:${handle.name}`) },
    create: async () => { calls.push('create'); throw new Error('should not create') },
    exec: async () => { throw new Error('unused') },
    stop: async () => {}
  }
  const result = await ensureUserSandbox({
    backend, workspaceId: 'ws_x', name: 'user-abc12345', policyYaml: '', image: 'img', log: () => {}
  })
  assert.equal(result.created, false)
  assert.deepEqual(calls, ['start:user-abc12345'])
})

test('没有同名沙箱：create，主进程是 room-agent', async () => {
  const created: Array<Record<string, unknown>> = []
  const backend = {
    id: 'openshell',
    isolated: true,
    available: async () => true,
    list: async () => [],
    start: async () => { throw new Error('no start') },
    create: async (input: Record<string, unknown>) => { created.push(input); return { id: input.name as string, name: input.name as string, backend: 'openshell' } },
    exec: async () => { throw new Error('unused') },
    stop: async () => {}
  }
  const result = await ensureUserSandbox({
    backend, workspaceId: 'ws_1', policyYaml: 'version: 1\n', image: 'roost/agent:dev',
    env: { ROOST_API: 'http://host.openshell.internal:8792', ROOST_RUNTIME_TOKEN: 'rt', ROOST_BOT_ID: 'selector' },
    providers: ['deepseek'], log: () => {}
  })
  assert.equal(result.created, true)
  assert.equal(created.length, 1)
  assert.deepEqual(created[0].command, ['node', '/opt/roost/room-agent.mjs'])
  assert.deepEqual(created[0].providers, ['deepseek'])
  assert.equal((created[0].env as Record<string, string>).ROOST_BOT_ID, 'selector')
  assert.deepEqual(BASE !== undefined, true) // 保持文件里 BASE 被使用
})
