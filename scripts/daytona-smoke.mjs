#!/usr/bin/env node
// 真实 Daytona 生命周期冒烟：probe → ensure → ensure（复用）→ status → exec → stop(remove)。
//
// 用法：
//   DAYTONA_API_KEY=dtn_... DAYTONA_SNAPSHOT=roost-agent-smoke node scripts/daytona-smoke.mjs
//
// 可选：
//   DAYTONA_API_URL       默认 https://app.daytona.io/api（自托管填 http://127.0.0.1:3100/api）
//   DAYTONA_ORGANIZATION_ID
//
// 注意：
//   * 会在账号里创建并删除一个 sandbox（几秒），失败时也会尝试清理；
//   * snapshot 必须包含 /workspace/.roost/ready 标记，否则 provider 的 ready 检查会超时；
//     最小做法见 docs/design/provider-console.md「smoke snapshot」。
import assert from 'node:assert/strict'

import { daytonaRuntimeProvider } from '../apps/api/src/runtime-provider-daytona.ts'

const apiKey = (process.env.DAYTONA_API_KEY ?? process.env.ROOST_DAYTONA_API_KEY ?? '').trim()
if (apiKey === '') {
  console.error('DAYTONA_API_KEY is required')
  process.exit(2)
}

const snapshot = (process.env.DAYTONA_SNAPSHOT ?? process.env.ROOST_DAYTONA_SNAPSHOT ?? 'roost-agent-smoke').trim()
const apiUrl = (process.env.DAYTONA_API_URL ?? process.env.ROOST_DAYTONA_API_URL ?? 'https://app.daytona.io/api').trim()
const organizationId = (process.env.DAYTONA_ORGANIZATION_ID ?? '').trim()

const provider = daytonaRuntimeProvider({
  apiUrl,
  apiKey,
  ...(organizationId === '' ? {} : { organizationId }),
  snapshot,
})

const workspaceId = `ws_smoke_${Date.now()}`
const spec = {
  workspaceId,
  image: snapshot,
  env: { ROOST_WORKSPACE_ID: workspaceId },
  resources: { cpus: 1, memoryMb: 1024 },
  readyTimeoutMs: 120_000,
}

const started = Date.now()
let created = false

try {
  const probe = await provider.probe()
  console.log('probe ok=', probe.ok, probe.problems)
  assert.equal(probe.ok, true, 'probe failed')

  const first = await provider.ensure(spec)
  created = first.created
  console.log('ensure#1 created=', first.created, 'name=', first.handle.name, 'phase=', first.status.phase)
  assert.equal(first.created, true)
  assert.equal(first.status.phase, 'ready')

  const second = await provider.ensure(spec)
  console.log('ensure#2 created=', second.created, 'reused=', second.handle.name === first.handle.name)
  assert.equal(second.created, false)
  assert.equal(second.handle.name, first.handle.name)

  const status = await provider.status({ workspaceId })
  console.log('status phase=', status?.phase)
  assert.equal(status?.phase, 'ready')

  const exec = await provider.exec({ workspaceId }, [
    'sh',
    '-c',
    'test -f /workspace/.roost/ready && echo ROOST_EXEC_OK',
  ])
  console.log('exec code=', exec.code, 'stdout=', JSON.stringify(exec.stdout.trim()))
  assert.equal(exec.code, 0)
  assert.match(exec.stdout, /ROOST_EXEC_OK/)

  await provider.stop({ workspaceId }, { remove: true })
  created = false
  console.log('after stop(remove) status=', await provider.status({ workspaceId }))

  console.log(`\nSMOKE PASS in ${((Date.now() - started) / 1000).toFixed(1)}s — workspace=${workspaceId}`)
} catch (error) {
  console.error('SMOKE FAIL:', error?.constructor?.name, error?.message)
  if (created) {
    try {
      await provider.stop({ workspaceId }, { remove: true })
    } catch (cleanupError) {
      console.error('cleanup failed:', cleanupError?.message)
    }
  }
  process.exit(1)
}
