// ACP (Agent Client Protocol) adapter: Grok Build and codex-acp.
//
// docs/design/agent-runtimes.md §6.1 says ACP is one transport option, never a
// requirement; the adapter still has to satisfy the same AgentEvent contract as
// DSH (§7). This module maps ACP `session/update` notifications onto that
// contract and owns the turn state machine: exactly one `turn.ended`, at most
// one `text.final`, and no deltas after cancellation.
//
// The transport is injected (see acp-transport.mjs) so tests script an agent in
// memory. One ACP child process is one session (§12.2 process model).
//
// ⚠️ ACP method/variant names below follow the public ACP JSON-RPC surface as
// of the design date. They have NOT been verified against a real Grok Build or
// codex-acp binary; `ACP_ASSUMPTIONS` lists every guess so the first live probe
// can correct them in one place. The adapter tolerates both `sessionUpdate` and
// `type` discriminants because ACP drafts have used both spellings.

import { AgentRuntimeError, defaultCapabilities } from '../../../packages/agent-runtime/src/index.ts'
import { createAcpTransport } from './acp-transport.mjs'

/**
 * Every protocol name/shape that needs verification against a real runtime.
 * Kept data-shaped so a live probe can compare and a report can cite it.
 */
export const ACP_ASSUMPTIONS = Object.freeze({
  protocol: 'Agent Client Protocol over JSON-RPC 2.0 stdio, newline-delimited',
  initialize: { method: 'initialize', params: ['protocolVersion', 'clientCapabilities', 'clientInfo'], response: ['agentInfo', 'agentCapabilities', 'authMethods'] },
  newSession: { method: 'session/new', params: ['cwd', 'mcpServers', 'systemPrompt?', 'model?'], response: ['sessionId'] },
  loadSession: { method: 'session/load', params: ['sessionId', 'cwd', 'mcpServers'], response: ['sessionId?'] },
  prompt: { method: 'session/prompt', params: ['sessionId', 'prompt:[{type:"text",text}]'], response: ['stopReason'] },
  cancel: { method: 'session/cancel', params: ['sessionId'], kind: 'notification' },
  update: { method: 'session/update', params: ['sessionId', 'update'] },
  requestPermission: { method: 'session/request_permission', params: ['sessionId', 'toolCall', 'options'], response: { outcome: 'selected|cancelled', optionId: 'string?' } },
  updateVariants: [
    'agent_message_chunk',
    'agent_thought_chunk',
    'agent_message_final (unverified; guarded if it appears)',
    'tool_call',
    'tool_call_update',
    'usage (unverified spelling)',
  ],
  stopReasons: ['end_turn', 'max_tokens', 'refusal', 'cancelled'],
})

const ACP_METHOD = Object.freeze({
  initialize: ACP_ASSUMPTIONS.initialize.method,
  newSession: ACP_ASSUMPTIONS.newSession.method,
  loadSession: ACP_ASSUMPTIONS.loadSession.method,
  prompt: ACP_ASSUMPTIONS.prompt.method,
  cancel: ACP_ASSUMPTIONS.cancel.method,
  update: ACP_ASSUMPTIONS.update.method,
  requestPermission: ACP_ASSUMPTIONS.requestPermission.method,
})

/** A minimal async queue: the transport pushes, the room actor consumes. */
function createEventQueue() {
  const items = []
  const waiters = []
  let closed = false
  return {
    push(item) {
      if (closed) return
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter({ value: item, done: false })
      else items.push(item)
    },
    close() {
      closed = true
      while (waiters.length > 0) waiters.shift()({ value: undefined, done: true })
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (items.length > 0) return Promise.resolve({ value: items.shift(), done: false })
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => waiters.push(resolve))
        },
        return() {
          closed = true
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
}

function contentText(content) {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(contentText).join('')
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text
    if (content.content !== undefined) return contentText(content.content)
    if (content.delta?.text !== undefined) return contentText(content.delta.text)
  }
  return ''
}

