// Agent Runtime 的 Slot / Binding / Session 存储（docs/design/agent-runtimes.md §11）。
//
// 纯 store 函数：不碰 HTTP、不碰适配器、不写房间事件。控制面只在这里记录
// “谁占着房间的哪个位置、绑定到哪个原生/Adapter 会话、Embedded 进程在哪”。
//
// 不变量：
//   * 一个 Slot 同时最多一个 active Binding（部分唯一索引兜底并发）。
//   * 关闭 Slot/Binding 会级联关闭其 active Session，避免 stale pid。
//   * kind / runtimeKind / state 全部白名单校验，非法值抛 StoreError。
//
// 本文件不在 packages/store/src/index.ts 里 re-export（控制面接线时再导出）。

import { isAgentRuntimeKind, AGENT_RUNTIME_KINDS } from '../../agent-runtime/src/index.ts'
import type { AgentRuntimeKind } from '../../agent-runtime/src/index.ts'
import { StoreError } from './errors.ts'
import { asInteger, asNonEmptyString, assertOpen, toNumber } from './internal.ts'
import { newRoostId } from './ids.ts'
import type { Store } from './types.ts'

export const SLOT_STATUSES = ['open', 'bound', 'closed'] as const
export const BINDING_KINDS = ['native', 'embedded'] as const
export const BINDING_STATES = ['active', 'closed', 'interrupted', 'failed'] as const
export const SESSION_STATUSES = ['starting', 'running', 'exited', 'failed', 'closed'] as const

export type SlotStatus = (typeof SLOT_STATUSES)[number]
export type BindingKind = (typeof BINDING_KINDS)[number]
export type BindingState = (typeof BINDING_STATES)[number]
export type SessionStatus = (typeof SESSION_STATUSES)[number]

export interface RoomSlot {
  id: string
  roomId: string
  botId?: string
  runtimeKind?: AgentRuntimeKind
  status: SlotStatus
  createdAt: number
  updatedAt: number
}

export interface CreateRoomSlotInput {
  roomId: string
  botId?: string
  runtimeKind?: AgentRuntimeKind
  status?: SlotStatus
  createdAt?: number
  id?: string
}

export interface AgentBinding {
  id: string
  slotId: string
  roomId: string
  botId?: string
  kind: BindingKind
  runtimeKind: AgentRuntimeKind
  externalId?: string
  state: BindingState
  generation: number
  createdAt: number
  lastSeenAt?: number
}

export interface CreateBindingInput {
  slotId: string
  roomId?: string
  botId?: string
  kind: BindingKind
  runtimeKind: AgentRuntimeKind
  externalId?: string
  state?: BindingState
  generation?: number
  createdAt?: number
  id?: string
}

export interface AgentSessionRecord {
  id: string
  bindingId: string
  workdir: string
  pid?: number
  status: SessionStatus
  startedAt?: number
  endedAt?: number
}

export interface CreateAgentSessionInput {
  bindingId: string
  workdir: string
  pid?: number
  status?: SessionStatus
  startedAt?: number
  id?: string
}

export interface ListBindingsFilter {
  slotId?: string
  roomId?: string
  botId?: string
  state?: BindingState
}

export interface ListSlotsFilter {
  roomId?: string
  botId?: string
  status?: SlotStatus
}

export interface CloseOptions {
  now?: number
  /** closeBinding 的终态：默认 closed；中断/失败可用 interrupted/failed。 */
  state?: Extract<BindingState, 'closed' | 'interrupted' | 'failed'>
}

interface SlotRow {
  id: string
  room_id: string
  bot_id: string | null
  runtime_kind: string | null
  status: string
  created_at: number | bigint
  updated_at: number | bigint
}

interface BindingRow {
  id: string
  slot_id: string
  room_id: string
  bot_id: string | null
  kind: string
  runtime_kind: string
  external_id: string | null
  state: string
  generation: number | bigint
  created_at: number | bigint
  last_seen_at: number | bigint | null
}

interface SessionRow {
  id: string
  binding_id: string
  workdir: string
  pid: number | bigint | null
  status: string
  started_at: number | bigint | null
  ended_at: number | bigint | null
}

// ---- validation ----------------------------------------------------------

function asSlotStatus(value: unknown, fallback: SlotStatus = 'open'): SlotStatus {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string' && (SLOT_STATUSES as readonly string[]).includes(value)) {
    return value as SlotStatus
  }
  throw new StoreError('INVALID_INPUT', `slot.status must be one of ${SLOT_STATUSES.join('|')}`)
}

