# 本地 Computer 与 roostd

> 状态：方案（2026-11-09）。参考 OpenMeld / Multica 的 local service 模型，
> 结合 Roost 现有的 workspace / room / round / Native Relay。
>
> 目标不是把本地电脑变成第二个 home runtime，而是让本地电脑成为
> **一个已绑定 workspace 的执行节点**。

## 1. 一句话

用户在自己的电脑上安装 `roost` CLI：

```bash
brew install roost
roost setup
```

安装器注册这台电脑，启动常驻 `roostd`，并把它加入一个 Roost workspace。
之后可以把某个 Bot 绑定到这台电脑和一个本地项目目录；云端房间派任务，
本地执行，结果回到房间。

```text
Cloud Workspace / Room
        │
        │ dispatch job
        ▼
roostd（本地常驻，出站连接）
        │
        ├── 本机 Agent CLI
        ├── 本地项目目录
        └── 结果 / 流式输出
```

## 2. 与 Workspace 的关系

```text
Workspace = 逻辑身份 + 权威 home runtime + 房间 / Bot / 记忆
Computer  = 一个用户电脑上的执行节点
Binding   = Workspace + Computer + Bot + 本地目录 + Agent
```

硬规则：

1. 一个 workspace 仍然只有一个 home runtime。
2. Computer 不是 home，不拥有 workspace 卷。
3. 本地电脑上的项目目录是用户的本地数据，不是云端 workspace 卷的副本。
4. 云端 Agent 和本地 Agent 通过房间/轮次协作，不通过两份 home 写同一份状态。

## 3. 组件

### 云端

```text
ComputerService
  ├── 注册 / 心跳 / 能力上报
  ├── Computer token / 吊销
  └── 在线状态

BindingService
  ├── Bot ↔ Computer ↔ Workspace
  ├── 本地目录 / Agent kind
  └── 权限 / 审批策略

DispatchService
  ├── 房间轮次 → computer job
  ├── lease / 重试 / 取消
  └── 结果回写 + outbox

WorkspaceService
  └── 之前的 workspace / storage / runtime 抽象
```

### 本地

```text
roost CLI
  ├── setup / login / daemon install
  ├── computer register
  ├── workspace attach
  ├── bot bind
  └── mcp serve

roostd
  ├── 出站连接 / 心跳 / 自动重连
  ├── Agent 探测（claude / codex / grok / dsh）
  ├── Job 队列 / lease / 取消
  ├── Agent 进程管理（进程树、超时）
  ├── 流式事件 / 最终结果
  └── 本地日志与诊断
```

## 4. 数据模型

```sql
CREATE TABLE computers (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  name          TEXT NOT NULL,
  os            TEXT NOT NULL,
  arch          TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  version       TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL,          -- registered | connected | offline | revoked
  last_seen_at  INTEGER,
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);

CREATE TABLE computer_tokens (
  id            TEXT PRIMARY KEY,
  computer_id   TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);

CREATE TABLE computer_bindings (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  computer_id   TEXT NOT NULL,
  bot_id        TEXT NOT NULL,
  agent_kind    TEXT NOT NULL,          -- dsh | claude-code | codex | grok-build
  workdir       TEXT,                   -- 用户本地路径；不传给云端执行
  permission_json TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL,          -- active | paused | revoked
  created_at    INTEGER NOT NULL,
  UNIQUE (workspace_id, bot_id, computer_id)
);

CREATE TABLE computer_jobs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  room_id       TEXT NOT NULL,
  round_id      TEXT NOT NULL,
  slot_index    INTEGER NOT NULL,
  bot_id        TEXT NOT NULL,
  binding_id    TEXT NOT NULL,
  state         TEXT NOT NULL,          -- queued | claimed | running | done | failed | cancelled | expired
  lease_until   INTEGER,
  idem          TEXT NOT NULL UNIQUE,
  payload_json  TEXT NOT NULL,
  result_json   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
```

`computer_bindings.workdir` 只保存在本地 daemon；云端最多保存一个经过用户确认的展示名/摘要，不上传路径内容。

## 5. 身份与安全

### 5.1 用户登录

