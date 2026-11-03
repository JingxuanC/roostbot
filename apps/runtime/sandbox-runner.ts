// 把 OpenShell 沙箱接进 worker：Bot 的「想」这一步在沙箱里执行。
//
// 这不是模型回合（DSH 还没接进来），而是把**执行**放进沙箱：
// 每个 worker 进程起一个沙箱，回复时在里面跑一条命令，把结果带回房间。
// 换成真 DSH 回合时，把 run() 里的命令换成 DSH 的入口即可，接口不变。

import { OpenShellBackend, PassthroughBackend, renderPolicyYaml, type SandboxBackend, type SandboxHandle } from '../../packages/sandbox/src/index.ts'

export interface SandboxRunnerOptions {
  backend: 'openshell' | 'passthrough'
  /** 沙箱镜像；默认 node:22-alpine（有 uid 1000，够跑演示命令）。 */
  image?: string
  /** 沙箱名；同一 gateway 内要唯一。 */
  name?: string
  /** openshell 可执行文件（默认 PATH）。 */
  binary?: string
  log?: (line: string) => void
}

export interface SandboxRunner {
  readonly backend: string
  /** 在沙箱里跑一条命令，返回 stdout（失败抛错）。 */
  run(command: string[]): Promise<{ code: number; stdout: string; stderr: string }>
  stop(): Promise<void>
}

/** 沙箱策略：不给出网（默认拒绝），只读系统路径，可写 /tmp。 */
export function sandboxPolicy() {
  return renderPolicyYaml({
    version: 1,
    // 没有网络规则时，schema 的 baseline 路径不会自动加上，所以动态链接器与 /lib
    // 必须自己列：漏了 /lib 会导致 /bin/sh 启动即 Permission denied（实测 os error 13）。
    filesystem: {
      read: ['/usr', '/etc', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/dev/null'],
      write: ['/tmp', '/workspace']
    },
    process: { user: 1000, caps: [] },
    network: { default: 'deny', allow: [] }
  })
}

export async function startSandboxRunner(options: SandboxRunnerOptions): Promise<SandboxRunner> {
  const log = options.log ?? ((line: string) => console.log(`[sandbox] ${line}`))
  const backend: SandboxBackend =
    options.backend === 'openshell'
      ? new OpenShellBackend({ binary: options.binary ?? 'openshell' })
      : new PassthroughBackend()

  if (!(await backend.available())) {
    throw new Error(`${options.backend} backend is not available (openshell CLI missing?)`)
  }

  // 19 字符上限：`roost-` + 10 位随机 = 16 字符。
  const name = options.name ?? `roost-${Math.random().toString(36).slice(2, 12).padEnd(10, '0')}`
  let handle: SandboxHandle | null = null
  if (options.backend === 'openshell') {
    handle = await backend.create({
      name,
      policyYaml: sandboxPolicy(),
      image: options.image ?? 'docker.io/library/node:22-alpine'
    })
    log(`sandbox ${handle.name} created (${handle.id})`)
  }

  return {
    backend: options.backend,
    async run(command) {
      const target: SandboxHandle = handle ?? { id: `local_${name}`, name, backend: backend.id }
      const result = await backend.exec(target, command, { timeoutMs: 30_000 })
      return { code: result.code, stdout: result.stdout, stderr: result.stderr }
    },
    async stop() {
      if (handle !== null) {
        await backend.stop(handle).catch((error: unknown) => log(`stop failed: ${String(error)}`))
      }
    }
  }
}

/** 沙箱里跑的那条命令：输出足够证明「真的在沙箱里」。 */
export const SANDBOX_PROBE = [
  'sh',
  '-lc',
  'printf "uid=%s gid=%s\\n" "$(id -u)" "$(id -g)"; echo "host=$(hostname)"; echo "cgroup=$(head -c 80 /proc/1/cgroup 2>/dev/null | tr "\\n" " ")"'
]
