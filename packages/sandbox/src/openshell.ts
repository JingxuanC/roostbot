// OpenShell 后端：调 `openshell` CLI，不 import 任何 SDK（零依赖）。
//
// 这台机器没有 Docker / Podman，也没有装 openshell CLI，所以本实现只在测试里对着
// 一个假的 openshell 脚本验证过命令行形状；真跑起来要等有容器运行时的机器。
// 设计见 docs/design/sandboxing.md §3。

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CreateSandboxInput, ExecOptions, SandboxBackend, SandboxHandle } from './backend.ts'
import { SandboxError, type ExecResult } from './exec.ts'

export interface OpenShellBackendOptions {
  /** openshell 可执行文件；默认 'openshell'（PATH 里找）。 */
  binary?: string
  /** 额外参数，例如 `--gateway <name>`。 */
  commonArgs?: string[]
  /** 策略文件放哪；默认写临时目录。 */
  policyDir?: string
  /** 单次命令超时。 */
  timeoutMs?: number
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

/** ROOST_* 是运行时接线（文档里的已知妥协）。其它像凭据的键拒绝放进 argv。 */
function isCredentialEnv(key: string): boolean {
  if (key.startsWith('ROOST_')) return false
  return /(api[_-]?key|_key$|secret|password|credential|token)/i.test(key)
}

export function runCommand(binary: string, args: string[], options: { timeoutMs?: number; stdin?: string } = {}): Promise<RunResult> {
  const startedAt = Date.now()
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let timer: NodeJS.Timeout | undefined
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, options.timeoutMs)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (timer !== undefined) clearTimeout(timer)
      if (error.code === 'ENOENT') {
        reject(new SandboxError('backend_unavailable', `${binary} not found on PATH`))
        return
      }
      reject(new SandboxError('exec_failed', `${binary} failed: ${error.message}`, { cause: error }))
    })
    child.on('close', (code) => {
      if (timer !== undefined) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, timedOut, durationMs: Date.now() - startedAt })
    })
    if (options.stdin !== undefined) child.stdin.end(options.stdin)
    else child.stdin.end()
  })
}

export class OpenShellBackend implements SandboxBackend {
  readonly id = 'openshell' as const
  /** OpenShell 承诺隔离（Landlock + seccomp 网络中介 + 失败关闭）；是否真生效取决于部署。 */
  readonly isolated = true
  private readonly binary: string
  private readonly commonArgs: string[]
  private readonly policyDir?: string
  private readonly defaultTimeoutMs: number

  constructor(options: OpenShellBackendOptions = {}) {
    this.binary = options.binary ?? 'openshell'
    this.commonArgs = options.commonArgs ?? []
    this.policyDir = options.policyDir
    this.defaultTimeoutMs = options.timeoutMs ?? 120_000
  }

