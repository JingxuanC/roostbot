// Agent supervisor: the one place runtime-kind selection, session lifetime and
// the AgentEvent guard live (docs/design/agent-runtimes.md §6–§7, §12.2).
//
// Responsibilities:
// - map a room bot's `runtimeKind` to an AgentAdapter via the registry;
// - keep exactly one session per (room, bot), including a configurable runtime
//   kind (a second kind for the same bot is a programming error, not a silent
//   swap);
// - guard every event stream with `guardAgentEvents`, so a buggy adapter cannot
//   corrupt the room actor with a missing/duplicate terminal frame;
// - cancel the current turn and close sessions on shutdown;
// - cache capabilities per runtime kind and expose probe/stats.
//
// Explicitly NOT responsibilities (design §4.2/§4.3): the supervisor writes no
// database rows, pushes no SSE and changes no room state. It only creates and
// drives adapters; the control plane persists whatever the room actor decides.
//
// Not wired into room-agent yet; room-agent integration is a later task.

import { AgentRuntimeError, guardAgentEvents } from '../../packages/agent-runtime/src/index.ts'
import { createRuntimeAdapter } from './agent-adapters/registry.mjs'

const KEY_SEPARATOR = '\u0000'

function sanitizeIdPart(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 80)
}

/** Deterministic DSH session id for one (room, bot) pair. */
export function defaultSessionId(roomId, botId) {
  return `room-${sanitizeIdPart(roomId)}-${sanitizeIdPart(botId)}`
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgentRuntimeError('supervisor.invalid_request', `${label} must be a non-empty string`)
  }
  return value
}

function sessionKey(roomId, botId) {
  return `${requireString(roomId, 'roomId')}${KEY_SEPARATOR}${requireString(botId, 'botId')}`
}

function isSession(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.send === 'function'
    && typeof value.cancel === 'function'
    && typeof value.close === 'function'
}

/**
 * Create the supervisor.
 *
 * @param {object} [options]
 * @param {Function} [options.createAdapter] (kind, config) => AgentAdapter (defaults to the registry)
 * @param {import('../../packages/agent-runtime/src/index.ts').AgentAdapter[]} [options.adapters] prebuilt adapters (tests)
 * @param {Record<string, object>} [options.adapterConfigs] per-kind config for createAdapter
 * @param {(message: string, meta?: object) => void} [options.logger]
 */
