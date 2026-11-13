// Roost Console billing bridge for roostbot.
//
// The account id is local; the wallet dimension is the Roost organization id
// carried by the OIDC userinfo and persisted on accounts.roost_org_id.
// This endpoint is read-only on purpose: budget spend still goes through the
// local quota/reservation layer until the product meter is converted to credits.

import type { IncomingMessage, ServerResponse } from 'node:http'

import { findAccountById, setAccountRoostOrg } from '../../../packages/store/src/accounts-auth.ts'
import type { Store } from '../../../packages/store/src/types.ts'
import { authenticate, sendError, sendJson } from './server.ts'

export interface RoostBillingContext {
  rawStore?: Store
  now: () => number
}

const CONSOLE_URL = (process.env['ROOST_CONSOLE_API_URL'] ?? '').replace(/\/+$/, '')
const SERVICE_SECRET = process.env['ROOST_CONSOLE_SERVICE_SECRET'] ?? ''

async function consolePost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  if (CONSOLE_URL === '' || SERVICE_SECRET === '') {
    throw new Error('Roost Console billing is not configured')
  }
  const response = await fetch(CONSOLE_URL + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Roost Console returned ${response.status}`)
  return (await response.json()) as T
}

interface Org { id: string; name: string; plan_code: string }
interface Entitlement {
  org_id: string
  product: string
  enabled: boolean
  plan_code: string
  monthly_cap_credits: number | null
  available_credits: number
  balance_credits: number
  reserved_credits: number
}

export async function handleRoostBilling(
  ctx: RoostBillingContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await authenticate(ctx as never, req)
  if (!auth.ok) {
    sendError(res, 401, auth.code ?? 'unauthorized', auth.message ?? 'login required')
    return
  }
  if (ctx.rawStore === undefined) {
    sendError(res, 503, 'roost.billing_unavailable', 'billing needs durable storage')
    return
  }
  const account = findAccountById(ctx.rawStore, auth.session.accountId)
  if (account === null) {
    sendError(res, 401, 'unauthorized', 'account not found')
    return
  }

  let orgId = account.roostOrgId
  try {
    if (orgId === null) {
      if (account.oidcSubject === null) {
        sendError(res, 409, 'roost.link_required', 'link a Roost account with OIDC first')
        return
      }
      const org = await consolePost<Org>('/internal/v1/orgs/resolve-user', { user_id: account.oidcSubject })
      orgId = org.id
      setAccountRoostOrg(ctx.rawStore, account.id, orgId)
    }
    const entitlement = await consolePost<Entitlement>('/internal/v1/entitlements/resolve', {
      org_id: orgId,
      product: 'roostbot',
    })
    sendJson(res, 200, {
      orgId,
      product: 'roostbot',
      planCode: entitlement.plan_code,
      enabled: entitlement.enabled,
      balanceCredits: entitlement.balance_credits,
      availableCredits: entitlement.available_credits,
      reservedCredits: entitlement.reserved_credits,
      monthlyCapCredits: entitlement.monthly_cap_credits,
    })
  } catch (err) {
    sendError(res, 502, 'roost.billing_unavailable', err instanceof Error ? err.message : 'billing unavailable')
  }
}
