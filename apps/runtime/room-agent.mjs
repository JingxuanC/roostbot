// 房间 agent：沙箱里的长活 DSH + 每房间一个会话。
//
// 这是方案 A 的落点：不再每条消息 fork 一个 `dsh headless`，而是
//   一个长活 `dsh --profile sdk`（JSON-RPC over stdio）
//   + 每个 (room, bot) 一个 sessionId
//   + 控制面轮询收发。
// 多轮上下文由 DSH 自己维护（session 常驻），我们只负责路由和持久化。
//
// 协议见 @deepseek-ai/dsh-sdk-protocol：initialize / session/prompt / session/wait，
// 通知是 session.event 与 session.status。

import { spawn } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

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

/** 从 session.event 里取助手文本（assistant/message 的 text blocks）。 */
export function assistantText(event) {
  if (event === undefined || event.type !== 'assistant/message') return undefined
  const content = event.data?.message?.content
  if (!Array.isArray(content)) return undefined
  const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('')
  return text === '' ? undefined : text
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

export async function startRoomAgent(options) {
  const log = options.log ?? ((line) => console.log(`[room-agent] ${line}`))
  const botId = options.botId
  const pollMs = options.pollMs ?? 500
  const apiBase = options.apiBase
  const token = options.runtimeToken
  const headers = { 'content-type': 'application/json', 'x-runtime-token': token }
  const cursors = loadCursors(options.stateFile)
  const assistant = new Map()
  const idleWaiters = new Map()
  const prepared = new Set()
  let stopped = false

  const child = spawn(options.dshBin ?? 'dsh', ['--profile', options.dshProfile ?? 'sdk'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  const rpc = new JsonRpcProcessClient(child)

  rpc.on('session.event', (params) => {
    const text = assistantText(params?.event)
    if (text !== undefined) assistant.set(params.sessionId, text)
  })
  rpc.on('session.status', (params) => {
    if (params?.status !== 'idle') return
    const waiter = idleWaiters.get(params.sessionId)
    if (waiter !== undefined) {
      idleWaiters.delete(params.sessionId)
      waiter()
    }
  })

  const initialized = await rpc.request('initialize', {
    cwd: options.workdir ?? '/workspace',
    provider: options.provider ?? 'deepseek',
    model: options.model ?? 'deepseek-chat'
  })
  log(`sdk ready: ${initialized?.serverInfo?.name ?? 'unknown'} ${initialized?.serverInfo?.version ?? ''}`)

  /**
   * 等这个 session 空闲。**必须在 prompt 之前注册**：服务端可能在 prompt 的
   * 应答回来之前就发出 session.status=idle（假服务端 5ms 就发了，真实服务也可能很快），
   * 先发后注册会丢事件、只能等超时。
   */
  function idleSignal(sessionId) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 30_000)
      idleWaiters.set(sessionId, () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  async function prepareSession(sessionId) {
    // 沙箱 stop/start 或进程重启后，DSH_HOME 里的会话还在；先 resume，
    // 否则 SDK 会为同一个 id 新建一个空会话，多轮上下文就断了。
    if (prepared.has(sessionId)) return
    prepared.add(sessionId)
    await rpc.request('session/resume', { sessionId }).catch(() => undefined)
  }

  async function turn(roomId, seq, text) {
    const sessionId = sessionIdFor(roomId, botId)
    await prepareSession(sessionId)
    assistant.delete(sessionId)
    const idle = idleSignal(sessionId)
    await rpc.request('session/prompt', {
      sessionId,
      contentBlocks: [{ type: 'text', text: `房间里有人说：${text}` }]
    })
    // 没有 status 通知时用 session/wait 兜底（真服务端会等到空闲再回）。
    await Promise.race([
      idle,
      rpc.request('session/wait', { sessionId }).then(() => new Promise((r) => setTimeout(r, 50))).catch(() => undefined)
    ])
    idleWaiters.delete(sessionId)
    const answer = assistant.get(sessionId)
    if (answer === undefined) {
      log(`no assistant text for ${sessionId} seq ${seq}`)
      return
    }
    const response = await fetch(`${apiBase}/api/rooms/${encodeURIComponent(roomId)}/say`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ botId, text: answer, idem: `reply-${roomId}-${seq}` })
    })
    if (!response.ok) log(`say failed ${response.status}: ${await response.text()}`)
    else log(`replied ${roomId} seq ${seq} session ${sessionId}`)
  }

  async function poll() {
    const roomsResponse = await fetch(`${apiBase}/api/internal/rooms`, { headers })
    if (!roomsResponse.ok) throw new Error(`rooms ${roomsResponse.status}`)
    const { rooms } = await roomsResponse.json()
    for (const room of rooms) {
      const after = cursors[room.id] ?? 0
      const messagesResponse = await fetch(
        `${apiBase}/api/internal/rooms/${encodeURIComponent(room.id)}/messages?after=${after}`,
        { headers }
      )
      if (!messagesResponse.ok) continue
      const { messages } = await messagesResponse.json()
      for (const message of messages) {
        cursors[room.id] = Math.max(cursors[room.id] ?? 0, message.seq)
        saveCursors(options.stateFile, cursors)
        if (message.actor?.kind !== 'user') continue
        await turn(room.id, message.seq, message.text)
      }
    }
  }

  async function loop() {
    while (!stopped) {
      try {
        await poll()
      } catch (error) {
        log(`poll failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  void loop()

  return {
    async stop() {
      stopped = true
      await rpc.request('shutdown').catch(() => undefined)
      rpc.close()
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
