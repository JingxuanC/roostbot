// sandbox runner：passthrough 后端（本机）验证接线与策略形状；
// 真正的 OpenShell 沙箱在远端验证（docs/spikes/0002）。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SANDBOX_PROBE, sandboxPolicy, startSandboxRunner } from '../sandbox-runner.ts'
import { startRoomWorker } from '../worker.ts'

test('策略：默认拒绝出网，非 root，只读系统路径', () => {
  const yaml = sandboxPolicy()
  assert.match(yaml, /^version: 1$/m)
  assert.match(yaml, /read_only:/)
  assert.match(yaml, /run_as_user: "1000"/)
  assert.doesNotMatch(yaml, /network_policies/)
  assert.doesNotMatch(yaml, /access: full/)
})

test('passthrough runner 能真执行命令并返回 stdout/退出码', async () => {
  const runner = await startSandboxRunner({ backend: 'passthrough', log: () => {} })
  const probe = await runner.run(SANDBOX_PROBE)
  assert.equal(probe.code, 0)
  assert.match(probe.stdout, /uid=\d+ gid=\d+/)

  const failing = await runner.run(['sh', '-lc', 'exit 3'])
  assert.equal(failing.code, 3)
  await runner.stop()
})

test('不存在的后端会明确报错，不静默降级', async () => {
  await assert.rejects(
    () => startSandboxRunner({ backend: 'openshell', binary: '/nonexistent/openshell', log: () => {} }),
    /backend is not available/
  )
})

test('worker 接受注入的 reply（沙箱回合替换点）', async () => {
  const seen: string[] = []
  const handle = await startRoomWorker({
    apiBase: 'http://127.0.0.1:1',
    runtimeToken: 'x',
    pollMs: 10,
    reply: async ({ text }) => {
      seen.push(text)
      return null
    },
    log: () => {}
  })
  handle.stop()
  assert.deepEqual(seen, [])
  assert.equal(handle.replies, 0)
})
