// 房间 worker：把「有人在房间里说话」变成「Bot 也在房间里说话」。
//
// v0 是一个**占位回复者**：它订阅控制面的内部接口，看到人的消息就回一句。
// 配了 ROOST_SANDBOX=openshell 时，「想」这一步会在真实沙箱里执行（见 sandbox-runner.ts），
// 回复里带上沙箱内的 uid/hostname 作为证据；没配时退回固定模板。
// 它存在的意义是先把事件流、SSE、渲染三段打通；之后把 reply() 换成 DSH 回合即可，
// 接口不变：读消息 → 想 → 以 Bot 身份说话。
//
// 设计见 docs/design/messaging.md（投递语义）与 docs/design/agent-collaboration.md（回合）。

export interface RoomWorkerOptions {
  /** 控制面地址，例如 http://127.0.0.1:8787。 */
  apiBase: string
  /** 内部接口 token（ROOST_RUNTIME_TOKEN）。 */
  runtimeToken: string
  /** 轮询间隔（毫秒）。 */
  pollMs?: number
  /** 回复前等待，避免和人的下一条消息抢话。 */
  replyDelayMs?: number
  /** 只盯这些房间；不给就盯全部。 */
  roomIds?: string[]
  /** 注入点：换成真 DSH 回合时只改这里。 */
  reply?: (input: { roomId: string; text: string; seq: number }) => Promise<string | null>
  log?: (line: string) => void
  /** 停止信号。 */
  signal?: AbortSignal
}

export interface RoomWorkerHandle {
  stop: () => void
  /** 已处理到的最新 seq（按房间）。 */
  cursors: Map<string, number>
  /** 回过的消息数量（测试与观测用）。 */
  replies: number
}

interface Message {
  seq: number
  at: string
  actor: { kind: string; id: string }
  text: string
}

/** 默认回复：诚实说明这是占位，不假装是模型。 */
export function placeholderReply(text: string): string {
  const clipped = text.length > 120 ? `${text.slice(0, 120)}…` : text
  return `收到：「${clipped}」。这是 v0 的占位回复——DSH 回合还没接进来，先把事件流跑通。`
}

export async function startRoomWorker(options: RoomWorkerOptions): Promise<RoomWorkerHandle> {
  const pollMs = options.pollMs ?? 400
  const replyDelayMs = options.replyDelayMs ?? 600
  const log = options.log ?? ((line: string) => console.log(`[room-worker] ${line}`))
  const reply = options.reply ?? (async ({ text }) => placeholderReply(text))
  const cursors = new Map<string, number>()
  const answered = new Set<number>()
  let replies = 0
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-runtime-token': options.runtimeToken
  }

  async function discoverRooms(): Promise<string[]> {
    const response = await fetch(`${options.apiBase}/api/internal/rooms`, { headers })
    if (!response.ok) throw new Error(`rooms ${response.status}: ${await response.text()}`)
    const body = (await response.json()) as { rooms: Array<{ id: string }> }
    const ids = body.rooms.map((room) => room.id)
    return options.roomIds === undefined ? ids : ids.filter((id) => options.roomIds!.includes(id))
  }

  async function readMessages(roomId: string): Promise<Message[]> {
    const after = cursors.get(roomId) ?? 0
    const response = await fetch(
      `${options.apiBase}/api/internal/rooms/${encodeURIComponent(roomId)}/messages?after=${after}`,
      { headers }
    )
    if (!response.ok) throw new Error(`messages ${response.status}: ${await response.text()}`)
    const body = (await response.json()) as { messages: Message[] }
    return body.messages
  }

  async function say(roomId: string, botId: string, text: string, seq: number): Promise<void> {
    const response = await fetch(`${options.apiBase}/api/rooms/${encodeURIComponent(roomId)}/say`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ botId, text, idem: `reply-${roomId}-${seq}` })
    })
    if (!response.ok) throw new Error(`say ${response.status}: ${await response.text()}`)
  }

  async function tick(): Promise<void> {
    if (stopped) return
    let rooms: string[]
    try {
      rooms = await discoverRooms()
    } catch (error) {
      log(`discover failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const roomId of rooms) {
      if (stopped) return
      let messages: Message[]
      try {
        messages = await readMessages(roomId)
      } catch {
        // 房间被删：忘掉游标，下一轮重新发现。
        cursors.delete(roomId)
        continue
      }
      for (const message of messages) {
        cursors.set(roomId, Math.max(cursors.get(roomId) ?? 0, message.seq))
        if (message.actor.kind !== 'user') continue
        if (answered.has(message.seq)) continue
        answered.add(message.seq)
        if (replyDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, replyDelayMs))
        if (stopped) return
        try {
          const text = await reply({ roomId, text: message.text, seq: message.seq })
          if (text === null) continue
          await say(roomId, process.env.ROOST_BOT_ID ?? 'selector', text, message.seq)
          replies += 1
          log(`replied in ${roomId} to seq ${message.seq}`)
        } catch (error) {
          log(`reply failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      await tick()
      if (stopped) return
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, pollMs)
      })
    }
  }

  const handle: RoomWorkerHandle = {
    stop: () => {
      stopped = true
      if (timer !== null) clearTimeout(timer)
    },
    cursors,
    get replies() {
      return replies
    }
  }

  options.signal?.addEventListener('abort', handle.stop, { once: true })
  void loop()
  return handle
}

