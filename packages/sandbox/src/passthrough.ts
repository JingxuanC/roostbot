// 本地直通后端：**不是沙箱**。
//
// 它存在有两个理由：本机开发时没有容器运行时；以及让 runtime 的调用点不必为「本机模式」写分支。
// 它永远把 isolated 报成 false，事件里记 sandbox.mode=local-untrusted，
// 界面上也必须如实说「本机执行 = 你自己的信任域」（docs/design/sandboxing.md §7）。

import { runCommand } from './openshell.ts'
import type { CreateSandboxInput, ExecOptions, SandboxBackend, SandboxHandle } from './backend.ts'
import { SandboxError, type ExecResult } from './exec.ts'

export class PassthroughBackend implements SandboxBackend {
  readonly id = 'passthrough' as const
  readonly isolated = false

  async available(): Promise<boolean> {
    return true
  }

  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    // 不创建任何东西：本机模式没有边界可建。名字保留给日志与事件。
    return { id: `local_${input.name}`, name: input.name, backend: this.id }
  }

  async exec(handle: SandboxHandle, argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
    void handle
    if (argv.length === 0) throw new SandboxError('invalid_exec', 'exec needs at least one argument')
    const [binary, ...rest] = argv
    try {
      const result = await runCommand(binary!, rest, {
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.stdin === undefined ? {} : { stdin: options.stdin })
      })
      if (result.timedOut) throw new SandboxError('timeout', `command timed out after ${options.timeoutMs}ms`)
      return { code: result.code, stdout: result.stdout, stderr: result.stderr, timedOut: false, durationMs: result.durationMs }
    } catch (error) {
      if (error instanceof SandboxError) throw error
      throw new SandboxError('exec_failed', error instanceof Error ? error.message : String(error), { cause: error })
    }
  }

  async stop(): Promise<void> {
    // 没有要停的东西。
  }
}
