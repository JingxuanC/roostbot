// DSH 侧适配器：把 DSH 的工具审批问句接到控制面审批（docs/build/wave3.md §A）。
//
// 事实基础（全部读过源码，见 describeDshApprovalSurface 的 findings）：
//
//   * DSH 有公开的审批缝：`ctx.approval`（ApprovalService）+ 一个
//     `approval/request` **waterfall 事件**。答案是"注册一个 answerer"：
//        ctx.on('approval/request', (request, next) => Promise<ApprovalOutcome>)
//     返回结果词即认领，调 next() 表示交给链上下一个 answerer。
//     先例：@deepseek-ai/dsh-acp/lib/index.js:1158。
//   * 结果词是封闭的四种：allowed-once / rejected / cancelled / unavailable。
//   * 请求里**没有工具参数**，只有 agent / toolName / callId / reason /
//     displayReason / signal。所以 argsSummary 只能由插件侧拼"工具名 + call id
//     + 理由"，真实参数需要另找工具调用记录（当前无公开 API，见 gaps）。
//
// 因此：能桥。但这个包不 import 任何 DSH 包 —— 适配器只吃一个鸭子类型的
// `{ on(event, listener) }`，由插件在自己的 apply(ctx) 里把 ctx 传进来。

import type { ApprovalRequest, BridgeOutcome, DshApprovalOutcome } from './contract.ts'
import { REQUEST_CONSEQUENCE_MAX, REQUEST_ID_MAX, REQUEST_SUMMARY_MAX } from './contract.ts'
import type { ApprovalBridge } from './bridge.ts'

/** DSH 源码核对版本（`@deepseek-ai/dsh-user-approval` 的 package.json version）。 */
export const DSH_APPROVAL_VERSION = '0.2.1-rc.5'

