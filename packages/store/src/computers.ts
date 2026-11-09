// 本地 Computer / binding / job store（design/local-computer.md）。
//
// 这里只做持久化，不执行 Agent、不写房间消息。Computer token 只存 sha256。

import { createHash, randomBytes } from 'node:crypto'

import { StoreError } from './errors.ts'
import { asInteger, asNonEmptyString, assertOpen, toNumber } from './internal.ts'
import { newRoostId } from './ids.ts'
import type { Store } from './types.ts'

export const COMPUTER_STATUSES = ['registered', 'connected', 'offline', 'revoked'] as const
export type ComputerStatus = (typeof COMPUTER_STATUSES)[number]
export const COMPUTER_JOB_STATES = ['queued', 'claimed', 'running', 'done', 'failed', 'cancelled', 'expired'] as const
export type ComputerJobState = (typeof COMPUTER_JOB_STATES)[number]
export const COMPUTER_BINDING_STATUSES = ['active', 'paused', 'revoked'] as const
export type ComputerBindingStatus = (typeof COMPUTER_BINDING_STATUSES)[number]

export interface Computer {
  id: string
  accountId: string
  name: string
  os: string
  arch: string
  fingerprint: string
  version?: string
  capabilities: Record<string, unknown>
  status: ComputerStatus
  lastSeenAt?: number
  createdAt: number
  revokedAt?: number
}

export interface ComputerBinding {
  id: string
  workspaceId: string
  computerId: string
  botId: string
  agentKind: string
  workdirLabel?: string
  permission: Record<string, unknown>
  status: ComputerBindingStatus
  createdAt: number
  revokedAt?: number
}

export interface ComputerJob {
  id: string
  bindingId: string
  computerId: string
  workspaceId: string
  roomId: string
  roundId: string
  slotIndex: number
  botId: string
  state: ComputerJobState
  leaseUntil?: number
  idem: string
  payload: Record<string, unknown>
  result?: unknown
  createdAt: number
  updatedAt: number
}

interface ComputerRow {
  id: string
  account_id: string
  name: string
  os: string
  arch: string
  fingerprint: string
  version: string | null
  capabilities_json: string
  status: string
  last_seen_at: number | bigint | null
  created_at: number | bigint
  revoked_at: number | bigint | null
}

interface BindingRow {
  id: string
  workspace_id: string
  computer_id: string
  bot_id: string
  agent_kind: string
  workdir_label: string | null
  permission_json: string
  status: string
  created_at: number | bigint
  revoked_at: number | bigint | null
}

interface JobRow {
  id: string
  binding_id: string
  computer_id: string
  workspace_id: string
  room_id: string
  round_id: string
  slot_index: number | bigint
  bot_id: string
  state: string
  lease_until: number | bigint | null
  idem: string
  payload_json: string
  result_json: string | null
  created_at: number | bigint
  updated_at: number | bigint
}

function asStatus(value: unknown, fallback: ComputerStatus = 'connected'): ComputerStatus {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !(COMPUTER_STATUSES as readonly string[]).includes(value)) {
    throw new StoreError('INVALID_INPUT', `computer.status must be one of ${COMPUTER_STATUSES.join('|')}`)
  }
  return value as ComputerStatus
}

function asBindingStatus(value: unknown, fallback: ComputerBindingStatus = 'active'): ComputerBindingStatus {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !(COMPUTER_BINDING_STATUSES as readonly string[]).includes(value)) {
    throw new StoreError('INVALID_INPUT', `binding.status must be one of ${COMPUTER_BINDING_STATUSES.join('|')}`)
  }
  return value as ComputerBindingStatus
}

function asJobState(value: unknown, fallback: ComputerJobState = 'queued'): ComputerJobState {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !(COMPUTER_JOB_STATES as readonly string[]).includes(value)) {
    throw new StoreError('INVALID_INPUT', `job.state must be one of ${COMPUTER_JOB_STATES.join('|')}`)
  }
  return value as ComputerJobState
}

