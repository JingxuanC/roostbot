// OpenShell 后端：调 `openshell` CLI，不 import 任何 SDK（零依赖）。
//
// 这台机器没有 Docker / Podman，也没有装 openshell CLI，所以本实现只在测试里对着
// 一个假的 openshell 脚本验证过命令行形状；真跑起来要等有容器运行时的机器。
// 设计见 docs/design/sandboxing.md §3。

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
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
    const dir = this.policyDir ?? (await mkdtemp(join(tmpdir(), 'roost-policy-')))
    const policyPath = join(dir, `${input.name}.policy.yaml`)
    await writeFile(policyPath, input.policyYaml, { mode: 0o600 })

    const args = [...this.commonArgs, 'sandbox', 'create', '--name', input.name, '--policy', policyPath, '--detach']
    if (input.image !== undefined) args.push('--from', input.image)
    for (const mount of input.mounts ?? []) {
      args.push('--mount', `${mount.hostPath}:${mount.sandboxPath}${mount.readOnly === true ? ':ro' : ''}`)
    }
    for (const [key, value] of Object.entries(input.env ?? {})) {
      args.push('--env', `${key}=${value}`)
    }

    const result = await runCommand(this.binary, args, { timeoutMs: this.defaultTimeoutMs })
    if (result.code !== 0) {
      throw new SandboxError('create_failed', `openshell sandbox create failed (${result.code}): ${result.stderr.trim()}`)
    }
    // CLI 成功时不保证打印 id；用 name 作为句柄，exec/stop 都按 name 找。
    const printed = result.stdout.trim().split(/\s+/).find((token) => token.startsWith('sb_') || token.startsWith('sandbox_'))
    return { id: printed ?? input.name, name: input.name, backend: this.id }
  }

  async exec(handle: SandboxHandle, argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
    if (argv.length === 0) throw new SandboxError('invalid_exec', 'exec needs at least one argument')
    const result = await runCommand(
      this.binary,
      [...this.commonArgs, 'sandbox', 'exec', handle.id, '--', ...argv],
      { timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs, ...(options.stdin === undefined ? {} : { stdin: options.stdin }) }
    )
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

  async stop(handle: SandboxHandle): Promise<void> {
    const result = await runCommand(this.binary, [...this.commonArgs, 'sandbox', 'stop', handle.id], { timeoutMs: 60_000 })
    if (result.code !== 0) {
      throw new SandboxError('exec_failed', `openshell sandbox stop failed (${result.code}): ${result.stderr.trim()}`)
    }
  }
}
