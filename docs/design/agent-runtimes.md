# 多 Agent 运行时与 Adapter

> 状态：方案（2026-11-07）。  
> 目标：让同一个房间可以接入不同 Agent harness（DSH、Grok Build、Claude Code、Codex、Hermes），同时不把控制面改写成另一套系统。  
> 参考：PairRoom（MIT，Go）的 Runtime / Slot / Binding / Native-Relay 模型；本文只借概念，不引入其代码或本地桌面架构。

## 1. 结论

采用：

> **事件驱动核心 + Runtime Adapter 边界 + Room Slot / Binding + Native / Embedded 双模式。**

拆成三条硬边界：

1. **房间层只认 AgentEvent**，不认 DSH / Claude / Codex 的私有协议。
2. **Adapter 只负责驱动 Agent 进程**，不写房间事件、不直接改数据库。
3. **凭据分两种边界**：
   - Native：凭据留在用户自己的 Agent 环境；
   - Embedded：凭据由控制面按 Bot/Workspace 注入，绝不进镜像。

控制面的**房间、消息、事件、SSE、审批、产物**核心不重写；需要扩展的是 Bot 配置、能力、凭据、用量、runtime supervisor 和 UI。

## 2. 目标与非目标

### 目标

- 同一房间可以有不同 Runtime 的 Bot。
- 新增 Runtime 不需要改房间状态机。
- 支持流式输出、工具调用、权限请求、取消、用量、错误。
- 支持断线、runtime 重启、sandbox 重建后的可解释恢复。
- 支持 Native（用户已有 Claude Code / Codex / Grok Build 会话）和 Embedded（Roost 启动 Agent）两种接入。
- 保留现有 DSH 路径，不做一次性大迁移。

### 非目标

- 不实现一个“万能 Agent 进程”在一个进程里跑所有 harness。
- 不把 Claude / Codex 的订阅凭据复制到共享镜像。
- 不让多个 Agent 在同一 workspace 并行写同一文件。
- 不在本阶段引入 Kafka / NATS / 多控制面实例。
- 不把 Grok Build 的 subagents 映射成房间成员。

## 3. 术语

| 术语 | 含义 |
|---|---|
| **Runtime** | Agent harness 类型：`dsh` / `grok-build` / `claude-code` / `codex` / `hermes` |
| **Adapter** | 驱动某个 Runtime 的进程适配层，把输入/输出归一化为 AgentEvent |
| **Slot** | 房间里的一个参与者位置；不绑定 Runtime |
| **Binding** | 某个原生会话或 Adapter 会话与 Slot 的绑定关系 |
| **Turn** | 一次激活产生的执行；一个 Turn 有且只有一个终态 |
| **Native** | Agent 保持自己的进程、工具、凭据和权限；Roost 只做 relay/audit |
| **Embedded** | Roost 启动 Adapter 和 Agent 进程，并托管会话 |
| **Platform Tool** | Roost 提供的能力：`send_image`、`create_team`、`post_card`、memory 等 |
| **Native Tool** | Agent harness 自带的 bash/edit/search/tool loop |

## 4. 总体架构

```text
                         ┌─────────────────────────┐
                         │        Room Actor        │
                         │  round / slot / state    │
                         └────────────┬────────────┘
                                      │ AgentTurn
                                      ▼
                         ┌─────────────────────────┐
                         │      AgentAdapter        │
                         │  capability negotiation  │
                         └──────┬──────────┬────────┘
                                │          │
                  ┌─────────────┘          └──────────────┐
                  ▼                                       ▼
          Native Relay                              Embedded Adapter
     (Claude/Codex/Grok session)                (Roost-owned process)
                  │                                       │
                  ▼                                       ▼
          hooks / ACP / CLI                      DSH JSON-RPC / ACP / CLI
                  │                                       │
                  └──────────────┬────────────────────────┘
                                 ▼
                         AgentEvent stream
                                 │
                                 ▼
                    Room events / SSE / approvals / usage
```