  async available(): Promise<boolean> {
    try {
      const result = await runCommand(this.binary, [...this.commonArgs, '--version'], { timeoutMs: 10_000 })
      return result.code === 0
    } catch {
      return false
    }
  }

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    // OpenShell 的 sandbox 名上限 19 字符（实测 0.1.6：21 > 19 被拒）。
    if (!/^[a-z0-9][a-z0-9-]{0,18}$/.test(input.name)) {
      throw new SandboxError(
        'invalid_name',
        `openshell sandbox name must match [a-z0-9][a-z0-9-]{0,18} (got "${input.name}", ${input.name.length} chars)`
      )
    }
    for (const key of Object.keys(input.env ?? {})) {
      if (isCredentialEnv(key)) {
        throw new SandboxError('invalid_env', `env ${key} looks like a credential; inject it with a provider, not the CLI`)
      }
    }
    const createdDir = this.policyDir === undefined ? await mkdtemp(join(tmpdir(), 'roost-policy-')) : undefined
    const dir = createdDir ?? this.policyDir!
    try {
    const policyPath = join(dir, `${input.name}.policy.yaml`)
    await writeFile(policyPath, input.policyYaml, { mode: 0o600 })

    // 真实 CLI（0.1.6 实测）：create 接受 --name/--from/--policy/--detach/--env/--workspace，
    // **不接受 --mount**；挂载由 gateway 的 [openshell.drivers.docker].enable_bind_mounts 与
    // 卷管理负责（见 docs/spikes/0002-openshell-on-remote.md）。
    if ((input.mounts ?? []).length > 0) {
      throw new SandboxError(
        'unsupported',
        'openshell sandbox create has no --mount flag in 0.1.6; use a workspace or gateway-side bind mounts'
      )
    }
    const args = [...this.commonArgs, 'sandbox', 'create', '--name', input.name, '--policy', policyPath, '--detach']
    if (input.image !== undefined) args.push('--from', input.image)
    for (const provider of input.providers ?? []) {
      args.push('--provider', provider)
    }
    for (const [key, value] of Object.entries(input.env ?? {})) {
      args.push('--env', `${key}=${value}`)
    }
    // --detach 需要一个长期存活的 canonical process，否则沙箱很快进入非 Ready，
    // 后续 exec 会报 "sandbox is not ready"。
    args.push('--', ...(input.command ?? ['sh', '-lc', 'exec sleep infinity']))

    const result = await runCommand(this.binary, args, { timeoutMs: this.defaultTimeoutMs })
    if (result.code !== 0) {
      throw new SandboxError('create_failed', `openshell sandbox create failed (${result.code}): ${result.stderr.trim()}`)
    }
    // CLI 成功时不保证打印 id；用 name 作为句柄，exec/stop 都按 name 找。
    const printed = result.stdout.trim().split(/\s+/).find((token) => token.startsWith('sb_') || token.startsWith('sandbox_'))
    return { id: printed ?? input.name, name: input.name, backend: this.id }
    } finally {
      if (createdDir !== undefined) await rm(createdDir, { recursive: true, force: true })
    }
  }

  async exec(handle: SandboxHandle, argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
    if (argv.length === 0) throw new SandboxError('invalid_exec', 'exec needs at least one argument')
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
    // 真实 CLI 的 --timeout 单位是秒；0 = 不超时。
    const args = [...this.commonArgs, 'sandbox', 'exec', handle.id, '--timeout', String(Math.ceil(timeoutMs / 1000)), '--', ...argv]
    const result = await runCommand(this.binary, args, {
      timeoutMs,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin })
    })
    if (result.timedOut) {
      throw new SandboxError('timeout', `openshell exec timed out after ${options.timeoutMs ?? this.defaultTimeoutMs}ms`)
    }
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: false,
      durationMs: result.durationMs
    }
  }

  async suspend(handle: SandboxHandle): Promise<void> {
    const result = await runCommand(this.binary, [...this.commonArgs, 'sandbox', 'suspend', handle.id], { timeoutMs: 120_000 })
    if (result.code !== 0) {
      throw new SandboxError('exec_failed', `openshell sandbox suspend failed (${result.code}): ${result.stderr.trim()}`)
    }
  }

  async resume(handle: SandboxHandle): Promise<void> {
    const result = await runCommand(this.binary, [...this.commonArgs, 'sandbox', 'resume', handle.id], { timeoutMs: 120_000 })
    if (result.code !== 0) {
      throw new SandboxError('exec_failed', `openshell sandbox resume failed (${result.code}): ${result.stderr.trim()}`)
    }
  }

  async list(): Promise<Array<{ name: string; phase: string }>> {
    const result = await runCommand(this.binary, [...this.commonArgs, 'sandbox', 'list'], { timeoutMs: 60_000 })
    if (result.code !== 0) return []
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !/^NAME\b/.test(line))
      .map((line) => {
        const parts = line.split(/\s+/)
        return { name: parts[0] ?? '', phase: parts[parts.length - 1] ?? '' }
      })
      .filter((entry) => entry.name !== '')
  }

  async start(handle: SandboxHandle): Promise<void> {
    const result = await runCommand(this.binary, [...this.commonArgs, 'sandbox', 'start', handle.id], { timeoutMs: 180_000 })
    if (result.code !== 0) {
      throw new SandboxError('exec_failed', `openshell sandbox start failed (${result.code}): ${result.stderr.trim()}`)
    }
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const result = await runCommand(this.binary, [...this.commonArgs, 'sandbox', 'delete', handle.id], { timeoutMs: 120_000 })
    // delete 是异步的；404/已删除也算成功。
    if (result.code !== 0 && !/not found|does not exist/i.test(result.stderr)) {
      throw new SandboxError('exec_failed', `openshell sandbox delete failed (${result.code}): ${result.stderr.trim()}`)
    }
  }

  async stop(handle: SandboxHandle): Promise<void> {
    // stop 保留工作区；delete 才是销毁（见 sandbox 子命令列表）。
    const result = await runCommand(this.binary, [...this.commonArgs, 'sandbox', 'stop', handle.id], { timeoutMs: 60_000 })
    if (result.code !== 0) {
      throw new SandboxError('exec_failed', `openshell sandbox stop failed (${result.code}): ${result.stderr.trim()}`)
    }
  }
}
