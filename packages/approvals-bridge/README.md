# @roost/approvals-bridge

DSH 的工具审批 ⇄ 控制面审批（`approvals` 表）之间的桥。
零依赖、可擦除 TS、相对导入带 `.ts`。

```
DSH 工具层 ──ctx.approval.request()──▶ approval/request 瀑布
                                            │  （本包的 answerer）
                                            ▼
                              POST /api/internal/approvals  ──▶ 控制面 approvals 行
                                            │                      │ 用户点批准/拒绝
                              GET  /api/internal/approvals/:id ◀───┘（wait 轮询）
                                            ▼
                              allowed-once / rejected / cancelled / unavailable
```

## 0. 结论先说

**能真正桥接，不是只能走 HTTP 旁路。** DSH 有公开的审批缝：

- 服务：`ctx.approval`（`ApprovalService`）
- 事件：`approval/request`，**waterfall**，`ctx.on('approval/request', (request, next) => Promise<ApprovalOutcome>)`
- 结果词封闭：`allowed-once | rejected | cancelled | unavailable`

所以 `installApprovalBridge(ctx, bridge, { scope })` 是**可用的适配器**，由 host 插件在
`apply(ctx)` 里注册。`describeDshApprovalSurface()` 返回 `supported: true`、`reason: null`，
并把证据（文件 + 行号）与仍然存在的缺口分成 `findings` / `gaps` 两个数组。

但有三件事必须知道（第 4 节展开）：

1. 桥必须是**进程内 host 插件**注册的 answerer；`dsh-sdk-jsonrpc-server` 没有审批方法，
   进程外 SDK 客户端拿不到审批面。
2. DSH 的审批请求**不带工具参数**（只有 `toolName / callId / reason`）。
3. DSH 没有 allow-always，控制面没有撤销接口，也没有"超时"这个概念。

## 1. 状态机

```
            submit()
               │
               ▼
          ┌─────────┐  settle('approved')   ┌──────────┐  → DSH allowed-once
          │ pending │ ────────────────────▶ │ approved │
          │         │  settle('rejected')   ├──────────┤  → DSH rejected
          │         │ ────────────────────▶ │ rejected │
          │         │  expire(deadline)     ├──────────┤  → DSH rejected（失败关闭）
          │         │ ────────────────────▶ │ timeout  │
          └─────────┘  dispose()            └──────────┘
```

不变量（都有测试守着）：

| 不变量 | 行为 |
|---|---|
| 幂等 · 提交 | 同一 `id` 再 `submit` 返回既有账目，不重复打控制面 |
| 幂等 · 落定 | 终态再 `settle` 原样返回，`decidedAt` 不变，`onSettled` 不再触发 |
| 不翻案 | 先批准后拒绝仍是 `approved`（与 `packages/store/src/approvals.ts` 的 `decideApproval` 同一条哲学：审批一旦落定就是事实） |
| 并发 | 多张单互不牵连；`list()` 按提交顺序 |
| 超时 | `decidedAt` 取 `deadline` 而不是"现在"，同样输入同样账目；`setTimeout` 分段（2^31-1 上限）且按时钟复核 |
| 失败关闭 | 建单失败 / `dispose` / 超时都不放行 |

结果词映射（`toDshOutcome`）：

| 桥状态 | 条件 | DSH 结果 | 模型看到的后果 |
|---|---|---|---|
| `approved` | 用户批准 | `allowed-once` | 放行 |
| `rejected` | 用户拒绝 | `rejected` | `the user rejected tool "X"` |
| `timeout` | 超时 | `rejected` | 同上（**不是** `unavailable`） |
| `rejected` + `failure='request_failed'` | 控制面建单失败 | `unavailable` | `no approval channel is available` |
| `pending` + 请求 `signal` abort | DSH 撤回 | `cancelled` | `approval … was cancelled` |

> 超时为什么不是 `unavailable`：通道是通的（单子建出来了、人在看），只是没人回答。
> `unavailable` 表示"没有可用通道"，用错会让模型以为部署缺能力。

## 2. 可用路径 A：控制面 HTTP（今天就能跑）

控制面已经把内部接口接好了（`apps/api/src/server.ts:2422`、`:2431`），
**不需要改 server.ts**：