### 4.1 控制面保留的职责

- 事件日志（append-only）
- 房间 round / slot 状态
- SSE 推送
- 消息、附件、审批、产物
- 计费与额度
- Bot 身份、权限、工作区

### 4.2 Adapter 的职责

- `probe()`：检查二进制、版本、登录态、模型可用性
- `capabilities()`：报告能力
- `openSession()`：启动或绑定一个 Agent 会话
- 把 Agent 输出归一化为 `AgentEvent`
- 处理取消、超时、进程退出、stderr、日志脱敏

### 4.3 不变量

- Adapter 不直接写 `events` 表。
- Adapter 不直接发 SSE。
- Adapter 不直接改房间状态。
- 所有副作用都经控制面的事件/命令通道。

## 5. 双模式

### 5.1 Native 模式

适用于用户已经有 Claude Code、Codex、Grok Build 会话的场景。

```text
用户已有的 Agent 会话
  → hook / ACP / 本地 relay
  → 绑定到 Room Slot
  → 只转发房间消息和结果
```

特点：

- 模型、工具、凭据、权限留在用户环境
- Roost 看不到用户 API key
- Roost 只保存房间消息和投递状态
- 适合桌面端、BYO、LAN、企业内网

风险：

- 需要用户安装/批准 hooks
- 原生会话可能不在，投递只能排队
- “已发送”不等于“模型已读”
- 跨机器需要 LAN/relay 鉴权

### 5.2 Embedded 模式

适用于 Web、手机、云端房间。

```text
Room Slot
  → Roost Adapter
  → 启动 Agent 进程
  → 独立 workdir / env / cgroup
```

特点：

- 用户无需本地 CLI
- 控制面统一管理生命周期
- 凭据由 secret provider 注入
- 可以计费、限额、审计

风险：

- 镜像大、依赖冲突
- 版本升级由 Roost 负责
- 多 Agent 工具写冲突
- 厂商 ToS / 登录方式限制

### 5.3 选择建议

```text
用户已有订阅 / 本地会话 → Native
Web / 手机 / 无本地环境 → Embedded
```

两种模式可以共存，但同一个 Slot 同一时刻只能有一种 Binding。

## 6. AgentAdapter 接口

```ts
export type AgentRuntimeKind =
  | 'dsh'
  | 'grok-build'
  | 'claude-code'
  | 'codex'
  | 'hermes'

export interface AgentAdapter {
  readonly kind: AgentRuntimeKind

  probe(): Promise<AgentProbe>

  capabilities(): AgentCapabilities

  openSession(spec: AgentSessionSpec): Promise<AgentSession>
}

export interface AgentProbe {
  ok: boolean
  version?: string
  binary?: string
  auth: 'ok' | 'missing' | 'unknown'
  problems: string[]
}

export interface AgentCapabilities {
  streaming: boolean
  tools: 'native' | 'platform' | 'none'
  permissions: 'native' | 'bridge' | 'none'
  images: { input: boolean; output: boolean }
  resume: boolean
  subagents: boolean
  mcp: boolean
  models: string[]
  maxContextTokens?: number
  maxOutputTokens?: number
}

export interface AgentSessionSpec {
  sessionId: string
  roomId: string
  botId: string
  workspaceId: string
  workdir: string
  model?: string
  systemPrompt?: string
  mcpServers?: McpServerConfig[]
  env: Record<string, string>
  resumeState?: unknown
}

export interface AgentSession {
  readonly id: string

  send(turn: AgentTurn, options?: SendOptions): AsyncIterable<AgentEvent>

  cancel(turnId: string, reason: CancelReason): Promise<void>

  close(): Promise<void>

  snapshot?(): Promise<unknown>
}

export interface AgentTurn {
  turnId: string
  input: string
  context: RoomContext
  signal: AbortSignal
}

export interface RoomContext {
  roomName: string
  members: Array<{ botId: string; name: string; role?: string }>
  recentMessages: Array<{ seq: number; actor: string; text: string; at: string }>
  summary?: string
  artifacts: Array<{
    artifactId: string
    kind: string
    name: string
    url: string
  }>
  tokenBudget: number
}
```

