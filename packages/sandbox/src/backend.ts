// 沙箱后端接口：runtime 只认这个接口，不认 OpenShell。
// 设计见 docs/design/sandboxing.md §3 —— 选择 OpenShell 作为默认实现，
// 但接口留在这里，gVisor / microVM 将来只换实现。

import type { ExecResult } from './exec.ts'

export interface CreateSandboxInput {
  /** 沙箱名（同一个 workspace 内唯一，便于重连复用）。 */
  name: string
  /** 策略 YAML 文本（由 renderPolicyYaml 生成）。 */
  policyYaml: string
  /** 镜像；不传用后端的默认。 */
  image?: string
  /** 需要挂载的目录（只读数据面、workspace 卷）。 */
  mounts?: Array<{ hostPath: string; sandboxPath: string; readOnly?: boolean }>
  /** 额外环境变量；**不允许放凭据**（凭据只在网关侧注入）。 */
  env?: Record<string, string>
  /**
   * canonical main process。`--detach` 时必须给一个不立刻退出的命令，
   * 否则沙箱会在 exec 之前就进入非 Ready 状态（实测）。
   * 默认 `sh -lc 'exec sleep infinity'`。
   */
  command?: string[]
}

export interface SandboxHandle {
  id: string
  name: string
  backend: SandboxBackendId
}

export type SandboxBackendId = 'openshell' | 'passthrough'

export interface ExecOptions {
  timeoutMs?: number
  cwd?: string
  /** 传给进程的 stdin。 */
  stdin?: string
}

export interface SandboxBackend {
  readonly id: SandboxBackendId
  /**
   * 这个后端能不能承诺隔离。
   * passthrough 明确返回 false：本机执行是用户自己的信任域（sandboxing.md §7）。
   */
  readonly isolated: boolean
  /** 依赖是否就绪（CLI 在 PATH、运行时可用）。 */
  available(): Promise<boolean>
  create(input: CreateSandboxInput): Promise<SandboxHandle>
  exec(handle: SandboxHandle, argv: string[], options?: ExecOptions): Promise<ExecResult>
  stop(handle: SandboxHandle): Promise<void>
}
