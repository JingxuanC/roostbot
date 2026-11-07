// Generic NDJSON CLI adapter — the fallback path for Claude Code and Codex when
// no ACP transport is available (docs/design/agent-runtimes.md §6.1).
//
// Contract differences from the ACP adapter:
// - one long-lived child process per session; prompts are written as NDJSON
//   lines (`promptWriter`), stdout lines are decoded by an injectable `parser`;
// - stderr is diagnostics only — it never becomes an AgentEvent;
// - process crash/exit maps to error + turn.ended(error), never to a fake stop;
// - cancellation sends SIGINT, then SIGTERM after `graceMs`, then SIGKILL.
//
// The default parsers cover the documented stream shapes:
// - Claude Code: `--output-format stream-json` (assistant/tool_result/result)
//   plus `stream_event` content deltas when `--include-partial-messages` is on;
// - Codex: `codex exec --json` (item.* / turn.completed / turn.failed).
// A different wrapper CLI only needs a matching `parser`/`promptWriter`.
//
// ⚠️ Unverified: Claude Code's `--input-format stream-json` stdin envelope and
// the exact Codex `cmd`-execution item fields. The parser tolerates both
// camelCase and snake_case keys where practical; see CLI_ASSUMPTIONS.

import { spawn as nodeSpawn } from 'node:child_process'
import { AgentRuntimeError, defaultCapabilities } from '../../../packages/agent-runtime/src/index.ts'

/** Names/fields that need checking against real CLI output. */
export const CLI_ASSUMPTIONS = Object.freeze({
  claudeCode: {
    command: 'claude --headless --input-format stream-json --output-format stream-json (or a wrapper that speaks NDJSON on stdin)',
    userLine: { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '…' }] } },
    output: ['system', 'assistant', 'user(tool_result)', 'result', 'stream_event(content_block_delta)'],
  },
  codex: {
    command: 'codex exec --json (or a wrapper that speaks NDJSON on stdin)',
    userLine: { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '…' }] } },
    output: ['thread.started', 'turn.started', 'item.started/completed', 'turn.completed', 'turn.failed', 'error'],
  },
  unverified: [
    'Claude Code stdin stream-json envelope (assumed user/message/content)',
    'Codex stdin prompt envelope (assumed user/message/content)',
    'Codex command_execution output/exit_code field names',
    'Codex mcp_tool_call argument field name',
  ],
})

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
  }
  return ''
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function asParser(value) {
  if (typeof value === 'function') return value
  if (value !== null && typeof value === 'object' && typeof value.parse === 'function') return (line) => value.parse(line)
  return null
}

/** Claude Code stream-json parser. */
export function createClaudeCodeParser() {
  return (line) => {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return []
    }
    if (event === null || typeof event !== 'object') return []
    switch (event.type) {
      case 'system':
        return []
      case 'stream_event': {
        const inner = event.event ?? {}
        if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && typeof inner.delta.text === 'string') {
          return [{ type: 'text.delta', text: inner.delta.text }]
        }
        return []
      }
      case 'assistant': {
        const blocks = Array.isArray(event.message?.content) ? event.message.content : []
        const out = []
        for (const block of blocks) {
          if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
            out.push({ type: 'text.delta', text: block.text })
          } else if (block?.type === 'tool_use') {
            out.push({
              type: 'tool.call',
              callId: String(block.id ?? `tool-${out.length + 1}`),
              name: String(block.name ?? 'tool'),
              input: block.input ?? null,
            })
          }
        }
        return out
      }
      case 'user': {
        const blocks = Array.isArray(event.message?.content) ? event.message.content : []
        const out = []
        for (const block of blocks) {
          if (block?.type !== 'tool_result') continue
          const failed = block.is_error === true
          out.push({
            type: 'tool.result',
            callId: String(block.tool_use_id ?? block.id ?? ''),
            ok: !failed,
            ...(failed
              ? { error: contentText(block.content) || 'tool failed' }
              : { output: contentText(block.content) }),
          })
        }
        return out
      }
      case 'result': {
        const out = []
        const usage = event.usage ?? {}
        if (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number') {
          out.push({
            type: 'usage',
            ...(typeof usage.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
            ...(typeof usage.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
            estimated: false,
          })
        }
        const failed = event.is_error === true
          || String(event.subtype ?? '').startsWith('error')
        if (failed) {
          out.push({
            type: 'error',
            code: 'cli.result_error',
            message: String(event.result ?? event.subtype ?? 'CLI reported an error'),
            retryable: false,
          })
        } else if (typeof event.result === 'string' && event.result !== '') {
          out.push({ type: 'text.final', text: event.result })
        }
        out.push({ type: 'turn.ended', reason: failed ? 'error' : 'stop' })
        return out
      }
      default:
        return []
    }
  }
}