### 6.1 实现分布

| Adapter | 传输 |
|---|---|
| `DshAdapter` | DSH JSON-RPC + `assistant/live-chunk` tap |
| `GrokBuildAcpAdapter` | 原生 ACP |
| `CodexAcpAdapter` | `codex-acp` 适配器；不可用时 `codex exec --json` |
| `ClaudeCliAdapter` | `claude --headless --output-format stream-json` |
| `HermesAdapter` | API 或 CLI，能力按 probe 报告 |

ACP 不是强制协议。ACP 适合统一 session/permission/cancel；CLI JSON 适合官方稳定输出。每个 Adapter 自己选择传输，但必须满足同一个 `AgentEvent` 契约。

## 7. AgentEvent 协议

```ts
export type AgentEvent =
  | { type: 'turn.started'; turnId: string; at: number }
  | { type: 'text.delta'; turnId: string; seq: number; text: string }
  | { type: 'text.final'; turnId: string; text: string }
  | { type: 'reasoning.delta'; turnId: string; text: string }
  | { type: 'tool.call'; turnId: string; callId: string; name: string; input: unknown }
  | { type: 'tool.result'; turnId: string; callId: string; ok: boolean; output?: unknown; error?: string }
  | { type: 'permission.request'; turnId: string; requestId: string; tool: string; args: unknown; risk?: string }
  | { type: 'permission.resolved'; turnId: string; requestId: string; decision: 'allow' | 'deny' }
  | { type: 'artifact'; turnId: string; path: string; mime: string; name?: string }
  | { type: 'usage'; turnId: string; inputTokens?: number; outputTokens?: number; estimated?: boolean }
  | { type: 'error'; turnId: string; code: string; message: string; retryable: boolean }
  | { type: 'turn.ended'; turnId: string; reason: 'stop' | 'cancelled' | 'timeout' | 'error' }
```

### 7.1 不变量

1. 每个 Turn 有且只有一个 `turn.ended`。
2. 成功时 `text.final` 最多一次；最终消息以 `text.final` 为准。
3. `text.delta` 只用于展示，不写 durable event log。
4. `tool.call` 的 `callId` 在同一个 Turn 内稳定。
5. 取消后不再产生 delta。
6. 错误必须发 `error` 或 `turn.ended`。
7. 所有事件都带 `turnId`，可关联 trace。

### 7.2 durable / ephemeral

| 类型 | 是否写 events 表 | 原因 |
|---|---|---|
| `text.final` | 是 | 最终消息 |
| `tool.call/result` | 是 | 审计/证据 |
| `permission.*` | 是 | 审批 |
| `usage` | 是 | 计费 |
| `artifact` | 是 | 产物引用 |
| `text.delta` | 否 | token 流，量太大 |
| `reasoning.delta` | 否 | 内部过程，默认不展示 |

`text.delta` 走内存 stream hub；断线后不要求恢复每个 token，只显示“正在生成”或等待最终消息。

## 8. 工具模型

### 8.1 Native Tools

Agent 自带的工具留在 Agent 进程内：

```text
Claude Code: Bash / Read / Edit / Search
Codex: shell / apply_patch
Grok Build: 自身工具
DSH: 自身工具
```

Roost 不重新实现这些工具。

### 8.2 Platform Tools

Roost 提供的能力通过 MCP 暴露：

```text
Roost MCP Server
  ├─ send_image
  ├─ create_team
  ├─ post_card
  ├─ room_context
  └─ memory
```

支持 MCP 的 Agent 都接同一个 MCP Server，避免每个 Adapter 重写工具桥。