function asBindingKind(value: unknown): BindingKind {
  if (typeof value === 'string' && (BINDING_KINDS as readonly string[]).includes(value)) {
    return value as BindingKind
  }
  throw new StoreError('INVALID_INPUT', `binding.kind must be one of ${BINDING_KINDS.join('|')}`)
}

function asBindingState(value: unknown, fallback: BindingState = 'active'): BindingState {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string' && (BINDING_STATES as readonly string[]).includes(value)) {
    return value as BindingState
  }
  throw new StoreError('INVALID_INPUT', `binding.state must be one of ${BINDING_STATES.join('|')}`)
}

function asSessionStatus(value: unknown, fallback: SessionStatus = 'starting'): SessionStatus {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'string' && (SESSION_STATUSES as readonly string[]).includes(value)) {
    return value as SessionStatus
  }
  throw new StoreError('INVALID_INPUT', `session.status must be one of ${SESSION_STATUSES.join('|')}`)
}

function asRuntimeKind(value: unknown, required = false): AgentRuntimeKind | undefined {
  if (value === undefined || value === null) {
    if (required) throw new StoreError('INVALID_INPUT', 'binding.runtimeKind is required')
    return undefined
  }
  if (!isAgentRuntimeKind(value)) {
    throw new StoreError(
      'INVALID_INPUT',
      `runtimeKind must be one of ${AGENT_RUNTIME_KINDS.join('|')}`,
    )
  }
  return value
}

function optionalId(value: unknown, fallback: string, at: number): string {
  if (value === undefined || value === null) return fallback
  return asNonEmptyString(value, 'id')
}

function readNow(value: unknown, label: string): number {
  if (value === undefined || value === null) return Date.now()
  return asInteger(value, label, 0)
}

// ---- row mapping ---------------------------------------------------------

function rowToSlot(row: unknown): RoomSlot {
  const r = row as SlotRow
  return {
    id: r.id,
    roomId: r.room_id,
    ...(r.bot_id === null ? {} : { botId: r.bot_id }),
    ...(isAgentRuntimeKind(r.runtime_kind) ? { runtimeKind: r.runtime_kind } : {}),
    status: asSlotStatus(r.status),
    createdAt: toNumber(r.created_at),
    updatedAt: toNumber(r.updated_at),
  }
}

function rowToBinding(row: unknown): AgentBinding {
  const r = row as BindingRow
  return {
    id: r.id,
    slotId: r.slot_id,
    roomId: r.room_id,
    ...(r.bot_id === null ? {} : { botId: r.bot_id }),
    kind: asBindingKind(r.kind),
    runtimeKind: asRuntimeKind(r.runtime_kind, true) as AgentRuntimeKind,
    ...(r.external_id === null ? {} : { externalId: r.external_id }),
    state: asBindingState(r.state),
    generation: toNumber(r.generation),
    createdAt: toNumber(r.created_at),
    ...(r.last_seen_at === null ? {} : { lastSeenAt: toNumber(r.last_seen_at) }),
  }
}

function rowToSession(row: unknown): AgentSessionRecord {
  const r = row as SessionRow
  return {
    id: r.id,
    bindingId: r.binding_id,
    workdir: r.workdir,
    ...(r.pid === null ? {} : { pid: toNumber(r.pid) }),
    status: asSessionStatus(r.status),
    ...(r.started_at === null ? {} : { startedAt: toNumber(r.started_at) }),
    ...(r.ended_at === null ? {} : { endedAt: toNumber(r.ended_at) }),
  }
}

// ---- slots ---------------------------------------------------------------