```sh
# 1) 落一张待审批单（kind 必须匹配 ^[a-z][a-z0-9_.-]*$）
curl -sS -X POST "$BASE/api/internal/approvals" \
  -H "x-runtime-token: $RUNTIME_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
        "workspaceId": "ws_1",
        "kind": "tool.call",
        "requester": "bot_1",
        "requesterKind": "bot",
        "action": "bash",
        "target": "call_1",
        "consequence": "needs network",
        "payload": { "tool": "bash", "callId": "call_1" }
      }'
# → 201 { "approval": { "id": "apr_…", "status": "pending", … } }
# → 200 { "approval": null, "granted": true }   命中长期授权，无需等待

# 2) 轮询决定（runtime token）
curl -sS "$BASE/api/internal/approvals/apr_…" -H "x-runtime-token: $RUNTIME_TOKEN"
# → { "approval": { "status": "pending" | "approved" | "rejected", … } }

# 3) 用户决策（Bearer，owner/admin 之外的人看不到这张单）
curl -sS -X POST "$BASE/api/approvals/apr_…" \
  -H "authorization: Bearer $SESSION" \
  -H 'content-type: application/json' \
  -d '{"decision":"approved"}'
```

**`kind` 用 `tool.call` 或 `tool-call`，不要用 `tool_call`**：store 的 `readKind`
只接受 `^[a-z][a-z0-9_.-]*$`（`packages/store/src/approvals.ts:535`），下划线会被
400 `approval.invalid` 拒掉。wave3 §A 里写的 `kind='tool_call'` 直接照抄会失败。

`wait` 的写法（注入给 `createApprovalBridge`）：

```js
async function wait({ approvalId, signal, deadlineAt }) {
  let delay = 250
  while (!signal.aborted) {
    const res = await fetch(`${BASE}/api/internal/approvals/${approvalId}`, {
      headers: { 'x-runtime-token': TOKEN },
      signal,
    })
    if (!res.ok) throw new Error(`approval poll ${res.status}`)
    const { approval } = await res.json()
    if (approval.status !== 'pending') return approval.status   // approved | rejected
    if (deadlineAt !== null && Date.now() >= deadlineAt) return null  // 交给桥记 timeout
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(delay * 2, 2000)
  }
  return null
}
```

轮询要点：`signal` 一 abort 就停（桥落定/`dispose` 都会 abort）；**不要自己判超时
后返回 `rejected`**，返回 `null` 让桥写 `timeout`，账目才有唯一来源。

## 3. 可用路径 B：DSH answerer（真正的桥）

### 源码事实（`@deepseek-ai/dsh-user-approval@0.2.1-rc.5`）

| 位置 | 事实 |
|---|---|
| `lib/types/types.d.ts:81` | `'approval/request'(this: Scoped<Agent>, req, next) => Promise<ApprovalOutcome>`，`@mode waterfall` |
| `lib/types/types.d.ts:26` | 结果词 `allowed-once \| rejected \| cancelled \| unavailable` |
| `lib/types/types.d.ts:55` | `ApprovalRequestEvent` 字段：`agent / toolName / callId? / reason? / displayReason? / signal?` |
| `lib/types/index.d.ts:21` | `interface Context { approval: ApprovalService }` |
| `lib/types/index.d.ts:135` | `request(req: ApprovalRequest): Promise<ApprovalOutcome>` |
| `lib/index.js:176` | `ctx.waterfall(scopeTarget(agent, agent), 'approval/request', req, () => 'unavailable')` —— 瀑布终点失败关闭 |
| `lib/index.js:175` | 策略 `never` 在派发前直接 `rejected`，answerer 根本看不到请求 |
| `lib/index.js:174` | `signal` 已 abort → `cancelled`；等待中 abort 也立刻收敛 |
| `lib/index.js:130` | 必须在打开的 turn 内调用，否则先抛错、不写审计 |
| `dsh-acp/lib/index.js:1158` | host 侧 answerer 的真实先例：`ctx.on('approval/request', (request, next) => …)`，不归自己管就 `next()` |
| `dsh-tools/lib/index.js:3551` | 工具层实际传的字段（比事件声明更窄） |
| `dsh-tools/lib/index.js:3559` | 四种结果词的模型侧后果（`switch (outcome)`） |
| `dsh-api-remotes/lib/types/remote-events.d.ts:21` | `approval/request` 以 `waterfall` 转发给客户端 → 一等事件 |
| `dsh-client-ui-approval/lib/client.js:355` | 客户端 UI 也是同一个注册形态（`ctx.remote.$on`） |
| `dsh-sdk-jsonrpc-server/lib/index.js:275` | `handleRequest` 没有审批方法（进程外客户端无审批面） |
| `dsh-permission-presets/README.md:41` | `danger-full-access` preset 把 sandbox 与 `approval: 'never'` 一起钉死 |