function jsonObject(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'object' || Array.isArray(value)) return fallback
  return value as Record<string, unknown>
}

function readJsonObject(text: string): Record<string, unknown> {
  try { return jsonObject(JSON.parse(text), {}) } catch { return {} }
}

function readJson(text: string | null): unknown {
  if (text === null) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

function rowToComputer(row: unknown): Computer {
  const r = row as ComputerRow
  return {
    id: r.id,
    accountId: r.account_id,
    name: r.name,
    os: r.os,
    arch: r.arch,
    fingerprint: r.fingerprint,
    ...(r.version === null ? {} : { version: r.version }),
    capabilities: readJsonObject(r.capabilities_json),
    status: asStatus(r.status),
    ...(r.last_seen_at === null ? {} : { lastSeenAt: toNumber(r.last_seen_at) }),
    createdAt: toNumber(r.created_at),
    ...(r.revoked_at === null ? {} : { revokedAt: toNumber(r.revoked_at) }),
  }
}

function rowToBinding(row: unknown): ComputerBinding {
  const r = row as BindingRow
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    computerId: r.computer_id,
    botId: r.bot_id,
    agentKind: r.agent_kind,
    ...(r.workdir_label === null ? {} : { workdirLabel: r.workdir_label }),
    permission: readJsonObject(r.permission_json),
    status: asBindingStatus(r.status),
    createdAt: toNumber(r.created_at),
    ...(r.revoked_at === null ? {} : { revokedAt: toNumber(r.revoked_at) }),
  }
}

function rowToJob(row: unknown): ComputerJob {
  const r = row as JobRow
  const result = readJson(r.result_json)
  return {
    id: r.id,
    bindingId: r.binding_id,
    computerId: r.computer_id,
    workspaceId: r.workspace_id,
    roomId: r.room_id,
    roundId: r.round_id,
    slotIndex: toNumber(r.slot_index),
    botId: r.bot_id,
    state: asJobState(r.state),
    ...(r.lease_until === null ? {} : { leaseUntil: toNumber(r.lease_until) }),
    idem: r.idem,
    payload: readJsonObject(r.payload_json),
    ...(result === undefined ? {} : { result }),
    createdAt: toNumber(r.created_at),
    updatedAt: toNumber(r.updated_at),
  }
}

export function hashComputerToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function generateComputerToken(): string {
  return `roostc_${randomBytes(32).toString('hex')}`
}

export interface CreateComputerInput {
  accountId: string
  name: string
  os: string
  arch: string
  fingerprint: string
  version?: string
  capabilities?: Record<string, unknown>
  now?: number
}

export function createComputer(store: Store, input: CreateComputerInput): Computer {
  assertOpen(store)
  const now = input.now ?? Date.now()
  const id = newRoostId('cmp', now)
  store.db.prepare(
    `INSERT INTO computers (id, account_id, name, os, arch, fingerprint, version, capabilities_json, status, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?)`,
  ).run(
    id,
    asNonEmptyString(input.accountId, 'computer.accountId'),
    asNonEmptyString(input.name, 'computer.name'),
    asNonEmptyString(input.os, 'computer.os'),
    asNonEmptyString(input.arch, 'computer.arch'),
    asNonEmptyString(input.fingerprint, 'computer.fingerprint'),
    input.version === undefined ? null : input.version,
    JSON.stringify(jsonObject(input.capabilities, {})),
    now,
    now,
  )
  return getComputer(store, id) as Computer
}

export function getComputer(store: Store, id: string): Computer | null {
  assertOpen(store)
  const row = store.db.prepare('SELECT * FROM computers WHERE id = ?').get(asNonEmptyString(id, 'computer.id'))
  return row === undefined || row === null ? null : rowToComputer(row)
}

export function listComputers(store: Store, accountId: string): Computer[] {
  assertOpen(store)
  const rows = store.db
    .prepare('SELECT * FROM computers WHERE account_id = ? ORDER BY created_at DESC')
    .all(asNonEmptyString(accountId, 'computer.accountId'))
  return rows.map(rowToComputer)
}