```text
roost setup
  → 浏览器 OAuth / device code
  → CLI 保存 refresh token（系统 keychain 或 0600 文件）
```

### 5.2 Computer token

- 与 user session、runtime token 分离
- 只允许：
  - 上报自身心跳
  - 拉取自己 computer 的 job
  - 回传自己的 job 事件/结果
- 可单独吊销
- 不包含 workspace home 的 runtime token
- 不向本地 Agent 暴露云端模型 key

### 5.3 权限

Binding 里有：

```json
{
  "agentKind": "claude-code",
  "allowNetwork": true,
  "allowShell": true,
  "approval": "ask",
  "workdirLabel": "project-a"
}
```

云端只能派任务，不能绕过本地 binding 的权限；本地 daemon 是最终执行者，按本地策略再次校验。

## 6. 连接协议

第一版不引入 WebSocket 依赖，使用 **HTTPS 出站长轮询 + SSE 可选**：

```text
GET  /api/computers/:id/jobs?wait=25
POST /api/computers/:id/jobs/:jobId/claim
POST /api/computers/:id/jobs/:jobId/events
POST /api/computers/:id/jobs/:jobId/result
POST /api/computers/:id/heartbeat
GET  /api/computers/:id/events        # SSE，可选
```

后续可在 Runtime Gateway 上加 WebSocket，但协议语义不变。

### 6.1 Job 生命周期

```text
queued
  → claimed（lease，心跳续租）
  → running
  → done | failed | cancelled

lease 过期 → queued（可重派）
```

- `idem` 保证同一轮不会重复执行
- 结果先写本地 outbox，再回传；网络失败可重试
- 取消：CP 写 cancelled，daemon 终止进程树
- 电脑离线：不自动换到云端，除非 binding 显式配置 `fallback: cloud`

## 7. 房间轮次怎么走

现有 `round-orchestrator` 继续负责“谁在什么时候发言”。

增加一种执行路由：

```text
slot
  ├── cloud runtime（现有）
  └── computer binding（新增）
```

流程：

```text
用户发消息
  → openRound
  → slot: bot X
  → 查到 X 绑定到 computer C
  → 写 computer_job(queued)
  → roostd 拉取
  → 启动本地 Agent
  → 流式 delta → CP
  → 最终结果 → advance
  → 房间消息 + round 完成
```

本地 Agent 不直接连 Runtime Gateway；它由 roostd 启动，`roostd` 负责和 CP 通信。

## 8. CLI

```bash
roost setup
roost login
roost daemon install
roost daemon start
roost daemon status
roost daemon logs

roost computer list
roost computer rename <id> "MacBook Pro"

roost workspace attach <workspace-id> --path ./project
roost bot bind <bot-id> --computer <id> --agent claude-code --path ./project

roost agent discover
roost job list
roost mcp serve --stdio
```

`roost setup` 应完成：

1. 下载/安装 CLI 与 daemon
2. 浏览器登录
3. 注册 computer
4. 安装 launchd / systemd / Windows Run 自启动（用户确认）
5. 打印 Web 端连接链接

## 9. Web UI

新增 **Computers** 页面：

```text
本机电脑
├── 在线状态
├── 已安装 Agent
├── 绑定列表
├── 最近任务
└── 断开 / 吊销
```

房间里的 Bot 显示“本地执行”标记；离线时显示不可用，而不是假装云端在跑。

## 10. 失败模式

| 场景 | 行为 |
|---|---|
| 电脑休眠/断网 | computer offline；job 不自动换云，按 binding 策略处理 |
| daemon 崩溃 | lease 过期，job 回到 queued；本地 outbox 恢复 |
| Agent 进程崩溃 | job failed，保留 transcript / 错误 |
| 同一 job 重复投递 | `idem` + 原子 claim，只执行一次 |
| 版本不兼容 | 拒绝 claim，提示升级 CLI/daemon |
| 用户吊销电脑 | token 吊销，binding 失效，进行中的 job 标记 cancelled |
| 本地目录被删除 | claim 前校验，失败不启动 Agent |

## 11. 分期

### P0

