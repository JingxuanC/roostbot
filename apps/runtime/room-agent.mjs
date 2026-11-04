// 房间 agent：沙箱里的长活 DSH + 每 (room, bot) 一个会话。
//
// 这是方案 A 的落点：不再每条消息 fork 一个 `dsh headless`，而是
//   一个长活 `dsh --profile sdk`（JSON-RPC over stdio）
//   + 每个 (room, bot) 一个 sessionId
//   + 控制面轮询收发。
// 多轮上下文由 DSH 自己维护（session 常驻），我们只负责路由和持久化。
//
// 派发决策在控制面（docs/design/rooms.md §9）：本进程只是执行器。
// 收到用户消息后优先取本轮 assignments，逐个投递并 advance 回报；
// 接口不可用时退回旧的单 Bot `say` 路径（ROOST_BOT_ID）。
//
// 协议见 @deepseek-ai/dsh-sdk-protocol：initialize / session/prompt / session/wait，
// 通知是 session.event 与 session.status。

import { graceLimitsFromEnv, graceVerdict } from './turn-grace.mjs'
import { spawn } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

import { DEFAULT_DSH_WEB_PORT, startDshWeb } from './dsh-web.mjs'
import { installProfilePlugin } from './profile-plugins.mjs'

/** 环境变量里的端口：非法/未设返回 undefined，交给默认值。 */
function readPort(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65_536 ? parsed : undefined
}

/** 换行分隔的 JSON-RPC 2.0 客户端（stdio）。 */
export class JsonRpcProcessClient {
  constructor(child) {
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    this.handlers = new Map()
    this.buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    this.closed = new Promise((resolve) => child.once('close', resolve))
  }

  #onData(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line === '') continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        continue // 坏帧忽略（协议就是这么定的）
      }
      if (frame.id !== undefined && frame.method === undefined) {
        const pending = this.pending.get(frame.id)
        if (pending === undefined) continue
        this.pending.delete(frame.id)
        if (frame.error !== undefined) pending.reject(new Error(`${frame.error.code}: ${frame.error.message}`))
        else pending.resolve(frame.result)
        continue
      }
      if (frame.method !== undefined) {
        const handler = this.handlers.get(frame.method)
        if (handler !== undefined) handler(frame.params)
      }
    }
  }

  on(method, handler) {
    this.handlers.set(method, handler)
  }

  request(method, params) {
    const id = this.nextId++
    const frame = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(`${JSON.stringify(frame)}\n`)
    })
  }

  close() {
    try {
      this.child.stdin.end()
    } catch {
      // 已经关了
    }
    this.child.kill('SIGTERM')
  }
}

const SESSION_ID_SAFE = /[^A-Za-z0-9._:-]/g

/** 确定性会话 id：同 (room, bot) 永远是同一个 DSH session。 */
export function sessionIdFor(roomId, botId) {
  return `room-${String(roomId).replace(SESSION_ID_SAFE, '_')}-${String(botId).replace(SESSION_ID_SAFE, '_')}`
}

/** 回复去重键：带上 botId，多 Bot 同 seq 不会互相覆盖。 */
export function replyIdem(roomId, seq, botId) {
  return `reply-${roomId}-${seq}-${botId}`
}

/** 从 session.event 里取助手文本（assistant/message 的 text blocks）。 */
export function assistantText(event) {
  if (event === undefined || event.type !== 'assistant/message') return undefined
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return undefined
  const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('')
  return text === '' ? undefined : text
}

// [PASS] 允许中英文方括号和大小写；与 packages/rooms 的 classifyReply 同一口径
// （沙箱镜像只拷 room-agent.mjs，不能 import 包，所以这里保留一份等价实现）。
// 裸写 pass 不算，避免把 "pass" 当静默吞掉。
const PASS_LIKE = /^[[【]\s*pass\s*[\]】]$/i

/**
 * 把一次会话输出归类成控制面的 SlotResult（packages/contract 的联合类型）。
 * `[PASS]` 是唯一约定的静默标记（docs/design/rooms.md §4）。
 */
export function classifySlotResult(text) {
  if (typeof text !== 'string' || text.trim() === '') return { kind: 'missed' }
  if (PASS_LIKE.test(text.trim())) return { kind: 'passed' }
  return { kind: 'posted', text }
}

