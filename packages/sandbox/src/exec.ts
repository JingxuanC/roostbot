// 执行结果与错误：后端实现共用。

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  /** 是否因为超时被杀。 */
  timedOut: boolean
  durationMs: number
}

export type SandboxErrorCode =
  | 'backend_unavailable'
  | 'invalid_name'
  | 'create_failed'
  | 'exec_failed'
  | 'timeout'
  | 'unsupported'
  | 'invalid_exec'

export class SandboxError extends Error {
  code: SandboxErrorCode
  constructor(code: SandboxErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SandboxError'
    this.code = code
  }
}
