// OpenShell 后端：对着一个**假的 openshell 脚本**验证命令行形状与错误映射。
// 真 sandbox 需要容器运行时，这台机器没有（docs/design/sandboxing.md §7）。

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  OpenShellBackend,
  PassthroughBackend,
  SandboxError,
  isEgressAllowed,
  isProcessPolicySafe,
  renderPolicyYaml,
  type SandboxPolicy
} from '../src/index.ts'

const BASE = 1_760_000_000_000

const policy: SandboxPolicy = {
  version: 1,
  filesystem: { read: ['/usr', '/etc', '/opt/app'], write: ['/workspace', '/tmp'] },
  process: { user: 1000, caps: [] },
  network: {
    default: 'deny',
    allow: [
      { binary: '/opt/app/engine/report_engine', host: 'api.qnaigc.com', methods: ['GET', 'POST'], credentials: 'model-gateway' },
      { binary: '/usr/bin/git', host: 'github.com', methods: ['GET'] }
    ]
  }
}

function fakeOpenshell(): { dir: string; log: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'roost-fake-openshell-'))
  const log = join(dir, 'calls.log')
  const script = join(dir, 'openshell')
  writeFileSync(
    script,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  --version) echo "openshell 0.1.0"; exit 0 ;;
esac
case "$2" in
  create) echo "sb_created_123"; exit 0 ;;
  exec) shift 3; echo "ran: $*"; exit 7 ;;
  stop|start|suspend|resume) exit 0 ;;
