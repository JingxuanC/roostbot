# 预算：先预留，再结算

> 状态：方案（2026-11-03）。统一 `scheduling.md`（Run 数）、`assignment.md`（每树 64/96）、`loop-and-context.md`（token）、`sandboxing.md`（策略）四处的预算口径。

## 1. 一句话

**预算是分层的：租户 → 工作区 → 回合（Run/Assignment）→ 单次模型调用。** 每一层只扣自己的账，子层失败不能突破父层上限。**准入时预留，结束时结算**——这是 Google ACE 那个缺陷给我们的教训。

## 2. 五个计量单位

| 单位 | 谁扣 | 来源 |
|---|---|---|
| **容器秒** | 控制面 | runtime 心跳/启停事件 |
| **模型 token**（in/out/cached） | 模型代理 | 每次调用的响应 usage |
| **工具调用数** | runtime | `tool.call` 事件 |
| **存储 GB·天** | 控制面 | 卷大小采样 |
| **消息数** | runtime | `chat.message` 事件（防刷屏） |

**不按"请求数"单独计费**：ACE 的文档说得很清楚——单个模型调用差异巨大，请求数无法反映成本。

## 3. 分层与归属

```
tenant（计费主体）
 └─ workspace（配额边界）
     └─ run / assignment（执行预算）
         └─ turn（单次模型调用预算）
```

| 层 | 管什么 | 超了怎么办 |
|---|---|---|
| tenant | 月总额、席位、存储上限 | 新工作返回 429；进行中的不打断 |
| workspace | 每日 token / Run 数 / 容器秒 | 同上 |
| run/assignment | 单次 token / wall / 工具调用数 | 该 Run 标 `budget`，不杀整个 workspace |
| turn | 单次调用上限（输入窗口 + 输出上限） | 模型代理拒绝或截断输出 |

## 4. 预留-结算（核心机制）

```
① 准入：要起一个 Run
     ↓ 估算：tokens ≈ f(模型, 上下文大小) → 预留
     ↓ 预算不足 → 拒绝（429），不预留
② 执行：每次模型调用从预留里扣
     ↓ 接近耗尽 → 触发软停（提示模型收尾）
③ 结算：实际用量 vs 预留
     ↓ 差额退回池子（可能为负，负的也记，防作弊）
```

**为什么必须预留**：ACE 的 token 预算在响应完成后才计输出 token，并发请求可能一起越过上限。预留把"越过"变成"排队"。

**多层同时预留**：一次准入同时检查 workspace / run / turn 中已配置的配额，每层各自 `reserved`；全部通过才放行，任一不足则整次回滚（不存在"外层失败、内层已扣"）。

预估函数（先粗后细）：

```
reserve = min(turnCap, inputEstimate + outputCap)
inputEstimate = manifest.totals.input（我们本来就算得出来，见 packages/context）
outputCap     = 按模型配置（默认 4k）
```

## 5. 超限行为（必须统一）

| 情形 | 行为 |
|---|---|
| tenant 月额度耗尽 | 新 Run 一律 429 `quota_exhausted`；进行中的跑完 |
| workspace 日额度耗尽 | 同上，次日 0 点（工作区时区）重置 |
| 单 Run 预算耗尽 | Run 标 `outcome=budget`，返回部分结果 |
| 单 turn 超输出上限 | 截断并在事件里记 `truncated: true` |
| 存储超限 | 拒绝新附件；提示清理 |
| 并发预留冲突 | 预留失败方等待或 429，**不静默降级** |

**软限与硬限**：80% 发提醒（事件 + 通知），100% 硬拦截。

## 6. 谁在哪里扣账

| 扣账点 | 依据 | 写什么事件 |
|---|---|---|
| 控制面准入 | tenant/workspace 配额 | `billing.reserve` |
| 模型代理 | 每次响应 usage | `billing.usage`（turn 维度） |
| runtime | 回合结束 | `turn.completed(usage)` |
| 控制面结算 | 预留 − 实际 | `billing.settle` |
| 控制面采样 | 卷大小、容器秒 | `billing.usage`（日聚合） |

**幂等**：`billing.usage` 必须带 `turnId`，重放不重复计费。

## 7. BYO token 下的两种账

