// Cordis 插件入口：把审批桥真正挂进一个 DSH 进程（docs/build/wave3.md §A）。
//
// 这个文件是「分发」的最后一段：bridge 状态机（bridge.ts）与 DSH answerer
// （dsh.ts）都已存在，这里只做两件有副作用的事：
//   1. request —— 把一次 DSH 工具审批落成控制面的 pending 审批单；
//   2. wait    —— 轮询控制面，直到人批准/拒绝，或桥自己记超时。
//
// 纪律：
//   * 不 import 任何 DSH 包。`ctx` 只要求 `on(event, listener)`，由 Cordis
//     宿主传进来；这样插件包在 node:test 里不需要 DSH 也能跑。
//   * 建单失败 = 通道坏了，桥记 `request_failed`，DSH 适配器答 `unavailable`
//     （不是「用户拒绝」）。超时 = 人没回答，桥记 `timeout`，DSH 答 `rejected`
//     （失败关闭）。
//   * 轮询只信控制面的 status：approved / rejected 以外的词一律当作「还没决定」，
//     免得一个坏响应被误读成放行。

import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'

import { createApprovalBridge } from './bridge.ts'
import type { ApprovalBridge, BridgeDecision, WaitInput } from './bridge.ts'
import { defaultRequestId, installApprovalBridge } from './dsh.ts'
import type { DshApprovalContext, DshApprovalRequestEvent, InstallApprovalBridgeHandle } from './dsh.ts'

/** 插件配置（由 profile 的 cordis.patch.yml 注入）。 */
export interface ApprovalBridgePluginConfig {
  /** 控制面根地址，例如 `http://host.openshell.internal:8792`。 */
  apiBase: string
  /** 每个 workspace 一张的短 runtime token；只发给控制面的内部审批接口。 */
  runtimeToken: string
  workspaceId: string
  botId: string
  /** 等一个决定的上限；默认 5 分钟，超时失败关闭。 */
  timeoutMs?: number
}

/**
 * 测试注入点。生产路径（Cordis 调 `apply(ctx, config)`）不传第三个参数，
 * 于是用全局 fetch / 真实 setTimeout。
 */
export interface ApprovalBridgePluginDeps {
  fetch?: typeof fetch
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  /** 第一次轮询前的等待；默认 500ms（测试传小值，别真的等半秒）。 */
  pollIntervalMs?: number
  /** 退避上限；默认 2000ms。 */
  maxPollIntervalMs?: number
}