### 8.3 权限桥

```text
Agent 权限请求
  → Adapter 归一化 permission.request
  → 控制面审批
  → permission.resolved
  → Agent 继续 / 拒绝
```

控制面审批表复用现有 `approvals`，增加：

```text
runtimeKind
adapterRequestId
toolName
```

### 8.4 写冲突

v1 规则：

- 每个 Bot 独立 workdir：`/workspace/agents/<botId>`
- 共享产物只写 `/workspace/shared/artifacts`
- 共享区写入需要锁或串行
- 不允许两个 Agent 同时改同一个仓库工作树

后续可引入 git worktree per Bot + 显式 merge。

## 9. 房间编排

### 9.1 Slot 与 Binding

```text
Room
  ├─ Slot 1 → Bot A → Binding(runtime=dsh)
  ├─ Slot 2 → Bot B → Binding(runtime=grok-build)
  └─ Slot 3 → Bot C → Binding(runtime=codex)
```

Slot 不绑定 Runtime。Bot 的设置里才有 Runtime；Binding 记录当前会话。

### 9.2 发言规则

多 Agent 房间最怕无限互相回复。建议：

```text
Bot 输出 → 检查是否明确要进入房间
  @agentX  → 转发给指定 Slot
  @user    → 发布到房间
  无 mention → 只作为该 Turn 结果，不自动触发下一个 Agent
```

Roost 的默认策略：

- 用户消息 → Room Actor 决定谁回答
- Bot 之间 relay 需要显式 mention
- 不自动无限循环
- 超过 N 轮强制停下等用户

### 9.3 Turn 状态机

```text
queued
  → running
  → completed / failed / cancelled / waiting_input / interrupted
```

与现有 `agent-collaboration.md` 的 Assignment 状态机对齐，不另起一套。

### 9.4 等待与取消

- Adapter 的 `send()` 是 async iterable；消费端可以背压。
- 取消：先协议 cancel，再 SIGINT，超时 SIGTERM，再 SIGKILL。
- 等待：有硬超时；超时转 `turn.ended(timeout)`，不假装成功。

## 10. 控制面改造清单

### 10.1 几乎不变

```text
events 表 / SSE / rooms / messages
approvals / artifacts / budgets
OpenShell runtime
模型代理
```

只要 Adapter 归一化到现有事件类型，房间和 SSE 不需要重写。

### 10.2 必须变

| 模块 | 改动 |
|---|---|
| `bots` | 增加 `runtime_kind`、`runtime_config`、`credential_ref` |
| `rooms` | Slot 与 Binding 表；Bot 与 Slot 的关系 |
| 能力 | 缓存 `capabilities`，UI 按能力渲染 |
| 凭据 | secret provider / BYO key / native 不托管 |
| 审批 | 统一 runtime 的 permission payload |
| 用量 | Adapter 发 usage；没有则估算 |
| runtime supervisor | 按 Bot runtime 选择 Adapter |
| UI | 创建 Bot 选 Runtime；能力/凭据状态 |
| 事件 | 增加 agent.turn / permission / usage 类型 |

### 10.3 控制面“几乎不用变”的准确说法

```text
房间/事件/SSE 核心：85%–90% 不变
Bot/凭据/能力/用量/UI：新增
runtime supervisor：中等改造
```

不是零改动，但不需要重写控制面。

## 11. 数据模型