function toAcpMcpServers(servers) {
  if (!Array.isArray(servers)) return []
  return servers.map((server) => {
    if (server === null || typeof server !== 'object') return server
    const mapped = { name: server.name }
    if (typeof server.command === 'string') mapped.command = server.command
    if (Array.isArray(server.args)) mapped.args = server.args
    if (server.env !== null && typeof server.env === 'object' && !Array.isArray(server.env)) {
      mapped.env = Object.entries(server.env).map(([name, value]) => ({ name, value: String(value) }))
    }
    if (typeof server.url === 'string') mapped.url = server.url
    if (server.headers !== null && typeof server.headers === 'object') mapped.headers = server.headers
    return mapped
  })
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

async function safeClose(transport) {
  try {
    await transport.close()
  } catch {
    // best effort
  }
}

/** `text/cancelled/...` -> the AgentEvent turn.ended reason. */
function stopReasonToEnd(stopReason) {
  if (stopReason === 'cancelled') return 'cancelled'
  if (stopReason === 'refusal') return 'error'
  // end_turn and max_tokens both mean "this turn is over"; the final text is
  // whatever the agent streamed before stopping.
  return 'stop'
}

/**
 * Create the ACP adapter for one runtime kind.
 *
 * @param {object} options
 * @param {'grok-build'|'codex'} options.kind
 * @param {Function} [options.spawn] child_process.spawn-compatible (injected)
 * @param {string} [options.command] runtime binary
 * @param {string[]} [options.args]
 * @param {Record<string,string>} [options.env]
 * @param {string} [options.cwd]
 * @param {number} [options.protocolVersion] ACP initialize protocolVersion
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.initializeTimeoutMs]
 * @param {number} [options.promptTimeoutMs] hard per-turn timeout; 0 = none
 * @param {'allow'|'deny'|Function} [options.permissionPolicy] default deny
 * @param {Record<string,Function>} [options.clientRequestHandlers] fs/terminal handlers
 * @param {Function} [options.createTransport] transport factory (tests)
 * @param {Function} [options.probe] alternative probe implementation
 * @param {Function} [options.composePrompt] turn -> prompt text
 * @param {Function} [options.onDiagnostic]
 */
export function createAcpAdapter(options = {}) {
  const kind = options.kind
  if (kind !== 'grok-build' && kind !== 'codex') {
    throw new AgentRuntimeError('runtime.unsupported', `ACP adapter kind must be grok-build or codex, got ${String(kind)}`)
  }
  const protocolVersion = options.protocolVersion ?? 1
  const initializeTimeoutMs = options.initializeTimeoutMs ?? 10_000
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000
  const promptTimeoutMs = options.promptTimeoutMs ?? 0
  const permissionPolicy = options.permissionPolicy ?? 'deny'
  const diagnostics = []
  const onDiagnostic = (level, message) => {
    diagnostics.push({ level, message, at: Date.now() })
    if (diagnostics.length > 200) diagnostics.shift()
    if (typeof options.onDiagnostic === 'function') {
      try {
        options.onDiagnostic(level, message)
      } catch {
        // diagnostics must not break the session
      }
    }
  }
  const createTransport = typeof options.createTransport === 'function'
    ? options.createTransport
    : () => createAcpTransport({
      spawn: options.spawn,
      command: options.command,
      args: options.args ?? [],
      env: options.env,
      cwd: options.cwd,
      requestTimeoutMs,
      onDiagnostic,
    })

  const caps = Object.freeze({
    ...defaultCapabilities(kind),
    streaming: true,
    tools: 'native',
    permissions: kind === 'grok-build' ? 'native' : 'bridge',
    images: { input: false, output: false },
    resume: true,
    subagents: kind === 'grok-build',
    mcp: true,
    models: Array.isArray(options.models) ? [...options.models] : [],
  })

  let probeCache = null

  async function initializeTransport(transport) {
    const result = await transport.sendRequest(ACP_METHOD.initialize, {
      protocolVersion,
      clientCapabilities: options.clientCapabilities ?? {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: options.clientInfo ?? { name: 'roost-acp-adapter', version: '0.1.0' },
    }, { timeoutMs: initializeTimeoutMs })
    if (result === null || typeof result !== 'object') {
      throw new AgentRuntimeError('acp.initialize_failed', 'initialize returned no result object')
    }
    if (typeof result.protocolVersion === 'number' && result.protocolVersion !== protocolVersion) {
      onDiagnostic('protocol', `agent speaks protocolVersion ${result.protocolVersion}, adapter requested ${protocolVersion}`)
    }
    return result
  }

  async function probe() {
    if (probeCache !== null) return probeCache
    if (typeof options.probe === 'function') {
      probeCache = await options.probe()
      return probeCache
    }
    let transport = null
    try {
      transport = createTransport({ purpose: 'probe' })
      const initialized = await initializeTransport(transport)
      const agentInfo = initialized.agentInfo ?? initialized.serverInfo ?? {}
      probeCache = {
        ok: true,
        version: typeof agentInfo.version === 'string' ? agentInfo.version : undefined,
        binary: typeof options.command === 'string' ? options.command : agentInfo.name,
        auth: 'unknown',
        problems: [],
      }
      return probeCache
    } catch (error) {
      probeCache = {
        ok: false,
        version: undefined,
        binary: typeof options.command === 'string' ? options.command : undefined,
        auth: 'unknown',
        problems: [messageOf(error)],
      }
      return probeCache
    } finally {
      if (transport !== null) await safeClose(transport)
    }
  }

  async function openSession(spec) {
    if (spec === null || typeof spec !== 'object') throw new AgentRuntimeError('session.invalid', 'openSession needs a spec')
    if (typeof spec.sessionId !== 'string' || spec.sessionId === '') throw new AgentRuntimeError('session.invalid', 'spec.sessionId is required')
    if (typeof spec.workdir !== 'string' || spec.workdir === '') throw new AgentRuntimeError('session.invalid', 'spec.workdir is required')
    const transport = createTransport({ purpose: 'session', spec })
    try {
      await initializeTransport(transport)
      const acpSessionId = await acquireSession(transport, spec)
      return createSession({ transport, spec, acpSessionId })
    } catch (error) {
      await safeClose(transport)
      if (error instanceof AgentRuntimeError) throw error
      throw new AgentRuntimeError('acp.session_failed', `ACP session failed: ${messageOf(error)}`)
    }
  }

  async function acquireSession(transport, spec) {
    const resumeId = spec.resumeState !== null && typeof spec.resumeState === 'object'
      ? spec.resumeState.acpSessionId
      : undefined
    if (typeof resumeId === 'string' && resumeId !== '') {
      try {
        const loaded = await transport.sendRequest(ACP_METHOD.loadSession, {
          sessionId: resumeId,
          cwd: spec.workdir,
          mcpServers: toAcpMcpServers(spec.mcpServers),
        }, { timeoutMs: requestTimeoutMs })
        const loadedId = loaded?.sessionId ?? loaded?.session?.id ?? resumeId
        return String(loadedId)
      } catch (error) {
        if (options.resumeFallback === false) {
          throw new AgentRuntimeError('acp.resume_failed', `session/load failed: ${messageOf(error)}`)
        }
        onDiagnostic('protocol', `session/load failed (${messageOf(error)}); opening a new session`)
      }
    }
    const created = await transport.sendRequest(ACP_METHOD.newSession, {
      cwd: spec.workdir,
      mcpServers: toAcpMcpServers(spec.mcpServers),
      ...(typeof spec.systemPrompt === 'string' && spec.systemPrompt !== '' ? { systemPrompt: spec.systemPrompt } : {}),
      ...(typeof spec.model === 'string' && spec.model !== '' ? { model: spec.model } : {}),
    }, { timeoutMs: requestTimeoutMs })
    const sessionId = created?.sessionId ?? created?.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new AgentRuntimeError('acp.session_missing', 'session/new returned no sessionId')
    }
    return sessionId
  }

  function createSession({ transport, spec, acpSessionId }) {
    const composePrompt = typeof options.composePrompt === 'function'
      ? options.composePrompt
      : (turn) => turn.input
    let activeTurn = null
    let turnCount = 0
    let closed = false

    async function handlePermissionRequest(request, active) {
      const params = request.params ?? {}
      const requestId = String(request.id ?? `perm-${active.permissionSeq + 1}`)
      active.permissionSeq += 1
      const toolCall = params.toolCall ?? params.tool ?? {}
      const tool = typeof toolCall.title === 'string'
        ? toolCall.title
        : typeof toolCall.kind === 'string'
          ? toolCall.kind
          : typeof params.tool === 'string'
            ? params.tool
            : 'tool'
      const args = toolCall.rawInput ?? toolCall.input ?? params.args ?? null
      const event = {
        type: 'permission.request',
        turnId: active.turnId,
        requestId,
        tool,
        args,
        ...(typeof params.risk === 'string' ? { risk: params.risk } : {}),
      }
      if (active.ended) {
        return { outcome: { outcome: 'cancelled' } }
      }
      active.emit(event)
      let decision = 'deny'
      try {
        decision = typeof permissionPolicy === 'function'
          ? await permissionPolicy(event, { params, sessionId: acpSessionId })
          : permissionPolicy
      } catch (error) {
        onDiagnostic('protocol', `permission policy failed (${messageOf(error)}); denying`)
        decision = 'deny'
      }
      decision = decision === 'allow' ? 'allow' : 'deny'
      active.emit({ type: 'permission.resolved', turnId: active.turnId, requestId, decision })
      const offered = Array.isArray(params.options) ? params.options : []
      const wantedPrefix = decision === 'allow' ? 'allow' : 'reject'
      const chosen = offered.find((option) => String(option?.kind ?? option?.optionKind ?? '').startsWith(wantedPrefix))
      if (chosen !== undefined && typeof chosen.optionId === 'string') {
        return { outcome: { outcome: 'selected', optionId: chosen.optionId } }
      }
      const fallback = decision === 'allow' ? offered.find((option) => typeof option?.optionId === 'string') : undefined
      if (fallback !== undefined) return { outcome: { outcome: 'selected', optionId: fallback.optionId } }
      return { outcome: { outcome: decision === 'allow' ? 'selected' : 'cancelled' } }
    }

    function createTurnState(turn) {
      const queue = createEventQueue()
      const state = {
        turnId: turn.turnId,
        queue,
        ended: false,
        finalEmitted: false,
        usageEmitted: false,
        text: '',
        seq: 0,
        cancelRequested: false,
        permissionSeq: 0,
        toolCalls: new Map(),
        emit(event) {
          if (state.ended) return
          queue.push({ ...event, turnId: turn.turnId })
        },
        emitFinal(text) {
          if (state.ended || state.finalEmitted) return
          if (typeof text !== 'string' || text === '') return
          state.finalEmitted = true
          state.emit({ type: 'text.final', text })
        },
        emitUsage(inputTokens, outputTokens, estimated) {
          if (state.ended || state.usageEmitted) return
          state.usageEmitted = true
          state.emit({
            type: 'usage',
            ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
            ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
            estimated: estimated === true,
          })
        },
        pushError(code, message, retryable) {
          if (state.ended) return
          state.emit({ type: 'error', code, message, retryable: retryable === true })
        },
      }
      return state
    }

    function handleUpdate(state, rawUpdate) {
      if (state.ended) return
      const update = rawUpdate !== null && typeof rawUpdate === 'object' ? rawUpdate : {}
      const variant = update.sessionUpdate ?? update.type ?? update.kind
      switch (variant) {
        case 'agent_message_chunk': {
          const text = contentText(update.content ?? update.delta ?? update)
          if (text === '') return
          state.text += text
          state.seq += 1
          state.emit({ type: 'text.delta', seq: state.seq, text })
          return
        }
        case 'agent_thought_chunk':
        case 'reasoning': {
          const text = contentText(update.content ?? update.delta ?? update)
          if (text !== '') state.emit({ type: 'reasoning.delta', text })
          return
        }
        case 'agent_message_final': {
          // Not in the public spec but cheap to guard: if an agent sends a
          // terminal-text variant, it becomes the one text.final.
          state.emitFinal(contentText(update.content ?? update.text ?? update))
          return
        }
        case 'tool_call': {
          const callId = String(update.toolCallId ?? update.tool_call_id ?? update.id ?? `tool-${state.toolCalls.size + 1}`)
          state.toolCalls.set(callId, update)
          state.emit({
            type: 'tool.call',
            callId,
            name: String(update.title ?? update.name ?? update.kind ?? update.toolName ?? 'tool'),
            input: update.rawInput ?? update.input ?? null,
          })
          return
        }
        case 'tool_call_update': {
          const callId = String(update.toolCallId ?? update.tool_call_id ?? update.id ?? '')
          if (callId === '') return
          const status = String(update.status ?? '')
          if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') return
          const output = update.rawOutput ?? update.output ?? contentText(update.content)
          const failed = status !== 'completed'
          state.emit({
            type: 'tool.result',
            callId,
            ok: !failed,
            ...(failed
              ? { error: contentText(update.content) || String(update.error ?? 'tool failed') }
              : { output: output === '' ? null : output }),
          })
          return
        }
        case 'usage': {
          const usage = update.usage ?? update
          state.emitUsage(
            Number(usage.inputTokens ?? usage.input_tokens),
            Number(usage.outputTokens ?? usage.output_tokens),
            false,
          )
          return
        }
        default:
          onDiagnostic('protocol', `ignoring unverified session/update variant: ${String(variant)}`)
      }
    }

    function startTurn(turn, sendOptions) {
      if (closed) throw new AgentRuntimeError('session.closed', 'session is closed')
      if (activeTurn !== null) throw new AgentRuntimeError('session.busy', 'one turn at a time per ACP session')
      if (turn === null || typeof turn !== 'object') throw new AgentRuntimeError('session.invalid', 'turn is required')
      if (typeof turn.turnId !== 'string' || turn.turnId === '') throw new AgentRuntimeError('session.invalid', 'turn.turnId is required')
      turnCount += 1
      const state = createTurnState(turn)
      const active = {
        turnId: turn.turnId,
        state,
        emit: state.emit,
        permissionSeq: 0,
        turn,
        finalize: null,
        cleanup: null,
      }
      const cleanups = []
      active.finalize = (reason, terminal = {}) => {
        if (state.ended) return
        if (terminal.error !== undefined) state.pushError(terminal.code ?? 'acp.turn_error', terminal.error, terminal.retryable === true)
        if (reason === 'stop') {
          state.emitUsage(terminal.inputTokens, terminal.outputTokens, terminal.estimated)
          state.emitFinal(terminal.finalText ?? state.text)
        }
        // The terminal frame is pushed directly: `state.emit` refuses events
        // once ended, and this event is the one that *makes* it ended.
        state.queue.push({ type: 'turn.ended', turnId: turn.turnId, reason })
        state.ended = true
        state.queue.close()
        for (const cleanup of cleanups.splice(0)) {
          try {
            cleanup()
          } catch {
            // ignore
          }
        }
        if (activeTurn === active) activeTurn = null
      }
      active.cleanup = () => active.finalize('cancelled')
      const emit = state.emit
      emit({ type: 'turn.started', at: Date.now() })

      if (turn.signal !== null && turn.signal !== undefined && typeof turn.signal.addEventListener === 'function') {
        const onAbort = () => {
          if (!state.ended) void cancel(turn.turnId, 'user')
        }
        turn.signal.addEventListener('abort', onAbort, { once: true })
        cleanups.push(() => turn.signal.removeEventListener('abort', onAbort))
      }

      const timeoutMs = typeof sendOptions?.timeoutMs === 'number' && sendOptions.timeoutMs > 0
        ? sendOptions.timeoutMs
        : promptTimeoutMs
      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          if (state.ended) return
          try {
            transport.notify(ACP_METHOD.cancel, { sessionId: acpSessionId })
          } catch {
            // best effort
          }
          active.finalize('timeout')
        }, timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
        cleanups.push(() => clearTimeout(timer))
      }

      const unsubscribeNotifications = transport.onNotification((message) => {
        if (state.ended) return
        if (message.method !== ACP_METHOD.update) return
        const params = message.params ?? {}
        if (typeof params.sessionId === 'string' && params.sessionId !== acpSessionId) return
        handleUpdate(state, params.update ?? params)
      })
      cleanups.push(unsubscribeNotifications)

      if (typeof transport.onRequest === 'function') {
        const unsubscribeRequests = transport.onRequest(async (request) => {
          if (request?.method === ACP_METHOD.requestPermission) {
            const params = request.params ?? {}
            if (typeof params.sessionId === 'string' && params.sessionId !== acpSessionId) return undefined
            return handlePermissionRequest(request, { ...active, ended: state.ended })
          }
          const handler = options.clientRequestHandlers?.[request?.method]
          if (typeof handler === 'function') return handler(request.params ?? {}, request)
          return undefined
        })
        cleanups.push(unsubscribeRequests)
      }

      activeTurn = active
      const promptText = String(typeof composePrompt === 'function' ? composePrompt(turn) : turn.input ?? '')
      const inputBytes = promptText.length
      transport.sendRequest(ACP_METHOD.prompt, {
        sessionId: acpSessionId,
        prompt: [{ type: 'text', text: promptText }],
      }, { timeoutMs: 0 }).then((result) => {
        if (state.ended) return
        const stopReason = result !== null && typeof result === 'object' ? result.stopReason : undefined
        const expected = stopReasonToEnd(stopReason)
        if (expected === 'error') {
          active.finalize('error', {
            code: 'acp.refusal',
            error: `agent refused the prompt (stopReason=${String(stopReason)})`,
            retryable: false,
          })
          return
        }
        if (expected === 'cancelled') {
          active.finalize('cancelled')
          return
        }
        const outputChars = state.text.length
        const estimated = !state.usageEmitted
        active.finalize('stop', {
          finalText: state.text,
          inputTokens: estimated ? Math.ceil(inputBytes / 4) : undefined,
          outputTokens: estimated ? Math.ceil(outputChars / 4) : undefined,
          estimated,
        })
      }).catch((error) => {
        if (state.ended) return
        state.pushError(error?.code ?? 'acp.prompt_failed', messageOf(error), false)
        active.finalize('error')
      })

      return state.queue
    }

    async function cancel(turnId, reason) {
      if (closed) return
      const active = activeTurn
      if (active === null || active.turnId !== turnId) return
      active.state.cancelRequested = true
      try {
        transport.notify(ACP_METHOD.cancel, { sessionId: acpSessionId })
      } catch (error) {
        onDiagnostic('transport', `session/cancel failed: ${messageOf(error)}`)
      }
      active.finalize('cancelled')
      void reason
    }

    async function close() {
      if (closed) return
      closed = true
      if (activeTurn !== null) {
        try {
          transport.notify(ACP_METHOD.cancel, { sessionId: acpSessionId })
        } catch {
          // ignore
        }
        activeTurn.finalize('cancelled')
      }
      await safeClose(transport)
    }

    return {
      id: spec.sessionId,
      get acpSessionId() {
        return acpSessionId
      },
      send(turn, sendOptions) {
        return startTurn(turn, sendOptions)
      },
      cancel,
      close,
      async snapshot() {
        return {
          kind,
          sessionId: spec.sessionId,
          acpSessionId,
          turns: turnCount,
          activeTurnId: activeTurn?.turnId ?? null,
          closed,
          diagnostics: diagnostics.slice(-20),
        }
      },
    }
  }

  return {
    kind,
    probe,
    capabilities() {
      return { ...caps, images: { ...caps.images }, models: [...caps.models] }
    },
    openSession,
  }
}