/** `apply` 的返回值。Cordis 会忽略它；测试与诊断用得到账本。 */
export interface ApprovalBridgePluginHandle {
  bridge: ApprovalBridge
  answerer: InstallApprovalBridgeHandle
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_POLL_MS = 500
const DEFAULT_MAX_POLL_MS = 2_000

/**
 * 插件入口。Cordis 的 `apply` 约定：拿到宿主 ctx 与配置，注册副作用即可。
 *
 * ```yaml
 * - insert:
 *     - id: roost-approval-bridge
 *       name: '@roost/approval-bridge'
 *       config:
 *         apiBase: http://host.openshell.internal:8792
 *         runtimeToken: rt_…
 *         workspaceId: ws_…
 *         botId: bot_…
 * ```
 */
export function apply(
  ctx: DshApprovalContext,
  config: ApprovalBridgePluginConfig,
  deps: ApprovalBridgePluginDeps = {},
): ApprovalBridgePluginHandle {
  if (ctx === null || typeof ctx !== 'object' || typeof (ctx as { on?: unknown }).on !== 'function') {
    throw new TypeError('approval bridge plugin needs a Cordis-like ctx with on(event, listener)')
  }
  const settings = readConfig(config)
  const doFetch = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))
  const sleep = deps.sleep ?? defaultSleep
  const pollIntervalMs = readDelay(deps.pollIntervalMs, DEFAULT_POLL_MS, 'pollIntervalMs')
  const maxPollIntervalMs = readDelay(deps.maxPollIntervalMs, DEFAULT_MAX_POLL_MS, 'maxPollIntervalMs')

  // 命中长期授权时控制面返回 { approval: null, granted: true }，没有 id 可轮询。
  // 记在本地，wait 直接答 approved —— 否则一次已授权的调用会白等 5 分钟。
  const granted = new Set<string>()
  // DSH 的 approval 事件带 callId，但桥的契约里只有 argsSummary/consequence。
  // 自己包一层 requestId，把 callId 留下来给 payload（展示与审计用）。
  const callIds = new Map<string, string>()
  // 一条 DSH 进程里会有多个 Bot 的 session；approval 事件按 session id 归到真实 bot。
  const botIds = new Map<string, string>()
  const nextRequestId = defaultRequestId()

  let bridge: ApprovalBridge
  bridge = createApprovalBridge({
    timeoutMs: settings.timeoutMs,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    request: async (request) => {
      const callId = callIds.get(request.id)
      callIds.delete(request.id)
      const botId = botIds.get(request.id) ?? settings.botId
      botIds.delete(request.id)
      const response = await doFetch(`${settings.apiBase}/api/internal/approvals`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-runtime-token': settings.runtimeToken,
        },
        body: JSON.stringify({
          workspaceId: settings.workspaceId,
          kind: 'tool.call',
          requester: botId,
          requesterKind: 'bot',
          action: `调用工具 ${request.tool}`,
          target: request.id,
          consequence: request.consequence === '' ? request.argsSummary : request.consequence,
          payload: {
            tool: request.tool,
            ...(callId === undefined ? {} : { callId }),
          },
        }),
      })
      if (!response.ok) {
        throw new Error(`create approval ${response.status}`)
      }
      const body = await response.json().catch(() => null)
      if (body !== null && typeof body === 'object' && body.granted === true) {
        granted.add(request.id)
        return { approvalId: null }
      }
      const id = body?.approval?.id
      if (typeof id !== 'string' || id === '') {
        throw new Error('create approval returned no approval id')
      }
      return { approvalId: id }
    },
    wait: (input) =>
      waitForDecision(input, {
        apiBase: settings.apiBase,
        runtimeToken: settings.runtimeToken,
        fetch: doFetch,
        sleep,
        pollIntervalMs,
        maxPollIntervalMs,
        granted,
        now: deps.now ?? (() => Date.now()),
      }),
  })

  const answerer = installApprovalBridge(ctx, bridge, {
    scope: { workspaceId: settings.workspaceId, botId: settings.botId },
    describe: (request) => describeForCard(request),
    requestId: (request) => {
      const id = nextRequestId(request)
      const callId = typeof request.callId === 'string' ? request.callId.trim() : ''
      if (callId !== '') callIds.set(id, callId)
      const sessionId = typeof request.agent?.session?.id === 'string' ? request.agent.session.id : ''
      const botMatch = /-((?:bot_)[0-9A-Za-z]+)$/.exec(sessionId)
      if (botMatch !== null) botIds.set(id, botMatch[1]!)
      return id
    },
  })

  // 给 Bot 一个真正可调用的团队创建工具。复用同一个 runtime token / workspace 配置，
  // 建房仍走控制面的 create_room 审批，不在沙箱里直接写控制面库。
  // DSH 的 SDK 只转发 durable session/event，真正的 token 流在 agent/assistant-stream。
  // 插件直接把它节流成 chat.message.delta，房间 SSE 才能逐字显示。
  const streamBuffers = new Map<string, { roomId: string; botId: string; text: string; timer: ReturnType<typeof setTimeout> | null }>()
  const flushStream = (sessionId: string) => {
    const buffer = streamBuffers.get(sessionId)
    if (buffer === undefined || buffer.text === '') return
    const text = buffer.text
    buffer.text = ''
    void doFetch(`${settings.apiBase}/api/internal/rooms/${encodeURIComponent(buffer.roomId)}/deltas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-runtime-token': settings.runtimeToken },
      body: JSON.stringify({ botId: buffer.botId, delta: text }),
    }).catch(() => undefined)
  }
  const onAssistantStream = (event: unknown) => {
    if (event === null || typeof event !== 'object') return
    const record = event as { agent?: { session?: { id?: unknown } }; frame?: { type?: unknown; chunk?: { type?: unknown; text?: unknown } } }
    const sessionId = typeof record.agent?.session?.id === 'string' ? record.agent.session.id : ''
    const roomMatch = /^room-(rm_[0-9A-Za-z]+)-/.exec(sessionId)
    if (!roomMatch) return
    const roomId = roomMatch[1]!
    const botMatch = /-((?:bot_)[0-9A-Za-z]+)$/.exec(sessionId)
    const botId = botMatch?.[1] ?? settings.botId
    const frame = record.frame
    if (frame?.type === 'start') {
      streamBuffers.set(sessionId, { roomId, botId, text: '', timer: null })
      return
    }
    if (frame?.type === 'end') {
      const buffer = streamBuffers.get(sessionId)
      if (buffer?.timer != null) clearTimeout(buffer.timer)
      flushStream(sessionId)
      streamBuffers.delete(sessionId)
      return
    }
    if (frame?.type !== 'chunk' || frame.chunk?.type !== 'text-delta') return
    const text = typeof frame.chunk.text === 'string' ? frame.chunk.text : ''
    if (text === '') return
    let buffer = streamBuffers.get(sessionId)
    if (buffer === undefined) {
      buffer = { roomId, botId, text: '', timer: null }
      streamBuffers.set(sessionId, buffer)
    }
    buffer.text += text
    if (buffer.timer !== null) return
    buffer.timer = setTimeout(() => {
      if (buffer.timer !== null) buffer.timer = null
      flushStream(sessionId)
    }, 50)
  }
  if (typeof ctx.on === 'function') ctx.on('agent/assistant-stream', onAssistantStream)

  const tools = (ctx as unknown as { tools?: { register?: (definition: unknown) => unknown } }).tools
  if (tools !== undefined && typeof tools.register === 'function') {
    tools.register(createTeamTool(settings, doFetch))
    tools.register(createSendImageTool(settings, doFetch))
  }

  return { bridge, answerer }
}

/** Cordis 插件名：入口模块被 patch 的 `name` 引用，导出它只是让 meta 可见。 */
/** 从 DSH session id（room-<roomId>-<botId>）取真实 bot id。 */
function botIdFromSessionId(sessionId: string): string {
  const match = /-((?:bot_)[0-9A-Za-z]+)$/.exec(sessionId)
  return match === null ? '' : match[1]!
}

function createTeamTool(
  settings: { apiBase: string; runtimeToken: string; workspaceId: string; botId: string },
  doFetch: typeof fetch,
): unknown {
  const parameters = {
    type: 'object',
    properties: {
      name: { type: 'string', description: '团队/房间名称，例如「量化研究组」' },
      purpose: { type: 'string', description: '这个团队要解决的长期目标' },
      members: {
        type: 'array',
        items: { type: 'string' },
        description: '成员 Bot 的名称或 id；不填默认把工作区所有 Bot 拉进来',
      },
    },
    required: ['name'],
    additionalProperties: false,
  }
  return {
    name: 'create_team',
    description:
      'Create a Roost team room with the selected bots. The request becomes a one-time ' +
      'create_room approval; tell the user to approve it in 需要你. Use this when the user asks ' +
      'to form a team/group of bots, not for a normal chat reply.',
    parameters,
    output: {
      schema: { type: 'object' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: Record<string, unknown>, exec: { signal?: AbortSignal; agent?: { session?: { id?: string } } }) {
      const name = typeof args['name'] === 'string' ? args['name'].trim() : ''
      if (name === '') throw new Error('team name is required')
      const purpose = typeof args['purpose'] === 'string' ? args['purpose'].trim() : ''
      const requested = Array.isArray(args['members'])
        ? args['members'].filter((member): member is string => typeof member === 'string' && member.trim() !== '').map((member) => member.trim())
        : []
      const headers = { 'content-type': 'application/json', 'x-runtime-token': settings.runtimeToken }
      const botsResponse = await doFetch(
        `${settings.apiBase}/api/internal/bots?workspaceId=${encodeURIComponent(settings.workspaceId)}`,
        { headers, signal: exec.signal },
      )
      if (!botsResponse.ok) throw new Error(`list bots failed: HTTP ${botsResponse.status}`)
      const botsBody = (await botsResponse.json()) as { bots?: Array<{ id?: unknown; name?: unknown }> }
      const bots = Array.isArray(botsBody.bots) ? botsBody.bots.filter((bot) => typeof bot.id === 'string') : []
      if (bots.length < 2) throw new Error('workspace needs at least two bots to create a team')
      const byId = new Map(bots.map((bot) => [String(bot.id), String(bot.name ?? bot.id)]))
      const byName = new Map(bots.map((bot) => [String(bot.name ?? ''), String(bot.id)]))
      const sessionBotId = botIdFromSessionId(String(exec.agent?.session?.id ?? ''))
      const callerBotId = sessionBotId !== '' && byId.has(sessionBotId) ? sessionBotId : settings.botId
      if (!byId.has(callerBotId)) throw new Error(`caller bot ${callerBotId} is not a workspace bot`)
      const selected = requested.length === 0
        ? bots.map((bot) => String(bot.id))
        : requested.map((member) => byName.get(member) ?? (byId.has(member) ? member : ''))
      if (selected.some((id) => id === '')) throw new Error('unknown team member: use a bot name from this workspace')
      const memberBotIds = Array.from(new Set([callerBotId, ...selected]))
      if (memberBotIds.length < 2) throw new Error('a team needs at least two distinct bots')
      const response = await doFetch(`${settings.apiBase}/api/internal/bot-rooms`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          workspaceId: settings.workspaceId,
          botId: callerBotId,
          name,
          ...(purpose === '' ? {} : { purpose }),
          memberBotIds,
        }),
        signal: exec.signal,
      })
      const body = (await response.json().catch(() => null)) as
        | { approval?: { id?: unknown; status?: unknown }; error?: { message?: unknown } }
        | null
      if (!response.ok) {
        const message = body && body.error && typeof body.error.message === 'string' ? body.error.message : `HTTP ${response.status}`
        throw new Error(`create team failed: ${message}`)
      }
      const approvalId = body && body.approval && typeof body.approval.id === 'string' ? body.approval.id : ''
      return {
        status: 'pending_approval',
        approvalId,
        name,
        members: memberBotIds.map((id) => byId.get(id) ?? id),
        note: '告诉用户在「需要你」里批准这一次建团队请求。'
      }
    },
  }
}

/** 把沙箱里的图片文件登记成 artifact，再以 image part 发进当前房间。 */
function createSendImageTool(
  settings: { apiBase: string; runtimeToken: string; workspaceId: string; botId: string },
  doFetch: typeof fetch,
): unknown {
  return {
    name: 'send_image',
    description:
      'Send an image file from the sandbox into the current Roost room. Use this after generating ' +
      'a PNG/JPEG/WebP chart or picture; pass its absolute path (for example /workspace/out/chart.png).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the image inside the sandbox' },
        text: { type: 'string', description: 'Optional caption shown above the image' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: Record<string, unknown>, exec: { signal?: AbortSignal; agent?: { session?: { id?: string } } }) {
      const filePath = typeof args['path'] === 'string' ? args['path'].trim() : ''
      if (filePath === '') throw new Error('image path is required')
      const caption = typeof args['text'] === 'string' ? args['text'].trim() : ''
      const sessionId = String(exec.agent?.session?.id ?? '')
      const roomMatch = /^room-(rm_[0-9A-Za-z]+)-/.exec(sessionId)
      if (roomMatch === null) throw new Error('send_image is only available inside a room session')
      const roomId = roomMatch[1]!
      const botMatch = /-((?:bot_)[0-9A-Za-z]+)$/.exec(sessionId)
      const botId = botMatch?.[1] ?? settings.botId
      const bytes = await readFile(filePath)
      if (bytes.byteLength === 0) throw new Error('image file is empty')
      if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('image file exceeds 20 MiB')
      const ext = extname(filePath).toLowerCase()
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg'
      const name = basename(filePath) || `image${ext || '.png'}`
      const authHeaders = { 'x-runtime-token': settings.runtimeToken }
      const uploaded = await doFetch(`${settings.apiBase}/api/internal/artifacts`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'content-type': mime,
          'x-workspace-id': settings.workspaceId,
          'x-produced-by': botId,
          'x-artifact-kind': 'image',
          'x-artifact-name': name,
          'x-file-mime': mime,
        },
        body: bytes,
        signal: exec.signal,
      })
      const uploadBody = (await uploaded.json().catch(() => null)) as { artifact?: { id?: unknown }; message?: unknown } | null
      if (!uploaded.ok) {
        const message = uploadBody && typeof uploadBody === 'object' && typeof (uploadBody as { message?: unknown }).message === 'string'
          ? String((uploadBody as { message?: unknown }).message)
          : `HTTP ${uploaded.status}`
        throw new Error(`upload image failed: ${message}`)
      }
      const artifactId = uploadBody && uploadBody.artifact && typeof uploadBody.artifact.id === 'string' ? uploadBody.artifact.id : ''
      if (artifactId === '') throw new Error('upload image returned no artifact id')
      const posted = await doFetch(`${settings.apiBase}/api/rooms/${encodeURIComponent(roomId)}/say`, {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ botId, ...(caption === '' ? {} : { text: caption }), artifactIds: [artifactId] }),
        signal: exec.signal,
      })
      const postedBody = (await posted.json().catch(() => null)) as { message?: { seq?: unknown } } | null
      if (!posted.ok) throw new Error(`post image message failed: HTTP ${posted.status}`)
      return { artifactId, messageSeq: postedBody?.message?.seq ?? null, roomId }
    },
  }
}

export const name = '@roost/approval-bridge'

// ---- 控制面轮询 --------------------------------------------------------------

interface WaitOptions {
  apiBase: string
  runtimeToken: string
  fetch: typeof fetch
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  pollIntervalMs: number
  maxPollIntervalMs: number
  granted: Set<string>
  now: () => number
}

/**
 * 500ms → 2s 退避地轮询一张审批单。
 *
 * 返回：
 *   * `approved` / `rejected` —— 人的决定，原样交给桥；
 *   * `null` —— 这一轮没等到（超时 / 被 abort / 未知 status），桥据此记
 *     `timeout`（失败关闭），**不要在这里编一个 rejected**。
 */
async function waitForDecision(input: WaitInput, options: WaitOptions): Promise<BridgeDecision | null> {
  const { request, approvalId, signal, deadlineAt } = input
  if (options.granted.has(request.id)) {
    options.granted.delete(request.id)
    return 'approved'
  }
  if (approvalId === null) return null

  let delay = options.pollIntervalMs
  while (!signal.aborted) {
    let response: Response
    try {
      response = await options.fetch(
        `${options.apiBase}/api/internal/approvals/${encodeURIComponent(approvalId)}`,
        { headers: { 'x-runtime-token': options.runtimeToken }, signal },
      )
    } catch (error) {
      // 桥落定/超时会 abort：这不是控制面故障，安静收手。
      if (signal.aborted || isAbortError(error)) return null
      throw error
    }
    if (!response.ok) throw new Error(`poll approval ${response.status}`)

    const body = await response.json().catch(() => null)
    const status = body?.approval?.status
    if (status === 'approved') return 'approved'
    if (status === 'rejected') return 'rejected'
    // pending 之外只可能是控制面加了新词：宁可继续等/超时，也不放行。
    if (status !== 'pending') return null

    if (deadlineAt !== null && options.now() >= deadlineAt) return null
    try {
      await options.sleep(delay, signal)
    } catch {
      if (signal.aborted) return null
      throw new Error('approval poll sleep failed')
    }
    delay = Math.min(delay * 2, options.maxPollIntervalMs)
  }
  return null
}

/** 卡片文案：DSH 只给 toolName / callId / reason / displayReason，没有工具参数。 */
export function describeForCard(request: DshApprovalRequestEvent): {
  argsSummary: string
  consequence: string
} {
  const callId = typeof request.callId === 'string' && request.callId !== '' ? ` (call ${request.callId})` : ''
  const reason = readDisplayReason(request)
  return {
    argsSummary: `${request.toolName}${callId}${reason === '' ? '' : ` — ${reason}`}`,
    consequence:
      reason === '' ? `tool ${request.toolName} will run with no recorded justification` : reason,
  }
}

/** displayReason 是本地化给人看的；中文优先，其次英文，最后退到 reason。 */
function readDisplayReason(request: DshApprovalRequestEvent): string {
  const display = request.displayReason
  if (display !== null && typeof display === 'object') {
    for (const key of ['zh', 'en']) {
      const value = display[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
  }
  return typeof request.reason === 'string' ? request.reason.trim() : ''
}

// ---- 小工具 ------------------------------------------------------------------

function readConfig(config: ApprovalBridgePluginConfig): Required<ApprovalBridgePluginConfig> {
  if (config === null || typeof config !== 'object') {
    throw new TypeError('approval bridge plugin needs a config object')
  }
  const apiBase = readText(config.apiBase, 'apiBase').replace(/\/+$/, '')
  if (!/^https?:\/\//.test(apiBase)) {
    throw new TypeError('approval bridge plugin config.apiBase must be an http(s) URL')
  }
  return {
    apiBase,
    runtimeToken: readText(config.runtimeToken, 'runtimeToken'),
    workspaceId: readText(config.workspaceId, 'workspaceId'),
    botId: readText(config.botId, 'botId'),
    timeoutMs: readTimeout(config.timeoutMs),
  }
}

function readText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`approval bridge plugin config.${field} is required (non-empty string)`)
  }
  return value.trim()
}

function readTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError('approval bridge plugin config.timeoutMs must be a positive finite number')
  }
  return Math.trunc(value)
}

function readDelay(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`approval bridge deps.${field} must be a positive finite number`)
  }
  return Math.trunc(value)
}

/** 可被 abort 打断的 sleep：桥超时/落定后轮询必须立刻停手，不能挂着 500ms 定时器。 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return new Promise((resolve) => setTimeout(resolve, ms))
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal!.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}
