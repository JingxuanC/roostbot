// CLI personal access token (P0 for `roost login`).
//
// The browser can create a 90-day session token for a CLI; the token is
// returned once and stored only as sha256. It is intentionally a normal
// device session, so all existing user APIs keep working without a second
// authentication path.

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { StorePort } from './port.ts'
import { authenticate, hashSessionToken, isPlainObject, readJsonBody, sendError, sendJson } from './server.ts'

export interface CliTokenRouteContext {
  store: StorePort
  now: () => number
}

const CLI_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000

export async function handleCreateCliToken(
  ctx: CliTokenRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await authenticate(ctx, req)
  if (!auth.ok) return sendError(res, auth.status, auth.code, auth.message, { 'www-authenticate': 'Bearer' })
  let label = 'roost CLI'
  try {
    const parsed = await readJsonBody(req)
    if (parsed.ok && isPlainObject(parsed.value) && typeof parsed.value['label'] === 'string' && parsed.value['label'].trim() !== '') {
      label = parsed.value['label'].trim().slice(0, 80)
    }
  } catch {
    // A body is optional for this endpoint.
  }
  const now = ctx.now()
  const token = randomBytes(32).toString('hex')
  try {
    const session = await ctx.store.createSession({
      accountId: auth.session.accountId,
      tokenHash: hashSessionToken(token),
      now,
      expiresAt: now + CLI_TOKEN_TTL_MS,
      deviceLabel: label,
      platform: 'cli',
    })
    sendJson(res, 201, { token, expiresAt: session.expiresAt, deviceId: session.deviceId })
  } catch (error) {
    sendError(res, 500, 'cli_token.failed', error instanceof Error ? error.message : String(error))
  }
}
