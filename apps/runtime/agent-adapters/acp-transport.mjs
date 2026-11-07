// JSON-RPC 2.0 over a child process' stdio, for Agent Client Protocol (ACP)
// runtimes (docs/design/agent-runtimes.md §6.1: Grok Build native ACP and the
// codex-acp adapter).
//
// Scope and non-goals:
// - Transport only: correlation ids, timeouts, notifications, server->client
//   requests and shutdown. It knows nothing about sessions or AgentEvents.
// - Zero dependencies. `spawn` is injectable so tests use a fake duplex child
//   instead of a vendor binary.
// - Framing is an injected strategy. ACP currently writes newline-delimited
//   JSON; isolating encode/decode here means a future `Content-Length` framed
//   variant (LSP-style) is a new framing object, not a transport rewrite.
//
// Error codes are local strings on TransportError; JSON-RPC error objects from
// the peer are surfaced verbatim as `error.rpc`.
//
// Unverified against a real Grok Build: the ACP method names themselves belong
// to the adapter (see acp-adapter.mjs). This module only moves frames.

import { spawn as nodeSpawn } from 'node:child_process'

/** A transport-level failure with a stable local code. */
export class TransportError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'TransportError'
    this.code = code
    // Raw JSON-RPC error object from the peer, when the failure came from one.
    this.rpc = options.rpc
    this.cause = options.cause
  }
}

/**
 * Newline-delimited JSON framing (the ACP/stdin convention).
 *
 * A `createDecoder` instance is stateful on purpose: a chunk may split a frame,
 * and one chunk may carry several frames, so the decoder keeps the remainder
 * until the next push. `end()` flushes a final unframed line if the peer forgot
 * the trailing newline.
 */
export function createLineFraming(options = {}) {
  const maxBufferBytes = options.maxBufferBytes ?? 8 * 1024 * 1024
  return {
    name: 'newline-delimited-json',
    encode(message) {
      return `${JSON.stringify(message)}\n`
    },
    createDecoder(onMessage, onError) {
      let buffer = ''
      const fail = (code, message) => {
        if (typeof onError === 'function') onError(new TransportError(code, message))
      }
      const parseLine = (line) => {
        const trimmed = line.replace(/\r$/, '').trim()
        if (trimmed === '') return
        let message
        try {
          message = JSON.parse(trimmed)
        } catch (error) {
          fail('transport.bad_json', `dropping a frame that is not JSON: ${String(error.message).slice(0, 120)}`)
          return
        }
        if (message === null || typeof message !== 'object' || Array.isArray(message)) {
          fail('transport.bad_frame', 'dropping a JSON-RPC frame that is not an object')
          return
        }
        onMessage(message)
      }
      return {
        push(chunk) {
          buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
          if (buffer.length > maxBufferBytes) {
            fail('transport.frame_too_large', `frame buffer exceeded ${maxBufferBytes} bytes; dropping it`)
            buffer = ''
            return
          }
          let index = buffer.indexOf('\n')
          while (index >= 0) {
            const line = buffer.slice(0, index)
            buffer = buffer.slice(index + 1)
            parseLine(line)
            index = buffer.indexOf('\n')
          }
        },
        end() {
          if (buffer.trim() !== '') parseLine(buffer)
          buffer = ''
        },
      }
    },
  }
}

/** The default framing, exported so callers can pass it explicitly. */
export const LINE_FRAMING = createLineFraming()

function resolveFraming(framing) {
  if (framing === undefined) return LINE_FRAMING
  if (typeof framing === 'string') {
    if (framing === 'line' || framing === 'newline' || framing === LINE_FRAMING.name) return LINE_FRAMING
    throw new TypeError(`unknown ACP framing: ${framing}`)
  }
  if (typeof framing.encode !== 'function' || typeof framing.createDecoder !== 'function') {
    throw new TypeError('ACP framing must provide encode() and createDecoder()')
  }
  return framing
}

/**
 * Create a JSON-RPC transport over one child process.
 *
 * @param {object} options
 * @param {Function} options.spawn child_process.spawn-compatible function (injected in tests)
 * @param {string} options.command runtime binary
 * @param {string[]} [options.args]
 * @param {Record<string,string>} [options.env] complete env for the child
 * @param {string} [options.cwd]
 * @param {object|string} [options.framing] framing strategy (default newline JSON)
 * @param {number} [options.requestTimeoutMs] default per-request timeout; 0 disables
 * @param {number} [options.closeGraceMs] graceful stdin close before SIGTERM
 * @param {(level: 'stderr'|'protocol'|'transport', message: string) => void} [options.onDiagnostic]
 */