esac
exit 1
`,
    { mode: 0o755 }
  )
  chmodSync(script, 0o755)
  return { dir, log, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('策略渲染成 OpenShell YAML：与官方 schema 字段一致', () => {
  const yaml = renderPolicyYaml(policy)
  // 顶层与段落名（schema.mdx 的 4 个可选项里我们用 3 个）
  assert.match(yaml, /^version: 1$/m)
  assert.match(yaml, /^filesystem_policy:$/m)
  assert.match(yaml, /^  read_only:$/m)
  assert.match(yaml, /^  read_write:$/m)
  assert.match(yaml, /^process:$/m)
  assert.match(yaml, /^  run_as_user: "1000"$/m)
  assert.match(yaml, /^  run_as_group: "1000"$/m)
  // 网络：映射式，endpoints + binaries
  assert.match(yaml, /^network_policies:$/m)
  assert.match(yaml, /^    endpoints:$/m)
  assert.match(yaml, /^      - host: "api\.qnaigc\.com"$/m)
  assert.match(yaml, /^        port: 443$/m)
  // GET+POST 不是完整的 read-write 预设，必须写成显式规则。
  assert.match(yaml, /^        protocol: rest$/m)
  assert.match(yaml, /method: "GET"/)
  assert.match(yaml, /method: "POST"/)
  assert.match(yaml, /path: "\*\*"/)
  assert.doesNotMatch(yaml, /access: read-write/)
  assert.match(yaml, /^landlock:$/m)
  assert.match(yaml, /^  compatibility: hard_requirement$/m)
  assert.match(yaml, /^    binaries:$/m)
  assert.match(yaml, /^      - path: "\/opt\/app\/engine\/report_engine"$/m)
  // 凭据只写 provider 名，不写凭据值
  assert.match(yaml, /^        credential_binding:$/m)
  assert.match(yaml, /^          provider: "model-gateway"$/m)
  assert.doesNotMatch(yaml, /sk-|api[_-]?key/i)
  // 渲染结果与判定一致
  assert.equal(isEgressAllowed(policy, { binary: '/usr/bin/git', host: 'github.com', method: 'POST' }), false)
  assert.equal(isEgressAllowed(policy, { binary: '/opt/app/engine/report_engine', host: 'api.qnaigc.com', method: 'POST' }), true)
})

test('create / exec / stop 的命令行形状（假 CLI）', async () => {
  const fake = fakeOpenshell()
  try {
    const backend = new OpenShellBackend({ binary: join(fake.dir, 'openshell'), policyDir: fake.dir })
    assert.equal(await backend.available(), true)

    const handle = await backend.create({
      name: 'ws-test',
      policyYaml: renderPolicyYaml(policy),
      image: 'roost/engine:dev',
      env: { ROOST_RUN: 'run_1' },
      providers: ['deepseek']
    })
    assert.equal(handle.id, 'sb_created_123')
    assert.equal(handle.name, 'ws-test')
    assert.equal(handle.backend, 'openshell')

    const calls = readFileSync(fake.log, 'utf8').trim().split('\n')
    assert.equal(calls[0], '--version')
    const createCall = calls.find((line) => line.includes('sandbox create'))
    assert.ok(createCall)
    assert.match(createCall!, /--name ws-test/)
    assert.match(createCall!, /--policy .*ws-test\.policy\.yaml/)
    assert.match(createCall!, /--detach/)
    assert.match(createCall!, /--from roost\/engine:dev/)
    assert.match(createCall!, /--env ROOST_RUN=run_1/)
    assert.match(createCall!, /-- sh -lc exec sleep infinity/)
    assert.match(createCall!, /--provider deepseek/)

    // 策略文件真的写了，且内容就是 renderPolicyYaml 的输出。
    const written = readFileSync(join(fake.dir, 'ws-test.policy.yaml'), 'utf8')
    assert.equal(written, renderPolicyYaml(policy))

    const result = await backend.exec(handle, ['sh', '-lc', 'echo hi'])
    assert.equal(result.code, 7)
    assert.match(result.stdout, /ran: .*sh -lc echo hi/)

    // exec 带 --timeout（秒）与分隔符。
    const execCall = readFileSync(fake.log, 'utf8').split('\n').find((line) => line.includes('sandbox exec'))
    assert.match(execCall!, /--timeout \d+ -- sh -lc echo hi/)

    await backend.suspend!(handle)
    await backend.resume!(handle)
    await backend.start!(handle)
    const calls2 = readFileSync(fake.log, 'utf8')
    assert.ok(calls2.includes(`sandbox suspend ${handle.id}`))
    assert.ok(calls2.includes(`sandbox resume ${handle.id}`))
    assert.ok(calls2.includes(`sandbox start ${handle.id}`))

    await backend.stop(handle)
    assert.ok(readFileSync(fake.log, 'utf8').includes(`sandbox stop ${handle.id}`))
  } finally {
    fake.cleanup()
  }
})

test('sandbox 名超过 19 字符：就地拒绝，不发请求', async () => {
  const backend = new OpenShellBackend({ binary: '/nonexistent/openshell', policyDir: '/tmp' })
  await assert.rejects(
    () => backend.create({ name: 'roost-worker-too-long-name', policyYaml: 'version: 1\n' }),
    (error: unknown) => error instanceof SandboxError && error.code === 'invalid_name'
  )
})

test('mounts 在 0.1.6 的 create 里没有对应参数：明确报 unsupported', async () => {
  const fake = fakeOpenshell()
  try {
    const backend = new OpenShellBackend({ binary: join(fake.dir, 'openshell'), policyDir: fake.dir })
    await assert.rejects(
      () =>
        backend.create({
          name: 'ws-mount',
          policyYaml: renderPolicyYaml(policy),
          mounts: [{ hostPath: '/tmp/data', sandboxPath: '/data', readOnly: true }]
        }),
      (error: unknown) => error instanceof SandboxError && error.code === 'unsupported'
    )
  } finally {
    fake.cleanup()
  }
})

test('没有 openshell：available=false，调用报 backend_unavailable', async () => {
  const backend = new OpenShellBackend({ binary: join(tmpdir(), 'definitely-not-openshell-xyz') })
  assert.equal(await backend.available(), false)
  await assert.rejects(
    () => backend.exec({ id: 'x', name: 'x', backend: 'openshell' }, ['true']),
    (error: unknown) => error instanceof SandboxError && error.code === 'backend_unavailable'
  )
})

test('passthrough 明确不承诺隔离，并真的能本机执行', async () => {
  const backend = new PassthroughBackend()
  assert.equal(backend.isolated, false)
  const handle = await backend.create({ name: 'local', policyYaml: '' })
  const result = await backend.exec(handle, [process.execPath, '-e', 'process.stdout.write("local-ok")'])
  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'local-ok')
})

test('凭据样式的 env 不进 argv，临时策略目录用完即删', async () => {
  const fake = fakeOpenshell()
  const { readdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  try {
    const backend = new OpenShellBackend({ binary: join(fake.dir, 'openshell') })
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('roost-policy-')))
    await assert.rejects(
      () => backend.create({
        name: 'ws-env',
        policyYaml: 'version: 1\n',
        env: { OPENAI_API_KEY: 'sk-test-value' },
      }),
      (error: unknown) => error instanceof SandboxError && error.code === 'invalid_env',
    )
    await backend.create({
      name: 'ws-env',
      policyYaml: 'version: 1\n',
      env: { ROOST_RUN: 'run_1' },
    })
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith('roost-policy-') && !before.has(name))
    assert.deepEqual(after, [])
    const calls = readFileSync(fake.log, 'utf8')
    assert.doesNotMatch(calls, /OPENAI_API_KEY/)
    assert.doesNotMatch(calls, /sk-test-value/)
  } finally {
    fake.cleanup()
  }
})

test('../ 名字不能把策略文件写到 policyDir 外面', async () => {
  const backend = new OpenShellBackend({ binary: '/nonexistent/openshell', policyDir: '/tmp' })
  await assert.rejects(
    () => backend.create({ name: '../escaped', policyYaml: 'version: 1\n' }),
    (error: unknown) => error instanceof SandboxError && error.code === 'invalid_name',
  )
})

test('策略安全判定与后端默认值一致', () => {
  assert.equal(isProcessPolicySafe(policy.process), true)
  assert.equal(isProcessPolicySafe({ user: 0, caps: [] }), false)
  assert.ok(BASE > 0)
})