// CLI：`ROOST_API=http://127.0.0.1:8787 ROOST_RUNTIME_TOKEN=… node worker.ts`
async function main(): Promise<void> {
  const apiBase = process.env.ROOST_API ?? 'http://127.0.0.1:8787'
  const runtimeToken = process.env.ROOST_RUNTIME_TOKEN
  if (runtimeToken === undefined || runtimeToken === '') {
    console.error('[room-worker] ROOST_RUNTIME_TOKEN is required')
    process.exit(2)
  }

  const sandboxMode = process.env.ROOST_SANDBOX
  if (sandboxMode === 'openshell' || sandboxMode === 'passthrough') {
    const { startSandboxRunner, SANDBOX_PROBE } = await import('./sandbox-runner.ts')
    const dshTurn = process.env.ROOST_SANDBOX_TURN === 'dsh'
    const runner = await startSandboxRunner({
      backend: sandboxMode,
      ...(process.env.ROOST_SANDBOX_IMAGE === undefined ? {} : { image: process.env.ROOST_SANDBOX_IMAGE }),
      ...(process.env.ROOST_SANDBOX_NAME === undefined ? {} : { name: process.env.ROOST_SANDBOX_NAME }),
      ...(dshTurn ? { mockModel: process.env.ROOST_DSH_MOCK === '1' } : {}),
      ...(process.env.ROOST_DSH_BASE_URL === undefined ? {} : { modelBaseUrl: process.env.ROOST_DSH_BASE_URL }),
      ...(process.env.ROOST_DSH_MODEL === undefined ? {} : { model: process.env.ROOST_DSH_MODEL }),
      ...(process.env.ROOST_DSH_PROVIDER === undefined ? {} : { provider: process.env.ROOST_DSH_PROVIDER })
    })
    // 空闲即挂起：接 scheduling.md 的「睡/醒握手」——没有回合时释放内存，
    // 下一条消息到达时由 runner 自动 resume。
    const idleMs = Number.parseInt(process.env.ROOST_SANDBOX_IDLE_MS ?? '0', 10)
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleIdleSuspend = () => {
      if (!Number.isFinite(idleMs) || idleMs <= 0) return
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        void runner.suspend().then((did) => {
          if (did) console.log('[worker] sandbox suspended while idle')
        }).catch((error: unknown) => console.error('[worker] suspend failed:', error))
      }, idleMs)
    }

    const modelLabel =
      process.env.ROOST_DSH_PROVIDER !== undefined
        ? `真实模型（凭据由 OpenShell provider「${process.env.ROOST_DSH_PROVIDER}」注入）`
        : process.env.ROOST_DSH_MOCK === '1'
          ? 'mock 模型'
          : 'DSH provider'
    const handle = await startRoomWorker({
      apiBase,
      runtimeToken,
      reply: async ({ text }) => {
        const clipped = text.length > 120 ? `${text.slice(0, 120)}…` : text
        if (dshTurn) {
          const answer = await runner.runDshTurn(`房间里有人说：${text}`)
          scheduleIdleSuspend()
          return `「${answer}」（沙箱内 DSH 回合 · ${modelLabel} · ${runner.backend}）`
        }
        const probe = await runner.run(SANDBOX_PROBE)
        scheduleIdleSuspend()
        const evidence = probe.stdout.trim().split('\n').slice(0, 2).join(' · ')
        return `收到：「${clipped}」。这条回复由 ${runner.backend} 沙箱内的同名进程生成（${evidence}）；DSH 回合还没接进来。`
      }
    })
    const shutdown = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      handle.stop()
      void runner.stop().finally(() => process.exit(0))
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    return
  }

  const handle = await startRoomWorker({ apiBase, runtimeToken })
  const shutdown = () => {
    handle.stop()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  await main()
}