export function createAcpTransport(options = {}) {
  const {
    spawn = nodeSpawn,
    command,
    args = [],
    env,
    cwd,
    requestTimeoutMs = 30_000,
    closeGraceMs = 500,
    onDiagnostic,
  } = options
  if (typeof spawn !== 'function') throw new TypeError('createAcpTransport requires a spawn function')
  if (typeof command !== 'string' || command === '') throw new TypeError('createAcpTransport requires a command')
  if (!Array.isArray(args)) throw new TypeError('createAcpTransport args must be an array')
  const framing = resolveFraming(options.framing)

  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (child === null || typeof child !== 'object') throw new TypeError('spawn did not return a child process')

  const pending = new Map()
  const notificationHandlers = new Set()
  const requestHandlers = new Set()
  const exitHandlers = new Set()
  let nextId = 1
  let closed = false
  let closing = null
  let exitInfo = null

  const diagnostic = (level, message) => {
    if (typeof onDiagnostic !== 'function') return
    try {
      onDiagnostic(level, message)
    } catch {
      // A bad diagnostic sink must not break the protocol.
    }
  }

  const rejectPending = (error) => {
    for (const [id, entry] of pending) {
      pending.delete(id)
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  const onExit = (code, signal) => {
    exitInfo = { code, signal }
    if (closed) return
    closed = true
    try {
      decoder.end()
    } catch {
      // ignore
    }
    rejectPending(new TransportError('transport.exit', `agent process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`))
    for (const handler of exitHandlers) {
      try {
        handler(exitInfo)
      } catch {
        // exit observers are isolated
      }
    }
  }

  const writeFrame = (text) => {
    if (closed) throw new TransportError('transport.closed', 'transport is closed')
    const stdin = child.stdin
    if (stdin === null || stdin === undefined) throw new TransportError('transport.no_stdin', 'child process has no stdin')
    try {
      stdin.write(text)
    } catch (error) {
      throw new TransportError('transport.write_failed', `could not write to the agent: ${String(error?.message ?? error)}`, { cause: error })
    }
  }

  const handleRequest = (message) => {
    const request = {
      id: message.id,
      method: message.method,
      params: message.params,
      raw: message,
    }
    void (async () => {
      for (const handler of requestHandlers) {
        let result
        try {
          result = await handler(request)
        } catch (error) {
          const rpc = error instanceof TransportError && typeof error.rpc?.code === 'number'
            ? error.rpc
            : { code: -32603, message: String(error?.message ?? error) }
          try {
            sendError(message.id, rpc)
          } catch {
            return
          }
          return
        }
        if (result !== undefined) {
          try {
            sendResult(message.id, result)
          } catch {
            // The peer went away while its request was being answered.
          }
          return
        }
      }
      diagnostic('protocol', `no handler for agent request ${String(message.method)}; replying -32601`)
      try {
        sendError(message.id, { code: -32601, message: `method not found: ${String(message.method)}` })
      } catch {
        // ignore
      }
    })()
  }

  const handleMessage = (message) => {
    if (message === null || typeof message !== 'object') return
    const hasId = Object.hasOwn(message, 'id') && message.id !== null && message.id !== undefined
    const method = typeof message.method === 'string' ? message.method : undefined
    if (method !== undefined && hasId) {
      handleRequest(message)
      return
    }
    if (method !== undefined) {
      for (const handler of notificationHandlers) {
        try {
          handler({ method, params: message.params, raw: message })
        } catch (error) {
          diagnostic('protocol', `notification handler failed: ${String(error?.message ?? error)}`)
        }
      }
      return
    }
    if (!hasId) {
      diagnostic('protocol', 'dropping a JSON-RPC message with neither method nor id')
      return
    }
    const entry = pending.get(message.id)
    if (entry === undefined) {
      diagnostic('protocol', `received a response for unknown request id ${String(message.id)}`)
      return
    }
    pending.delete(message.id)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    if (message.error !== undefined && message.error !== null) {
      entry.reject(new TransportError('transport.rpc_error', String(message.error.message ?? 'JSON-RPC error'), { rpc: message.error }))
      return
    }
    entry.resolve(message.result)
  }

  const decoder = framing.createDecoder(
    handleMessage,
    (error) => diagnostic('protocol', `${error.code}: ${error.message}`),
  )

  child.stdout?.on('data', (chunk) => {
    try {
      decoder.push(chunk)
    } catch (error) {
      diagnostic('transport', `decoder failed: ${String(error?.message ?? error)}`)
    }
  })
  child.stdout?.on('end', () => {
    try {
      decoder.end()
    } catch {
      // ignore
    }
  })
  child.stderr?.on('data', (chunk) => {
    // stderr is diagnostic only; it never enters the JSON-RPC stream.
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    for (const line of text.split('\n')) {
      if (line.trim() !== '') diagnostic('stderr', line.trim())
    }
  })
  child.on('error', (error) => {
    diagnostic('transport', `child error: ${String(error?.message ?? error)}`)
    if (!closed) {
      closed = true
      rejectPending(new TransportError('transport.spawn_failed', String(error?.message ?? error), { cause: error }))
    }
  })
  child.on('exit', (code, signal) => onExit(code, signal))

  function sendRequest(method, params, requestOptions = {}) {
    if (typeof method !== 'string' || method === '') throw new TypeError('sendRequest needs a method')
    if (closed) return Promise.reject(new TransportError('transport.closed', 'transport is closed'))
    const id = nextId++
    const timeoutMs = requestOptions.timeoutMs ?? requestTimeoutMs
    const frame = framing.encode({ jsonrpc: '2.0', id, method, params: params ?? {} })
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: undefined, method }
      if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          pending.delete(id)
          reject(new TransportError('transport.timeout', `${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        if (typeof entry.timer.unref === 'function') entry.timer.unref()
      }
      pending.set(id, entry)
      try {
        writeFrame(frame)
      } catch (error) {
        pending.delete(id)
        if (entry.timer !== undefined) clearTimeout(entry.timer)
        reject(error)
      }
    })
  }

  function notify(method, params) {
    if (typeof method !== 'string' || method === '') throw new TypeError('notify needs a method')
    if (closed) return false
    writeFrame(framing.encode({ jsonrpc: '2.0', method, params: params ?? {} }))
    return true
  }

  function sendResult(id, result) {
    writeFrame(framing.encode({ jsonrpc: '2.0', id, result: result ?? {} }))
  }

  function sendError(id, error) {
    writeFrame(framing.encode({ jsonrpc: '2.0', id, error }))
  }

  function onNotification(handler) {
    if (typeof handler !== 'function') throw new TypeError('onNotification needs a handler')
    notificationHandlers.add(handler)
    return () => notificationHandlers.delete(handler)
  }

  /**
   * Observe agent->client requests (ACP permission prompts, fs/terminal
   * requests). The first handler that returns a value answers the request; if
   * none do, the transport replies JSON-RPC -32601.
   */
  function onRequest(handler) {
    if (typeof handler !== 'function') throw new TypeError('onRequest needs a handler')
    requestHandlers.add(handler)
    return () => requestHandlers.delete(handler)
  }

  function onExitEvent(handler) {
    if (typeof handler !== 'function') throw new TypeError('onExit needs a handler')
    exitHandlers.add(handler)
    if (exitInfo !== null) queueMicrotask(() => handler(exitInfo))
    return () => exitHandlers.delete(handler)
  }

  /** End stdin, then escalate SIGTERM -> SIGKILL until the child is gone. */
  async function close() {
    if (closing !== null) return closing
    closing = (async () => {
      if (closed) return
      try {
        child.stdin?.end?.()
      } catch {
        // stdin may already be destroyed
      }
      const exited = await waitForExit(closeGraceMs)
      if (!exited) {
        try {
          child.kill?.('SIGTERM')
        } catch {
          // ignore
        }
        const killed = await waitForExit(closeGraceMs)
        if (!killed) {
          try {
            child.kill?.('SIGKILL')
          } catch {
            // ignore
          }
        }
      }
      closed = true
      rejectPending(new TransportError('transport.closed', 'transport was closed'))
    })()
    return closing
  }

  function waitForExit(timeoutMs) {
    if (exitInfo !== null) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve(false)
      }, Math.max(1, timeoutMs))
      if (typeof timer.unref === 'function') timer.unref()
      const unsubscribe = onExitEvent(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsubscribe()
        resolve(true)
      })
    })
  }

  return {
    get pid() {
      return child.pid ?? null
    },
    get exitInfo() {
      return exitInfo
    },
    sendRequest,
    notify,
    sendResult,
    sendError,
    onNotification,
    onRequest,
    onExit: onExitEvent,
    close,
    isClosed: () => closed,
    framing: framing.name,
    child,
  }
}

export const ACP_TRANSPORT_DEFAULTS = Object.freeze({
  requestTimeoutMs: 30_000,
  closeGraceMs: 500,
})