/** DSH 一次审批请求的形状（`lib/types/types.d.ts:55`）。 */
export interface DshApprovalRequestEvent {
  readonly agent?: { readonly session?: { readonly id?: string } } | undefined
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly displayReason?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

/** 链上下一个 answerer；返回结果词即"我答了"，调用它即"交给别人"。 */
export type DshNextAnswerer = () => Promise<DshApprovalOutcome>

export type DshAnswerer = (
  request: DshApprovalRequestEvent,
  next: DshNextAnswerer,
) => DshApprovalOutcome | Promise<DshApprovalOutcome>

/**
 * 鸭子类型的 Cordis Context：只要 `on`。
 * 真实签名是 `ctx.on(name, listener): () => void`（返回 disposer）；
 * 这里不 import `@deepseek-ai/cordis`，避免把 DSH 变成这个包的依赖。
 */
export interface DshApprovalContext {
  on(event: 'approval/request', listener: DshAnswerer): unknown
}

export interface BridgeScope {
  workspaceId: string
  botId: string
}

export interface InstallApprovalBridgeOptions {
  /** 这条 DSH 请求属于哪个 workspace / bot。函数形态返回 null = 不归本桥管，交回链上。 */
  readonly scope: BridgeScope | ((request: DshApprovalRequestEvent) => BridgeScope | null)
  /** 把 DSH 请求翻译成卡片字段；默认 describeDshRequest。 */
  readonly describe?: (request: DshApprovalRequestEvent) => { argsSummary: string; consequence: string }
  /** 桥侧 id；默认按 callId 去重（见 defaultRequestId）。 */
  readonly requestId?: (request: DshApprovalRequestEvent) => string
  /**
   * 本桥答不了时怎么办。默认失败关闭：返回 'unavailable'。
   * 想留给本机 UI 答案，就传 `(request, next) => next()`。
   */
  readonly fallback?: (request: DshApprovalRequestEvent, next: DshNextAnswerer) => DshApprovalOutcome | Promise<DshApprovalOutcome>
  readonly now?: () => number
}

export interface InstallApprovalBridgeHandle {
  readonly event: 'approval/request'
  /** 已注册的答案器；测试可以直接调用它，不必造一个 Cordis。 */
  readonly listener: DshAnswerer
  dispose(): void
}

/**
 * 把桥装成一个 DSH approval answerer。
 *
 * ```ts
 * // 插件 lib/index.js —— 唯一需要 import DSH 的地方
 * export function apply(ctx, config) {
 *   const bridge = createApprovalBridge({ request, wait, timeoutMs: config.timeoutMs })
 *   installApprovalBridge(ctx, bridge, { scope: { workspaceId: config.workspaceId, botId: config.botId } })
 * }
 * ```
 */
export function installApprovalBridge(
  ctx: DshApprovalContext,
  bridge: ApprovalBridge,
  options: InstallApprovalBridgeOptions,
): InstallApprovalBridgeHandle {
  if (ctx === null || typeof ctx !== 'object' || typeof (ctx as { on?: unknown }).on !== 'function') {
    throw new TypeError('installApprovalBridge needs a Cordis-like ctx with on(event, listener)')
  }
  if (bridge === null || typeof bridge !== 'object' || typeof bridge.submit !== 'function') {
    throw new TypeError('installApprovalBridge needs an approval bridge (createApprovalBridge)')
  }
  if (options === null || typeof options !== 'object' || options.scope === undefined) {
    throw new TypeError('installApprovalBridge needs options.scope (workspaceId + botId)')
  }

  const now = options.now ?? (() => Date.now())
  const describe = options.describe ?? describeDshRequest
  const makeId = options.requestId ?? defaultRequestId()
  const fallback = options.fallback ?? defaultFallback
  const scopeOf = options.scope
  let disposed = false

  const listener: DshAnswerer = async (request, next) => {
    if (request === null || typeof request !== 'object' || typeof request.toolName !== 'string' || request.toolName === '') {
      // 不是审批请求的形状：不认领，别把畸形数据变成一次"拒绝"。
      return next()
    }
    const scope = typeof scopeOf === 'function' ? scopeOf(request) : scopeOf
    if (scope === null) return next()
    // 已经被撤回：既不建单也不打扰人。
    if (request.signal?.aborted === true) return 'cancelled'

    const described = describe(request)
    const submitted: ApprovalRequest = {
      id: makeId(request),
      workspaceId: scope.workspaceId,
      botId: scope.botId,
      tool: request.toolName,
      argsSummary: clip(described.argsSummary, REQUEST_SUMMARY_MAX),
      consequence: clip(described.consequence, REQUEST_CONSEQUENCE_MAX),
      requestedAt: now(),
    }

    let outcome: BridgeOutcome
    try {
      outcome = await bridge.submit(submitted)
    } catch {
      // 桥自己拒收（非法请求 / 已 dispose）：交回链上，别把内部错误当用户的"不"。
      return fallback(request, next)
    }

    if (outcome.state === 'pending') {
      try {
        const settled = await raceAbort(bridge.waitFor(outcome.id), request.signal)
        // settled === null 表示 DSH 撤回了问句：答 cancelled，控制面那张单留在
        // 那里等它自己超时（控制面没有撤销接口，别假装撤掉了）。
        if (settled === null) return 'cancelled'
        outcome = settled
      } catch {
        return fallback(request, next)
      }
    }

    // 建单失败 ≠ 用户拒绝：DSH 的 unavailable 才是"没有可用通道"。
    if (outcome.failure === 'request_failed') return 'unavailable'
    return outcome.dshOutcome ?? 'unavailable'
  }

  const registered = ctx.on('approval/request', listener)

  return {
    event: 'approval/request',
    listener,
    dispose(): void {
      if (disposed) return
      disposed = true
      if (typeof registered === 'function') (registered as () => void)()
    },
  }
}

/**
 * 把 DSH 请求翻成卡片字段的默认实现。
 *
 * 只能这样：DSH 的审批请求不带参数（README 的 Known Limitations：
 * "The request carries no tool arguments"），call id 与 reason 是全部可得信息。
 */
export function describeDshRequest(request: DshApprovalRequestEvent): {
  argsSummary: string
  consequence: string
} {
  const callId = typeof request.callId === 'string' && request.callId !== '' ? ` (call ${request.callId})` : ''
  const reason = typeof request.reason === 'string' ? request.reason.trim() : ''
  return {
    argsSummary: `${request.toolName}${callId}${reason === '' ? '' : ` — ${reason}`}`,
    consequence:
      reason === ''
        ? `tool ${request.toolName} will run with no recorded justification`
        : reason,
  }
}

/**
 * 默认 id 约定：
 *   * 有 callId → `dsh:<session>:<callId>`。同一次工具调用的重试拿到同一张单，
 *     不会给同一个人弹两次；已落定的单会立刻复用自己的结果。
 *   * 没有 callId → `dsh:<session>:<tool>:<序号>`。没有稳定关联就用全新单。
 */
export function defaultRequestId(): (request: DshApprovalRequestEvent) => string {
  let sequence = 0
  return (request: DshApprovalRequestEvent): string => {
    const session = sessionOf(request)
    const callId = typeof request.callId === 'string' ? request.callId.trim() : ''
    const raw = callId === '' ? `dsh:${session}:${request.toolName}:${sequence++}` : `dsh:${session}:${callId}`
    return raw.slice(0, REQUEST_ID_MAX)
  }
}

// ---- describeDshApprovalSurface ---------------------------------------------

export interface DshApprovalFinding {
  /** 相对 `~/.dsh/superagent-cli/node_modules/.pnpm/<pkg>/node_modules/` 的路径。 */
  readonly file: string
  readonly line: number
  readonly fact: string
}

export interface DshApprovalSurface {
  /** DSH 是否有可注册的审批钩子。 */
  readonly supported: boolean
  /** supported=false 时说明缺口；true 时为 null。 */
  readonly reason: string | null
  readonly version: string
  readonly seam: {
    readonly service: string
    readonly event: string
    readonly mode: 'waterfall'
    readonly register: string
    readonly request: readonly string[]
    readonly outcomes: readonly DshApprovalOutcome[]
    readonly policies: readonly ['ask', 'never']
  }
  readonly findings: readonly DshApprovalFinding[]
  readonly gaps: readonly string[]
}

const DEFAULT_SURFACE: DshApprovalSurface = Object.freeze({
  supported: true,
  reason: null,
  version: DSH_APPROVAL_VERSION,
  seam: Object.freeze({
    service: 'ctx.approval (ApprovalService)',
    event: 'approval/request',
    mode: 'waterfall' as const,
    register: "ctx.on('approval/request', (request, next) => Promise<ApprovalOutcome>)",
    request: Object.freeze(['agent', 'toolName', 'callId?', 'reason?', 'displayReason?', 'signal?']),
    outcomes: Object.freeze(['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const),
    policies: Object.freeze(['ask', 'never'] as const),
  }),
  findings: Object.freeze([
    {
      file: '@deepseek-ai/dsh-user-approval/lib/types/types.d.ts',
      line: 81,
      fact:
        "'approval/request'(this: Scoped<Agent>, req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>) — 声明为 @mode waterfall，这就是可注册的答案器入口",
    },
    {
      file: '@deepseek-ai/dsh-user-approval/lib/types/types.d.ts',
      line: 26,
      fact: "ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' —— 封闭词汇，没有 'timeout'",
    },
    {
      file: '@deepseek-ai/dsh-user-approval/lib/types/types.d.ts',
      line: 55,
      fact: 'ApprovalRequestEvent 只有 agent / toolName / callId? / reason? / displayReason? / signal?，不带工具参数',
    },
    {
      file: '@deepseek-ai/dsh-user-approval/lib/types/index.d.ts',
      line: 21,
      fact: 'declare module @deepseek-ai/cordis { interface Context { approval: ApprovalService } }',
    },
    {
      file: '@deepseek-ai/dsh-user-approval/lib/types/index.d.ts',
      line: 135,
      fact: 'request(req: ApprovalRequest): Promise<ApprovalOutcome> —— 消费者侧的调用点',
    },
    {
      file: '@deepseek-ai/dsh-user-approval/lib/index.js',
      line: 176,
      fact:
        "decide() 走 this.ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', req, () => 'unavailable') —— 瀑布终点是失败关闭的 unavailable",
    },
    {
      file: '@deepseek-ai/dsh-user-approval/lib/index.js',
      line: 175,
      fact: "effectivePolicy === 'never' 时在派发前直接返回 'rejected'，任何 answerer 都看不到请求",
    },
    {
      file: '@deepseek-ai/dsh-user-approval/lib/index.js',
      line: 174,
      fact: "signal 已 abort 时返回 'cancelled'；等待期间 abort 也立刻收敛为 cancelled（:178-188）",
    },
    {
      file: '@deepseek-ai/dsh-user-approval/lib/index.js',
      line: 130,
      fact: 'request() 必须在打开的 turn 内调用，否则先抛错、不写审计 —— 没有跨 turn 的持久审批工作流',
    },
    {
      file: '@deepseek-ai/dsh-acp/lib/index.js',
      line: 1158,
      fact:
        "ctx.on('approval/request', (request, next) => ...)：真实的 host 侧 answerer 先例；不归自己管就 return next()",
    },
    {
      file: '@deepseek-ai/dsh-tools/lib/index.js',
      line: 3551,
      fact:
        'approval.request({ agent, toolName, callId, reason, displayReason, signal }) —— 工具层实际传的字段，比事件声明更窄',
    },
    {
      file: '@deepseek-ai/dsh-tools/lib/index.js',
      line: 3559,
      fact:
        "switch (outcome) 一对一映射：allowed-once → allow；rejected → 'the user rejected tool X'；cancelled → 'was cancelled'；unavailable → 'no approval channel is available'（:3581）",
    },
    {
      file: '@deepseek-ai/dsh-api-remotes/lib/types/remote-events.d.ts',
      line: 21,
      fact: "approval/request 以 mode: 'waterfall' 转发给客户端 —— 说明它是一等事件，不是内部实现细节",
    },
    {
      file: '@deepseek-ai/dsh-client-ui-approval/lib/client.js',
      line: 355,
      fact: 'ctx.remote.$on("approval/request", ...)：客户端 UI 答案器也是同一个注册形态',
    },
    {
      file: '@deepseek-ai/dsh-permission-presets/README.md',
      line: 41,
      fact: "preset `danger-full-access` = sandbox danger-full-access + approval 'never' —— 权限档位会把审批策略一起钉死",
    },
    {
      file: '@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js',
      line: 275,
      fact:
        'handleRequest 只认 initialize / session/prompt / session/resume / session/wait / session/working-directory/* / shutdown —— 进程外 SDK 客户端没有审批方法',
    },
  ]),
  gaps: Object.freeze([
    '请求不带工具参数：argsSummary 只能由插件用 toolName + callId + reason 拼，真实参数要读工具调用记录（DSH 未在 approval 事件里公开）。',
    "没有 allow-always：DSH 只有一次性的 'allowed-once'，没有记住的规则、吊销或 grant store；控制面的 approval_grants 无法回灌成 DSH 的长期授权。",
    '只能在打开的 turn 里问：跨 turn / 无人值守的持久审批工作流 DSH 侧不存在（lib/index.js:130 直接抛）。',
    '控制面没有撤销接口：DSH 撤回（cancelled）时那张控制面单只能原地等超时，桥不假装撤销。',
    "进程外 SDK/JSON-RPC 客户端拿不到审批面：桥必须是由 host 插件（进程内）注册的 answerer，不能靠 sdk-jsonrpc-server。",
    "approval 'never' 策略下请求根本不到 answerer：部署若用 danger-full-access preset，桥永远不会被调用（这是策略，不是 bug）。",
  ]),
})

/**
 * 说明 DSH 侧的审批面。
 *
 * 与 wave3 §A 的"若没有公开钩子就报缺口"相反：这里**有**公开钩子，所以返回
 * `supported: true` 与 `reason: null`，并把"证据（文件+行号）"和"仍然存在的
 * 缺口"分成两个数组，避免把结论和限制混成一句话。
 */
export function describeDshApprovalSurface(): DshApprovalSurface {
  return DEFAULT_SURFACE
}

// ---- 内部 --------------------------------------------------------------------

async function defaultFallback(
  _request: DshApprovalRequestEvent,
  _next: DshNextAnswerer,
): Promise<DshApprovalOutcome> {
  return 'unavailable'
}

/**
 * 与 DSH 的 signal 赛跑：撤回（abort）立刻返回 null，不等控制面。
 * 迟到答案会被丢掉（和 DSH 自己的语义一致）。
 */
function raceAbort(
  promise: Promise<BridgeOutcome>,
  signal: AbortSignal | undefined,
): Promise<BridgeOutcome | null> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.resolve(null)
  return new Promise<BridgeOutcome | null>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      resolve(null)
    }
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (outcome) => {
        cleanup()
        resolve(outcome)
      },
      (err: unknown) => {
        cleanup()
        reject(err)
      },
    )
  })
}

function sessionOf(request: DshApprovalRequestEvent): string {
  const id = request.agent?.session?.id
  return typeof id === 'string' && id !== '' ? id : 'session'
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}
