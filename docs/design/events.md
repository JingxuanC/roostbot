# 事件：一份日志，多个投影

> 状态：方案（2026-11-03）。本文是 `event-schema`、`scheduling`、`assignment`、`messaging` 三处事件定义的**统一上位**。

## 1. 为什么需要一份

之前有三套事件定义各自为政：

| 来源 | 事件 |
|---|---|
| `event-schema` | `user.message` / `bot.message` / `tool.call` / `approval.request` … 10 种 |
| `scheduling` | `enqueued` / `admitted` / `started` / `settled` / `missed` … |
| `assignment` | `enqueued` / `started` / `parked` / `answered` / `settled` … |

如果实现时变成三张表、三种订阅，就再也拼不出“一句话从进来到结束”的完整时间线。**定死：一个 workspace 只有一份追加式日志。**

## 2. 日志的物理形态

- 存储：workspace 卷里的 **SQLite**（`events` 表 + `seq` 自增），WAL 模式
- 写入者：**只有 home runtime**（控制面写自己的域事件，见 §6）
- 客户端**不写事件**，只发命令；命令被 runtime 接受后才产生事件
- 只追加，不修改；删除用 tombstone 事件

## 3. 事件信封

```jsonc
{
  "id": "ev_01H...",
  "seq": 4211,                       // workspace 内单调递增，唯一排序依据
  "at": "2026-11-03T12:00:00.123Z",  // 写入时刻
  "domain": "assignment",            // 见 §4
  "kind": "assignment.completed",    // domain.action
  "actor": { "kind": "bot", "id": "risk" },
  "subject": { "kind": "assignment", "id": "as_7f" },
  "audience": "room:r_quant",        // team | room:<id> | member:<id>
  "parent": 4210,                    // 回答哪条事件
  "idem": "as_7f:completed",         // 幂等键（同 key 只写一次）
  "trace": { "run": "run_9", "turn": "turn_3", "assignment": "as_7f" },
  "v": 1,
  "payload": { }                     // 域自定义，见 §5
}
```

**规则**

1. `seq` 是**唯一**排序依据，不用时间戳排序（时钟会漂）
2. `idem` 唯一约束；重复写入直接忽略并返回已有事件
3. `trace` 用来把一条链上的事件串起来（run → turn → assignment）
4. 大对象**不进 payload**：工具输出超过 8KB 写附件，payload 只留引用 + 摘要

## 4. 域（domain）与事件种类

| domain | 事件 | 谁写 |
|---|---|---|
| `chat` | `chat.message`（user/bot）、`chat.message.edited`、`chat.unread` | runtime |
| `turn` | `turn.started`、`turn.step`、`turn.completed`、`turn.failed`、`turn.interrupted` | runtime |
| `tool` | `tool.call`、`tool.result`、`tool.denied` | runtime / 沙箱 |
| `approval` | `approval.requested`、`approval.decided` | runtime |
| `assignment` | `assignment.enqueued`、`assignment.started`、`assignment.parked`、`assignment.answered`、`assignment.settled`、`assignment.cancelled` | runtime |
| `schedule` | `schedule.activation`、`schedule.run.started`、`schedule.run.settled`、`schedule.run.missed` | runtime（控制面触发时带 `actor: control-plane`） |
| `sandbox` | `sandbox.ready`、`sandbox.denied`、`sandbox.frozen`、`sandbox.stopped` | runtime |
| `memory` | `memory.written`、`memory.superseded`、`memory.deleted` | runtime |
| `workspace` | `workspace.created`、`workspace.started`、`workspace.stopped`、`workspace.migrated` | 控制面 |
| `auth` | `auth.paired`、`auth.session.revoked`、`auth.token.refreshed` | 控制面 |
| `billing` | `billing.usage`、`billing.reserve`、`billing.settle`、`billing.cap` | 控制面 |

**兼容映射**（旧定义 → 新定义）：

