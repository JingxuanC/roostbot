// 深度健康检查：API 探活之外，再查 store / sandbox / gateway（M6-6.6、slo.md §2）。
//
// 每个 probe 由调用方注入（控制面用真实实现，测试用假实现），本模块只负责：
//   1. 并发执行，给每个 probe 一个超时；
//   2. 把「返回 ok:false」记为 failed，把「抛错/超时」记为 down；
//   3. 汇总成三态：任一 down → down；否则任一 failed → degraded；否则 ok。
//
// 不读环境变量、不直接碰 DB/CLI，保证可测且不会把凭据写进 detail。

export type HealthStatus = 'ok' | 'degraded' | 'down'
export type ProbeStatus = 'ok' | 'failed' | 'down'
export type ProbeName = 'api' | 'store' | 'sandbox' | 'gateway'

export interface HealthProbeResult {
  ok: boolean
  detail?: string
}

export type HealthProbe = () => HealthProbeResult | Promise<HealthProbeResult>

export interface HealthProbes {
  api?: HealthProbe
  store?: HealthProbe
  sandbox?: HealthProbe
  gateway?: HealthProbe
}

export interface HealthCheck {
  name: ProbeName
  status: ProbeStatus
  detail?: string
  durationMs: number
}

export interface HealthReport {
  status: HealthStatus
  checks: HealthCheck[]
  /** 报告时刻（ISO date-time）。 */
  at: string
}

export interface RunHealthChecksOptions {
  probes: HealthProbes
  /** epoch 毫秒、Date 或返回毫秒的函数；默认当前时间。 */
  now?: number | Date | (() => number)
  /** 单个 probe 的超时；默认 2000ms。<=0 表示不设超时。 */
  timeoutMs?: number
}

export const DEFAULT_PROBE_TIMEOUT_MS = 2000
export const PROBE_NAMES: readonly ProbeName[] = ['api', 'store', 'sandbox', 'gateway']

const MAX_DETAIL_CHARS = 300

function nowMs(now: number | Date | (() => number) | undefined): number {
  if (typeof now === 'function') {
    const value = now()
    return Number.isFinite(value) ? value : Date.now()
  }
  if (now instanceof Date) {
    const value = now.getTime()
    return Number.isFinite(value) ? value : Date.now()
  }
  if (typeof now === 'number' && Number.isFinite(now)) return now
  return Date.now()
}

function detailOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text
}

class ProbeTimeoutError extends Error {
  constructor(ms: number) {
    super(`probe timed out after ${ms}ms`)
    this.name = 'ProbeTimeoutError'
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProbeTimeoutError(timeoutMs)), timeoutMs)
    // 不要让一个待超时的 probe 拖住进程退出。
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

async function runProbe(name: ProbeName, probe: HealthProbe, timeoutMs: number): Promise<HealthCheck> {
  const startedAt = Date.now()
  try {
    const result = await withTimeout(Promise.resolve().then(probe), timeoutMs)
    const durationMs = Math.max(0, Date.now() - startedAt)
    const ok = typeof result === 'object' && result !== null && (result as HealthProbeResult).ok === true
    const detail = typeof result === 'object' && result !== null ? (result as HealthProbeResult).detail : undefined
    return {
      name,
      status: ok ? 'ok' : 'failed',
      ...(typeof detail === 'string' && detail !== '' ? { detail: detail.slice(0, MAX_DETAIL_CHARS) } : {}),
      durationMs
    }
  } catch (error) {
    return { name, status: 'down', detail: detailOf(error), durationMs: Math.max(0, Date.now() - startedAt) }
  }
}

/** 聚合三态：down 优先，其次 degraded（有 failed），全 ok 才 ok。 */
export function aggregateHealth(checks: readonly HealthCheck[]): HealthStatus {
  if (checks.some((check) => check.status === 'down')) return 'down'
  if (checks.some((check) => check.status === 'failed')) return 'degraded'
  return 'ok'
}

/** 并发跑全部已配置 probe；未配置的跳过，不计入 checks。 */
export async function runHealthChecks(options: RunHealthChecksOptions): Promise<HealthReport> {
  const { probes } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const at = nowMs(options.now)

  const pending: Array<Promise<HealthCheck>> = []
  for (const name of PROBE_NAMES) {
    const probe = probes[name]
    if (typeof probe === 'function') pending.push(runProbe(name, probe, timeoutMs))
  }
  const checks = await Promise.all(pending)

  return {
    status: aggregateHealth(checks),
    checks,
    at: new Date(at).toISOString()
  }
}
