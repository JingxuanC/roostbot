// 空闲睡眠：沙箱闲置一段时间后 stop，再有活动时 start。
//
// 设计见 docs/design/scheduling.md §9（睡眠与唤醒握手）、docs/design/sandboxing.md §15
// 与 docs/build/wave2.md §E：
//   * 这里只做本地状态机，不引进程模型、不引依赖；
//   * 只导出，谁在 room-agent / 控制面里启动由 Lead 决定；
//   * 停/启走注入的 backend（OpenShell 的 stop/start），本模块不碰 Docker。
//
// 重要限制（docs/design/scheduling.md §9）：容器不该自己决定睡眠。本模块是
// 给「控制面/room-agent 已经决定要睡」的场景用的执行器；没有接 `/internal/power`
// 之前不要自动启用。

const DEFAULT_IDLE_MS = 30 * 60_000
const DEFAULT_POLL_MS = 60_000
const PHASES = new Set(['ready', 'stopped', 'error', 'unknown'])

/**
 * 决定空闲状态机下一步。纯函数。
 *
 * - ready：闲置 >= idleMs → 'stop'，否则 'none'；
 * - stopped：最近 idleMs 内有过活动（touch 把 lastActivityAt 推到停睡之后）→ 'wake'，
 *   否则 'none'。刚停完时 lastActivityAt 已经至少 idleMs 老，所以不会立刻醒来；
 * - error / unknown：'none'，坏状态交给上层修复，不在这里自愈重启。
 *
 * @param {{ lastActivityAt: number, now: number, idleMs: number, phase: string }} input
 * @returns {'stop' | 'wake' | 'none'}
 */
export function planIdleAction(input) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('planIdleAction input must be an object')
  }
  const lastActivityAt = readFinite('lastActivityAt', input.lastActivityAt)
  const now = readFinite('now', input.now)
  const idleMs = readIdleMs(input.idleMs)
  const phase = normalizePhase(input.phase)
  const idleFor = now - lastActivityAt

  if (phase === 'ready') return idleFor >= idleMs ? 'stop' : 'none'
  if (phase === 'stopped') return idleFor < idleMs ? 'wake' : 'none'
  return 'none'
}

/**
 * 启动空闲睡/醒状态机。
 *
 * backend 必须提供 `stop(sandbox)` / `start(sandbox)`（可以是同步或返回 Promise）。
 * tick 内按 planIdleAction 的结果调用其中一个；并发的 tick 会合并成一次，
 * 重复 tick 不会重复 stop/start。touch() 表示「有人/有活要用沙箱」。
 *
 * @param {{
 *   backend: { stop: (sandbox: unknown) => unknown, start: (sandbox: unknown) => unknown },
 *   sandbox: unknown,
 *   idleMs?: number,
 *   pollMs?: number,
 *   phase?: string,
 *   now?: () => number,
 *   log?: (message: string) => void,
 * }} options
 * @returns {{ tick: () => Promise<'stop'|'wake'|'none'>, touch: (at?: number) => void,
 *   stop: () => void, state: () => { phase: string, lastActivityAt: number, idleMs: number } }}
 */
export function startIdleSleeper(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('startIdleSleeper options must be an object')
  }
  const backend = options.backend
  if (backend === null || typeof backend !== 'object' || typeof backend.stop !== 'function' || typeof backend.start !== 'function') {
    throw new TypeError('backend must provide stop() and start()')
  }
  if (options.sandbox === undefined || options.sandbox === null) {
    throw new TypeError('sandbox is required')
  }

  const idleMs = readIdleMs(options.idleMs === undefined ? DEFAULT_IDLE_MS : options.idleMs)
  const pollMs = readPollMs(options.pollMs === undefined ? DEFAULT_POLL_MS : options.pollMs)
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const log = typeof options.log === 'function' ? options.log : () => {}

  const sandbox = options.sandbox
  const label = sandboxLabel(sandbox)
  const createdAt = now()
  const initialPhase = normalizePhase(
    options.phase === undefined ? sandboxPhase(sandbox) : options.phase,
  )
  const state = {
    phase: initialPhase,
    // ready：现在算一次活动，给满一个 idle 窗口；stopped/error/unknown：
    // 构造本身不算活动，等 touch() 才唤醒（否则启动即醒，睡不回去）。
    lastActivityAt: initialPhase === 'ready' ? createdAt : createdAt - idleMs,
    idleMs,
  }

  let stopped = false
  let inFlight = null
  let timer = null

  async function runTick() {
    if (stopped) return 'none'
    const at = now()
    const action = planIdleAction({
      lastActivityAt: state.lastActivityAt,
      now: at,
      idleMs: state.idleMs,
      phase: state.phase,
    })

    if (action === 'stop') {
      try {
        await backend.stop(sandbox)
        state.phase = 'stopped'
        log(`idle-sleeper: stopped ${label} after ${at - state.lastActivityAt}ms idle`)
        return 'stop'
      } catch (err) {
        state.phase = 'error'
        log(`idle-sleeper: stop ${label} failed: ${errorMessage(err)}`)
        return 'none'
      }
    }

    if (action === 'wake') {
      try {
        await backend.start(sandbox)
        state.phase = 'ready'
        // 醒来这一刻算一次活动：否则下一次 tick 会立刻又满足 idle 条件。
        state.lastActivityAt = at
        log(`idle-sleeper: started ${label} on activity`)
        return 'wake'
      } catch (err) {
        state.phase = 'error'
        log(`idle-sleeper: start ${label} failed: ${errorMessage(err)}`)
        return 'none'
      }
    }

    return 'none'
  }

  function tick() {
    if (stopped) return Promise.resolve('none')
    if (inFlight !== null) return inFlight
    inFlight = runTick().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  /** 记录一次活动。停在 stopped 上的沙箱会在下一次 tick 被叫醒。 */
  function touch(at) {
    const atMs = at === undefined ? now() : readFinite('touch.at', at)
    state.lastActivityAt = Math.max(state.lastActivityAt, atMs)
  }

  /** 停止状态机本身（不 stop 沙箱）；幂等。 */
  function stop() {
    if (stopped) return
    stopped = true
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function snapshot() {
    return { phase: state.phase, lastActivityAt: state.lastActivityAt, idleMs: state.idleMs }
  }

  timer = setInterval(() => {
    void tick()
  }, pollMs)
  // 后台状态机不拖住进程退出。
  timer.unref?.()

  return { tick, touch, stop, state: snapshot }
}

// ---- 内部 --------------------------------------------------------------------

function readFinite(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`)
  }
  return value
}

function readIdleMs(value) {
  const idleMs = readFinite('idleMs', value)
  if (idleMs <= 0) throw new TypeError('idleMs must be > 0')
  return idleMs
}

function readPollMs(value) {
  const pollMs = readFinite('pollMs', value)
  if (pollMs <= 0) throw new TypeError('pollMs must be > 0')
  return pollMs
}

function normalizePhase(raw) {
  if (typeof raw !== 'string') return 'unknown'
  const phase = raw.trim().toLowerCase()
  return PHASES.has(phase) ? phase : 'unknown'
}

function sandboxPhase(sandbox) {
  return sandbox !== null && typeof sandbox === 'object' ? sandbox.phase : undefined
}

function sandboxLabel(sandbox) {
  if (sandbox === null || typeof sandbox !== 'object') return 'sandbox'
  const name = sandbox.name ?? sandbox.id
  return typeof name === 'string' && name !== '' ? name : 'sandbox'
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err)
}