export function touchComputer(store: Store, id: string, at = Date.now()): Computer | null {
  assertOpen(store)
  store.db.prepare("UPDATE computers SET status = 'connected', last_seen_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, id)
  return getComputer(store, id)
}

export function revokeComputer(store: Store, id: string, at = Date.now()): Computer | null {
  assertOpen(store)
  store.db.prepare("UPDATE computers SET status = 'revoked', revoked_at = ? WHERE id = ?").run(at, id)
  store.db.prepare('UPDATE computer_tokens SET revoked_at = ? WHERE computer_id = ? AND revoked_at IS NULL').run(at, id)
  store.db.prepare("UPDATE computer_bindings SET status = 'revoked', revoked_at = ? WHERE computer_id = ? AND status = 'active'").run(at, id)
  return getComputer(store, id)
}

export interface CreateComputerTokenInput {
  computerId: string
  tokenHash: string
  expiresAt: number
  now?: number
}

export function createComputerToken(store: Store, input: CreateComputerTokenInput): string {
  assertOpen(store)
  const now = input.now ?? Date.now()
  const id = newRoostId('ctk', now)
  store.db.prepare(
    'INSERT INTO computer_tokens (id, computer_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, input.computerId, input.tokenHash, now, input.expiresAt)
  return id
}

export function findComputerByTokenHash(store: Store, tokenHash: string, now = Date.now()): Computer | null {
  assertOpen(store)
  const row = store.db.prepare(
    `SELECT c.* FROM computer_tokens t JOIN computers c ON c.id = t.computer_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ? AND c.revoked_at IS NULL`,
  ).get(tokenHash, now)
  return row === undefined || row === null ? null : rowToComputer(row)
}

export interface CreateComputerBindingInput {
  workspaceId: string
  computerId: string
  botId: string
  agentKind: string
  workdirLabel?: string
  permission?: Record<string, unknown>
  now?: number
}

export function createComputerBinding(store: Store, input: CreateComputerBindingInput): ComputerBinding {
  assertOpen(store)
  const now = input.now ?? Date.now()
  const id = newRoostId('cb', now)
  try {
    store.db.prepare(
      `INSERT INTO computer_bindings (id, workspace_id, computer_id, bot_id, agent_kind, workdir_label, permission_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    ).run(
      id,
      input.workspaceId,
      input.computerId,
      input.botId,
      input.agentKind,
      input.workdirLabel ?? null,
      JSON.stringify(jsonObject(input.permission, {})),
      now,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('UNIQUE')) throw new StoreError('COMPUTER_BINDING_EXISTS', 'this Bot already has an active computer binding in this workspace')
    throw error
  }
  return getComputerBinding(store, id) as ComputerBinding
}

export function getComputerBinding(store: Store, id: string): ComputerBinding | null {
  assertOpen(store)
  const row = store.db.prepare('SELECT * FROM computer_bindings WHERE id = ?').get(asNonEmptyString(id, 'binding.id'))
  return row === undefined || row === null ? null : rowToBinding(row)
}

export interface ListComputerBindingsFilter {
  workspaceId?: string
  computerId?: string
  botId?: string
  status?: ComputerBindingStatus
}

export function listComputerBindings(store: Store, filter: ListComputerBindingsFilter = {}): ComputerBinding[] {
  assertOpen(store)
  const clauses: string[] = []
  const values: unknown[] = []
  if (filter.workspaceId !== undefined) { clauses.push('workspace_id = ?'); values.push(filter.workspaceId) }
  if (filter.computerId !== undefined) { clauses.push('computer_id = ?'); values.push(filter.computerId) }
  if (filter.botId !== undefined) { clauses.push('bot_id = ?'); values.push(filter.botId) }
  if (filter.status !== undefined) { clauses.push('status = ?'); values.push(filter.status) }
  const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
  return store.db.prepare(`SELECT * FROM computer_bindings ${where} ORDER BY created_at DESC`).all(...values).map(rowToBinding)
}

export function revokeComputerBinding(store: Store, id: string, at = Date.now()): ComputerBinding | null {
  assertOpen(store)
  store.db.prepare("UPDATE computer_bindings SET status = 'revoked', revoked_at = ? WHERE id = ?").run(at, id)
  return getComputerBinding(store, id)
}

export interface CreateComputerJobInput {
  bindingId: string
  computerId: string
  workspaceId: string
  roomId: string
  roundId: string
  slotIndex: number
  botId: string
  payload: Record<string, unknown>
  idem: string
  now?: number
}

export function createComputerJob(store: Store, input: CreateComputerJobInput): ComputerJob {
  assertOpen(store)
  const now = input.now ?? Date.now()
  const id = newRoostId('cjob', now)
  try {
    store.db.prepare(
      `INSERT INTO computer_jobs
       (id, binding_id, computer_id, workspace_id, room_id, round_id, slot_index, bot_id, state, idem, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
    ).run(
      id, input.bindingId, input.computerId, input.workspaceId, input.roomId, input.roundId,
      input.slotIndex, input.botId, input.idem, JSON.stringify(input.payload), now, now,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('UNIQUE')) {
      const existing = store.db.prepare('SELECT * FROM computer_jobs WHERE idem = ?').get(input.idem)
      if (existing !== undefined && existing !== null) return rowToJob(existing)
    }
    throw error
  }
  return getComputerJob(store, id) as ComputerJob
}

export function getComputerJob(store: Store, id: string): ComputerJob | null {
  assertOpen(store)
  const row = store.db.prepare('SELECT * FROM computer_jobs WHERE id = ?').get(asNonEmptyString(id, 'job.id'))
  return row === undefined || row === null ? null : rowToJob(row)
}

export function listQueuedComputerJobs(store: Store, computerId: string, limit = 10): ComputerJob[] {
  assertOpen(store)
  const rows = store.db.prepare(
    "SELECT * FROM computer_jobs WHERE computer_id = ? AND state = 'queued' ORDER BY created_at ASC LIMIT ?",
  ).all(computerId, limit)
  return rows.map(rowToJob)
}

export function claimComputerJob(store: Store, input: { jobId: string; computerId: string; leaseMs?: number; now?: number }): ComputerJob | null {
  assertOpen(store)
  const now = input.now ?? Date.now()
  const leaseUntil = now + (input.leaseMs ?? 60_000)
  const changed = store.db.prepare(
    `UPDATE computer_jobs SET state = 'claimed', lease_until = ?, updated_at = ?
     WHERE id = ? AND computer_id = ? AND (state = 'queued' OR (state = 'claimed' AND lease_until < ?))`,
  ).run(leaseUntil, now, input.jobId, input.computerId, now)
  if (Number(changed.changes) === 0) return null
  return getComputerJob(store, input.jobId)
}

export function markComputerJobRunning(store: Store, jobId: string, at = Date.now()): ComputerJob | null {
  assertOpen(store)
  store.db.prepare("UPDATE computer_jobs SET state = 'running', updated_at = ? WHERE id = ? AND state = 'claimed'").run(at, jobId)
  return getComputerJob(store, jobId)
}

export function finishComputerJob(
  store: Store,
  input: { jobId: string; state: 'done' | 'failed' | 'cancelled'; result?: unknown; now?: number },
): ComputerJob | null {
  assertOpen(store)
  const now = input.now ?? Date.now()
  store.db.prepare(
    'UPDATE computer_jobs SET state = ?, result_json = ?, lease_until = NULL, updated_at = ? WHERE id = ?',
  ).run(input.state, input.result === undefined ? null : JSON.stringify(input.result), now, input.jobId)
  return getComputerJob(store, input.jobId)
}

export function expireComputerJobs(store: Store, now = Date.now()): number {
  assertOpen(store)
  const result = store.db.prepare(
    "UPDATE computer_jobs SET state = 'expired', updated_at = ? WHERE state = 'claimed' AND lease_until < ?",
  ).run(now, now)
  return Number(result.changes)
}