```sql
-- Bot 的 runtime 配置
ALTER TABLE bots ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'dsh';
ALTER TABLE bots ADD COLUMN runtime_config TEXT;
ALTER TABLE bots ADD COLUMN credential_ref TEXT;
ALTER TABLE bots ADD COLUMN capabilities TEXT;

-- 房间参与者位置
CREATE TABLE room_slots (
  id            TEXT PRIMARY KEY,
  room_id       TEXT NOT NULL,
  bot_id        TEXT,
  runtime_kind  TEXT,
  status        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 原生会话 / Adapter 会话绑定
CREATE TABLE agent_bindings (
  id             TEXT PRIMARY KEY,
  slot_id        TEXT NOT NULL,
  room_id        TEXT NOT NULL,
  bot_id         TEXT,
  kind           TEXT NOT NULL,       -- native | embedded
  runtime_kind   TEXT NOT NULL,
  external_id    TEXT,                -- 原生 session id / ACP session id
  state          TEXT NOT NULL,
  generation     INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER
);

-- 运行时会话（Embedded）
CREATE TABLE agent_sessions (
  id             TEXT PRIMARY KEY,
  binding_id     TEXT NOT NULL,
  workdir        TEXT NOT NULL,
  pid            INTEGER,
  status         TEXT NOT NULL,
  started_at     INTEGER,
  ended_at       INTEGER
);
```

如果暂时不想加表，也可以先把 `room_slots` / `agent_bindings` 存在 `rooms` 的 JSON 字段里；但生产前应该表化。

## 12. 镜像与进程

### 12.1 一个 workspace 镜像

```text
/opt/agents/
  dsh/
  grok-build/
  claude-code/
  codex/
  hermes/

/opt/roost/
  agent-supervisor
  adapter-sdk
  adapters/
    dsh.js
    acp.js
    claude-cli.js
    codex-cli.js
    hermes-api.js
```

要求：

- 版本固定，不 `latest`
- `probe` 能报版本和登录态
- 启动时检查依赖
- 不把任何 key 写进镜像
- 日志脱敏

### 12.2 进程模型

```text
agent-supervisor（一个 workspace 一个）
  ├─ Bot A: dsh session
  ├─ Bot B: grok-build ACP process
  ├─ Bot C: claude process
  └─ Bot D: codex process
```

每个进程：

- 独立 workdir
- 独立 env
- 独立 cgroup / 资源上限
- 独立日志
- 独立生命周期

### 12.3 生产建议

开发期一个镜像；生产期按依赖冲突拆 sidecar。  
不要把全部 Agent 塞进一个 Node 进程。

## 13. 安全

| 边界 | 规则 |
|---|---|
| 凭据 | Native 不托管；Embedded 用 secret provider；镜像零密钥 |
| 网络 | 每个 Runtime 独立 egress allowlist |
| 工具 | Platform Tool 走 MCP + runtime token |
| 权限 | 默认 deny；全权 Bot 才自动 allow |
| Prompt injection | 房间上下文标记来源，不把不可信文本当系统指令 |
| 日志 | 不打印 key / token / cookie |
| 多租户 | workspace 级隔离；不能跨 workspace 读产物 |

## 14. 用量与计费

Adapter 应发：

```text
usage { inputTokens, outputTokens, estimated }
```

支持情况：

- DSH：有 usage
- Claude / Codex：有
- Grok Build：可能没有
- Hermes：取决于实现

没有 usage 时：

- 按字符/调用次数估算
- 标 `estimated: true`
- 账本必须能区分真实/估算

## 15. 故障与恢复

| 故障 | 处理 |
|---|---|
| Adapter 启动失败 | `probe` 失败，Bot 标记不可用，不发假消息 |
| Agent 进程崩溃 | 最多重启 N 次；支持 resume 的续，否则 `failed` |
| 控制面断线 | Adapter 保持会话；重连后从 cursor 补发 |
| Sandbox 重建 | 不支持 resume 的 Bot 标记 `interrupted`，不重放旧回复 |
| 重复投递 | 用 `turnId` + `eventId` 去重 |
| 取消超时 | SIGINT → SIGTERM → SIGKILL |
| 不确定投递 | 标 `uncertain`，等人工检查，不盲目 retry |

## 16. 可观测性

每个 Turn 至少记录：

```text
adapter.probe
adapter.spawn
turn.queue
turn.start
adapter.first_event
first.delta
tool.call
tool.result
turn.end
```