export function createAgentSupervisor(options = {}) {
  const createAdapter = typeof options.createAdapter === 'function' ? options.createAdapter : createRuntimeAdapter
  const adapterConfigs = options.adapterConfigs ?? {}
  const provided = new Map((options.adapters ?? []).map((adapter) => [adapter.kind, adapter]))
  const log = typeof options.logger === 'function' ? options.logger : () => {}

  /** @type {Map<string, import('../../packages/agent-runtime/src/index.ts').AgentAdapter>} */
  const adapters = new Map(provided)
  /** @type {Map<string, import('../../packages/agent-runtime/src/index.ts').AgentCapabilities>} */
  const capabilityCache = new Map()
  /** @type {Map<string, object>} */
  const sessions = new Map()
  /** @type {Map<string, Promise<object>>} */
  const opening = new Map()

  function adapterFor(kind) {
    if (typeof kind !== 'string' || kind === '') {
      throw new AgentRuntimeError('runtime.unsupported', `runtimeKind must be a string, got ${String(kind)}`)
    }
    const cached = adapters.get(kind)
    if (cached !== undefined) return cached
    const adapter = createAdapter(kind, adapterConfigs[kind] ?? {})
    if (adapter === null || typeof adapter !== 'object' || adapter.kind !== kind) {
      throw new AgentRuntimeError('supervisor.adapter_mismatch', `adapter factory returned an adapter for ${String(adapter?.kind)} instead of ${kind}`)
    }
    if (typeof adapter.openSession !== 'function') {
      throw new AgentRuntimeError('supervisor.adapter_mismatch', `adapter ${kind} has no openSession()`)
    }
    adapters.set(kind, adapter)
    return adapter
  }

  /** Capabilities are cached per kind; refreshCapabilities() is the escape hatch. */
  function capabilities(kind) {
    const cached = capabilityCache.get(kind)
    if (cached !== undefined) return cached
    const adapter = adapterFor(kind)
    const caps = typeof adapter.capabilities === 'function' ? adapter.capabilities() : null
    if (caps === null || typeof caps !== 'object') {
      throw new AgentRuntimeError('supervisor.adapter_mismatch', `adapter ${kind} returned no capabilities`)
    }
    capabilityCache.set(kind, caps)
    return caps
  }

  function refreshCapabilities(kind) {
    capabilityCache.delete(kind)
    return capabilities(kind)
  }

  async function probe(kind) {
    return adapterFor(kind).probe()
  }

  function buildSessionSpec(request) {
    const roomId = requireString(request.roomId, 'roomId')
    const botId = requireString(request.botId, 'botId')
    const runtimeKind = requireString(request.runtimeKind, 'runtimeKind')
    const incoming = request.sessionSpec !== null && typeof request.sessionSpec === 'object' ? request.sessionSpec : {}
    const spec = { ...incoming }
    spec.sessionId = typeof spec.sessionId === 'string' && spec.sessionId !== ''
      ? spec.sessionId
      : defaultSessionId(roomId, botId)
    spec.roomId = roomId
    spec.botId = botId
    if (typeof spec.workspaceId !== 'string' || spec.workspaceId === '') spec.workspaceId = String(request.workspaceId ?? '')
    if (typeof spec.workdir !== 'string' || spec.workdir === '') spec.workdir = String(request.workdir ?? '')
    spec.env = { ...(request.env ?? {}), ...(spec.env ?? {}) }
    return { spec, runtimeKind }
  }

  /**
   * Get or create the session for one (room, bot).
   * A `runtimeKind` mismatch for an existing bot throws instead of silently
   * replacing the session (that would change capabilities mid-room).
   */
  async function ensureSession(request) {
    const key = sessionKey(request.roomId, request.botId)
    const runtimeKind = requireString(request.runtimeKind, 'runtimeKind')
    const existing = sessions.get(key)
    if (existing !== undefined) {
      if (existing.kind !== runtimeKind) {
        throw new AgentRuntimeError(
          'supervisor.runtime_mismatch',
          `bot ${request.botId} in room ${request.roomId} is already running ${existing.kind}, not ${runtimeKind}`,
        )
      }
      return existing
    }
    const pending = opening.get(key)
    if (pending !== undefined) {
      const opened = await pending
      if (opened.kind !== runtimeKind) {
        throw new AgentRuntimeError('supervisor.runtime_mismatch', `bot ${request.botId} is already opening ${opened.kind}`)
      }
      return opened
    }
    const task = (async () => {
      // Capability caching also validates the adapter before a process starts.
      const caps = capabilities(runtimeKind)
      const adapter = adapterFor(runtimeKind)
      const { spec } = buildSessionSpec({ ...request, runtimeKind })
      const session = await adapter.openSession(spec)
      if (!isSession(session)) {
        throw new AgentRuntimeError('supervisor.adapter_mismatch', `adapter ${runtimeKind} returned an invalid session`)
      }
      const entry = {
        key,
        roomId: spec.roomId,
        botId: spec.botId,
        kind: runtimeKind,
        adapter,
        session,
        spec,
        capabilities: caps,
        createdAt: Date.now(),
        turns: 0,
      }
      sessions.set(key, entry)
      log('supervisor.session_opened', { roomId: entry.roomId, botId: entry.botId, runtimeKind, sessionId: session.id })
      return entry
    })()
    opening.set(key, task)
    try {
      return await task
    } finally {
      opening.delete(key)
    }
  }

  /**
   * Send one turn and return the GUARDED event stream.
   *
   * The generator awaits session creation on first pull, so a caller can always
   * get an AsyncIterable synchronously and failures surface at the boundary.
   */
  function send(request) {
    const turn = request?.turn
    if (turn === null || typeof turn !== 'object' || typeof turn.turnId !== 'string' || turn.turnId === '') {
      throw new AgentRuntimeError('supervisor.invalid_request', 'turn.turnId is required')
    }
    return (async function* guardedTurn() {
      const entry = await ensureSession(request)
      entry.turns += 1
      const iterable = entry.session.send(turn, request.options)
      for await (const event of guardAgentEvents(turn.turnId, iterable)) yield event
    })()
  }

  async function cancel(roomId, botId, turnId, reason = 'user') {
    const key = sessionKey(roomId, botId)
    const entry = sessions.get(key)
    if (entry === undefined) return false
    requireString(turnId, 'turnId')
    await entry.session.cancel(turnId, reason)
    log('supervisor.cancel', { roomId, botId, turnId, reason })
    return true
  }

  /** Close one session, cancelling an in-flight turn first (design §9.4). */
  async function closeSession(roomId, botId) {
    const key = sessionKey(roomId, botId)
    const pending = opening.get(key)
    if (pending !== undefined) {
      try {
        await pending
      } catch {
        opening.delete(key)
        return false
      }
    }
    const entry = sessions.get(key)
    if (entry === undefined) return false
    try {
      await entry.session.close()
    } finally {
      sessions.delete(key)
      log('supervisor.session_closed', { roomId: entry.roomId, botId: entry.botId, runtimeKind: entry.kind })
    }
    return true
  }

  /** Close every session; idempotent and safe to await on shutdown. */
  async function closeAll() {
    const entries = [...sessions.values()]
    sessions.clear()
    await Promise.all(entries.map(async (entry) => {
      try {
        await entry.session.close()
      } catch (error) {
        log('supervisor.close_failed', { roomId: entry.roomId, botId: entry.botId, message: String(error?.message ?? error) })
      }
    }))
    return entries.length
  }

  function getSession(roomId, botId) {
    const entry = sessions.get(sessionKey(roomId, botId))
    if (entry === undefined) return undefined
    return {
      roomId: entry.roomId,
      botId: entry.botId,
      runtimeKind: entry.kind,
      sessionId: entry.session.id,
      turns: entry.turns,
      createdAt: entry.createdAt,
      capabilities: entry.capabilities,
    }
  }

  function listSessions() {
    return [...sessions.values()].map((entry) => ({
      roomId: entry.roomId,
      botId: entry.botId,
      runtimeKind: entry.kind,
      sessionId: entry.session.id,
      turns: entry.turns,
      createdAt: entry.createdAt,
    }))
  }

  function stats() {
    return {
      sessions: sessions.size,
      opening: opening.size,
      adapters: [...adapters.keys()],
      runtimes: [...capabilityCache.keys()],
    }
  }

  return {
    ensureSession,
    send,
    cancel,
    closeSession,
    closeAll,
    getSession,
    listSessions,
    capabilities,
    refreshCapabilities,
    probe,
    stats,
    adapterFor,
  }
}
