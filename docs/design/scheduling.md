# 调度：Bot 怎么被定时激活

> 状态：方案（2026-11-03）。落地顺序见 §12。本文只定语义与接口，不含实现。

## 1. 目标

一个 Bot 在什么情况下会开始一个回合？目前能想到的有三种，方案要把它们收敛成**一个原语**：

| 来源 | 例子 |
|---|---|
| **clock**（时间） | 每天 9:00 让数据官做盘前检查 |
| **event**（事件） | 新 Issue、公告、IM 消息、CI 失败 |
| **repair**（修复） | watchdog 发现运行时没在跑 |
| （manual） | 人在界面上点一下 |

**不目标**：不在工作区容器里做权威计时；不让定时任务往房间发用户消息（会触发其他 Bot）；不做跨租户的全局 cron 服务。

## 2. 统一原语：Activation

```jsonc
{
  "id": "act_01H...",
  "kind": "clock",                  // clock | event | repair | manual
  "source": "routine:daily-premarket",
  "target": { "workspace": "ws_123", "bot": "data-officer", "room": null },
  "idem": "routine:daily-premarket@2026-11-04T01:00:00Z",   // 幂等键，见 §7
  "scheduledFor": "2026-11-04T01:00:00Z",
  "payload": { "brief": "做盘前检查…", "inputs": [] },
  "budget": { "tokens": 40000, "wallMs": 300000, "toolCalls": 40 },
  "doneWhen": "产出一份盘前摘要，含数据源状态与异动清单",
  "createdAt": "2026-11-04T00:59:58Z"
}
```

Activation 只描述**“要开始一件事”**，不描述怎么跑。怎么跑由 Run（§5）负责。

## 3. 分层职责

```
                    ┌─────────────────────────────┐
  clock/event/repair│ 控制面 control plane         │  ← 权威时钟、配额、唤醒、看门狗
                    │ · workspace_schedules        │
                    │ · 提前 1–3 min 唤醒容器        │
                    │ · 跨工作区视图与计费           │
                    └──────────────┬──────────────┘
                                   │ POST /internal/activate（带 runtime token）
                                   ▼
                    ┌─────────────────────────────┐
                    │ workspace 容器               │
                    │ · tick 每 2s：处理到期 effect │  ← 只负责「due → run」
                    │ · effect 队列（持久、可重试）  │
                    │ · missed 判定与收据           │
                    │ · GET /internal/power         │  ← nextDueAt / busy / 可睡否
                    └──────────────┬──────────────┘
                                   │ 起回合
                                   ▼
                    ┌─────────────────────────────┐
                    │ Bot routine（可选）           │
                    │ · checks：纯代码，先判要不要花 │
                    │ · 有事项 → 才起 AI run        │
                    └─────────────────────────────┘
```

**不可让步**：watchdog 与控制面**不能**住在工作区容器里（容器挂了就一起挂）。superagent 的做法是把每小时检查放在**操作者自己的 profile**，这条要照抄。

## 4. 时间语义

- 对外只暴露 **cron（5 段）+ IANA 时区**，不暴露偏移量。
- 内部不用“到点执行”，而用 **tick 扫描**：每 2 秒看 `nextRunAt <= now` 的 routine，把它变成 Run。理由：重启后从持久状态恢复，不会因为错过 tick 丢任务。
- `nextRunAt` **必须持久化**；进程启动时重算一次（防止时区/夏令时变更）。
- **夏令时**：跳过的本地时刻跳过；重复的本地时刻只跑一次（按第一次算）。
- `cron` 之外还要支持三种简化形态：`daily(time, tz)`、`weekly(days, time, tz)`、`every(seconds)`。DSH 内置 schedule 已是这套，保持一致。

## 5. Run 生命周期

```
queued ──admit──► running ──turn ends──► waiting（派了子任务）
   │                 │                      │
   │                 ├─ needs_input ────────┤（等人）
   │                 ├─ completed            │
   │                 ├─ failed               │
   │                 ├─ missed（错过窗口）    │
   │                 └─ expired（等人超时）   │
   └── skipped（重叠且策略=skip，留收据）
```

**outcome 枚举**（可分支，值来自 OMB 的成熟设计）：

```
done | needs_input | budget | stalled | interrupted | provider_error
denied | expired | stopped | missed | refused | duplicate
```

