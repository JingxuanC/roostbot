// 沙箱里的 `dsh web` 子进程（插件面板容器；ADR 0004 / plugin-marketplace.md §3 C 级）。
//
// 只负责三件事：把进程拉起来、等它就绪、失败/退出时收拾干净。
//   - 只绑 127.0.0.1（端口默认 4099）；外部只能经控制面 /w/<workspace>/dsh/* 反代。
//   - 就绪判定：GET http://127.0.0.1:<port>/ 返回 200 且 body 含 `<!doctype html`（大小写不敏感）。
//   - 失败一律返回 { ready: false }，**不抛**：面板容器起不来不能拖垮房间对话（room-agent）。
//
// startDshWeb() 会等到就绪或超时才返回（ready 是布尔值）；room-agent 在后台调用它，
// 以免 dsh web 的启动时间拖慢 SDK 会话的 initialize。

import { spawn } from 'node:child_process'

/** 沙箱内 dsh web 的默认端口（与 surface.ts 的 DSH_WEB_PORT 一致）。 */
export const DEFAULT_DSH_WEB_PORT = 4099

/** 默认就绪超时：真机上 dsh web 首次启动要加载 profile，给足时间。 */
export const DEFAULT_READY_TIMEOUT_MS = 20_000

/** 探活间隔。 */
export const DEFAULT_POLL_INTERVAL_MS = 100

/** SIGTERM 之后等多久补 SIGKILL。 */
export const DEFAULT_STOP_TIMEOUT_MS = 3_000

/** 单次探活的 HTTP 超时上限。 */
const PROBE_TIMEOUT_MS = 1_000

/** 就绪判定标记（小写比较）。 */
const READY_MARKER = '<!doctype html'

/** 子进程 stdout/stderr 各留最后这么多字符，只用于失败日志。 */
const OUTPUT_TAIL_LIMIT = 4_000

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function validPort(value) {
  return Number.isInteger(value) && value > 0 && value < 65_536
}

/** 可被 abort 打断的 sleep：room-agent stop 时不必等满一拍。 */
function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve) => {
    let timer
    const done = () => {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', done)
      resolve()
    }
    timer = setTimeout(done, ms)
    if (signal !== undefined) {
      if (signal.aborted) done()
      else signal.addEventListener('abort', done, { once: true })
    }
  })
}

/** 单次探活：200 + HTML 壳才算就绪；任何异常都当作「还没起来」。 */
async function probeOnce(port, timeoutMs, signal) {
  const timeout = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))
  const probeSignal = signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'GET',
      headers: { accept: 'text/html' },
      redirect: 'manual',
      signal: probeSignal
    })
    if (response.status !== 200) {
      // 把 body 排空，避免 keep-alive 连接占着上游。
      await response.text().catch(() => '')
      return false
    }
    const body = await response.text()
    return body.toLowerCase().includes(READY_MARKER)
  } catch {
    return false
  }
}

/**
 * 启动 `dsh web --port <port> --no-open` 并轮询就绪。
 *
 * @param {object} [options]
 * @param {number} [options.port=4099]
 * @param {string} [options.bin='dsh']
 * @param {(line: string) => void} [options.log]
 * @param {number} [options.readyTimeoutMs=20000]
 * @param {number} [options.pollIntervalMs=100]
 * @param {number} [options.stopTimeoutMs=3000]
 * @param {AbortSignal} [options.signal] 提前取消（room-agent stop）
 * @param {Record<string, string>} [options.env] 追加/覆盖子进程环境变量
 * @returns {Promise<{ready: boolean, port: number, url: string, pid: number | undefined, stop: () => Promise<void>}>}
 */
