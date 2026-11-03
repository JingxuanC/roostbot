# 协作：Assignment 状态机

> 状态：方案（2026-11-03）。配套：`loop-and-context.md`（注入）、`messaging.md`（投递）、`scheduling.md`（启动）。

## 1. 为什么需要它

消息只是载体（`messaging.md` §1）。一旦 A 让 B 干活，就会冒出**消息表达不了的问题**：

- B 接了吗？在做吗？做完了吗？
- B 卡住了要问人，问谁？
- B 做到一半容器崩了，重来还是续做？
- A 等 B 的时候，又来了一个请求，算同一件事还是新的？
- 这个任务链已经传了几层，会不会绕圈？

这五个问题就是 **Assignment** 要回答的。它和 `scheduling.md` 的 **Run** 不是一回事：

| 概念 | 是什么 | 谁产生 |
|---|---|---|
| **Run** | 一次激活（定时/事件/修复）触发的执行 | 调度器 |
| **Assignment** | 一个 Bot 委托给另一个 Bot 的工作单元 | Bot 自己（工具调用） |

一个 Assignment 的执行会**产生 Run**；一个 Run 也可能**发起多个 Assignment**。

## 2. 核心记录

```jsonc
{
  "id": "as_01H...",
  "rootId": "as_01H...",          // 整棵树的最初节点；预算按它算
  "parentId": "as_00F...",        // 谁派的；根节点没有
  "depth": 2,                     // 距离 root 的边数
  "mode": "work",                 // work | consult | notify
  "requester": { "kind": "bot", "botId": "selector", "threadId": "t_9" },
  "assignee":  { "botId": "risk", "threadId": "r_quant/risk" },
  "status": "running",
  "outcome": null,
  "brief": "复核这 5 个候选的流动性风险",   // ≤ 12,000 字符
  "doneWhen": "给出每只的流动性结论与反例",
  "budget": { "tokens": 20000, "wallMs": 600000, "toolCalls": 40 },
  "reply": "resume",              // resume | poll | none
  "level": "ask",                 // 继承的审批级别（见 workspace/权限）
  "executions": 1,
  "restarts": 0,
  "carrying": [],                 // 正在替父节点携带的提问
  "question": null,               // needs_input 时的问题
  "answer": null,
  "evidence": null,               // 由 harness 观测，不信模型自述
  "createdAt": "…", "startedAt": "…", "lastActivityAt": "…", "finishedAt": null
}
```

## 3. 状态机

```
queued ──admit──► running ──turn ends──┬─► waiting（派了子任务，等它们）
   │                  │                ├─► needs_input（有问题要人/发起者答）
   │                  │                ├─► completed
   │                  │                ├─► failed
   │                  │                └─► cancelled（人停止 / 预算耗尽 / 环）
   │                  │
   └─ refused（校验拒绝）  └─ interrupted（宿主重启打断，可 resume 或 rerun）
                                │
                                └── answer/resume ──► running（executions+1）
```

| 状态 | 含义 | 谁推进 |
|---|---|---|
| `queued` | 已接受，未开始 | 调度/执行器 |
| `running` | 一个回合正在执行 | 目标 Bot |
| `waiting` | 自身回合结束，等它派出去的子任务 | 子任务结算 |
| `needs_input` | 停车等人或等发起者回答 | 人或发起者 |
| `completed` / `failed` / `cancelled` / `refused` / `interrupted` | 终态或可恢复态 | — |

**与 OMB 的差异**：我们把 `interrupted` 显式建模（OMB 用 restart 标记），因为云上容器重启是常态。

## 4. Outcome 枚举（终态必须带原因）

```
done | needs_input | budget | stalled | interrupted | provider_error
denied | expired | stopped | missed | refused | duplicate | cancelled
```

调用方可以按 outcome 分支：`budget` 要缩范围，`denied` 要请求人授权，`stalled` 要换方法。

## 5. 三种模式

| mode | 语义 | 副作用 | 典型场景 |
|---|---|---|---|
| `work` | 真的干活（可用工具） | 允许 | 委托复核、跑回测 |
| `consult` | 只回答，不采取行动 | 禁止写操作 | 问另一个 Bot 的专业判断 |
| `notify` | 单向告知 | 无 | “我改了这个文件，别再动它” |

`consult` 在实现上就是**注入时明确写“act on nothing”**（OMB 的做法），并在工具层禁写——不能只靠提示词。

## 6. 层级与预算（防爆）

| 约束 | 建议值 | 理由 |
|---|---|---|
| 最大深度 | **2**（Bot → Bot；再深就必须走房间讨论） | DSH 默认 depth 1，OMB 允许 4；我们取 2，因为云上每一层都是一次完整上下文重建 |
| 每 root 请求数 | **64** | OMB 实测值 |
| 每 root 执行数 | **96** | 同上 |
| 单 brief | **12,000 字符** | OMB |
| 单 assignment 预算 | tokens / wallMs / toolCalls 三项都要能设 | 一维预算会被绕过 |
| 租约 | **10 分钟**无进展 → `stalled` | 容器崩溃后必须能回收 |

**禁止**：把任务派回祖先（`ancestor` 检查），否则直接成环。

## 7. 问题与回答（needs_input）

```
B 卡住 → status=needs_input, question="这个口径用 TTM 还是最近一期？"
        ├─ 发起者是 Bot 且 reply=resume → 问题上浮到 A 的下一轮（carrying）
        ├─ 发起者是人 → 卡片
        └─ 无人回答超时 → expired（不是 failed）
```

规则：

1. **停车不挂进程**：`needs_input` 是持久状态，重启后仍在。
2. **回答带出处**：`answeredBy: {kind:'bot'|'person', id}`，因为“谁拍的板”要能审计。
3. **Full access 下的代答**：允许发起者代替人回答，但必须记录 `decide.default`，且仅限于授权范围内的问题。

