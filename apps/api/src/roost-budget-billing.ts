// Bridge roostbot's operational budget reservations to Roost Credits.
//
// roostbot keeps its SQLite quota/reservation layer for local limits. This
// module mirrors each chargeable reservation into the Roost Console billing
// ledger so the organization wallet is the actual money source of truth.
// Only reservations whose workspace belongs to a Roost org are mirrored; a
// local-only deployment keeps working with ROOST_CONSOLE_* unset.

import type { Store } from '../../../packages/store/src/types.ts'

const CONSOLE_URL = (process.env['ROOST_CONSOLE_API_URL'] ?? '').replace(/\/+$/, '')
const SERVICE_SECRET = process.env['ROOST_CONSOLE_SERVICE_SECRET'] ?? ''

// 1 Roost credit = ¥0.01. These are deliberately conservative list rates; the
// product can tune them without touching the ledger contract.
const CREDITS_PER_UNIT: Record<string, number> = {
  tokens: 1 / 1000,
  runs: 5,
  container_seconds: 0.05,
  storage_bytes: 1 / 10_000_000_000,
  messages: 0.05,
}

export class RoostBudgetDenied extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RoostBudgetDenied'
  }
}

export function roostBudgetEnabled(): boolean {
  return CONSOLE_URL !== '' && SERVICE_SECRET !== ''
}

function orgForWorkspace(rawStore: Store, workspaceId: string): string | null {
  const row = rawStore.db
    .prepare(
      `SELECT a.roost_org_id AS org_id
         FROM workspaces w JOIN accounts a ON a.id = w.tenant_id
        WHERE w.id = ?`,
    )
    .get(workspaceId) as { org_id?: string | null } | undefined
  const org = row?.org_id
  return typeof org === 'string' && org !== '' ? org : null
}

export function creditsFor(metric: string, units: number): number {
  const rate = CREDITS_PER_UNIT[metric] ?? 0
  if (units <= 0 || rate <= 0) return 0
  return Math.max(1, Math.ceil(units * rate))
}

interface ReservationRef {
  id: string
  metric: string
}

interface LedgerCall {
  workspaceId: string
  reservation: ReservationRef
  credits: number
}

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(CONSOLE_URL + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
}

export async function reserveRoostCredits(
  rawStore: Store,
  workspaceId: string,
  reservation: ReservationRef,
  units: number,
): Promise<string | null> {
  if (!roostBudgetEnabled()) return null
  const orgId = orgForWorkspace(rawStore, workspaceId)
  if (orgId === null) return null
  const credits = creditsFor(reservation.metric, units)
  if (credits <= 0) return orgId
  const response = await post('/internal/v1/usage/leases', {
    org_id: orgId,
    product: 'roostbot',
    run_ref: `roostbot:${reservation.id}`,
    estimated_credits: credits,
    ttl_seconds: 900,
  })
  if (response.status === 402 || response.status === 429) {
    throw new RoostBudgetDenied('Roost 积分不足，请到 console.roostbots.com 充值')
  }
  if (!response.ok) throw new Error(`Roost reserve returned ${response.status}`)
  return orgId
}

export async function settleRoostCredits(
  rawStore: Store,
  workspaceId: string,
  reservation: ReservationRef,
  units: number,
): Promise<void> {
  if (!roostBudgetEnabled()) return
  const orgId = orgForWorkspace(rawStore, workspaceId)
  if (orgId === null) return
  const credits = creditsFor(reservation.metric, units)
  const response = await post('/internal/v1/usage/leases/by-run/settle', {
    org_id: orgId,
    product: 'roostbot',
    run_ref: `roostbot:${reservation.id}`,
    actual_credits: credits,
  })
  if (!response.ok) throw new Error(`Roost settle returned ${response.status}`)
}