`describeDshApprovalSurface()` 把这些原样返回，供运行期自检/文档生成用。

### 插件接法

```js
// 插件 lib/index.js —— 只有这里 import DSH
import { createApprovalBridge, installApprovalBridge } from '@roost/approvals-bridge'

export function apply(ctx, config) {
  const bridge = createApprovalBridge({
    timeoutMs: config.timeoutMs ?? 5 * 60_000,
    request: async (req) => {
      const res = await fetch(`${config.apiBase}/api/internal/approvals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-runtime-token': config.runtimeToken },
        body: JSON.stringify({
          workspaceId: req.workspaceId,
          kind: 'tool.call',            // 不要下划线
          requester: req.botId,
          requesterKind: 'bot',
          action: req.tool,
          target: req.id,
          consequence: req.consequence,
          payload: { tool: req.tool, argsSummary: req.argsSummary },
        }),
      })
      if (!res.ok) throw new Error(`create approval ${res.status}`)
      const body = await res.json()
      return { approvalId: body.approval?.id ?? null }   // granted:true 时没有 id
    },
    wait,
    onSettled: (outcome) => ctx.logger?.info?.('approval bridge', outcome.state, outcome.id),
  })

  installApprovalBridge(ctx, bridge, {
    scope: { workspaceId: config.workspaceId, botId: config.botId },
  })
}
```

`installApprovalBridge(ctx, bridge, options)`：

| 选项 | 说明 |
|---|---|
| `scope` | `{ workspaceId, botId }`，或 `(request) => scope \| null`；返回 `null` = 不归本桥管，`next()` 交回链上 |
| `describe` | 把 DSH 请求翻成 `{ argsSummary, consequence }`；默认 `describeDshRequest` |
| `requestId` | 桥侧 id；默认 `defaultRequestId()`（有 `callId` 就按它去重） |
| `fallback` | 答不了时怎么办；默认失败关闭（`'unavailable'`），传 `(req, next) => next()` 可让本机 UI 接 |
| `now` | 时钟注入（测试用） |

返回 `{ event, listener, dispose }`：`listener` 是已注册的 answerer（测试可直接调用），
`dispose()` 调用 `ctx.on` 返回的 disposer（幂等）。

语义细节：

- **DSH 请求没有 request id**，桥自己生成。默认按 `callId` 去重：同一次工具调用被问两次
  只会有一张控制面单，第二次直接复用已落定的结果。没有 `callId` 才每次新开。
- **`signal` abort**（DSH 撤回）：立刻答 `cancelled`，**控制面那张单留在 pending**
  —— 控制面没有撤销接口，桥不假装撤销，让它按自己的时限超时。这段时间里用户仍可能点
  批准，桥会忽略（迟到答案丢弃）。
- **策略 `never`**：请求到不了 answerer。如果部署用 `danger-full-access` preset，
  桥永远不会被调用——这是策略，不是 bug。
- **turn 限制**：DSH 只在打开的 turn 内问；桥不能凭空发起审批。

## 4. 不可用路径（别照着做）

| 想做的事 | 为什么不行 |
|---|---|
| 从进程外 SDK 客户端答审批 | `dsh-sdk-jsonrpc-server` 的 `handleRequest` 只有 `initialize / session/prompt / session/resume / session/wait / session/working-directory/* / shutdown`（`lib/index.js:275`） |
| 用完整工具参数展示给人看 | DSH 的 approval 事件不带 args（`types.d.ts:55`）；只能 `toolName + callId + reason` |
| "总是允许这个工具" | DSH 只有一次性 `allowed-once`，没有 grant store / 吊销；控制面的 `approval_grants` **无法**回灌成 DSH 的长期授权 |
| 让控制面把单撤掉 | `approvals-routes.ts` 只有 create / get（内部）与 decide / grants（用户），没有 cancel |
| 跨 turn / 无人值守排队等人批 | `ApprovalService.request()` 要求打开的 turn（`lib/index.js:130`） |
| 依赖 `kind='tool_call'` | store 的 kind 正则不接受下划线（`approvals.ts:535`） |
| 观测超时 | 控制面没有 `timeout` 状态：桥超时后那张行仍是 `pending`，UI 上需要自己按 `createdAt` 显示"已过期"，或后续加 sweep |

## 5. 接线建议（Lead）

1. **不用改 `server.ts`**：`/api/internal/approvals`（POST）与 `/api/internal/approvals/:id`（GET）
   已经接好（`server.ts:2422`、`:2431`）。若要 `tool.call` 这种 kind 出现在既有 UI 上，
   只需确认 UI 对未知 kind 有兜底文案。
2. **桥挂在 runtime 侧插件**，不要挂在 API 进程：审批发生在 DSH 进程里。
   `workspaceId` / `botId` / `runtimeToken` 从 workspace profile 注入（与
   `docs/design/plugins.md` §9 的"只读数据面 + 凭据"一致）。
3. **审计**：`createApproval` 已经写 `approval.requested`、`decideApproval` 写 `approval.decided`
   （`packages/store/src/approvals.ts:203`、`:304`），所以桥的 `onSettled` 只做日志/指标，
   **不要再写一条领域事件**，否则同一事实两条记录。
4. **超时建议 5 分钟**（`timeoutMs`）。超时后控制面行仍是 `pending`：UI 侧要么显示
   "已过期"，要么后续加一个按 `created_at` 的 sweep（不在本包 scope）。
5. **`wait` 的轮询**用第 2 节的写法：250ms → 2s 退避，听 `signal`，别自己判超时。
6. **失败关闭的默认值**是刻意的：桥连不上控制面时答 `unavailable`，让模型知道
   "没有通道"而不是"用户拒绝"。想在本机保留人工兜底就传 `fallback: (req, next) => next()`。
7. **账目只增不删**：一次 ask 一条，终态也留着（幂等与审计都要它）。进程重启即回收；
   若要长期不重启，按 `decidedAt` 定期换一台新桥（或后续给 `prune` 加参数，不在本包 scope）。

## 6. API

```ts
// contract.ts
readApprovalRequest(value, at?)            // → { ok: true, request } | { ok: false, errors[] }
toDshOutcome(decision)                     // approved→allowed-once；rejected|timeout→rejected；null→null
isTerminal(state); isBridgeDecision(value)

// bridge.ts
createApprovalBridge({ request?, wait?, timeoutMs?, now?, setTimer?, clearTimer?, onSettled? })
  .submit(input)        → Promise<BridgeOutcome>   // 幂等
  .settle(id, decision, { at?, by?, note?, failure? }) → BridgeOutcome
  .expire(at?)          → BridgeOutcome[]          // 纯 tick，测试可手动驱动
  .waitFor(id)          → Promise<BridgeOutcome>
  .get(id) / .list() / .pending() / .size / .dispose()

// dsh.ts
installApprovalBridge(ctx, bridge, { scope, describe?, requestId?, fallback?, now? })
  → { event: 'approval/request', listener, dispose() }
describeDshApprovalSurface() → { supported: true, reason: null, seam, findings[], gaps[] }
describeDshRequest(request)  → { argsSummary, consequence }
defaultRequestId()           → (request) => string
```

`BridgeOutcome`：`{ id, request, state, decision, dshOutcome, failure, approvalId,
requestedAt, deadlineAt, decidedAt, decidedBy, note }`。快照是冻结的，外部改不动内部账。

## 7. 测试

```sh
export PATH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin:$PATH"
node --experimental-strip-types --test packages/approvals-bridge/test/*.test.ts
```

55 个用例：状态机 25（提交/批准/拒绝/超时/幂等/并发/失败关闭/dispose/不可变）、
契约 11（校验/映射/错误）、DSH 适配 19（注册/翻译/结果词/撤回/缺口描述）。
全部注入时钟与定时器，不 sleep（只有一个 5ms 的真实定时器用例）。
