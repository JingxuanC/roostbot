// 每个 workspace 一个本地面板转发端口（plugin-marketplace.md §3 C 级 / wave1 §C / TODO 5.2.5）。
//
// 沙箱里的 `dsh web` 只绑 127.0.0.1，控制面要反代就得先有一条到沙箱的转发：
//   openshell forward start <port> <sandbox> -d
// 本模块只做「workspace -> 本地端口」的内存映射，不碰 HTTP 反代（那是 dsh-proxy-routes）。
//
// 生命周期：
//   ensurePanelForward(workspaceId, {sandboxName})  幂等；已存在直接返回
//   resolvePanelPort(workspaceId)                   反代用；undefined = 面板未唤醒
//   stopPanelForward(workspaceId)                   沙箱 stop 时调用（best effort）
//   stopAllPanelForwards()                          进程退出 / 测试清理
//
// 零依赖；runner 可注入（测试不需要 openshell）。端口默认从 4100 递增，测试用 basePort 固定。

import { spawn } from 'node:child_process'

/** 默认端口起点；与 dsh web 的 4099 相邻，避免撞上控制面/侧车端口。 */
export const DEFAULT_PANEL_BASE_PORT = 4100

/** 单条 forward 命令的超时（毫秒）。CLI 卡住时不能把请求挂死。 */
const FORWARD_TIMEOUT_MS = 30_000

export interface PanelForwardResult {
  code: number
  stdout: string
  stderr: string
}

/** `openshell` 的调用抽象：收到的是子命令参数（不含 binary）。 */
export type PanelForwardRunner = (args: string[]) => Promise<PanelForwardResult>

export interface EnsurePanelForwardOptions {
  runner?: PanelForwardRunner
  /** 沙箱名（OpenShell sandbox name），必填。 */
  sandboxName?: string
  /** 测试注入：端口分配从哪个端口开始；不传用 4100 递增。 */
  basePort?: number
  log?: (line: string) => void
}

export interface StopPanelForwardOptions {
  runner?: PanelForwardRunner
  log?: (line: string) => void
}

export interface PanelForwardEndpoint {
  port: number
  url: string
}

/** 可识别的错误码，方便路由层映射 HTTP 状态。 */
export class PanelForwardError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PanelForwardError'
    this.code = code
  }
}

interface ForwardEntry {
  workspaceId: string
  port: number
  url: string
  sandboxName: string
  /** ensure 时用的 runner：stop 复用同一条注入通道，测试不必再传一遍。 */
  runner: PanelForwardRunner
}

const forwards = new Map<string, ForwardEntry>()
const pending = new Map<string, Promise<PanelForwardEndpoint>>()
const usedPorts = new Set<number>()
let nextDefaultPort = DEFAULT_PANEL_BASE_PORT

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65_536
}

/** 从 from 开始找第一个没被占用的端口；显式 basePort 不动全局游标。 */
function allocatePort(basePort?: number): number {
  if (basePort !== undefined) {
    if (!isValidPort(basePort)) throw new PanelForwardError('bad_port', `invalid basePort: ${String(basePort)}`)
    let port = basePort
    while (usedPorts.has(port)) port += 1
    if (!isValidPort(port)) throw new PanelForwardError('bad_port', 'no free panel port above basePort')
    usedPorts.add(port)
    return port
  }
  let port = nextDefaultPort
  while (usedPorts.has(port)) port += 1
  if (!isValidPort(port)) throw new PanelForwardError('bad_port', 'panel port range exhausted')
  usedPorts.add(port)
  nextDefaultPort = port + 1
  return port
}

/** stdout 里的第一个 http(s) URL；没有就返回 null（CLI 不打印时用约定端口）。 */
function parseForwardUrl(stdout: string): string | null {
  const match = /https?:\/\/[^\s"'<>]+/i.exec(stdout ?? '')
  if (match === null) return null
  // 去掉句末标点：CLI 可能打印 "forward ready: http://127.0.0.1:4100."
  const candidate = match[0].replace(/[.,;:)\]}]+$/, '')
  try {
    new URL(candidate) // 只做合法性校验，保留 CLI 原样输出
    return candidate
  } catch {
    return null
  }
}

function portFromUrl(url: string): number | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.port === '') return undefined
    const port = Number(parsed.port)
    return isValidPort(port) ? port : undefined
  } catch {
    return undefined
  }
}

function requireWorkspaceId(workspaceId: string): string {
  if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
    throw new PanelForwardError('bad_workspace', 'panel forward needs a workspace id')
  }
  return workspaceId
}

