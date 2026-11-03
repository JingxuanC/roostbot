// workspace 表（workspace.md §8）。卷里的这份由 home runtime 写，卷永远赢（§6）。

import { StoreError } from './errors.ts'
import {
  asInteger,
  asNonEmptyString,
  asOptionalString,
  asRecord,
  assertOpen,
  errorMessage,
  toNumber,
} from './internal.ts'
import { newWorkspaceId } from './ids.ts'
import type { CreateWorkspaceInput, HomeMode, Store, Workspace, WorkspaceState } from './types.ts'

export const HOME_MODES = ['cloud', 'local'] as const

export const WORKSPACE_STATES = [
  'absent',
  'stopped',
  'starting',
  'running',
  'stopping',
  'migrating',
] as const

interface WorkspaceRow {
  id: string
  tenant_id: string
  name: string
  home_mode: string
  state: string
  volume_id: string | null
  profile_ver: string
  created_at: number | bigint
}

export function createWorkspace(store: Store, input: CreateWorkspaceInput): Workspace {
  assertOpen(store)
  const req = asRecord(input, 'workspace', 'INVALID_WORKSPACE')

  const id =
    req.id === undefined || req.id === null
      ? newWorkspaceId()
      : asNonEmptyString(req.id, 'workspace.id', 'INVALID_WORKSPACE')
  const tenantId = asNonEmptyString(req.tenantId, 'workspace.tenantId', 'INVALID_WORKSPACE')
  const name = asNonEmptyString(req.name, 'workspace.name', 'INVALID_WORKSPACE')
  const homeMode = asHomeMode(req.homeMode)
  const state = asWorkspaceState(req.state)
  const volumeId = asOptionalString(req.volumeId, 'workspace.volumeId', 'INVALID_WORKSPACE')
  const profileVersion = asNonEmptyString(
    req.profileVersion,
    'workspace.profileVersion',
    'INVALID_WORKSPACE',
  )
  const createdAt =
    req.createdAt === undefined || req.createdAt === null
      ? Date.now()
      : asInteger(req.createdAt, 'workspace.createdAt', 0, 'INVALID_WORKSPACE')

  try {
    store.db
      .prepare(
        'INSERT INTO workspaces (id, tenant_id, name, home_mode, state, volume_id, profile_ver, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, tenantId, name, homeMode, state, volumeId, profileVersion, createdAt)
  } catch (err) {
    const message = errorMessage(err)
    if (message.includes('UNIQUE')) {
      throw new StoreError('WORKSPACE_EXISTS', `workspace ${id} already exists`, { cause: err })
    }
    throw new StoreError('WORKSPACE_WRITE_FAILED', `failed to create workspace ${id}: ${message}`, {
      cause: err,
    })
  }

  return { id, tenantId, name, homeMode, state, volumeId, profileVersion, createdAt }
}

export function listWorkspaces(store: Store, filter: { tenantId?: string } = {}): Workspace[] {
  assertOpen(store)
  const query = asRecord(filter, 'filter')

  const columns =
    'id, tenant_id, name, home_mode, state, volume_id, profile_ver, created_at'
  let sql = `SELECT ${columns} FROM workspaces`
  const params: unknown[] = []

  if (query.tenantId !== undefined && query.tenantId !== null) {
    sql += ' WHERE tenant_id = ?'
    params.push(asNonEmptyString(query.tenantId, 'filter.tenantId'))
  }
  sql += ' ORDER BY created_at ASC, id ASC'

  return store.db
    .prepare(sql)
    .all(...params)
    .map(rowToWorkspace)
}

function asHomeMode(value: unknown): HomeMode {
  if (value === undefined || value === null) return 'cloud'
  if (typeof value !== 'string' || !(HOME_MODES as readonly string[]).includes(value)) {
    throw new StoreError(
      'INVALID_WORKSPACE',
      `workspace.homeMode must be one of ${HOME_MODES.join(', ')} (workspace.md §8)`,
    )
  }
  return value as HomeMode
}

function asWorkspaceState(value: unknown): WorkspaceState {
  if (value === undefined || value === null) return 'stopped'
  if (typeof value !== 'string' || !(WORKSPACE_STATES as readonly string[]).includes(value)) {
    throw new StoreError(
      'INVALID_WORKSPACE',
      `workspace.state must be one of ${WORKSPACE_STATES.join(', ')} (workspace.md §8)`,
    )
  }
  return value as WorkspaceState
}

function rowToWorkspace(row: unknown): Workspace {
  const r = row as WorkspaceRow
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    homeMode: r.home_mode as HomeMode,
    state: r.state as WorkspaceState,
    volumeId: r.volume_id,
    profileVersion: r.profile_ver,
    createdAt: toNumber(r.created_at),
  }
}
