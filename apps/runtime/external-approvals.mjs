// Bridge ACP permission requests to the control plane's approval queue.
//
// ACP agents raise session/request_permission; this policy creates an approval
// for the Bot, polls until a user decides, and returns allow/deny to the agent.
// The control plane owns the approval table and the UI; this module only speaks
// the internal runtime-token API.

const DEFAULT_TIMEOUT_MS = 240_000
const DEFAULT_POLL_MS = 1_000

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {{
 *   request: (path: string, init?: RequestInit) => Promise<Response>,
 *   workspaceId: string,
 *   roomId?: string,
 *   timeoutMs?: number,
 *   pollMs?: number,
 *   sleep?: (ms:number)=>Promise<void>,
 *   log?: (line:string)=>void,
 * }} options
 */
export function createExternalApprovalPolicy(options) {
  const request = options.request
  const workspaceId = String(options.workspaceId ?? '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const log = options.log ?? (() => {})

  return async function permissionPolicy(event, context = {}) {
    const botId = String(context.spec?.botId ?? '')
    if (botId === '' || workspaceId === '') return 'deny'
    const tool = typeof event?.tool === 'string' && event.tool !== '' ? event.tool : 'external.tool'
    const requestId = typeof event?.requestId === 'string' ? event.requestId : ''
    const target = `external:${botId}:${requestId}`
    let created
    try {
      const response = await request('/api/internal/approvals', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId,
          kind: 'tool.call',
          requester: botId,
          requesterKind: 'bot',
          action: tool,
          target,
          payload: event?.args !== null && typeof event?.args === 'object' ? event.args : {},
          consequence: '外部 Agent 请求执行工具',
        }),
      })
      const text = await response.text().catch(() => '')
      let body = {}
      try { body = text === '' ? {} : JSON.parse(text) } catch { body = {} }
      if (!response.ok) {
        log(`external approval create failed: HTTP ${response.status} ${text.slice(0, 200)}`)
        return 'deny'
      }
      if (body.granted === true) return 'allow'
      if (body.approval === null || body.approval === undefined || typeof body.approval.id !== 'string') return 'deny'
      created = body.approval
    } catch (error) {
      log(`external approval create failed: ${messageOf(error)}`)
      return 'deny'
    }

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(pollMs)
      try {
        const response = await request(`/api/internal/approvals/${encodeURIComponent(created.id)}`)
        const text = await response.text().catch(() => '')
        let body = {}
        try { body = text === '' ? {} : JSON.parse(text) } catch { body = {} }
        if (!response.ok) continue
        const approval = body.approval ?? {}
        if (approval.status === 'approved') return 'allow'
        if (approval.status === 'denied' || approval.status === 'expired' || approval.status === 'cancelled') return 'deny'
      } catch {
        // transient control-plane failure: keep polling until deadline
      }
    }
    log(`external approval timed out for ${target}`)
    return 'deny'
  }
}