/** Codex `exec --json` event parser. */
export function createCodexParser() {
  return (line) => {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return []
    }
    if (event === null || typeof event !== 'object') return []
    switch (event.type) {
      case 'thread.started':
      case 'turn.started':
        return []
      case 'item.started':
      case 'item.completed': {
        const item = event.item ?? {}
        const kind = item.type ?? item.itemType
        const callId = String(item.id ?? item.call_id ?? `tool-${String(kind)}`)
        if (kind === 'agent_message') {
          const text = contentText(item.text ?? item.content ?? item.message)
          return event.type === 'item.completed' && text !== '' ? [{ type: 'text.delta', text }] : []
        }
        if (kind === 'reasoning') {
          const text = contentText(item.text ?? item.content ?? item.summary)
          return event.type === 'item.completed' && text !== '' ? [{ type: 'reasoning.delta', text }] : []
        }
        if (event.type === 'item.started') {
          if (kind === 'command_execution') {
            return [{ type: 'tool.call', callId, name: 'shell', input: item.command ?? item.cmd ?? null }]
          }
          if (kind === 'mcp_tool_call') {
            return [{
              type: 'tool.call',
              callId,
              name: String(item.name ?? item.tool_name ?? item.tool ?? 'mcp_tool'),
              input: item.arguments ?? item.args ?? item.input ?? null,
            }]
          }
          return []
        }
        if (kind === 'command_execution' || kind === 'mcp_tool_call') {
          const exitCode = item.exit_code ?? item.exitCode
          const status = String(item.status ?? '')
          const failed = (typeof exitCode === 'number' && exitCode !== 0) || status === 'failed'
          return [{
            type: 'tool.result',
            callId,
            ok: !failed,
            ...(failed
              ? { error: contentText(item.aggregated_output ?? item.output ?? item.error) || `tool exited ${String(exitCode ?? status)}` }
              : { output: contentText(item.aggregated_output ?? item.output ?? item.result) }),
          }]
        }
        return []
      }
      case 'turn.completed': {
        const usage = event.usage ?? {}
        const out = []
        if (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number') {
          out.push({
            type: 'usage',
            ...(typeof usage.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}),
            ...(typeof usage.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}),
            estimated: false,
          })
        }
        out.push({ type: 'turn.ended', reason: 'stop' })
        return out
      }
      case 'turn.failed': {
        return [
          {
            type: 'error',
            code: 'cli.turn_failed',
            message: String(event.error?.message ?? event.message ?? 'codex turn failed'),
            retryable: false,
          },
          { type: 'turn.ended', reason: 'error' },
        ]
      }
      case 'error':
        return [
          {
            type: 'error',
            code: 'cli.error',
            message: String(event.message ?? event.error?.message ?? 'codex error'),
            retryable: false,
          },
          { type: 'turn.ended', reason: 'error' },
        ]
      default:
        return []
    }
  }
}

function defaultParserFor(kind) {
  return kind === 'claude-code' ? createClaudeCodeParser() : createCodexParser()
}

function defaultPromptWriterFor(kind) {
  void kind
  // Shared envelope for both wrappers; override for a CLI with a different
  // stdin contract.
  return (turn) => `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: String(turn.input ?? '') }] },
  })}\n`
}

/**
 * Create the NDJSON CLI adapter.
 *
 * @param {object} options
 * @param {'claude-code'|'codex'} options.kind
 * @param {Function} [options.spawn]
 * @param {string} [options.command]
 * @param {string[]} [options.args]
 * @param {Record<string,string>} [options.env]
 * @param {string} [options.cwd]
 * @param {Function|{parse:Function}} [options.parser] default per kind
 * @param {Function} [options.promptWriter] turn -> NDJSON string
 * @param {number} [options.graceMs] SIGINT -> SIGTERM grace; default 500
 * @param {number} [options.killGraceMs] SIGTERM -> SIGKILL grace; default 1000
 * @param {number} [options.timeoutMs] per-turn timeout; 0 = none
 * @param {Function} [options.probe] probe override
 * @param {Function} [options.onDiagnostic] (level, line) for stderr/protocol
 * @param {object} [options.timers] { setTimeout, clearTimeout } for tests
 */
