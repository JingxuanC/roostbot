// 工作区运行时状态：沙箱名与阶段（docs/design/sandboxing.md §15、TODO 4.3.2）。
//
// 单独一张表，而不是挤进 0002 的 runtimes（那行的语义是"运行时注册 + token 摘要"）；
// 这里只回答"这个工作区的沙箱现在是什么状态"。

import { assertOpen, asNonEmptyString, asRecord, toNumber } from './internal.ts'
import type { Store } from './types.ts'

export type RuntimePhase = 'creating' | 'ready' | 'stopped' | 'error' | 'unknown'

export interface WorkspaceRuntime {
  workspaceId: string
  sandbox: string
  phase: RuntimePhase
  startedAt: number
  lastSeenAt: number
}

export function saveWorkspaceRuntime(
  store: Store,
  input: { workspaceId: string; sandbox: string; phase: RuntimePhase; startedAt?: number; lastSeenAt?: number }
): WorkspaceRuntime {
  assertOpen(store)
  const req = asRecord(input, 'runtime', 'INVALID_INPUT')
  const workspaceId = asNonEmptyString(req.workspaceId, 'runtime.workspaceId', 'INVALID_INPUT')
  const sandbox = asNonEmptyString(req.sandbox, 'runtime.sandbox', 'INVALID_INPUT')
  const phase = asNonEmptyString(req.phase, 'runtime.phase', 'INVALID_INPUT') as RuntimePhase
  const now = Date.now()
  const startedAt = req.startedAt === undefined ? now : toNumber(req.startedAt)
  const lastSeenAt = req.lastSeenAt === undefined ? now : toNumber(req.lastSeenAt)
  store.db
    .prepare(
      `INSERT INTO workspace_runtime (workspace_id, sandbox, phase, started_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         sandbox = excluded.sandbox, phase = excluded.phase, last_seen_at = excluded.last_seen_at`
    )
    .run(workspaceId, sandbox, phase, startedAt, lastSeenAt)
  return { workspaceId, sandbox, phase, startedAt, lastSeenAt }
}

export function getWorkspaceRuntime(store: Store, workspaceId: string): WorkspaceRuntime | null {
  assertOpen(store)
  const row = store.db
    .prepare('SELECT workspace_id, sandbox, phase, started_at, last_seen_at FROM workspace_runtime WHERE workspace_id = ?')
    .get(asNonEmptyString(workspaceId, 'runtime.workspaceId', 'INVALID_INPUT')) as
    | { workspace_id: string; sandbox: string; phase: string; started_at: number | bigint; last_seen_at: number | bigint }
    | undefined
  if (row === undefined || row === null) return null
  return {
    workspaceId: row.workspace_id,
    sandbox: row.sandbox,
    phase: row.phase as RuntimePhase,
    startedAt: toNumber(row.started_at),
    lastSeenAt: toNumber(row.last_seen_at)
  }
}
