// In-memory ACP transport for adapter tests. Speaks the same surface as
// acp-transport.mjs (sendRequest/notify/onNotification/onRequest/close) without
// a process, so the adapter's turn state machine is exercised deterministically.
//
// `script` is deliberately mutable: set `transport.script.prompt` before calling
// session.send(), and the fake agent can push session/update notifications or
// ask for permission through `context`.

export function createFakeAcpTransport(script = {}) {
  const notificationHandlers = new Set()
  const requestHandlers = new Set()
  const sentRequests = []
  const sentNotifications = []
  const responses = []
  let closed = false
  const calls = { initialize: 0, newSession: 0, prompt: 0, cancel: 0, loadSession: 0 }

  const state = {
    script,
    notificationHandlers,
    requestHandlers,
    sentRequests,
    sentNotifications,
    responses,
    calls,
    get closed() {
      return closed
    },
    emitNotification(method, params) {
      for (const handler of [...notificationHandlers]) handler({ method, params, raw: { jsonrpc: '2.0', method, params } })
    },
    async emitRequest(method, params, id = 'srv-1') {
      for (const handler of [...requestHandlers]) {
        const result = await handler({ id, method, params, raw: { jsonrpc: '2.0', id, method, params } })
        if (result !== undefined) {
          responses.push({ id, result })
          return result
        }
      }
      responses.push({ id, error: { code: -32601, message: 'method not found' } })
      return undefined
    },
  }

  const ctx = {
    transport: state,
    emitNotification: state.emitNotification,
    emitRequest: state.emitRequest,
  }

  const transport = {
    get script() {
      return state.script
    },
    set script(value) {
      state.script = value
    },
    get calls() {
      return state.calls
    },
    get sentRequests() {
      return state.sentRequests
    },
    get sentNotifications() {
      return state.sentNotifications
    },
    get responses() {
      return state.responses
    },
    get closed() {
      return closed
    },
    async sendRequest(method, params, options) {
      sentRequests.push({ method, params, options })
      if (method === 'initialize') {
        state.calls.initialize += 1
        if (typeof state.script.initialize === 'function') return state.script.initialize(params, ctx)
        return state.script.initialize ?? {
          protocolVersion: 1,
          agentInfo: { name: 'fake-grok-build', version: '1.2.3' },
          agentCapabilities: {},
        }
      }
      if (method === 'session/new') {
        state.calls.newSession += 1
        if (typeof state.script.newSession === 'function') return state.script.newSession(params, ctx)
        return state.script.newSession ?? { sessionId: state.script.sessionId ?? 'acp-session-1' }
      }
      if (method === 'session/load') {
        state.calls.loadSession += 1
        if (typeof state.script.loadSession === 'function') return state.script.loadSession(params, ctx)
        return state.script.loadSession ?? { sessionId: params?.sessionId }
      }
      if (method === 'session/prompt') {
        state.calls.prompt += 1
        if (typeof state.script.prompt === 'function') return state.script.prompt(params, ctx)
        return state.script.prompt ?? { stopReason: 'end_turn' }
      }
      throw Object.assign(new Error(`no fake ACP handler for ${method}`), {
        code: 'transport.rpc_error',
        rpc: { code: -32601, message: `no handler for ${method}` },
      })
    },
    notify(method, params) {
      sentNotifications.push({ method, params })
      if (method === 'session/cancel') state.calls.cancel += 1
      state.script.onNotify?.(method, params, ctx)
      return true
    },
    onNotification(handler) {
      notificationHandlers.add(handler)
      return () => notificationHandlers.delete(handler)
    },
    onRequest(handler) {
      requestHandlers.add(handler)
      return () => requestHandlers.delete(handler)
    },
    onExit() {
      return () => {}
    },
    async close() {
      closed = true
    },
    isClosed() {
      return closed
    },
  }
  return transport
}

export function acpSessionUpdate(sessionId, update) {
  return { sessionId, update }
}
