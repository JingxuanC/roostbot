// Runtime adapter registry (docs/design/agent-runtimes.md §6.1).
//
// One place maps an AgentRuntimeKind to an AgentAdapter implementation, so the
// supervisor and (later) room-agent never construct a vendor adapter inline:
//
//   dsh          DSH SDK JSON-RPC, delegated to the current room-agent session
//   grok-build   ACP (native)
//   codex        ACP (codex-acp)
//   claude-code  NDJSON CLI (official CLI stream-json fallback)
//   hermes       deliberately unsupported here (design §20 question 4)
//
// Not wired into room-agent yet. Everything is injectable: ACP takes a transport
// factory, the CLI takes spawn/parser, and the DSH adapter takes a delegate (the
// room-agent's current session) or a JsonRpcProcessClient-compatible object.

import { AgentRuntimeError, defaultCapabilities } from '../../../packages/agent-runtime/src/index.ts'
import { createAcpAdapter } from './acp-adapter.mjs'
import { createCliAdapter } from './cli-adapter.mjs'

/**
 * DSH adapter: wraps a session that the room agent already owns.
 *
 * Two supported shapes (in order):
 * - `config.delegate.openSession(spec)` — the room-agent passes its current
 *   session factory; the adapter is then a pure delegation with no protocol
 *   knowledge. This is the intended integration path.
 * - `config.client` / `config.rpc` — a `JsonRpcProcessClient`-compatible object
 *   (`request(method, params)`, `on(method, handler)`, `close()`). This speaks
 *   the DSH SDK protocol directly and is used by tests/scaffolding.
 *
 * DSH-owned details kept out of the adapter contract:
 * - the process/`initialize` handshake belongs to room-agent;
 * - `session/resume` is best-effort (a sandbox restart keeps the session);
 * - cancellation is best-effort `session/cancel` plus a local turn end, because
 *   the SDK protocol's only cancellation mechanism today is the room actor's
 *   abort signal (room-agent never sends a cancel request).
 *
 * ⚠️ `assistant/tool-call` / `assistant/tool-result` and `session/cancel` are
 * not part of the DSH event shapes observed in room-agent.mjs; they are mapped
 * opportunistically and documented here for the integration review.
 */
export function createDshAdapter(config = {}) {
  const delegate = config.delegate ?? null
  const client = config.client ?? config.rpc ?? null
  const capabilities = typeof config.capabilities === 'function'
    ? config.capabilities
    : () => defaultCapabilities('dsh')

  async function probe() {
    if (typeof config.probe === 'function') return config.probe()
    if (delegate !== null && typeof delegate.probe === 'function') return delegate.probe()
    return {
      ok: client !== null || delegate !== null,
      version: typeof config.version === 'string' ? config.version : undefined,
      binary: typeof config.binary === 'string' ? config.binary : 'dsh-sdk',
      auth: 'ok',
      problems: client === null && delegate === null ? ['dsh adapter needs a delegate or a JsonRpcProcessClient-compatible client'] : [],
    }
  }

  async function openSession(spec) {
    if (delegate !== null && typeof delegate.openSession === 'function') {
      const session = await delegate.openSession(spec)
      if (session === null || typeof session !== 'object') {
        throw new AgentRuntimeError('dsh.delegate_failed', 'delegate.openSession returned no session')
      }
      return session
    }
    if (typeof config.sessionFactory === 'function') {
      return config.sessionFactory(spec)
    }
    if (client === null || typeof client.request !== 'function' || typeof client.on !== 'function') {
      throw new AgentRuntimeError(
        'runtime.misconfigured',
        'dsh adapter needs config.delegate.openSession(spec) or config.client (JsonRpcProcessClient shape)',
      )
    }
    return createDshRpcSession({ client, spec, config })
  }

  return { kind: 'dsh', probe, capabilities, openSession }
}

