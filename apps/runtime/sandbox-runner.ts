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
  /** 传给沙箱的环境变量（**不能放密钥**；真实密钥走 provider）。 */
  env?: Record<string, string>
  /** 是否在沙箱里先起 mock 模型（没有真 key 的演示环境用）。 */
  mockModel?: boolean
  /** DSH 的模型 base URL；mock 时指向沙箱内 loopback。 */
  modelBaseUrl?: string
  /** 模型名。 */
  model?: string
  /** OpenShell provider 名：凭据由网关注入，沙箱内不设 key。 */
  provider?: string
  log?: (line: string) => void
}

export interface SandboxRunner {
  readonly backend: string
  /** 跑一个 DSH headless 回合，返回模型回复文本（沙箱内执行）。 */
  runDshTurn(text: string): Promise<string>
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
      // 没有网络规则时 schema 不会自动加 baseline 路径，必须自己列全：
      // /lib 是动态链接器（漏了 /bin/sh 直接 EACCES），/opt 放 mock，/proc 是 node 要读的。
      read: ['/usr', '/etc', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/proc', '/dev/null'],
      write: ['/tmp', '/workspace', '/var/lib/dsh']
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
      image: options.image ?? 'docker.io/library/node:22-alpine',
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.provider === undefined ? {} : { providers: [options.provider] })
    })
    log(`sandbox ${handle.name} created (${handle.id})`)
  }

  const turnCommand = (text: string): string[] => {
    const quoted = `'${text.replace(/'/g, `'\\''`)}'`
    const mock = options.mockModel === true
      ? 'node /opt/mock-openai.mjs > /tmp/mock.log 2>&1 & MOCK=$!; sleep 1; '
      : ''
    const cleanup = options.mockModel === true ? '; RC=$?; kill $MOCK 2>/dev/null; exit $RC' : ''
    const envParts = ['export HOME=/workspace']
    if (options.provider === undefined) {
      // 没有 provider：走 mock/自建 endpoint，需要一个（假的或真的）key 环境变量。
      if (options.modelBaseUrl !== undefined) envParts.push(`DEEPSEEK_BASE_URL=${options.modelBaseUrl}`)
      envParts.push('DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-mock-key}')
      if (options.model !== undefined) envParts.push(`DEEPSEEK_DEFAULT_MODEL=${options.model}`)
    }
    // provider 模式：**不设** DEEPSEEK_API_KEY —— 设置后 DSH 会自己发 Authorization，
    // 反而绕过了 OpenShell 的注入（实测 401）。
    const env = envParts.join(' ')
    return ['sh', '-lc', `${env}; ${mock}dsh --profile headless --json ${quoted}${cleanup}`]
  }

  return {
    backend: options.backend,
    async run(command) {
      const target: SandboxHandle = handle ?? { id: `local_${name}`, name, backend: backend.id }
      const result = await backend.exec(target, command, { timeoutMs: 30_000 })
      return { code: result.code, stdout: result.stdout, stderr: result.stderr }
    },
    /** 在沙箱里跑一个真正的 DSH headless 回合，返回 final 文本。 */
    async runDshTurn(text) {
      const target: SandboxHandle = handle ?? { id: `local_${name}`, name, backend: backend.id }
      const result = await backend.exec(target, turnCommand(text), { timeoutMs: 180_000 })
      const lines = result.stdout.split('\n').filter((line) => line.trim().startsWith('{'))
      const final = [...lines].reverse().find((line) => line.includes('"type":"final"'))
      if (final === undefined) {
        throw new Error(`dsh turn produced no final event (code=${result.code}): ${result.stderr.slice(-400)}`)
      }
      const parsed = JSON.parse(final) as { text?: string }
      return parsed.text ?? ''
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