/** 默认 runner：`openshell <args>`；测试注入替代。 */
function defaultRunner(args: string[]): Promise<PanelForwardResult> {
  const binary = process.env.ROOST_OPENSHELL_BIN ?? 'openshell'
  return new Promise((resolve, reject) => {
    let settled = false
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 已经退出
      }
    }, FORWARD_TIMEOUT_MS)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const detail =
        error.code === 'ENOENT' ? `${binary} not found on PATH` : `${binary} failed: ${errorMessage(error)}`
      reject(new PanelForwardError('backend_unavailable', detail))
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * 确保这个 workspace 有一条面板转发。已存在（或正在建立）时直接返回同一端点。
 * 没有 sandboxName → PanelForwardError('sandbox_required')；CLI 失败 → ('forward_failed')。
 */
export async function ensurePanelForward(
  workspaceId: string,
  options: EnsurePanelForwardOptions = {}
): Promise<PanelForwardEndpoint> {
  const id = requireWorkspaceId(workspaceId)
  const existing = forwards.get(id)
  if (existing !== undefined) return { port: existing.port, url: existing.url }
  const inflight = pending.get(id)
  if (inflight !== undefined) return inflight

  const sandboxName = typeof options.sandboxName === 'string' ? options.sandboxName.trim() : ''
  if (sandboxName === '') {
    throw new PanelForwardError(
      'sandbox_required',
      `panel forward needs a sandbox name for workspace ${id}`
    )
  }

  const runner = options.runner ?? defaultRunner
  const log = options.log ?? (() => {})
  const task = startForward(id, sandboxName, runner, log, options.basePort)
  pending.set(id, task)
  try {
    return await task
  } finally {
    pending.delete(id)
  }
}

async function startForward(
  workspaceId: string,
  sandboxName: string,
  runner: PanelForwardRunner,
  log: (line: string) => void,
  basePort?: number
): Promise<PanelForwardEndpoint> {
  const port = allocatePort(basePort)
  const args = ['forward', 'start', String(port), sandboxName, '-d']

  let result: PanelForwardResult
  try {
    result = await runner(args)
  } catch (error) {
    usedPorts.delete(port)
    if (error instanceof PanelForwardError) throw error
    throw new PanelForwardError('forward_failed', `openshell forward start failed: ${errorMessage(error)}`)
  }

  if (!Number.isInteger(result.code) || result.code !== 0) {
    usedPorts.delete(port)
    const detail = (result.stderr ?? '').trim()
    throw new PanelForwardError(
      'forward_failed',
      `openshell forward start exited ${String(result.code)}${detail === '' ? '' : `: ${detail}`}`
    )
  }

  const printedUrl = parseForwardUrl(result.stdout ?? '')
  const url = printedUrl ?? `http://127.0.0.1:${port}`
  const actualPort = portFromUrl(url) ?? port
  // CLI 自己报的端口才是实际监听端口；分配的那个端口如果没用上要释放。
  if (actualPort !== port) {
    usedPorts.delete(port)
    usedPorts.add(actualPort)
  }

  forwards.set(workspaceId, { workspaceId, port: actualPort, url, sandboxName, runner })
  log(`panel forward ready: ${workspaceId} -> 127.0.0.1:${actualPort}`)
  return { port: actualPort, url }
}

/** 反代目标端口；undefined = 这个 workspace 的面板容器没唤醒。 */
export function resolvePanelPort(workspaceId: string): number | undefined {
  if (typeof workspaceId !== 'string' || workspaceId === '') return undefined
  return forwards.get(workspaceId)?.port
}

/**
 * 停掉一个 workspace 的转发（best effort：CLI 失败只记日志，映射照样删除，
 * 否则沙箱已经停了、这里还一直返回一个死端口）。
 * 返回是否确实存在过映射。
 */
export async function stopPanelForward(
  workspaceId: string,
  options: StopPanelForwardOptions = {}
): Promise<boolean> {
  if (typeof workspaceId !== 'string' || workspaceId === '') return false
  const entry = forwards.get(workspaceId)
  if (entry === undefined) return false

  forwards.delete(workspaceId)
  usedPorts.delete(entry.port)
  const runner = options.runner ?? entry.runner
  const log = options.log ?? (() => {})

  try {
    const result = await runner(['forward', 'stop', String(entry.port), entry.sandboxName])
    if (result.code !== 0) {
      const detail = (result.stderr ?? '').trim()
      log(
        `panel forward stop ${workspaceId} exited ${String(result.code)}${detail === '' ? '' : `: ${detail}`}`
      )
    }
  } catch (error) {
    log(`panel forward stop ${workspaceId} failed: ${errorMessage(error)}`)
  }
  return true
}

/**
 * 停掉所有转发并重置端口分配（测试清理 / 进程退出）。
 * 每条用 ensure 时注入的 runner，保证测试的假 CLI 也能收到 stop。
 */
export async function stopAllPanelForwards(): Promise<void> {
  for (const workspaceId of [...forwards.keys()]) {
    await stopPanelForward(workspaceId)
  }
  usedPorts.clear()
  nextDefaultPort = DEFAULT_PANEL_BASE_PORT
}