```text
roost CLI
computer 注册 / 心跳
binding CRUD
roostd + 长轮询
一个 Agent kind（先 Claude Code 或 DSH）
房间派发 / 结果回写
```

### P1

```text
流式 delta / 取消
多 Agent kind
lease / outbox / 重连
launchd / systemd 自启动
Web Computers 页面
```

### P2

```text
MCP stdio
多 binding / 并发 execution lane
本地文件选择上传
审批与权限细化
```

### P3

```text
WebSocket
远端 MCP
跨电脑迁移 binding
workspace storage 双向同步
```

## 12. 与 OpenMeld 的关系

采用它的产品结构：

```text
CLI + local service / daemon
+ connected computer
+ agent profile binding
+ outbound connection
+ cloud dispatch
+ result outbox
```

不复制它的代码：

- OpenMeld 是 TypeScript/Electron/Cloudflare/PostgreSQL
- Roost 是 Node 22 / SQLite / 零运行时依赖控制面
- 我们只需要这些概念，不需要它的实现

## 13. 开放问题

1. 本地 Agent 使用自己的模型订阅，还是走 Roost 模型代理？
2. 一个 Bot 绑定多台电脑时如何路由（当前建议：一个 active binding + 显式 fallback）。
3. 本地 Agent 能否看到云端 workspace 记忆/文件，还是只通过 MCP 工具按需访问？
4. 是否允许一个 computer 同时服务多个 workspace。
5. 本地路径是否需要在云端展示；建议只展示用户命名的 project label。

## 14. 验收

```text
1. 安装 roost CLI 后，Web 出现一台 Connected Computer
2. 绑定 Bot 到本机 + 目录
3. 房间发消息，Bot 在本地启动
4. 流式回复进入房间
5. 关掉 daemon，房间显示 offline，不产生假回复
6. 重启 daemon，未完成 job 恢复或明确失败
7. 吊销 computer，token 立即失效
```

## 15. P0 实现状态（2026-11-09）

已落地：

```text
migrations/0025_computer_nodes.sql
packages/store/src/computers.ts
apps/api/src/computers-routes.ts
apps/api/src/cli-token-routes.ts
apps/api/src/computer-jobs.ts
apps/cli/roost.mjs
apps/api/test/computers.test.ts
apps/cli/test/roost.test.ts
```

已实现：

- 注册 computer，返回一次性 computer token
- heartbeat
- `GET /api/computers/:id/jobs?wait=25` 长轮询
- claim / events（流式 delta）/ result
- workspace member 创建 / 列表 / 吊销 computer binding
- cloud room-agent assignments 过滤本地绑定的 Bot
- `roost` CLI：login / setup / computer list / bind / daemon start|stop|status|logs|run
- `roostd`：本地 Agent 进程、stdout delta、最终结果、失败结果
- Settings 页生成 CLI token，并展示已连接电脑
- 一个本地 Agent 默认命令：Claude Code；其它 Agent 可通过 `~/.roost/config.json` 的 `agentCommands` 配置

P0 边界：

- 还没有 OS 级安装包/自动更新
- 还没有 Web 端创建 binding 的表单（用 `roost bind`）
- 没有 autostart 注册命令（可手工加 launchd/systemd）
- 没有离线重试 UI；job lease 过期会回到 queued
- 本地流式 delta 是 stdout 分块；最终结果仍是权威消息
- 暂不支持云端 Agent 调用本地 MCP（P2）


## 16. P1 增量（2026-11-09）

本轮补上：

- `roost agent discover [--json]`：探测本机 claude/codex/grok/dsh
- `roost agent set <kind> --command "..."`：按 Agent 配置本地命令
- daemon heartbeat 上报版本和 Agent 能力
- `GET /api/computers` 对超过 90 秒没心跳的 connected 电脑返回 `offline`
- `roost daemon autostart enable|disable|status`：
  macOS launchd / Linux systemd user / Windows Startup
- daemon 停止时 abort 当前长轮询，不再等 20 秒
- Settings 页「已连接的电脑」显示在线状态和 binding

仍未做：

- Web 端创建 binding 的表单（需要解决“本地 workdir 不能上传”的交互）
- 安装包 / 自动更新
- 多本地 Agent 的并发 execution lane