指标：

- 队列等待
- Adapter 启动时间
- 首 token 时间
- 工具耗时
- 失败率 / 取消率
- 每 Runtime 的 token 成本

## 17. 迁移阶段

### Phase 0：契约（2–3 天）

- 本文档评审
- `AgentAdapter` / `AgentEvent` 类型
- Bot runtime 字段
- 事件类型命名定稿

### Phase 1：DSH 回归（3–5 天）

- 抽出 `DshAdapter`
- 现有 room-agent 行为不变
- 验证聊天、图片、审批、取消、流式
- 加契约测试

### Phase 2：Native Relay PoC（3–5 天）

- 选一个外部 Runtime（建议 Grok Build ACP，协议最标准）
- 实现 join / bind / relay / audit
- 不做云端凭据
- 验证“已发送 ≠ 已读”

### Phase 3：Embedded 第二 Runtime（5–8 天）

- Grok Build ACP 或 Claude Code stream-json
- 独立 workdir
- 能力矩阵
- Roost MCP 工具网关

### Phase 4：多 Agent 房间（1–2 周）

- 多 Slot
- 发言规则 / mention
- 取消 / 超时 / 重试
- 用量/计费
- 故障注入
- 安全评审

总预估：**3–5 周**，取决于 Native 还是 Embedded 优先。

## 18. 验收标准

必须通过：

1. 同一房间：DSH Bot + 一个外部 Runtime Bot。
2. 两条消息都能正确归属作者。
3. 外部 Runtime 流式输出进入房间。
4. 外部 Runtime 工具调用能展示，权限请求能审批。
5. 取消一个 Turn 后不再有 delta。
6. runtime 重启后，不支持 resume 的会话不伪造成完成。
7. 重复投递不产生重复消息。
8. 镜像中没有任何长期密钥。
9. 一个 Agent 不能读另一个 workspace 的产物。
10. trace 能区分 queue / adapter / model / tool 耗时。

## 19. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| 厂商 ToS | Claude/Codex/Grok 的账号使用限制 | 逐个确认；优先 BYO / Native |
| 适配器维护 | 社区 ACP 适配器可能滞后 | 锁版本；contract tests；fallback CLI |
| 上下文成本 | 多 Agent 重复读房间历史 | 摘要 + token budget |
| 写冲突 | 多 Agent 同时改文件 | per-Bot workdir + shared 只读/锁 |
| 镜像膨胀 | 多个 CLI + 依赖 | 分层；生产 sidecar |
| 安全 | Agent 读取凭据 | secret provider；Native 优先 |
| 不可恢复 | CLI 无 session resume | 明确 `interrupted`，不假装成功 |

## 20. 开放问题

1. Native 模式是否进入 Roost 云端，还是只做桌面/LAN？
2. Embedded 模式的凭据是平台代管还是 BYO？
3. 平台工具用 MCP 还是每个 Adapter 单独桥？
4. Grok Build ACP 的版本兼容窗口有多长？
5. Claude Code / Codex 的 ACP 适配器是否值得维护，还是直接用官方 CLI JSON？
6. 多 Agent 房间默认是否允许 Bot 之间自动 relay，还是必须 mention？
7. 共享 workspace 的写入策略：锁、worktree、还是禁止并行？

## 21. 参考

- PairRoom：<https://github.com/sean2077/pairroom>（MIT，Runtime/Slot/Binding、Native/Embedded、relay/audit）
- JetBrains Agent Client Protocol：<https://github.com/jetbrains/agent-client-protocol>
- Codex ACP 适配器：<https://github.com/zed-industries/codex-acp>
- Claude Code ACP 社区适配器：<https://pypi.org/project/claude-code-acp/>
- 现有 Roost 设计：`docs/design/architecture-v2.md`、`rooms.md`、`messaging.md`、`agent-collaboration.md`、`sandboxing.md`、`events.md`