export function createRoomSlot(store: Store, input: CreateRoomSlotInput): RoomSlot {
  assertOpen(store)
  const req = (input ?? {}) as CreateRoomSlotInput
  const roomId = asNonEmptyString(req.roomId, 'slot.roomId')
  const room = store.db.prepare('SELECT id, workspace_id FROM rooms WHERE id = ?').get(roomId) as
    | { id: string; workspace_id: string }
    | undefined
  if (room === undefined || room === null) {
    throw new StoreError('ROOM_NOT_FOUND', `unknown room ${roomId}`)
  }
  const botId = req.botId === undefined || req.botId === null ? null : asNonEmptyString(req.botId, 'slot.botId')
  if (botId !== null) {
    const bot = store.db.prepare('SELECT id, workspace_id FROM bots WHERE id = ? AND deleted_at IS NULL').get(botId) as
      | { id: string; workspace_id: string }
      | undefined
    if (bot === undefined || bot === null) {
      throw new StoreError('BOT_NOT_FOUND', `unknown bot ${botId}`)
    }
    if (bot.workspace_id !== room.workspace_id) {
      throw new StoreError('INVALID_INPUT', 'slot bot and room must belong to the same workspace')
    }
  }
  const runtimeKind = asRuntimeKind(req.runtimeKind)
  const status = asSlotStatus(req.status)
  const createdAt = readNow(req.createdAt, 'slot.createdAt')
  const id = optionalId(req.id, newRoostId('slot', createdAt), createdAt)
  store.db
    .prepare(
      'INSERT INTO room_slots (id, room_id, bot_id, runtime_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, roomId, botId, runtimeKind ?? null, status, createdAt, createdAt)
  return rowToSlot(store.db.prepare('SELECT * FROM room_slots WHERE id = ?').get(id))
}

export function getRoomSlot(store: Store, id: string): RoomSlot | null {
  assertOpen(store)
  const row = store.db.prepare('SELECT * FROM room_slots WHERE id = ?').get(asNonEmptyString(id, 'slot.id'))
  return row === undefined || row === null ? null : rowToSlot(row)
}

export function listRoomSlots(store: Store, filter: ListSlotsFilter = {}): RoomSlot[] {
  assertOpen(store)
  const clauses: string[] = []
  const values: unknown[] = []
  if (filter.roomId !== undefined) {
    clauses.push('room_id = ?')
    values.push(asNonEmptyString(filter.roomId, 'slot.roomId'))
  }
  if (filter.botId !== undefined) {
    clauses.push('bot_id = ?')
    values.push(asNonEmptyString(filter.botId, 'slot.botId'))
  }
  if (filter.status !== undefined) {
    clauses.push('status = ?')
    values.push(asSlotStatus(filter.status))
  }
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
  return store.db
    .prepare(`SELECT * FROM room_slots${where} ORDER BY created_at, id`)
    .all(...values)
    .map(rowToSlot)
}

export function closeRoomSlot(store: Store, id: string, opts: CloseOptions = {}): RoomSlot {
  assertOpen(store)
  const slotId = asNonEmptyString(id, 'slot.id')
  const slot = getRoomSlot(store, slotId)
  if (slot === null) throw new StoreError('ROOM_NOT_FOUND', `unknown room slot ${slotId}`)
  if (slot.status === 'closed') return slot
  const now = readNow(opts.now, 'slot.close.now')
  store.db.exec('SAVEPOINT roost_close_slot')
  try {
    store.db
      .prepare("UPDATE room_slots SET status = 'closed', updated_at = ? WHERE id = ?")
      .run(now, slotId)
    store.db
      .prepare("UPDATE agent_bindings SET state = 'closed', last_seen_at = ? WHERE slot_id = ? AND state = 'active'")
      .run(now, slotId)
    store.db
      .prepare(
        "UPDATE agent_sessions SET status = 'closed', ended_at = ? WHERE status IN ('starting','running') AND binding_id IN (SELECT id FROM agent_bindings WHERE slot_id = ?)",
      )
      .run(now, slotId)
    store.db.exec('RELEASE roost_close_slot')
  } catch (err) {
    try {
      store.db.exec('ROLLBACK TO roost_close_slot')
      store.db.exec('RELEASE roost_close_slot')
    } catch {
      // 保留原始错误。
    }
    throw err instanceof StoreError ? err : new StoreError('INVALID_INPUT', `failed to close slot: ${String(err)}`)
  }
  return getRoomSlot(store, slotId) as RoomSlot
}

// ---- bindings ------------------------------------------------------------

export function createBinding(store: Store, input: CreateBindingInput): AgentBinding {
  assertOpen(store)
  const req = (input ?? {}) as CreateBindingInput
  const slotId = asNonEmptyString(req.slotId, 'binding.slotId')
  const kind = asBindingKind(req.kind)
  const runtimeKind = asRuntimeKind(req.runtimeKind, true) as AgentRuntimeKind
  const slot = getRoomSlot(store, slotId)
  if (slot === null) throw new StoreError('ROOM_NOT_FOUND', `unknown room slot ${slotId}`)
  if (slot.status === 'closed') throw new StoreError('INVALID_INPUT', `slot ${slotId} is closed`)
  const roomId =
    req.roomId === undefined || req.roomId === null ? slot.roomId : asNonEmptyString(req.roomId, 'binding.roomId')
  if (roomId !== slot.roomId) throw new StoreError('INVALID_INPUT', 'binding.roomId must match its slot room')
  const botId =
    req.botId === undefined || req.botId === null ? slot.botId ?? null : asNonEmptyString(req.botId, 'binding.botId')
  if (slot.botId !== undefined && botId !== null && slot.botId !== botId) {
    throw new StoreError('INVALID_INPUT', 'binding.botId must match its slot bot')
  }
  const externalId =
    req.externalId === undefined || req.externalId === null ? null : asNonEmptyString(req.externalId, 'binding.externalId')
  const state = asBindingState(req.state)
  const createdAt = readNow(req.createdAt, 'binding.createdAt')
  const requestedGeneration =
    req.generation === undefined || req.generation === null ? null : asInteger(req.generation, 'binding.generation', 1)
  const previous = store.db
    .prepare('SELECT COALESCE(MAX(generation), 0) AS generation FROM agent_bindings WHERE slot_id = ?')
    .get(slotId) as { generation: number | bigint }
  const generation = requestedGeneration ?? toNumber(previous.generation) + 1
  const id = optionalId(req.id, newRoostId('bind', createdAt), createdAt)

  store.db.exec('SAVEPOINT roost_create_binding')
  try {
    if (state === 'active') {
      const active = store.db
        .prepare("SELECT id FROM agent_bindings WHERE slot_id = ? AND state = 'active'")
        .get(slotId)
      if (active !== undefined && active !== null) {
        throw new StoreError('INVALID_INPUT', `slot ${slotId} already has an active binding`)
      }
    }
    store.db
      .prepare(
        'INSERT INTO agent_bindings (id, slot_id, room_id, bot_id, kind, runtime_kind, external_id, state, generation, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      )
      .run(id, slotId, roomId, botId, kind, runtimeKind, externalId, state, generation, createdAt)
    if (state === 'active' && slot.status === 'open') {
      store.db.prepare("UPDATE room_slots SET status = 'bound', updated_at = ? WHERE id = ?").run(createdAt, slotId)
    }
    store.db.exec('RELEASE roost_create_binding')
  } catch (err) {
    try {
      store.db.exec('ROLLBACK TO roost_create_binding')
      store.db.exec('RELEASE roost_create_binding')
    } catch {
      // 保留原始错误。
    }
    if (err instanceof StoreError) throw err
    throw new StoreError('INVALID_INPUT', `failed to create binding: ${String(err)}`)
  }
  return getBinding(store, id) as AgentBinding
}

export function getBinding(store: Store, id: string): AgentBinding | null {
  assertOpen(store)
  const row = store.db.prepare('SELECT * FROM agent_bindings WHERE id = ?').get(asNonEmptyString(id, 'binding.id'))
  return row === undefined || row === null ? null : rowToBinding(row)
}

export function listBindings(store: Store, filter: ListBindingsFilter = {}): AgentBinding[] {
  assertOpen(store)
  const clauses: string[] = []
  const values: unknown[] = []
  if (filter.slotId !== undefined) {
    clauses.push('slot_id = ?')
    values.push(asNonEmptyString(filter.slotId, 'binding.slotId'))
  }
  if (filter.roomId !== undefined) {
    clauses.push('room_id = ?')
    values.push(asNonEmptyString(filter.roomId, 'binding.roomId'))
  }
  if (filter.botId !== undefined) {
    clauses.push('bot_id = ?')
    values.push(asNonEmptyString(filter.botId, 'binding.botId'))
  }
  if (filter.state !== undefined) {
    clauses.push('state = ?')
    values.push(asBindingState(filter.state))
  }
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
  return store.db
    .prepare(`SELECT * FROM agent_bindings${where} ORDER BY created_at, id`)
    .all(...values)
    .map(rowToBinding)
}

export function closeBinding(store: Store, id: string, opts: CloseOptions = {}): AgentBinding {
  assertOpen(store)
  const bindingId = asNonEmptyString(id, 'binding.id')
  const binding = getBinding(store, bindingId)
  if (binding === null) throw new StoreError('INVALID_INPUT', `unknown binding ${bindingId}`)
  const state = opts.state ?? 'closed'
  if (state !== 'closed' && state !== 'interrupted' && state !== 'failed') {
    throw new StoreError('INVALID_INPUT', 'closeBinding state must be closed|interrupted|failed')
  }
  if (binding.state !== 'active') return binding
  const now = readNow(opts.now, 'binding.close.now')
  store.db.exec('SAVEPOINT roost_close_binding')
  try {
    store.db
      .prepare('UPDATE agent_bindings SET state = ?, last_seen_at = ? WHERE id = ? AND state = ?')
      .run(state, now, bindingId, 'active')
    store.db
      .prepare(
        "UPDATE agent_sessions SET status = 'closed', ended_at = ? WHERE binding_id = ? AND status IN ('starting','running')",
      )
      .run(now, bindingId)
    store.db.exec('RELEASE roost_close_binding')
  } catch (err) {
    try {
      store.db.exec('ROLLBACK TO roost_close_binding')
      store.db.exec('RELEASE roost_close_binding')
    } catch {
      // 保留原始错误。
    }
    throw err instanceof StoreError ? err : new StoreError('INVALID_INPUT', `failed to close binding: ${String(err)}`)
  }
  return getBinding(store, bindingId) as AgentBinding
}

// ---- embedded sessions ---------------------------------------------------

export function createAgentSession(store: Store, input: CreateAgentSessionInput): AgentSessionRecord {
  assertOpen(store)
  const req = (input ?? {}) as CreateAgentSessionInput
  const bindingId = asNonEmptyString(req.bindingId, 'session.bindingId')
  const binding = getBinding(store, bindingId)
  if (binding === null) throw new StoreError('INVALID_INPUT', `unknown binding ${bindingId}`)
  if (binding.state !== 'active') throw new StoreError('INVALID_INPUT', `binding ${bindingId} is not active`)
  if (binding.kind !== 'embedded') {
    throw new StoreError('INVALID_INPUT', `binding ${bindingId} is native; agent_sessions are embedded-only`)
  }
  const workdir = asNonEmptyString(req.workdir, 'session.workdir')
  const status = asSessionStatus(req.status)
  const pid =
    req.pid === undefined || req.pid === null ? null : asInteger(req.pid, 'session.pid', 0)
  const startedAt = readNow(req.startedAt, 'session.startedAt')
  const id = optionalId(req.id, newRoostId('sess', startedAt), startedAt)
  store.db
    .prepare(
      'INSERT INTO agent_sessions (id, binding_id, workdir, pid, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
    )
    .run(id, bindingId, workdir, pid, status, startedAt)
  return getAgentSession(store, id) as AgentSessionRecord
}

export function getAgentSession(store: Store, id: string): AgentSessionRecord | null {
  assertOpen(store)
  const row = store.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(asNonEmptyString(id, 'session.id'))
  return row === undefined || row === null ? null : rowToSession(row)
}

export function listAgentSessions(
  store: Store,
  filter: { bindingId?: string; status?: SessionStatus } = {},
): AgentSessionRecord[] {
  assertOpen(store)
  const clauses: string[] = []
  const values: unknown[] = []
  if (filter.bindingId !== undefined) {
    clauses.push('binding_id = ?')
    values.push(asNonEmptyString(filter.bindingId, 'session.bindingId'))
  }
  if (filter.status !== undefined) {
    clauses.push('status = ?')
    values.push(asSessionStatus(filter.status))
  }
  const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
  return store.db
    .prepare(`SELECT * FROM agent_sessions${where} ORDER BY started_at, id`)
    .all(...values)
    .map(rowToSession)
}

export function closeAgentSession(
  store: Store,
  id: string,
  opts: { now?: number; status?: Extract<SessionStatus, 'closed' | 'exited' | 'failed'> } = {},
): AgentSessionRecord {
  assertOpen(store)
  const sessionId = asNonEmptyString(id, 'session.id')
  const session = getAgentSession(store, sessionId)
  if (session === null) throw new StoreError('INVALID_INPUT', `unknown agent session ${sessionId}`)
  if (session.status === 'closed' || session.status === 'exited' || session.status === 'failed') return session
  const status = opts.status ?? 'closed'
  if (status !== 'closed' && status !== 'exited' && status !== 'failed') {
    throw new StoreError('INVALID_INPUT', 'closeAgentSession status must be closed|exited|failed')
  }
  const now = readNow(opts.now, 'session.close.now')
  store.db.prepare('UPDATE agent_sessions SET status = ?, ended_at = ? WHERE id = ?').run(status, now, sessionId)
  return getAgentSession(store, sessionId) as AgentSessionRecord
}

// 语义别名：设计文档用 Room Slot / Binding，调用方也可能只说 slot/binding。
export const createSlot = createRoomSlot
export const getSlot = getRoomSlot
export const listSlots = listRoomSlots
export const closeSlot = closeRoomSlot