## 8. 证据（Evidence）

报告必须带**harness 观测**，不是模型自述：

```jsonc
"evidence": {
  "commands": 12,
  "filesChanged": ["reports/a.html"],
  "toolCalls": 34, "okToolCalls": 33,
  "errors": ["…"],
  "outward": ["git push", "GMAIL_SEND_EMAIL"]
}
```

理由：模型说“我做完了”与“系统看到它做完了”是两件事；跨 Bot 协作里，后者才能用于审计与计费。

## 9. 重启与恢复

| 场景 | 处理 |
|---|---|
| 回合被重启切断 | `interrupted`；恢复时二选一：`rerun`（重跑该回合）或 `cut`（已派活，等子任务） |
| 子任务全结算但父没醒 | `resume`：父欠一个后续回合 |
| 消息投递失败 | 进 effect 队列重试；耗尽 → `failed(delivery_failed)` |
| 目标 Bot 被删 | 等待中的发起者收到 `cancelled(target_deleted)` |

**恢复顺序**：按 `rootId` 分树、`lastActivityAt` 升序，避免同时唤醒整棵树。

## 10. 跨工作区

Assignment 可以跨 workspace（用户 A 的工作区委托用户 B 的工作区），规则：

1. **记录在控制面**（不在任一侧的卷里），这样两边都能查
2. **执行在目标工作区**，由它产生 Run
3. **幂等键**：assignment id；重试不会产生两个
4. **权限**：目标工作区可以拒绝（`refused: policy`），并在自己的面板看得见这条外来的委托
5. **数据边界**：只交换 brief + report + evidence；不传文件内容，需要时走附件引用

## 11. 数据模型（控制面 / 卷内均可，跨区时用控制面）

```sql
CREATE TABLE assignments (
  id              TEXT PRIMARY KEY,
  root_id         TEXT NOT NULL,
  parent_id       TEXT,
  depth           INTEGER NOT NULL,
  mode            TEXT NOT NULL,            -- work|consult|notify
  requester_bot   TEXT NOT NULL,
  requester_thread TEXT,
  assignee_bot    TEXT NOT NULL,
  assignee_thread TEXT NOT NULL,
  status          TEXT NOT NULL,
  outcome         TEXT,
  brief           TEXT NOT NULL,
  done_when       TEXT,
  budget          TEXT NOT NULL,
  reply           TEXT NOT NULL,            -- resume|poll|none
  level           TEXT NOT NULL,
  question        TEXT,
  answer          TEXT,
  answered_by     TEXT,
  executions      INTEGER NOT NULL DEFAULT 0,
  restarts        INTEGER NOT NULL DEFAULT 0,
  last_activity   INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  finished_at     INTEGER,
  evidence        TEXT
);

CREATE TABLE assignment_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id TEXT NOT NULL,
  at            INTEGER NOT NULL,
  kind          TEXT NOT NULL,   -- enqueued|admitted|started|progress|parked|answered|waiting|resume_due|settled|reported|cancelled|budget|stalled
  detail        TEXT
);

CREATE TABLE inbox (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id TEXT NOT NULL,
  to_thread     TEXT NOT NULL,
  kind          TEXT NOT NULL,   -- request|report|needs_input
  delivered_at  INTEGER,
  read_at       INTEGER,
  UNIQUE (assignment_id, kind)
);
```

## 12. 接口（工具层）

| 工具 | 谁用 | 说明 |
|---|---|---|
| `delegate(bot, brief, {mode, doneWhen, budget, reply})` | 任何 Bot | 创建 assignment |
| `consult(bot, question)` | 任何 Bot | `mode=consult` 的快捷方式 |
| `notify(bot, text)` | 任何 Bot | `mode=notify` |
| `answer(assignment, text)` | 发起者 / 人 | 回答 needs_input |
| `status(assignment)` | 发起者 | 查状态（不阻塞） |
| `cancel(assignment, reason)` | 发起者 / Lead / 人 | 终止 |
| `list_assignments({status})` | 面板 / 审计 | 视图 |

**没有 `wait(assignment)`**：等待一律走事件流，不阻塞调用方（`messaging.md` 的 `wait_agent` 只报超时就是这个道理）。

## 13. 观测

| 指标 | 用途 |
|---|---|
| 每 root 的请求/执行数 | 判断预算是否太紧或太松 |
| `stalled` 比例 | 工具或模型质量问题 |
| `needs_input` 平均等待时长 | 人机协作的瓶颈 |
| 深度分布 | 判断是否该改用房间讨论 |
| `consult` vs `work` 比例 | 判断协作是否过重 |

## 14. 分期

### v0（本机）
- Bot 之间用 `message_bot` 直发，**不上 assignment**（够用、可观察）
- 记录每条消息的 exchangeId，事后分析“如果上状态机会解决什么”

### v1（单机 assignment）
- 引入 assignment 表 + 状态机 + evidence；`delegate/answer/status/cancel`
- **验收**：B 卡住问人 → 人答 → B 继续；容器重启后 `interrupted` 可续；深度超 2 被拒

### v2（跨工作区）
- assignment 上控制面，跨 workspace 转发与幂等
- **验收**：同 id 重试不产生第二条；目标拒绝时发起方拿到 `refused: policy` 且可审计

## 15. 待决问题

1. **深度到底 2 还是 3**？（2 更省上下文，3 更像真实组织）
2. **`consult` 的写操作要不要硬禁**（工具层）还是靠提示词？
3. **跨工作区的 assignment 归属**：发起方视角可见全部，还是只可见摘要？
4. **`interrupted` 默认重跑还是默认续**？