| 旧 | 新 |
|---|---|
| `user.message` / `bot.message` | `chat.message`（actor 区分） |
| `tool.call` / `tool.result` | 同名，归 `tool` 域 |
| `run.started` / `run.settled` | `schedule.run.started` / `schedule.run.settled` |
| `enqueued` / `admitted` / `parked` … | `assignment.*` |

## 5. 各域的 payload 要点

```jsonc
// chat.message
{ "role": "user|bot", "text": "…", "framing": "user|team-message|room", "attachments": [] }

// turn.completed
{ "usage": { "input": 8120, "output": 640, "cached": 2100 }, "durationMs": 42000 }

// tool.call / tool.result
{ "name": "get_a_realtime", "argsRef": "att_…", "ok": true, "summary": "600519 1580.0", "denied": false }

// assignment.settled
{ "outcome": "done", "evidence": { "commands": 12, "filesChanged": ["x.html"], "toolCalls": 34, "outward": [] } }

// schedule.run.settled
{ "routine": "daily-premarket", "scheduledFor": "…", "outcome": "done" }

// sandbox.denied
{ "kind": "network", "binary": "/usr/bin/curl", "host": "example.com", "method": "GET" }
```

## 6. 控制面与 runtime 的边界

| 事件 | 写在哪 | 为什么 |
|---|---|---|
| chat / turn / tool / assignment / sandbox / memory | workspace 卷 | 属于这个 workspace 的事实 |
| workspace / auth / billing | 控制面 DB + **转发一份到卷**（只读） | 控制面是权威，但 workspace 要能离线看到自己的状态 |

跨工作区的 assignment：**两侧各写一条**（发起方 `assignment.enqueued`，目标方 `assignment.started`），用同一个 `id` 关联；控制面做索引。

## 7. 投影（读模型）

| 读模型 | 从哪些事件派生 | 用途 |
|---|---|---|
| 时间线 | 全部（按 seq） | 面板、审计、回放 |
| Run 状态 | `schedule.*` + `turn.*` | `scheduling.md` 的状态机 |
| Assignment 状态 | `assignment.*` | `agent-collaboration.md` 的状态机 |
| 用量 | `turn.completed` + `billing.usage` | 计量、配额 |
| 未读与在线 | `chat.unread` + `auth.session.*` | 多端 UI |
| 沙箱拒绝 | `sandbox.denied` | 安全面板与策略调优 |

**投影是可重建的**：删掉投影表不影响事实；反过来不行。

## 8. 保留与压缩

| 项 | 策略 |
|---|---|
| 事件本体 | 永久保留（可配置：默认 365 天，按租户） |
| 大 payload | 外置附件；事件只留引用 |
| 快照 | 每 N 条（默认 10,000）打一次状态快照，加速重放 |
| 删除 | 写 `*.deleted` tombstone，不物理删除；账号删除时整卷销毁 |

## 9. 版本与迁移

- 信封版本 `v`；payload 各自版本
- 升级规则：**只加字段，不改语义**；语义变更必须新增 kind
- 读端用 upcaster（把旧 payload 升级成新形状），不做批量重写
- 迁移前打卷快照（`workspace.md` §7）

## 10. 与三份设计文档的接口

| 文档 | 用事件做什么 |
|---|---|
| `messaging.md` | 消息 = `chat.message`；投递状态由 `chat.message.delivered/read` 派生 |
| `agent-collaboration.md` | assignment 的 9 状态 = `assignment.*` 投影 |
| `scheduling.md` | Run 的 7 状态 = `schedule.run.*` 投影 |
| `sandboxing.md` | 拒绝原因进 `sandbox.denied`，再注入上下文 |
| `loop-and-context.md` | `ContextManifest` 与 `turn.started` 的 trace 对齐 |

## 11. 待决问题

1. **全局 `seq` 还是每流 `seq`**？全局简单但要单写者；每流要额外合并规则。
2. **控制面事件转发到卷**是实时还是批量？实时多一次往返，批量会延迟离线可见性。
3. **附件生命周期**：事件引用附件后，附件能否被 GC？（需要引用计数或保留期）
4. **审计保留期**与租户配额的关系：默认 365 天是否够，金融场景是否要更长。