export function createCliAdapter(options = {}) {
  const kind = options.kind
  if (kind !== 'claude-code' && kind !== 'codex') {
    throw new AgentRuntimeError('runtime.unsupported', `CLI adapter kind must be claude-code or codex, got ${String(kind)}`)
  }
  const graceMs = options.graceMs ?? 500
  const killGraceMs = options.killGraceMs ?? 1000
  const timeoutMs = options.timeoutMs ?? 0
  const timers = options.timers ?? { setTimeout, clearTimeout }
  const parser = asParser(options.parser) ?? defaultParserFor(kind)
  const promptWriter = typeof options.promptWriter === 'function' ? options.promptWriter : defaultPromptWriterFor(kind)
  const spawn = options.spawn ?? nodeSpawn
  const diagnostics = []
  const onDiagnostic = (level, message) => {
    diagnostics.push({ level, message, at: Date.now() })
    if (diagnostics.length > 200) diagnostics.shift()
    if (typeof options.onDiagnostic === 'function') {
      try {
        options.onDiagnostic(level, message)
      } catch {
        // diagnostics never break the session
      }
    }
  }

  const caps = Object.freeze({
    ...defaultCapabilities(kind),
    streaming: true,
    tools: 'native',
    // CLI fallbacks have no permission protocol; the control plane must not
    // expect approvals from them.
    permissions: 'none',
    images: { input: false, output: false },
    resume: false,
    subagents: false,
    mcp: kind === 'codex',
    models: Array.isArray(options.models) ? [...options.models] : [],
  })

  let probeCache = null

  async function probe() {
    if (probeCache !== null) return probeCache
    if (typeof options.probe === 'function') {
      probeCache = await options.probe()
      return probeCache
    }
    if (typeof spawn !== 'function') {
      probeCache = { ok: false, auth: 'unknown', problems: ['spawn is not available'] }
      return probeCache
    }
    probeCache = await new Promise((resolve) => {
      let settled = false
      const finish = (probeResult) => {
        if (settled) return
        settled = true
        probeResult.binary = typeof options.command === 'string' ? options.command : probeResult.binary
        probeResult.auth = 'unknown'
        resolve(probeResult)
      }
      let child
      try {
        child = spawn(options.command, ['--version'], { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        finish({ ok: false, problems: [messageOf(error)] })
        return
      }
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8') })
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
      const timer = timers.setTimeout(() => {
        try {
          child.kill?.('SIGKILL')
        } catch {
          // ignore
        }
        finish({ ok: false, problems: [`--version timed out after 5000ms`] })
      }, 5000)
      if (typeof timer?.unref === 'function') timer.unref()
      child.on('error', (error) => {
        timers.clearTimeout(timer)
        finish({ ok: false, problems: [messageOf(error)] })
      })
      child.on('exit', (code) => {
        timers.clearTimeout(timer)
        const version = stdout.trim().split('\n')[0]?.trim() ?? ''
        if (code === 0) finish({ ok: true, ...(version === '' ? {} : { version }), problems: [] })
        else finish({ ok: false, problems: [`--version exited ${String(code)}: ${stderr.trim().slice(0, 200)}`] })
      })
    })
    return probeCache
  }

  async function openSession(spec) {
    if (spec === null || typeof spec !== 'object') throw new AgentRuntimeError('session.invalid', 'openSession needs a spec')
    if (typeof spec.sessionId !== 'string' || spec.sessionId === '') throw new AgentRuntimeError('session.invalid', 'spec.sessionId is required')
    if (typeof spec.workdir !== 'string' || spec.workdir === '') throw new AgentRuntimeError('session.invalid', 'spec.workdir is required')
    if (typeof spawn !== 'function') throw new AgentRuntimeError('cli.spawn_unavailable', 'spawn is not available')
    let child
    try {
      child = spawn(options.command, options.args ?? [], {
        cwd: spec.workdir,
        env: { ...options.env, ...spec.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      throw new AgentRuntimeError('cli.spawn_failed', `CLI spawn failed: ${messageOf(error)}`)
    }
    if (child === null || typeof child !== 'object') throw new AgentRuntimeError('cli.spawn_failed', 'spawn returned no child process')

    let activeTurn = null
    let turnCount = 0
    let closed = false
    let exitInfo = null

    const stdoutDecoder = {
      buffer: '',
      push(chunk) {
        stdoutDecoder.buffer += chunk.toString('utf8')
        let index = stdoutDecoder.buffer.indexOf('\n')
        while (index >= 0) {
          const line = stdoutDecoder.buffer.slice(0, index).replace(/\r$/, '')
          stdoutDecoder.buffer = stdoutDecoder.buffer.slice(index + 1)
          if (line.trim() !== '') handleStdoutLine(line)
          index = stdoutDecoder.buffer.indexOf('\n')
        }
      },
    }
    const stderrDecoder = {
      buffer: '',
      push(chunk) {
        stderrDecoder.buffer += chunk.toString('utf8')
        let index = stderrDecoder.buffer.indexOf('\n')
        while (index >= 0) {
          const line = stderrDecoder.buffer.slice(0, index).replace(/\r$/, '')
          stderrDecoder.buffer = stderrDecoder.buffer.slice(index + 1)
          if (line.trim() !== '') onDiagnostic('stderr', line)
          index = stderrDecoder.buffer.indexOf('\n')
        }
      },
    }

    function handleStdoutLine(line) {
      let events
      try {
        events = parser(line)
      } catch (error) {
        onDiagnostic('protocol', `parser threw on a stdout line: ${messageOf(error)}`)
        return
      }
      if (!Array.isArray(events) || events.length === 0) return
      if (activeTurn === null || activeTurn.state.ended) {
        onDiagnostic('protocol', 'dropping stdout events outside an active turn')
        return
      }
      for (const event of events) applyEvent(event)
    }

    function applyEvent(event) {
      const active = activeTurn
      if (active === null) return
      const state = active.state
      if (state.ended) return
      if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return
      const stamped = { ...event, turnId: event.turnId ?? state.turnId }
      switch (event.type) {
        case 'turn.ended': {
          if (event.reason === 'stop') {
            finalizeTurn(state, 'stop')
            return
          }
          if (event.reason === 'cancelled') {
            finalizeTurn(state, 'cancelled')
            return
          }
          finalizeTurn(state, 'error')
          return
        }
        case 'text.final': {
          if (state.finalEmitted) return
          state.finalEmitted = true
          state.emit(stamped)
          return
        }
        case 'usage': {
          if (state.usageEmitted) return
          state.usageEmitted = true
          state.emit(stamped)
          return
        }
        case 'turn.started':
          // parsers should not emit this; the adapter owns turn.started.
          return
        default:
          state.emit(stamped)
      }
    }

    function finalizeTurn(state, reason) {
      if (state.ended) return
      if (reason === 'stop') {
        if (!state.usageEmitted) {
          state.usageEmitted = true
          state.emit({
            type: 'usage',
            inputTokens: Math.ceil(state.inputChars / 4),
            outputTokens: Math.ceil(state.accumulated.length / 4),
            estimated: true,
          })
        }
        if (!state.finalEmitted && state.accumulated !== '') {
          state.finalEmitted = true
          state.emit({ type: 'text.final', text: state.accumulated })
        }
      }
      // Bypass the ended guard: this frame is what ends the turn.
      state.queue.push({ type: 'turn.ended', turnId: state.turnId, reason })
      state.ended = true
      state.queue.close()
      for (const cleanup of state.cleanups.splice(0)) {
        try {
          cleanup()
        } catch {
          // ignore
        }
      }
      if (activeTurn !== null && activeTurn.state === state) activeTurn = null
    }

    function onProcessExit(code, signal) {
      exitInfo = { code, signal }
      try {
        stdoutDecoder.push('')
        stderrDecoder.push('')
      } catch {
        // ignore
      }
      if (activeTurn !== null && !activeTurn.state.ended) {
        const state = activeTurn.state
        if (state.cancelRequested) {
          finalizeTurn(state, 'cancelled')
        } else {
          state.emit({
            type: 'error',
            code: 'cli.exited',
            message: `CLI process exited before the turn ended (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
            retryable: false,
          })
          finalizeTurn(state, 'error')
        }
      }
      closed = true
      if (activeTurn !== null) activeTurn = null
    }

    child.stdout?.on('data', (chunk) => stdoutDecoder.push(chunk))
    child.stderr?.on('data', (chunk) => stderrDecoder.push(chunk))
    child.on('error', (error) => {
      onDiagnostic('transport', `CLI child error: ${messageOf(error)}`)
      if (activeTurn !== null && !activeTurn.state.ended) {
        activeTurn.state.emit({
          type: 'error',
          code: 'cli.spawn_failed',
          message: messageOf(error),
          retryable: false,
        })
        finalizeTurn(activeTurn.state, 'error')
      }
    })
    child.on('exit', (code, signal) => onProcessExit(code, signal))

    function startTurn(turn, sendOptions) {
      if (closed) throw new AgentRuntimeError('session.closed', 'session is closed')
      if (activeTurn !== null) throw new AgentRuntimeError('session.busy', 'one turn at a time per CLI session')
      if (turn === null || typeof turn !== 'object') throw new AgentRuntimeError('session.invalid', 'turn is required')
      if (typeof turn.turnId !== 'string' || turn.turnId === '') throw new AgentRuntimeError('session.invalid', 'turn.turnId is required')
      turnCount += 1
      const queue = createEventQueue()
      const state = {
        turnId: turn.turnId,
        queue,
        ended: false,
        finalEmitted: false,
        usageEmitted: false,
        accumulated: '',
        inputChars: String(turn.input ?? '').length,
        cancelRequested: false,
        cleanups: [],
        emit(event) {
          if (state.ended) return
          const stamped = { ...event, turnId: state.turnId }
          if (stamped.type === 'text.delta') {
            if (typeof stamped.text !== 'string' || stamped.text === '') return
            state.accumulated += stamped.text
          }
          queue.push(stamped)
        },
      }
      const active = { state }
      activeTurn = active
      state.emit({ type: 'turn.started', at: Date.now() })

      if (turn.signal !== null && turn.signal !== undefined && typeof turn.signal.addEventListener === 'function') {
        const onAbort = () => {
          if (!state.ended) void cancel(turn.turnId, 'user')
        }
        turn.signal.addEventListener('abort', onAbort, { once: true })
        state.cleanups.push(() => turn.signal.removeEventListener('abort', onAbort))
      }

      const effectiveTimeout = typeof sendOptions?.timeoutMs === 'number' && sendOptions.timeoutMs > 0
        ? sendOptions.timeoutMs
        : timeoutMs
      if (effectiveTimeout > 0) {
        const timer = timers.setTimeout(() => {
          if (state.ended) return
          try {
            child.kill?.('SIGINT')
          } catch {
            // ignore
          }
          finalizeTurn(state, 'timeout')
        }, effectiveTimeout)
        if (typeof timer?.unref === 'function') timer.unref()
        state.cleanups.push(() => timers.clearTimeout(timer))
      }

      let payload
      try {
        payload = promptWriter(turn, { sessionId: spec.sessionId, kind })
      } catch (error) {
        state.emit({ type: 'error', code: 'cli.prompt_write_failed', message: messageOf(error), retryable: false })
        finalizeTurn(state, 'error')
        return queue
      }
      const text = typeof payload === 'string' ? payload : ''
      try {
        if (text === '') throw new Error('promptWriter returned no data')
        child.stdin?.write?.(text.endsWith('\n') ? text : `${text}\n`)
      } catch (error) {
        state.emit({ type: 'error', code: 'cli.prompt_write_failed', message: messageOf(error), retryable: false })
        finalizeTurn(state, 'error')
      }
      return queue
    }

    async function cancel(turnId, reason) {
      if (closed) return
      const active = activeTurn
      if (active === null || active.state.turnId !== turnId) return
      const state = active.state
      state.cancelRequested = true
      try {
        child.kill?.('SIGINT')
      } catch (error) {
        onDiagnostic('transport', `SIGINT failed: ${messageOf(error)}`)
      }
      // Escalation outlives the turn state: the process may still be alive after
      // the turn.ended(cancelled) frame, and that is exactly when SIGTERM is due.
      const termTimer = timers.setTimeout(() => {
        if (closed) return
        try {
          child.kill?.('SIGTERM')
        } catch {
          // ignore
        }
      }, graceMs)
      const killTimer = timers.setTimeout(() => {
        if (closed) return
        try {
          child.kill?.('SIGKILL')
        } catch {
          // ignore
        }
      }, graceMs + killGraceMs)
      if (typeof termTimer?.unref === 'function') termTimer.unref()
      if (typeof killTimer?.unref === 'function') killTimer.unref()
      finalizeTurn(state, 'cancelled')
      void reason
    }

    async function close() {
      if (closed) return
      if (activeTurn !== null) {
        try {
          child.kill?.('SIGINT')
        } catch {
          // ignore
        }
        finalizeTurn(activeTurn.state, 'cancelled')
      }
      try {
        child.stdin?.end?.()
      } catch {
        // ignore
      }
      try {
        child.kill?.('SIGTERM')
      } catch {
        // ignore
      }
      closed = true
    }

    return {
      id: spec.sessionId,
      send(turn, sendOptions) {
        return startTurn(turn, sendOptions)
      },
      cancel,
      close,
      async snapshot() {
        return {
          kind,
          sessionId: spec.sessionId,
          turns: turnCount,
          activeTurnId: activeTurn?.state.turnId ?? null,
          closed,
          exit: exitInfo,
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