/**
 * 控制面失败后的下一次等待：1s→2s→4s…，上限 30s（docs/design/rooms.md 的运行时要求）。
 * 传入当前等待毫秒数；首次调用时当前值取 base。
 */
export function nextBackoff(currentMs, options = {}) {
  const base = options.baseMs ?? 1000
  const max = options.maxMs ?? 30_000
  const current = Number.isFinite(currentMs) && currentMs > 0 ? currentMs : base
  return Math.min(current * 2, max)
}

/** 内部房间返回的成员；兼容 string 与 {botId,role}，并去重。 */
export function roomMembers(room) {
  const raw = Array.isArray(room?.members) ? room.members : []
  const seen = new Set()
  const members = []
  for (const item of raw) {
    const botId = typeof item === 'string' ? item : item?.botId
    if (typeof botId !== 'string' || botId === '' || seen.has(botId)) continue
    seen.add(botId)
    members.push({ botId, role: item?.role === 'host' ? 'host' : 'member' })
  }
  return members
}

export class ControlPlaneError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'ControlPlaneError'
    this.status = options.status ?? 0
    this.body = options.body
    // 请求本身超时/被 abort（不是控制面回了错误码）：advance 要按 missed 兜底。
    this.timeout = options.timeout === true
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 等一个 abort 信号；resolve 'stopped'。返回的 cancel 负责摘掉监听。 */
/** 可取消的定时器：用于超时/宽限 race。 */
function delay(ms) {
  let timer
  let resolve
  const promise = new Promise((done) => {
    resolve = done
    timer = setTimeout(done, ms)
  })
  timer?.unref?.()
  return { promise, cancel: () => clearTimeout(timer) }
}

