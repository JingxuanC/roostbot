// Fake AgentAdapter/session for registry and supervisor tests: records session
// creation, can emit arbitrary event streams (including broken ones), and has
// no process, network or filesystem side effects.

import { defaultCapabilities } from '../../../../packages/agent-runtime/src/index.ts'

export async function* wellFormedTurn(turn, text = 'ok') {
  yield { type: 'turn.started', turnId: turn.turnId, at: 1 }
  yield { type: 'text.delta', turnId: turn.turnId, seq: 1, text }
  yield { type: 'text.final', turnId: turn.turnId, text }
  yield { type: 'turn.ended', turnId: turn.turnId, reason: 'stop' }
}

export async function* missingTerminalTurn(turn) {
  yield { type: 'turn.started', turnId: turn.turnId, at: 1 }
  yield { type: 'text.delta', turnId: turn.turnId, seq: 1, text: 'no end' }
}

export async function* duplicateFinalTurn(turn) {
  yield { type: 'text.final', turnId: turn.turnId, text: 'a' }
  yield { type: 'text.final', turnId: turn.turnId, text: 'b' }
  yield { type: 'turn.ended', turnId: turn.turnId, reason: 'stop' }
}

export async function* wrongTurnIdTurn(turn) {
  yield { type: 'turn.started', turnId: 'other-turn', at: 1 }
  yield { type: 'turn.ended', turnId: 'other-turn', reason: 'stop' }
}

export function createFakeAdapter(kind, options = {}) {
  const opened = []
  let capabilitiesCalls = 0
  let probeCalls = 0
  const adapter = {
    kind,
    async probe() {
      probeCalls += 1
      if (typeof options.probe === 'function') return options.probe()
      return { ok: true, version: `${kind}-1.0`, binary: kind, auth: 'ok', problems: [] }
    },
    capabilities() {
      capabilitiesCalls += 1
      const caps = options.capabilities ?? defaultCapabilities(kind)
      return typeof caps === 'function' ? caps() : caps
    },
    async openSession(spec) {
      if (typeof options.openSession === 'function') {
        return options.openSession(spec, opened)
      }
      const calls = { send: [], cancel: [], close: 0, snapshot: 0 }
      const session = {
        id: spec.sessionId,
        send(turn, sendOptions) {
          calls.send.push({ turn, sendOptions })
          if (typeof options.send === 'function') return options.send(turn, sendOptions, calls)
          return wellFormedTurn(turn)
        },
        async cancel(turnId, reason) {
          calls.cancel.push({ turnId, reason })
          if (typeof options.onCancel === 'function') await options.onCancel(turnId, reason)
        },
        async close() {
          calls.close += 1
          if (typeof options.onClose === 'function') await options.onClose()
        },
        async snapshot() {
          calls.snapshot += 1
          return { kind, sessionId: spec.sessionId, calls }
        },
      }
      opened.push({ spec, session, calls })
      return session
    },
  }
  return {
    adapter,
    opened,
    get capabilitiesCalls() {
      return capabilitiesCalls
    },
    get probeCalls() {
      return probeCalls
    },
  }
}