export async function startDshWeb(options = {}) {
  const port = validPort(options.port) ? options.port : DEFAULT_DSH_WEB_PORT
  const bin = typeof options.bin === 'string' && options.bin !== '' ? options.bin : 'dsh'
  const log = typeof options.log === 'function' ? options.log : () => {}
  const readyTimeoutMs =
    Number.isFinite(options.readyTimeoutMs) && options.readyTimeoutMs >= 0
      ? options.readyTimeoutMs
      : DEFAULT_READY_TIMEOUT_MS
  const pollIntervalMs =
    Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs > 0
      ? options.pollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS
  const stopTimeoutMs =
    Number.isFinite(options.stopTimeoutMs) && options.stopTimeoutMs >= 0
      ? options.stopTimeoutMs
      : DEFAULT_STOP_TIMEOUT_MS
  const signal = options.signal
  const url = `http://127.0.0.1:${port}/`

  let child = null
  let closed = false
  let exitDescription = ''
  let stderrTail = ''
  let stdoutTail = ''
  let stopping = null

  /** 幂等停止：SIGTERM → 超时 SIGKILL；返回的 promise 在进程退出（或兜底超时）后 resolve。 */
  const stop = () => {
    if (stopping !== null) return stopping
    stopping = new Promise((resolve) => {
      if (child === null || closed) {
        resolve()
        return
      }
      let finished = false
      let killTimer
      let hardTimer
      const finish = () => {
        if (finished) return
        finished = true
        if (killTimer !== undefined) clearTimeout(killTimer)
        if (hardTimer !== undefined) clearTimeout(hardTimer)
        resolve()
      }
      child.once('exit', finish)
      child.once('close', finish)
      child.once('error', finish)
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          finish()
          return
        }
        // SIGKILL 之后仍可能拿不到事件（极端情况）：兜底 resolve，不让调用方挂住。
        hardTimer = setTimeout(finish, 250)
      }, stopTimeoutMs)
      try {
        child.kill('SIGTERM')
      } catch {
        finish()
      }
    })
    return stopping
  }

  const failed = async (reason) => {
    const detail = reason === '' ? 'unknown reason' : reason
    const tail = stderrTail.trim() === '' ? stdoutTail.trim() : stderrTail.trim()
    log(`dsh web not ready: ${detail}${tail === '' ? '' : ` (${tail.slice(-300)})`}`)
    await stop()
    return { ready: false, port, url, pid: child?.pid, stop }
  }

  try {
    // stdin 给 /dev/null：dsh web 不需要交互；stdout/stderr 必须排空，否则子进程会被管道写阻塞。
    child = spawn(bin, ['web', '--port', String(port), '--no-open'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.env ?? {}) }
    })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdoutTail = (stdoutTail + chunk).slice(-OUTPUT_TAIL_LIMIT)
    })
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-OUTPUT_TAIL_LIMIT)
    })
    child.once('error', (error) => {
      closed = true
      exitDescription = `spawn failed: ${errorMessage(error)}`
    })
    child.once('exit', (code, exitSignal) => {
      closed = true
      if (exitDescription === '') exitDescription = `exited (code ${code}, signal ${exitSignal})`
      // 正常 stop 时不重复记日志（stop 的调用方自己知道）。
      if (stopping === null) log(`dsh web exited (code ${code}, signal ${exitSignal})`)
    })

    const deadline = Date.now() + readyTimeoutMs
    for (;;) {
      if (signal?.aborted) return await failed('aborted')
      if (closed) return await failed(exitDescription)
      const remaining = deadline - Date.now()
      if (remaining <= 0) return await failed(`not ready after ${readyTimeoutMs}ms`)
      const ready = await probeOnce(port, Math.min(PROBE_TIMEOUT_MS, remaining), signal)
      if (ready) {
        if (signal?.aborted) return await failed('aborted')
        return { ready: true, port, url, pid: child.pid, stop }
      }
      if (signal?.aborted) return await failed('aborted')
      if (closed) continue // 下一轮循环顶部立刻返回失败
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())), signal)
    }
  } catch (error) {
    // 理论上走不到（spawn 的错误是异步事件），但契约要求绝不抛。
    return await failed(errorMessage(error))
  }
}