function stopSignalPromise(signal) {
  if (signal === undefined || typeof signal.addEventListener !== 'function') {
    return { promise: null, cancel() {} }
  }
  let onAbort
  const promise = new Promise((resolve) => {
    onAbort = () => resolve('stopped')
    if (signal.aborted) resolve('stopped')
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  return {
    promise,
    cancel() {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
    }
  }
}

function loadCursors(path) {
  if (path === undefined || path === '') return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

function saveCursors(path, cursors) {
  if (path === undefined || path === '') return
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify(cursors, null, 2))
    renameSync(`${path}.tmp`, path)
  } catch {
    // 丢游标只会导致重复处理，后端有 idem 去重。
  }
}

/**
 * 启动 DSH 前把审批桥装进它的 profile（TODO 5.4.3）。
 *
 * 开关 `ROOST_APPROVAL_BRIDGE=1`（镜像默认开）。失败只记日志返回 null：
 * 桥装不上时房间对话照常，不能因为审批面坏了让 Bot 整个起不来。
 * 返回 null 表示「本次没有装」，调用方据此**不要**改 DSH 的权限档位。
 */
export function prepareApprovalBridgeProfile(options = {}) {
  const env = options.env ?? process.env
  const log = options.log ?? (() => {})
  if ((env.ROOST_APPROVAL_BRIDGE ?? '0') !== '1') return null

  const dshHome = (env.DSH_HOME ?? '').trim()
  if (dshHome === '') {
    log('approval bridge skipped: DSH_HOME is unset')
    return null
  }
  const missing = ['ROOST_API', 'ROOST_RUNTIME_TOKEN', 'ROOST_WORKSPACE_ID', 'ROOST_BOT_ID'].filter(
    (key) => (env[key] ?? '').trim() === ''
  )
  if (missing.length > 0) {
    log(`approval bridge skipped: missing env ${missing.join(', ')}`)
    return null
  }

  const timeoutMs = Number.parseInt(String(env.ROOST_APPROVAL_TIMEOUT_MS ?? ''), 10)
  try {
    const result = installProfilePlugin({
      dshHome,
      profile: (env.ROOST_DSH_PROFILE ?? 'sdk').trim() || 'sdk',
      packageDir: (env.ROOST_APPROVAL_BRIDGE_PACKAGE ?? '/opt/roost/packages/approvals-bridge').trim(),
      configJson: {
        apiBase: env.ROOST_API.trim(),
        runtimeToken: env.ROOST_RUNTIME_TOKEN.trim(),
        workspaceId: env.ROOST_WORKSPACE_ID.trim(),
        botId: env.ROOST_BOT_ID.trim(),
        ...(Number.isInteger(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {})
      }
    })
    log(`approval bridge installed at ${result.packageDir} (patched=${result.patched})`)
    return result
  } catch (error) {
    log(`approval bridge install failed: ${errorMessage(error)}`)
    return null
  }
}

export async function startRoomAgent(options) {
  const log = options.log ?? ((line) => console.log(`[room-agent] ${line}`))
  const botId = options.botId
  const pollMs = options.pollMs ?? 500
  const apiBase = String(options.apiBase ?? '').replace(/\/+$/, '')
  const token = options.runtimeToken
  const headers = { 'content-type': 'application/json', 'x-runtime-token': token }
  const cursors = loadCursors(options.stateFile)
  const assistant = new Map()
  const idleWaiters = new Map()
  const lastStatus = new Map()
  const prepared = new Set()
  // 单成员回复超时取 ROUND_LIMITS.replyTimeoutMs（240s）。沙箱镜像只拷 apps/runtime 下的
  // 文件，不能 import packages/contract，所以这里与契约常量保持同值。
  const turnTimeoutMs = options.turnTimeoutMs ?? 240_000
  // 可选 stop 轮询（GET /api/internal/rooms/:id/round）：接口没有 stopping 字段/
  // 404 时自动关闭，行为与之前完全一致。0 = 不轮询。
  const stopPollMs = Number.isFinite(options.stopPollMs) ? options.stopPollMs : 500
  const stopPollingEnabled = stopPollMs > 0
  // 某些房间的 round 接口没有 stop 能力（404/405/501）：只关这个房间，不影响别的房间。
  const stopPollingUnsupported = new Set()
  // advance 请求本身的超时：控制面 408 或请求超时都按 missed 兜底（不重跑该 slot）。
  const advanceTimeoutMs = Number.isFinite(options.advanceTimeoutMs) ? options.advanceTimeoutMs : 30_000
  const backoffBaseMs = options.backoffBaseMs ?? 1000
  const backoffMaxMs = options.backoffMaxMs ?? 30_000
  let stopped = false

  // 审批桥必须在 DSH 启动前落到 profile 里（DSH 只在 boot 时读 cordis.patch.yml）。
  // 装成功时把 DSH 的权限档位钉到 workspace-write：控制面给沙箱的
  // DSH_PERMISSION_MODE=danger-full-access 会把 approval 策略一起钉成 never，
  // 桥永远收不到请求；真正的外部边界仍是 OpenShell。
  const approvalBridge = prepareApprovalBridgeProfile({ log })
  const childEnv = { ...process.env, ...(options.dshEnv ?? {}) }
  if (approvalBridge !== null) {
    childEnv.DSH_PERMISSION_MODE = (process.env.ROOST_DSH_PERMISSION_MODE ?? '').trim() || 'workspace-write'
    childEnv.ROOST_APPROVAL_BRIDGE = '1'
    log(`dsh permission mode for approval bridge: ${childEnv.DSH_PERMISSION_MODE}`)
  }

  const child = spawn(options.dshBin ?? 'dsh', ['--profile', options.dshProfile ?? 'sdk'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  const rpc = new JsonRpcProcessClient(child)

  // 插件面板容器（ADR 0004 / wave1 §C）：沙箱里额外一个 `dsh web`，只绑 127.0.0.1:4099。
  // 后台启动、**不阻塞 SDK 会话**：面板容器起不来时只记日志（dsh-web 里打 reason），
  // 房间对话照常。ROOST_DSH_WEB=0 关闭；进程退出（stop）时一并 kill。
  const dshWebEnabled = (process.env.ROOST_DSH_WEB ?? '1') !== '0'
  const dshWebPort =
    readPort(options.dshWebPort ?? process.env.ROOST_DSH_WEB_PORT ?? process.env.DSH_WEB_PORT) ??
    DEFAULT_DSH_WEB_PORT
  const dshWebBin = options.dshWebBin ?? options.dshBin ?? process.env.ROOST_DSH_BIN ?? 'dsh'
  const dshWebAbort = new AbortController()
  let dshWebHandle = null
  let dshWebStart = null
  if (dshWebEnabled) {
    dshWebStart = startDshWeb({
      port: dshWebPort,
      bin: dshWebBin,
      log,
      signal: dshWebAbort.signal,
      ...(Number.isFinite(options.dshWebReadyTimeoutMs)
        ? { readyTimeoutMs: options.dshWebReadyTimeoutMs }
        : {})
    })
      .then((handle) => {
        dshWebHandle = handle
        if (handle.ready) log('dsh web ready')
        return handle
      })
      .catch(() => null) // startDshWeb 契约上不抛；兜底避免 unhandled rejection
  }

  rpc.on('session.event', (params) => {
    const text = assistantText(params?.event)
    if (text !== undefined) assistant.set(params.sessionId, text)
  })
  rpc.on('session.status', (params) => {
    if (typeof params?.sessionId !== 'string') return
    lastStatus.set(params.sessionId, params.status)
    if (params.status !== 'idle') return
    const waiter = idleWaiters.get(params.sessionId)
    if (waiter !== undefined) {
      idleWaiters.delete(params.sessionId)
      waiter()
    }
  })

  const initialized = await rpc.request('initialize', {
    cwd: options.workdir ?? '/workspace',
    // SDK 只认已注册的 adapter route：DSH 的 DeepSeek 路由 id 是 `deepseek-official`
    // （写成 `deepseek` 会得到 -32603 no adapter registered）。
    provider: options.provider ?? 'deepseek-official',
    model: options.model ?? 'deepseek-chat'
  })
  log(`sdk ready: ${initialized?.serverInfo?.name ?? 'unknown'} ${initialized?.serverInfo?.version ?? ''}`)

  /**
   * 等这个 session 空闲。**必须在 prompt 之前注册**：服务端可能在 prompt 的
   * 应答回来之前就发出 session.status=idle（假服务端 5ms 就发了，真实服务也可能很快），
   * 先发后注册会丢事件、只能等超时。
   */
  function idleSignal(sessionId) {
    let settle
    let timer
    const promise = new Promise((resolve) => {
      settle = (idle) => {
        clearTimeout(timer)
        resolve(idle)
      }
      timer = setTimeout(() => {
        idleWaiters.delete(sessionId)
        settle(false)
      }, turnTimeoutMs)
      idleWaiters.set(sessionId, () => settle(true))
    })
    return {
      promise,
      cancel() {
        idleWaiters.delete(sessionId)
        settle(false)
      }
    }
  }

  async function prepareSession(sessionId) {
    // 沙箱 stop/start 或进程重启后，DSH_HOME 里的会话还在；先 resume，
    // 否则 SDK 会为同一个 id 新建一个空会话，多轮上下文就断了。
    if (prepared.has(sessionId)) return
    prepared.add(sessionId)
    await rpc.request('session/resume', { sessionId }).catch(() => undefined)
  }

  /** 投一条 prompt，等 idle，返回助手文本（可能为空）；被 stop 时提前返回 stopped。 */
  async function runTurn(sessionId, text, signal) {
    await prepareSession(sessionId)
    assistant.delete(sessionId)
    const idle = idleSignal(sessionId)
    const stop = stopSignalPromise(signal)
    const limits = graceLimitsFromEnv()
    const deadline = delay(limits.replyTimeoutMs ?? 240_000)
    let grace = null
    try {
      await rpc.request('session/prompt', {
        sessionId,
        contentBlocks: [{ type: 'text', text }]
      })
      // 没有 status 通知时用 session/wait 兜底（真服务端会等到空闲再回）；
      // session/wait 本身失败时不要抢先结束，继续等 idle 通知/超时。
      const fallback = rpc
        .request('session/wait', { sessionId })
        .then(() => sleep(50))
        .then(() => true)
        .catch(() => new Promise(() => {}))
      const race = (timer) => {
        const racers = [idle.promise, fallback, timer.promise.then(() => 'deadline')]
        if (stop.promise !== null) racers.push(stop.promise)
        return Promise.race(racers)
      }
      let outcome = await race(deadline)
      // 4.2.16：到点仍在 DSH 里工作 → 再给 15s 收尾；宽限用完仍工作则按 working 收尾。
      if (outcome === 'deadline') {
        const verdict = graceVerdict({
          elapsedMs: limits.replyTimeoutMs ?? 240_000,
          working: lastStatus.get(sessionId) === 'working',
          ...limits
        })
        if (verdict === 'continue') {
          grace = delay(limits.workGraceMs ?? 15_000)
          outcome = await race(grace)
        }
      }
      return {
        answer: assistant.get(sessionId),
        idle: outcome === true,
        stopped: outcome === 'stopped',
        timedOut: outcome === 'deadline'
      }
    } finally {
      stop.cancel()
      idle.cancel()
      deadline.cancel()
      grace?.cancel?.()
    }
  }

  /** 一个 slot 的执行结果；会话丢失记 failed(SESSION)，用户停止记 missed，其余按文本归类。 */
  async function runSlot(sessionId, prompt, messageText, signal) {
    const text = typeof prompt === 'string' && prompt.trim() !== '' ? prompt : `房间里有人说：${messageText}`
    try {
      const { answer, idle, stopped: wasStopped } = await runTurn(sessionId, text, signal)
      // 用户停止当前成员：不重跑这个 slot，按 missed 收尾，轮次继续（docs/design/rooms.md §10）。
      if (wasStopped === true) return { kind: 'missed' }
      if (answer !== undefined) return classifySlotResult(answer)
      const status = lastStatus.get(sessionId)
      if (!idle && status === 'working') return { kind: 'working' }
      if (status === 'waiting-approval' || status === 'approval') return { kind: 'approval' }
      return { kind: 'missed' }
    } catch (error) {
      return { kind: 'failed', code: 'SESSION', message: errorMessage(error) }
    }
  }

  async function request(path, init = {}) {
    try {
      return await fetch(`${apiBase}${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers ?? {}) }
      })
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      throw new ControlPlaneError(`${path}: ${errorMessage(error)}`, { status: 0, timeout: timedOut })
    }
  }

  async function requestJson(path, init) {
    const response = await request(path, init)
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      throw new ControlPlaneError(`${path} ${response.status}${text === '' ? '' : `: ${text.slice(0, 200)}`}`, {
        status: response.status,
        body: text
      })
    }
    if (text.trim() === '') return undefined
    try {
      return JSON.parse(text)
    } catch {
      throw new ControlPlaneError(`${path} returned invalid JSON`, { status: response.status, body: text })
    }
  }

  /**
   * 取本轮 assignments。返回 null 表示接口不可用（404/405/501），调用方退回
   * 单 Bot `say`；网络/5xx 直接抛错，交给外层退避，避免重复发言。
   */
  async function fetchAssignments(roomId) {
    const path = `/api/internal/rooms/${encodeURIComponent(roomId)}/assignments`
    const response = await request(path)
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      await response.text().catch(() => '')
      return null
    }
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      throw new ControlPlaneError(`${path} ${response.status}${text === '' ? '' : `: ${text.slice(0, 200)}`}`, {
        status: response.status,
        body: text
      })
    }
    let payload
    try {
      payload = text.trim() === '' ? undefined : JSON.parse(text)
    } catch {
      throw new ControlPlaneError(`${path} returned invalid JSON`, { status: response.status, body: text })
    }
    return normalizeAssignments(payload, roomId)
  }

  /** assignments 列表归一化；容忍裸数组与 {assignments:[…]} 两种包裹。 */
  function normalizeAssignments(payload, roomId) {
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.assignments)
        ? payload.assignments
        : Array.isArray(payload?.slots)
          ? payload.slots
          : []
    const normalized = []
    list.forEach((item, position) => {
      if (item === null || typeof item !== 'object') return
      if (typeof item.botId !== 'string' || item.botId === '') return
      if (typeof item.roundId !== 'string' || item.roundId === '') return
      normalized.push({
        roundId: item.roundId,
        roomId: typeof item.roomId === 'string' && item.roomId !== '' ? item.roomId : roomId,
        botId: item.botId,
        sessionId:
          typeof item.sessionId === 'string' && item.sessionId !== ''
            ? item.sessionId
            : sessionIdFor(roomId, item.botId),
        prompt: typeof item.prompt === 'string' ? item.prompt : '',
        index: Number.isSafeInteger(item.index) && item.index >= 0 ? item.index : position,
        total: Number.isSafeInteger(item.total) && item.total >= 0 ? item.total : list.length
      })
    })
    return normalized
  }

  /**
   * 读当前轮次里的 stop 指令（GET /api/internal/rooms/:id/round）：
   *   number        → 要停的 slot 下标
   *   'any'         → stopping:true，停当前 slot
   *   null          → 没有指令 / 这次读失败（下一拍再试）
   *   'unsupported' → 接口没有这个能力（404/405/501），之后不再轮询
   * stopping 放在响应顶层或 round.stopping 上都接受（老接口没有该字段 → 行为不变）。
   */
  async function probeStopping(roomId) {
    const path = `/api/internal/rooms/${encodeURIComponent(roomId)}/round`
    let response
    try {
      response = await request(path)
    } catch {
      return null
    }
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      await response.text().catch(() => '')
      return 'unsupported'
    }
    const text = await response.text().catch(() => '')
    if (!response.ok) return null
    let payload
    try {
      payload = text.trim() === '' ? undefined : JSON.parse(text)
    } catch {
      return null
    }
    const raw = payload?.stopping ?? payload?.round?.stopping
    if (raw === true) return 'any'
    const value = raw !== null && typeof raw === 'object' ? (raw.slotIndex ?? raw.index) : raw
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }

  /**
   * 一个 slot 执行期间轮询 stop：命中就 abort 该 slot 的等待，由 runSlot 记 missed，
   * 然后 runAssignments 继续下一个 slot（docs/design/rooms.md §3/§10）。
   * 返回 { signal, cancel }；stopPollMs=0 或不支持时返回 null。
   */
  function watchSlotStop(roomId, slotIndex) {
    if (!stopPollingEnabled || stopPollingUnsupported.has(roomId)) return null
    const controller = new AbortController()
    let timer
    let active = true
    const finish = () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
    const check = async () => {
      if (!active) return
      const stopping = await probeStopping(roomId)
      if (!active) return
      if (stopping === 'unsupported') {
        stopPollingUnsupported.add(roomId)
        log(`round endpoint unavailable for ${roomId}; stop polling off for this room`)
        finish()
        return
      }
      if (stopping === 'any' || (typeof stopping === 'number' && stopping === slotIndex)) {
        log(`stop requested for ${roomId} slot ${slotIndex}`)
        finish()
        controller.abort()
        return
      }
      timer = setTimeout(check, stopPollMs)
    }
    timer = setTimeout(check, stopPollMs)
    return { signal: controller.signal, cancel: finish }
  }

  // 轮次已经被停掉/结束时，advance 的 4xx 是终态：记日志后继续，不能让
  // 游标卡在旧消息上反复重投。
  const TERMINAL_ADVANCE_STATUS = new Set([400, 404, 409, 410, 422])

  async function postAdvance(roundId, slotIndex, result) {
    const path = `/api/internal/rounds/${encodeURIComponent(roundId)}/advance`
    const signal = advanceTimeoutMs > 0 ? AbortSignal.timeout(advanceTimeoutMs) : undefined
    const response = await request(path, {
      method: 'POST',
      body: JSON.stringify({ slotIndex, result }),
      ...(signal === undefined ? {} : { signal })
    })
    const body = await response.text().catch(() => '')
    return { response, body }
  }

  /**
   * advance 408 / 请求超时：该 slot 的结果已经来不及了，补一条 missed 收尾；
   * 不重跑同一 slot（同一成员不会说两遍）。补报也失败时只记日志，不再重试。
   */
  async function reportMissed(roundId, slotIndex, reason) {
    log(`${reason} for ${roundId} slot ${slotIndex}; reporting missed`)
    try {
      const { response, body } = await postAdvance(roundId, slotIndex, { kind: 'missed' })
      if (response.ok) {
        log(`advanced ${roundId} slot ${slotIndex} missed`)
        return
      }
      if (TERMINAL_ADVANCE_STATUS.has(response.status)) {
        log(`advance skipped ${roundId} slot ${slotIndex} (${response.status})`)
        return
      }
      log(`advance missed failed ${response.status}${body === '' ? '' : `: ${body.slice(0, 200)}`}`)
    } catch (error) {
      log(`advance missed failed: ${errorMessage(error)}`)
    }
  }

  /** 回合结束后把文本送去做 claims 抽取（fire-and-forget，失败不影响对话）。 */
  async function rememberClaims(text) {
    const workspaceId = (options.workspaceId ?? process.env.ROOST_WORKSPACE_ID ?? '').trim()
    if (workspaceId === '' || typeof text !== 'string' || text.trim() === '') return
    try {
      await request('/api/internal/memory/claims', {
        method: 'POST',
        body: JSON.stringify({ workspaceId, text })
      })
    } catch {
      // 记忆写入不是本轮对话的前提。
    }
  }

  async function advance(roundId, slotIndex, result) {
    let response
    let body
    try {
      ({ response, body } = await postAdvance(roundId, slotIndex, result))
    } catch (error) {
      if (error instanceof ControlPlaneError && error.timeout === true) {
        await reportMissed(roundId, slotIndex, 'advance timed out')
        return
      }
      throw error
    }
    if (response.status === 408) {
      await reportMissed(roundId, slotIndex, 'advance 408')
      return
    }
    if (!response.ok) {
      if (TERMINAL_ADVANCE_STATUS.has(response.status)) {
        log(`advance skipped ${roundId} slot ${slotIndex} (${response.status})`)
        return
      }
      throw new ControlPlaneError(
        `/api/internal/rounds/${encodeURIComponent(roundId)}/advance ${response.status}${body === '' ? '' : `: ${body.slice(0, 200)}`}`,
        { status: response.status, body }
      )
    }
    log(`advanced ${roundId} slot ${slotIndex} ${result.kind}`)
  }

  async function runAssignments(roomId, assignments, message) {
    for (const assignment of assignments) {
      const sessionId =
        typeof assignment.sessionId === 'string' && assignment.sessionId !== ''
          ? assignment.sessionId
          : sessionIdFor(assignment.roomId ?? roomId, assignment.botId)
      await prepareSession(sessionId)
      const watch = watchSlotStop(assignment.roomId ?? roomId, assignment.index)
      let result
      try {
        result = await runSlot(sessionId, assignment.prompt, message.text, watch?.signal)
      } finally {
        watch?.cancel()
      }
      await advance(assignment.roundId, assignment.index, result)
    if (result.kind === 'posted' && typeof result.text === 'string') void rememberClaims(result.text)
    }
  }

  /** 旧路径：一个 Bot 直接把助手文本 `say` 回房间。 */
  async function fallbackSay(roomId, message) {
    const sessionId = sessionIdFor(roomId, botId)
    let answer
    try {
      const turn = await runTurn(sessionId, `房间里有人说：${message.text}`)
      answer = turn.answer
    } catch (error) {
      log(`turn failed for ${sessionId} seq ${message.seq}: ${errorMessage(error)}`)
      return
    }
    if (answer === undefined) {
      log(`no assistant text for ${sessionId} seq ${message.seq}`)
      return
    }
    const response = await request(`/api/rooms/${encodeURIComponent(roomId)}/say`, {
      method: 'POST',
      body: JSON.stringify({ botId, text: answer, idem: replyIdem(roomId, message.seq, botId) })
    })
    const body = await response.text().catch(() => '')
    if (!response.ok) log(`say failed ${response.status}: ${body}`)
    else {
      log(`replied ${roomId} seq ${message.seq} session ${sessionId}`)
      void rememberClaims(answer)
    }
  }

  /** 启动/轮询时发现成员就 prepare（resume 每个 session 一次）。 */
  async function syncRooms() {
    // 一沙箱一 workspace：带上 workspaceId，控制面只返回这个 workspace 的房间。
    const workspaceId = (process.env.ROOST_WORKSPACE_ID ?? '').trim()
    const roomsPath = workspaceId === '' ? '/api/internal/rooms' : `/api/internal/rooms?workspaceId=${encodeURIComponent(workspaceId)}`
    const data = await requestJson(roomsPath)
    const rooms = Array.isArray(data?.rooms) ? data.rooms : []
    for (const room of rooms) {
      if (typeof room?.id !== 'string' || room.id === '') continue
      const members = roomMembers(room)
      const targets = members.length > 0 ? members.map((member) => member.botId) : [botId]
      for (const target of targets) await prepareSession(sessionIdFor(room.id, target))
    }
    return rooms
  }

  async function handleUserMessage(room, members, message) {
    if (members.length > 0) {
      const assignments = await fetchAssignments(room.id)
      if (assignments !== null) {
        if (assignments.length === 0) {
          log(`no assignments for ${room.id} seq ${message.seq}`)
          return
        }
        await runAssignments(room.id, assignments, message)
        return
      }
      log(`assignments unavailable for ${room.id}; single-bot fallback`)
    }
    await fallbackSay(room.id, message)
  }

  async function pollRoom(room) {
    const after = cursors[room.id] ?? 0
    const data = await requestJson(
      `/api/internal/rooms/${encodeURIComponent(room.id)}/messages?after=${after}`
    )
    const messages = Array.isArray(data?.messages) ? data.messages : []
    const members = roomMembers(room)
    for (const message of messages) {
      if (!Number.isSafeInteger(message?.seq)) continue
      if (message.actor?.kind !== 'user') {
        cursors[room.id] = Math.max(cursors[room.id] ?? 0, message.seq)
        saveCursors(options.stateFile, cursors)
        continue
      }
      // 先处理再推进游标：控制面/派发接口抖动时下轮重试，
      // say 有 idem、advance 按 slot 状态收敛；处理成功才认为这条消息消费掉。
      await handleUserMessage(room, members, message)
      cursors[room.id] = Math.max(cursors[room.id] ?? 0, message.seq)
      saveCursors(options.stateFile, cursors)
    }
  }

  async function poll() {
    const rooms = await syncRooms()
    for (const room of rooms) {
      if (typeof room?.id !== 'string' || room.id === '') continue
      await pollRoom(room)
    }
  }

  async function loop() {
    let delay = backoffBaseMs
    while (!stopped) {
      try {
        await poll()
        delay = backoffBaseMs
      } catch (error) {
        // 控制面不可达：一行日志 + 指数退避，恢复后重置（不退出进程）。
        log(`poll failed: ${errorMessage(error)}`)
        await sleep(delay)
        delay = nextBackoff(delay, { baseMs: backoffBaseMs, maxMs: backoffMaxMs })
        continue
      }
      await sleep(pollMs)
    }
  }

  void loop()

  // stop 必须幂等：第二次调用不能往已经 end 的 stdin 再写 shutdown
  // （会抛 ERR_STREAM_WRITE_AFTER_END，且 socket 的 error 事件无人接）。
  let stopPromise = null
  return {
    stop() {
      if (stopPromise !== null) return stopPromise
      stopPromise = (async () => {
        stopped = true
        // 先取消/等 dsh web：abort 会让还在轮询的 startDshWeb 立刻 kill 子进程并返回。
        dshWebAbort.abort()
        if (dshWebStart !== null) await dshWebStart.catch(() => null)
        if (dshWebHandle !== null) await dshWebHandle.stop().catch(() => undefined)
        await rpc.request('shutdown').catch(() => undefined)
        rpc.close()
      })()
      return stopPromise
    },
    rpc
  }
}

// CLI
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  const required = ['ROOST_API', 'ROOST_RUNTIME_TOKEN', 'ROOST_BOT_ID']
  const missing = required.filter((key) => (process.env[key] ?? '') === '')
  if (missing.length > 0) {
    console.error(`[room-agent] missing env: ${missing.join(', ')}`)
    process.exit(2)
  }
  const agent = await startRoomAgent({
    apiBase: process.env.ROOST_API,
    runtimeToken: process.env.ROOST_RUNTIME_TOKEN,
    botId: process.env.ROOST_BOT_ID,
    ...(process.env.ROOST_STATE_FILE === undefined ? {} : { stateFile: process.env.ROOST_STATE_FILE }),
    ...(process.env.ROOST_WORKDIR === undefined ? {} : { workdir: process.env.ROOST_WORKDIR }),
    ...(process.env.ROOST_DSH_BIN === undefined ? {} : { dshBin: process.env.ROOST_DSH_BIN }),
    ...(process.env.ROOST_DSH_PROFILE === undefined ? {} : { dshProfile: process.env.ROOST_DSH_PROFILE }),
    ...(process.env.ROOST_DSH_PROVIDER === undefined ? {} : { provider: process.env.ROOST_DSH_PROVIDER }),
    ...(process.env.ROOST_DSH_MODEL === undefined ? {} : { model: process.env.ROOST_DSH_MODEL })
  })
  const shutdown = () => {
    void agent.stop().finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