一条 Run 至少记录：`routineId`、`scheduledFor`、`status`、`outcome`、`executions`、`restarts`、`lastActivityAt`、`finishedAt`、`result`、`evidence`（harness 观测：命令数/改文件/工具调用/对外动作）。

## 6. 常量表（数字全部有出处）

| 常量 | 值 | 来源 |
|---|---|---|
| 容器 tick | **2 秒**（处理 effect）/ **10 秒**（扫 routine） | superagent `passes.ts:40`；OMB `routines.ts:945` |
| 错过追赶窗口 | **12 小时**，更晚记 `missed` | OMB `routines.ts:274` |
| 启动静默 | **2 分钟**内不跑 checks | OMB `routine-check-pacing.ts:7` |
| checks 每日 AI 上限 | **24 次/24h** | OMB `:9` |
| 失败退避 | **15 分钟起，翻倍，上限 4 小时**，±20% 抖动 | OMB `:11-12,38` |
| launch effect 重试 | **5s 起翻倍到 300s，3 次** | superagent `docs/007:175` |
| 失败回合续跑 | **15s / 30s / 60s**，共 3 次 | superagent `docs/007:205` |
| 工作区提前唤醒 | **1 分钟**（suspend）/ **3 分钟**（stopped） | OMB `cloud-pro.md:1572` |
| 禁睡窗口 | `nextDueAt` 在 **5 分钟内**不允许睡 | OMB 同上 |
| 单回合无进展超时 | **5 分钟**默认，可配 1–1440 | OMB `config.ts:40` |
| 忙等上限 | **10 分钟**（OMB 用 30，云端成本太高） | 本地决策 |

## 7. 幂等与并发

- **幂等键**：`(routineId, scheduledFor)` 唯一。控制面重试、容器崩溃重启、双计时器都不会跑两次。
- **双触发保护**：只有控制面“决定”触发；容器只“执行”。容器自己的 tick 只处理**本地已知且未被控制面覆盖**的 routine（例如人手动建的、或在容器内 created 的）。
- **重叠策略**：`queue`（默认，等上一轮结束）或 `skip`（丢弃并留一条 `missed` 收据给 owner）。绝不并发跑同一 routine。
- **effect 队列**：与 superagent 相同——先落库再执行，按 kind 分别重试与健康检查；同类失败阻塞后续同类。

## 8. 错过、追赶、停止

- 迟于 `scheduledFor` **≤12h**：补跑一次，`scheduledFor` 记为原定时间（不改成现在）。
- **>12h**：记 `missed`，`error` 写“机器离线超过 12 小时”，并通知 owner。
- **一次性任务**（`runsOnce`）：过期永不补。
- **checks 型 routine 永不“错过”**：晚到的 check 一次读完全部积压，只起一个 run。
- **人工停止**：`stopped` 是终态，watchdog **不得**自动拉起（superagent 的 `--respect-stop`）。再次定时**不**自动恢复，需人确认或显式 resume。

## 9. 睡眠与唤醒握手

云上容器会睡，所以容器必须能回答“我还该醒多久”：

```http
GET /internal/power      （控制面签名调用）
200 {
  "v": 1,
  "busy": ["run", "recent-activity"],
  "nextDueAt": 1792358600000,
  "idleMinutes": 10,
  "canSleep": false,
  "reason": "due-soon"
}
```

`busy` 固定编码：`run`、`live-call`、`maintenance`、`recent-activity`、`recent-work`、`just-woke`、`due-soon`。

**规则**

1. 控制面在 `nextDueAt - 1min`（stopped 的 `-3min`）唤醒容器。
2. `nextDueAt` 在 5 分钟内，或 `busy` 非空，或最近 10 分钟有人用过 → 不许睡。
3. 容器永不自己停；只有控制面能停。
4. 唤醒后第一条激活带 `idem`，容器若已有同键 Run 则直接返回它（防重复）。

## 10. 数据模型（控制面）