| 账 | 谁看 | 用途 |
|---|---|---|
| **成本账**（实际花的钱） | 用户 | 透明：这个月用了多少、哪一段贵 |
| **配额账**（平台限流） | 平台 | 防滥用：Run 数、容器秒、存储 |

BYO 下平台不转售推理，所以**计费 = 容器秒 + 席位 + 存储**；token 只记账（用户自己承担）。

对平台自己提供的试用额度（若有）：单独一张 `credit` 表，按 token 扣，用完即止。

## 8. 默认配额

| 项 | 免费/试用 | 个人 | 团队 |
|---|---|---|---|
| workspace 数 | 1 | 3 | 10 |
| 同时运行容器 | 1 | 1 | 3 |
| 每日 Run 数 | 20 | 200 | 1000 |
| 每日 token（记账） | 200k | 2M | 10M |
| 存储 | 1 GB | 10 GB | 100 GB |
| 单 Run 预算上限 | 100k tokens | 500k | 1M |

数字先给默认值，等真实数据再调（`scheduling.md` 的实测会给出依据）。

## 9. 观测

| 指标 | 用途 |
|---|---|
| 预留 vs 实际 的偏差 | 预估函数是否离谱 |
| 429 比例（按原因） | 配额是否太紧 |
| 每 Run 的 token 构成 | 找出哪一段在涨（接 `ContextManifest`） |
| 缓存命中率 | 直接对应成本 |
| 单 workspace 日成本曲线 | 异常检测 |

## 10. 数据模型（控制面）

```sql
CREATE TABLE quotas (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL,           -- tenant | workspace | run | turn
  scope_id     TEXT NOT NULL,           -- run 层=runId，turn 层=turnId
  period       TEXT NOT NULL,           -- day | month
  metric       TEXT NOT NULL,           -- tokens|runs|container_seconds|storage_bytes|messages
  limit_value  INTEGER NOT NULL,
  used_value   INTEGER NOT NULL DEFAULT 0,
  reserved     INTEGER NOT NULL DEFAULT 0,
  resets_at    INTEGER,
  UNIQUE (scope, scope_id, period, metric)
);

CREATE TABLE reservations (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  metric       TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  settled_at   INTEGER,
  actual       INTEGER
);

CREATE TABLE usage_rows (
  id           TEXT PRIMARY KEY,
  at           INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  run_id       TEXT,
  turn_id      TEXT,
  bot_id       TEXT,
  model        TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER,
  tool_calls   INTEGER,
  cost_usd     REAL,
  container_seconds REAL,             -- 实现补充：容器秒，聚合求和
  storage_bytes     INTEGER,          -- 实现补充：卷大小采样，聚合取最大值
  source       TEXT                    -- provider_report | estimated
);
```

**存储口径**：`storage_bytes` 是 gauge（容量不是累计消费），`sumUsage` / `usageDaily` 一律取窗口内**最大值**，不求和；`container_seconds` 是累计量，按行**求和**。

## 11. 与其它文档的接口

| 文档 | 关系 |
|---|---|
| `scheduling.md` | "每日 Run 数" 是 `quotas` 的一条 metric |
| `agent-collaboration.md` | "每 root 64/96" 是**单棵树**的执行预算，与 `quotas` 正交（一个限总量，一个限爆炸半径） |
| `loop-and-context.md` | `ContextManifest.totals` 是 token 预留的输入 |
| `sandboxing.md` | 容器秒与工具调用数由沙箱统计 |
| `events.md` | 所有扣账动作都是 `billing.*` 事件 |

## 12. 待决问题

1. **重置时区**：按租户时区还是 UTC？（倾向：工作区时区，用户在白天不会遇到"刚重置就耗尽"）
2. **预留失败**：等待（排队）还是立刻 429？（倾向：交互式 429，后台任务排队）
3. **成本账的展示粒度**：按 Run、按 Bot、按房间——三者都要，默认按 Run。
4. **未结算的预留怎么回收**：超时（默认 2 倍 Run wall）自动释放。

## 13. 实现状态（M6-6.4 控制面批次）

已实现（`migrations/0014_budget.sql`、`migrations/0018_budget_layers.sql`、`packages/store/src/budget.ts`、`apps/api/src/budget-routes.ts`）：