function createDshRpcSession({ client, spec, config }) {
  if (typeof spec?.sessionId !== 'string' || spec.sessionId === '') {
    throw new AgentRuntimeError('session.invalid', 'spec.sessionId is required')
  }
  const sessionId = spec.sessionId
  const turnTimeoutMs = Number.isFinite(config.turnTimeoutMs) ? Math.max(0, config.turnTimeoutMs) : 240_000
  let prepared = false
  let active = null
  let turnCount = 0
  let closed = false

  function createQueue() {
    const items = []
    const waiters = []
    let done = false
    return {
      push(item) {
        if (done) return
        const waiter = waiters.shift()
        if (waiter !== undefined) waiter({ value: item, done: false })
        else items.push(item)
      },
      close() {
        done = true
        while (waiters.length > 0) waiters.shift()({ value: undefined, done: true })
      },
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (items.length > 0) return Promise.resolve({ value: items.shift(), done: false })
            if (done) return Promise.resolve({ value: undefined, done: true })
            return new Promise((resolve) => waiters.push(resolve))
          },
          return() {
            done = true
            return Promise.resolve({ value: undefined, done: true })
          },
        }
      },
    }
  }

  async function prepare() {
    if (prepared) return
    prepared = true
    try {
      await client.request('session/resume', { sessionId })
    } catch {
      // A fresh session id is legitimate; the prompt creates it.
    }
  }

  function send(turn, sendOptions = {}) {
    if (closed) throw new AgentRuntimeError('session.closed', 'dsh session is closed')
    if (active !== null) throw new AgentRuntimeError('session.busy', 'one turn at a time per DSH session')
    if (typeof turn?.turnId !== 'string' || turn.turnId === '') {
      throw new AgentRuntimeError('session.invalid', 'turn.turnId is required')
    }
    turnCount += 1
    const queue = createQueue()
    const state = {
      turnId: turn.turnId,
      seq: 0,
      text: '',
      finalText: null,
      finalEmitted: false,
      usageEmitted: false,
      ended: false,
      cleanups: [],
      emit(event) {
        if (state.ended) return
        queue.push({ ...event, turnId: state.turnId })
      },
      emitFinal(text) {
        if (state.ended || state.finalEmitted) return
        if (typeof text !== 'string' || text === '') return
        state.finalEmitted = true
        state.emit({ type: 'text.final', text })
      },
    }
    const finish = (reason, terminal = {}) => {
      if (state.ended) return
      if (terminal.error !== undefined) {
        state.emit({ type: 'error', code: terminal.code ?? 'dsh.turn_error', message: terminal.error, retryable: false })
      }
      if (reason === 'stop') {
        if (!state.usageEmitted) {
          state.usageEmitted = true
          state.emit({
            type: 'usage',
            inputTokens: Math.ceil(String(turn.input ?? '').length / 4),
            outputTokens: Math.ceil((state.finalText ?? state.text).length / 4),
            estimated: true,
          })
        }
        state.emitFinal(state.finalText ?? state.text)
      }
      queue.push({ type: 'turn.ended', turnId: state.turnId, reason })
      state.ended = true
      queue.close()
      for (const cleanup of state.cleanups.splice(0)) {
        try {
          cleanup()
        } catch {
          // ignore
        }
      }
      if (active !== null && active.state === state) active = null
    }
    active = { state, turnId: turn.turnId, finish }

    const timeoutMs = typeof sendOptions.timeoutMs === 'number' && sendOptions.timeoutMs > 0
      ? sendOptions.timeoutMs
      : turnTimeoutMs
    if (timeoutMs > 0) {
      const timer = setTimeout(() => finish('timeout'), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      state.cleanups.push(() => clearTimeout(timer))
    }
    if (turn.signal !== null && turn.signal !== undefined && typeof turn.signal.addEventListener === 'function') {
      const onAbort = () => {
        if (!state.ended) void cancel(turn.turnId, 'user')
      }
      turn.signal.addEventListener('abort', onAbort, { once: true })
      state.cleanups.push(() => turn.signal.removeEventListener('abort', onAbort))
    }

    state.emit({ type: 'turn.started', at: Date.now() })

    const onEvent = (params) => {
      if (state.ended) return
      if (typeof params?.sessionId === 'string' && params.sessionId !== sessionId) return
      const event = params?.event
      if (event === null || typeof event !== 'object') return
      if (event.type === 'assistant/live-chunk') {
        const chunk = event.data?.chunk
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
          state.text += chunk.text
          state.seq += 1
          state.emit({ type: 'text.delta', seq: state.seq, text: chunk.text })
        }
        return
      }
      if (event.type === 'assistant/message') {
        const content = event.data?.message?.content
        if (!Array.isArray(content)) return
        const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('')
        if (text === '') return
        state.finalText = text
        state.emitFinal(text)
        return
      }
      if (event.type === 'usage' || event.data?.usage !== undefined) {
        const usage = event.usage ?? event.data?.usage ?? {}
        state.usageEmitted = true
        state.emit({
          type: 'usage',
          ...(typeof usage.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
          ...(typeof usage.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
          estimated: event.estimated === true,
        })
        return
      }
      // Unverified DSH tool event spellings; mapped opportunistically.
      if (event.type === 'assistant/tool-call') {
        state.emit({
          type: 'tool.call',
          callId: String(event.data?.toolCall?.id ?? event.data?.id ?? `dsh-tool-${state.seq + 1}`),
          name: String(event.data?.toolCall?.name ?? event.data?.name ?? 'tool'),
          input: event.data?.toolCall?.input ?? event.data?.input ?? null,
        })
        return
      }
      if (event.type === 'assistant/tool-result') {
        state.emit({
          type: 'tool.result',
          callId: String(event.data?.toolCallId ?? event.data?.toolResult?.id ?? ''),
          ok: event.data?.ok !== false,
          ...(event.data?.ok === false
            ? { error: String(event.data?.error ?? 'tool failed') }
            : { output: event.data?.output ?? null }),
        })
      }
    }
    const onStatus = (params) => {
      if (state.ended) return
      if (typeof params?.sessionId === 'string' && params.sessionId !== sessionId) return
      if (params?.status === 'idle') finish('stop')
    }

    try {
      client.on('session.event', onEvent)
      client.on('session.status', onStatus)
    } catch (error) {
      finish('error', { error: `could not register DSH session handlers: ${String(error?.message ?? error)}` })
      return queue
    }
    state.cleanups.push(() => {
      // JsonRpcProcessClient has no unsubscribe; the room-agent integration
      // replaces this with its own delegate that routes per-session events.
      try {
        client.on('session.event', () => {})
        client.on('session.status', () => {})
      } catch {
        // ignore
      }
    })

    void (async () => {
      try {
        await prepare()
        await client.request('session/prompt', {
          sessionId,
          contentBlocks: [{ type: 'text', text: String(turn.input ?? '') }],
        })
      } catch (error) {
        if (!state.ended) {
          finish('error', {
            code: 'dsh.prompt_failed',
            error: String(error?.message ?? error),
          })
        }
      }
    })()

    return queue
  }

  async function cancel(turnId, reason) {
    if (closed) return
    const current = active
    if (current === null || current.turnId !== turnId) return
    try {
      await client.request('session/cancel', { sessionId })
    } catch {
      // Not part of the current DSH session protocol; local end is authoritative.
    }
    current.finish('cancelled')
    void reason
  }

  async function close() {
    if (closed) return
    closed = true
    if (active !== null) active.finish('cancelled')
  }

  return {
    id: spec.sessionId,
    send,
    cancel,
    close,
    async snapshot() {
      return {
        kind: 'dsh',
        sessionId: spec.sessionId,
        turns: turnCount,
        activeTurnId: active?.turnId ?? null,
        closed,
      }
    },
  }
}

/** adapter kinds this registry can construct today. */
export const REGISTRY_KINDS = Object.freeze(['dsh', 'grok-build', 'codex', 'claude-code', 'hermes'])

/**
 * Create the adapter for one runtime kind.
 *
 * @param {'dsh'|'grok-build'|'codex'|'claude-code'|'hermes'} kind
 * @param {object} [config] adapter-specific configuration; see each factory
 * @returns {import('../../../packages/agent-runtime/src/index.ts').AgentAdapter}
 */
export function createRuntimeAdapter(kind, config = {}) {
  switch (kind) {
    case 'dsh':
      return createDshAdapter(config)
    case 'grok-build':
    case 'codex':
      return createAcpAdapter({ ...config, kind })
    case 'claude-code':
      return createCliAdapter({ ...config, kind })
    case 'hermes':
      throw new AgentRuntimeError(
        'runtime.unsupported',
        'hermes adapter is not implemented: API vs CLI is still open (design §20)',
      )
    default:
      throw new AgentRuntimeError('runtime.unsupported', `unsupported runtime: ${String(kind)}`)
  }
}