```sql
CREATE TABLE workspace_schedules (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  routine_id    TEXT NOT NULL,           -- Bot 侧的 routine 标识
  bot_id        TEXT NOT NULL,
  cron          TEXT NOT NULL,
  timezone      TEXT NOT NULL,           -- IANA
  enabled       INTEGER NOT NULL DEFAULT 1,
  catch_up_ms   INTEGER NOT NULL DEFAULT 43200000,
  overlap       TEXT NOT NULL DEFAULT 'queue',   -- queue | skip
  next_run_at   INTEGER NOT NULL,
  last_run_at   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (workspace_id, routine_id)
);

CREATE TABLE activations (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,           -- clock | event | repair | manual
  source        TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  bot_id        TEXT NOT NULL,
  room_id       TEXT,
  idem          TEXT NOT NULL,
  scheduled_for INTEGER,
  payload       TEXT NOT NULL,
  budget        TEXT NOT NULL,
  done_when     TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE (idem)                          -- 幂等的唯一来源
);

CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  activation_id TEXT NOT NULL REFERENCES activations(id),
  status        TEXT NOT NULL,           -- queued | running | waiting | completed | failed | missed | skipped
  outcome       TEXT,
  executions    INTEGER NOT NULL DEFAULT 0,
  restarts      INTEGER NOT NULL DEFAULT 0,
  last_activity INTEGER NOT NULL,
  started_at    INTEGER,
  finished_at   INTEGER,
  result        TEXT,
  evidence      TEXT
);

CREATE TABLE run_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   TEXT NOT NULL,
  at       INTEGER NOT NULL,
  kind     TEXT NOT NULL,                -- enqueued|admitted|started|progress|parked|answered|settled|missed
  detail   TEXT
);
```

## 11. 容器 ↔ 控制面接口

| 方法 | 路径 | 谁调 | 说明 |
|---|---|---|---|
| POST | `/internal/activate` | 控制面 | 注入一个 Activation（带 runtime token + idem） |
| GET | `/internal/runs/:id` | 控制面 | 状态与结果 |
| POST | `/internal/runs/:id/stop` | 控制面 | 人工停止（写 `stopped`，watchdog 不再拉起） |
| GET | `/internal/power` | 控制面 | 就绪/忙碌/nextDueAt/可睡否 |
| POST | `/internal/drain` | 控制面 | 优雅停机（拒绝新 Run，等进行中的结束） |

全部走 runtime token；浏览器永远拿不到这些路径。

## 12. 分期与验收

### v0（本周）— 用 DSH 内置 schedule 验证语义

- 用 DSH 的 `daily` 建一个真实任务：每天 9:00 让「数据官」做盘前检查
- **验收**：到点 Bot 真的开始回合；房间不被搅动；连续 2–3 天不重复触发
- 产出：一份实测记录（延迟、是否重复、是否打扰房间）

### v1（下一阶段）— routine + checks

- 引入 `routine`：cron + checks（纯代码）+ 每日上限 + 退避
- **验收**：安静 tick 不产生模型调用（用量表可证）；有事时只起一次 run；失败 3 次后进入退避

### v2（云上）— 控制面权威时钟 + 睡眠握手

- 控制面持 `workspace_schedules`，容器提供 `/internal/power`，实现提前唤醒与禁睡窗口
- **验收**：
  1. 容器睡着时，到点前 1 分钟被唤醒并成功触发
  2. 双触发测试：控制面重发同一 `idem`，只产生一个 Run
  3. `nextDueAt` 5 分钟内，控制面拒绝睡眠请求
  4. 人工 `stop` 后，watchdog 不拉起

## 13. 待决问题

1. **event 源的第一批**：GitHub（superagent 已验证 60s 轮询可行）还是公告/IM？
2. **routine 的产物落在哪**：Bot 自己的 thread（推荐）还是房间？
3. **配额单位**：按“每日 Run 数”还是“每日 token”？建议两者都记，限流用 Run 数。
4. **routine 跨工作区复制**：模板化（控制面存模板，实例落各工作区）还是各建各的？

## 附：与既有系统的对照

| 能力 | DSH 内置 schedule | OMB routine | dsh-superagent | 本方案 |
|---|---|---|---|---|
| 时间触发 | ✅ cron/daily/weekly/every | ✅ cron/interval | ❌（靠轮询） | ✅ 控制面 cron |
| 先检查再花钱 | ❌ | ✅ checks | ✅ 程序层 fast path | ✅ checks |
| 错过追赶 | ❌ | ✅ 12h | ✅ effect 重放 | ✅ 12h |
| 持久 effect 队列 | ❌ | 部分 | ✅ | ✅ |
| 睡眠唤醒 | ❌ | ✅ 云端握手 | ❌ | ✅ |
| 人工停止尊重 | 部分 | ✅ | ✅ `--respect-stop` | ✅ |
| 失败退避 | ❌ | ✅ | ✅ | ✅ |
