// Runtime-agnostic AgentAdapter contract (docs/design/agent-runtimes.md §6–§7).
//
// The room actor only knows this contract. DSH, Grok Build, Claude Code,
// Codex and Hermes each implement it behind their own transport.

export const AGENT_RUNTIME_KINDS = [
  'dsh',
  'grok-build',
  'claude-code',
  'codex',
  'hermes',
] as const

export type AgentRuntimeKind = (typeof AGENT_RUNTIME_KINDS)[number]

export function isAgentRuntimeKind(value: unknown): value is AgentRuntimeKind {
  return typeof value === 'string' && (AGENT_RUNTIME_KINDS as readonly string[]).includes(value)
}

export interface AgentCapabilities {
  streaming: boolean
  tools: 'native' | 'platform' | 'none'
  permissions: 'native' | 'bridge' | 'none'
  images: { input: boolean; output: boolean }
  resume: boolean
  subagents: boolean
  mcp: boolean
  models: string[]
  maxContextTokens?: number
  maxOutputTokens?: number
}

export function defaultCapabilities(kind: AgentRuntimeKind): AgentCapabilities {
  return {
    streaming: kind === 'dsh' || kind === 'grok-build' || kind === 'hermes',
    tools: 'native',
    permissions: kind === 'grok-build' ? 'native' : 'bridge',
    images: { input: true, output: false },
    resume: kind === 'dsh',
    subagents: kind === 'grok-build',
    mcp: kind === 'dsh' || kind === 'grok-build' || kind === 'claude-code' || kind === 'codex' || kind === 'hermes',
    models: [],
  }
}

export interface AgentProbe {
  ok: boolean
  version?: string
  binary?: string
  auth: 'ok' | 'missing' | 'unknown'
  problems: string[]
}

export interface RoomContextMember {
  botId: string
  name: string
  role?: string
}

export interface RoomContextMessage {
  seq: number
  actor: string
  text: string
  at: string
}

export interface RoomContextArtifact {
  artifactId: string
  kind: string
  name: string
  url: string
}

export interface RoomContext {
  roomName: string
  members: RoomContextMember[]
  recentMessages: RoomContextMessage[]
  summary?: string
  artifacts: RoomContextArtifact[]
  tokenBudget: number
}

export interface AgentTurn {
  turnId: string
  input: string
  context: RoomContext
  signal: AbortSignal
}

export type CancelReason = 'user' | 'timeout' | 'shutdown' | 'superseded' | 'error'

export interface AgentSessionSpec {
  sessionId: string
  roomId: string
  botId: string
  workspaceId: string
  workdir: string
  model?: string
  systemPrompt?: string
  mcpServers?: McpServerConfig[]
  env: Record<string, string>
  resumeState?: unknown
}

export interface McpServerConfig {
  name: string
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
}

export interface SendOptions {
  /** Max time for one turn; adapter must end with turn.ended. */
  timeoutMs?: number
}

export type AgentEvent =
  | { type: 'turn.started'; turnId: string; at: number }
  | { type: 'text.delta'; turnId: string; seq: number; text: string }
  | { type: 'text.final'; turnId: string; text: string }
  | { type: 'reasoning.delta'; turnId: string; text: string }
  | { type: 'tool.call'; turnId: string; callId: string; name: string; input: unknown }
  | { type: 'tool.result'; turnId: string; callId: string; ok: boolean; output?: unknown; error?: string }
  | {
      type: 'permission.request'
      turnId: string
      requestId: string
      tool: string
      args: unknown
      risk?: string
    }
  | {
      type: 'permission.resolved'
      turnId: string
      requestId: string
      decision: 'allow' | 'deny'
    }
  | { type: 'artifact'; turnId: string; path: string; mime: string; name?: string }
  | { type: 'usage'; turnId: string; inputTokens?: number; outputTokens?: number; estimated?: boolean }
  | { type: 'error'; turnId: string; code: string; message: string; retryable: boolean }
  | { type: 'turn.ended'; turnId: string; reason: 'stop' | 'cancelled' | 'timeout' | 'error' }

export interface AgentSession {
  readonly id: string
  send(turn: AgentTurn, options?: SendOptions): AsyncIterable<AgentEvent>
  cancel(turnId: string, reason: CancelReason): Promise<void>
  close(): Promise<void>
  snapshot?(): Promise<unknown>
}

export interface AgentAdapter {
  readonly kind: AgentRuntimeKind
  probe(): Promise<AgentProbe>
  capabilities(): AgentCapabilities
  openSession(spec: AgentSessionSpec): Promise<AgentSession>
}

export class AgentRuntimeError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'AgentRuntimeError'
    this.code = code
  }
}

export interface AdapterRegistry {
  register(adapter: AgentAdapter): void
  get(kind: AgentRuntimeKind): AgentAdapter | undefined
  require(kind: AgentRuntimeKind): AgentAdapter
  list(): AgentAdapter[]
}

export function createAdapterRegistry(initial: AgentAdapter[] = []): AdapterRegistry {
  const adapters = new Map<AgentRuntimeKind, AgentAdapter>()
  const registry: AdapterRegistry = {
    register(adapter) {
      if (adapters.has(adapter.kind)) {
        throw new AgentRuntimeError('runtime.duplicate', `adapter already registered: ${adapter.kind}`)
      }
      adapters.set(adapter.kind, adapter)
    },
    get(kind) {
      return adapters.get(kind)
    },
    require(kind) {
      const adapter = adapters.get(kind)
      if (adapter === undefined) throw new AgentRuntimeError('runtime.unsupported', `unsupported runtime: ${kind}`)
      return adapter
    },
    list() {
      return [...adapters.values()]
    },
  }
  for (const adapter of initial) registry.register(adapter)
  return registry
}

/**
 * Enforce the contract the room actor relies on: every turn ends exactly once,
 * deltas never follow a terminal frame, and success has at most one final text.
 * Returns a wrapped iterable so bad adapters fail at the boundary instead of
 * corrupting room state.
 */
export async function* guardAgentEvents(
  turnId: string,
  events: AsyncIterable<AgentEvent>,
): AsyncIterable<AgentEvent> {
  let ended = false
  let finalText = false
  for await (const event of events) {
    if (event.turnId !== turnId) {
      throw new AgentRuntimeError('runtime.turn_mismatch', `event turn ${event.turnId} != ${turnId}`)
    }
    if (ended) throw new AgentRuntimeError('runtime.event_after_end', 'event after turn.ended')
    if (event.type === 'text.final') {
      if (finalText) throw new AgentRuntimeError('runtime.duplicate_final', 'duplicate text.final')
      finalText = true
    }
    if (event.type === 'turn.ended') ended = true
    yield event
  }
  if (!ended) throw new AgentRuntimeError('runtime.missing_end', `turn ${turnId} ended without turn.ended`)
}