| 能力 | 说明 |
|---|---|
| 配额读写 | `ensureQuota` / `getQuota` / `listQuotas` / `setQuotaLimit`（只改 `limit_value`） |
| 四层配额 | `quotas.scope` 支持 `tenant` / `workspace` / `run` / `turn`；UNIQUE 仍为 `(scope, scope_id, period, metric)` |
| 多层预留 | 一次 `reserve` 命中 workspace / run / turn 中所有已配置的层，**全部通过才预留**；每层各自写一条 `reservations` 并记账 |
| 预留-结算 | `reserve` 原子检查剩余并写 `reservations`；`settle` 幂等，`reserved -= amount`、`used += actual` |
| 周期重置 | `reserve`/`settle` 发现 `now >= resets_at` 时清零 `used/reserved` 并推进周期 |
| 用量 | `recordUsage` 写 `usage_rows` + `billing.usage`；支持 `containerSeconds` / `storageBytes`；`sumUsage` 汇总总量与按 Bot/Model 分组 |
| 日聚合 | `usageDaily({ workspaceId, days })` 按 UTC 日返回 tokens / containerSeconds / storageBytes（空日补零） |
| 软限 | `used / limit >= 0.8` 返回 warning（不阻断），写一次 `billing.cap` |
| 准入 | `POST /api/rooms/:id/messages` 落库前检查 workspace 的日 `runs`/`tokens` 配额，耗尽 429 `quota_exhausted` |

接口：

| 方法 | 路径 | 鉴权 |
|---|---|---|
| POST | `/api/internal/budget/reserve` | runtime token；可选 `turnId` / `scope`；201 `{reservation, remaining, reservations, layers}`，任一命中的层不足 429 `quota_exhausted`（`error.layer`） |
| POST | `/api/internal/budget/settle` | runtime token；200 `{reservation, remaining}` |
| POST | `/api/internal/usage` | runtime token；201，`<turnId>:<source>` 重放 200 + `deduped: true`；无 `turnId` 时用 `idem` |
| POST | `/api/internal/meter` | runtime token；`{workspaceId, kind, amount, at?, idem?}` → 202，同 `idem` 幂等 |
| GET | `/api/quotas?workspaceId=` | Bearer（成员只读） |
| PATCH | `/api/quotas/:id` | Bearer（仅 owner） |
| GET | `/api/usage?workspaceId=&from=&to=` | Bearer（owner/admin）；`totals` 含容器秒/存储，另返回 `daily` |

实现补充（与 §10 原文的差异）：

1. **`usage_rows.idem TEXT UNIQUE`**：幂等键 `<turnId>:<source>`，重放不重复计费（§6「幂等」）；没有 `turnId` 的采样用调用方给的 `idem`。
2. **`reservations.quota_id`**：§10 的 reservations 没有指向配额的外键，`settle` 无法定位要回落的配额；补一列，不改变预留语义。
3. **`billing.quota.changed`**：`PATCH /api/quotas/:id` 写该事件（§4 只定义了 usage/reserve/settle/cap，这是实现补充）。
4. **周期时区**：当前按 **UTC** 推进（日 = UTC 0 点，月 = UTC 1 号 0 点）；工作区时区留后续（§12 待决 1）。
5. **默认配额**：§8 的默认值尚未自动播种；由调用方通过 `ensureQuota` 显式建立。
6. **多层预留的返回**：`reservation` / `quota` 仍指最外层（workspace），`remaining` 取所有命中层的最小剩余；每层明细在 `layers[]`。任一不足的层以 `error.layer` 标出（`tenant|workspace|run|turn`），且整次预留回滚。
7. **`usage_rows.container_seconds REAL` / `storage_bytes INTEGER`**：实现补充列。容器秒是累计量，求和；存储是 gauge，聚合取窗口最大值（§10 已注明）。
8. **`GET /api/usage` 的 `daily`**：覆盖 `[from, to)` 触及的 UTC 日（最多 366 天），最旧 → 最新；某日存储取该日最大值。
9. **`POST /api/internal/meter`**：控制面采样入口，`kind` 只有 `container_seconds` / `storage_bytes`；没有 `turnId`，幂等键用 `idem`。

尚未实现（后续批次）：模型代理（token 由调用方上报，不由控制面抓取）、runtime 侧容器秒/存储采样的实际上报、预留超时回收。
