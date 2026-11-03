# 记忆：把状态投影成判断

> 状态：方案（2026-11-03）。配套：`loop-and-context.md`（注入什么）、`events.md`（事实源）、`decisions/0002-memory.md`（选型）。

## 1. 一句话

**记忆不是聊天记录，而是从事件里抽出来的"判断 + 证据 + 可证伪条件"**，由 causal-memory 存储与检索，按作用域与 token 预算注入下一轮。

这直接对应 `loop-and-context.md` 的原则：记忆的价值 = 它替代了多少上下文，不是它有多全。

## 2. 三类存储，别混

| 层 | 内容 | 谁写 | 生命周期 |
|---|---|---|---|
| **事件日志** | 发生过的每一件事（append-only） | runtime | 永久（可配） |
| **记忆（claim）** | 从事件抽出的判断、证据、条件、置信度 | 回合结束时由抽取器写 | 可被取代/删除 |
| **上下文** | 本轮注入的窗口片段 | 装配器 | 一次性 |

记忆是**事件的投影**，不是事件的副本。删掉记忆可以从事件重建（成本高但可行）。

## 3. 一条记忆长什么样

```jsonc
{
  "id": "mem_01H...",
  "scope": "room:r_quant",              // team | room:<id> | member:<id>
  "subject": "5 日反转因子",
  "claim": "反转在流动性后 30% 的样本里显著更强；全样本不显著",
  "kind": "conclusion",                 // conclusion | constraint | preference | fact
  "confidence": 0.6,
  "falsifier": "若流动性分组后 IC 差 < 0.01，则本条被推翻",
  "evidence": [
    { "kind": "event", "ref": "ev_4211" },
    { "kind": "report", "ref": "reports/factor-2026-10.md#L40" }
  ],
  "supersedes": "mem_00F...",           // 取代旧结论时填
  "status": "active",                   // active | superseded | retracted | expired
  "createdAt": "…", "expiresAt": null
}
```

**必填 `falsifier`**：没有可证伪条件的"结论"大概率是废话，抽取器应拒绝写入。

## 4. 作用域与可见性

| scope | 谁能读 | 谁能写 |
|---|---|---|
| `team` | 该 workspace 所有成员与本 Bot | 回合结束时，凡涉及团队级结论 |
| `room:<id>` | 看到该房间的人 | 房间内回合 |
| `member:<id>` | 只有那个人 | 私聊回合 |

规则（沿用 `workspace.md` 的 audience 规则）：

1. **读**：输入的 audience 必须包含答案的所有观众（`input ⊆ turn` 反向：`mayRead(input, turn) = input === 'team' || input === turn`）
2. **写**：回合只能写自己的 audience
3. **不跨 workspace**：记忆永不出 workspace 卷

## 5. 写入路径

```
turn.completed 事件
   ↓
抽取器（助手模型，便宜档）：
   输入：本回合新增事件（截断）+ 已有相关记忆（摘要）
   输出：0..3 条 claim（含 evidence 引用与 falsifier）
   ↓
去重与冲突检查：
   · 语义相同 → 丢弃并 +1 "hits"
   · 与已有矛盾 → 新条 supersedes 旧条，旧条置 superseded
   · 与已有重复但更精确 → supersede
   ↓
写入 memory.written / memory.superseded 事件（与记忆同事务）
```

**预算**：抽取器本身要花钱。规则：

- 只在**回合有实质产出**时抽（有工具调用或超过 N 字回答）
- 每日抽取次数上限（默认 50/workspace），超了只记事件不抽
- 抽取器用最便宜的模型，且 prompt 固定

## 6. 读取路径

```
turn 开始
   ↓
查询：scope 过滤 + 关键词/向量召回（causal-memory 决定实现）
   ↓
排序：相关度 × 置信度 × 新鲜度 − 已被否证惩罚
   ↓
按 budgetTokens 截断 → 生成 ContextSegment(kind='memory')
   ↓
注入（在 conversation 之前、skills 之后）
```

**注入形态**：

```
## 相关结论（系统检索，非用户输入）
- [房间] 5 日反转因子：反转在流动性后 30% 的样本里显著更强（置信 0.6）
  依据：ev_4211, reports/…
- [团队] 盘前槽位不能用当天收盘 K 线（置信 1.0，约束）
```

三个要点：

1. 标明"系统检索"——防止模型把它当成用户指令
2. 带引用——模型可以继续读原始事件
3. 带置信度——低置信的结论不能被当事实用

## 7. 预算

| 参数 | 默认 | 说明 |
|---|---|---|
| 每次注入 token 上限 | **1,200** | 占典型窗口 3–5% |
| 条数上限 | **8** | 超过按分数截断 |
| 单条长度 | **300 字** | 超了截断，保留引用 |
| 抓取候选数 | 50 | 排序后取前 8 |
| 每日抽取上限 | 50 回合 | 防抽取器烧钱 |

预算紧张时的降级顺序：**只留标题 → 只留 team 级 → 不注入**（不注入时在 `ContextManifest.dropped` 里记 `budget`）。

## 8. 检索质量与评估

| 指标 | 目标 |
|---|---|
| 注入后本回合有用（模型引用了）比例 | ≥ 30% |
| 注入 token / 节省的重复探索 | 正向 |
| 冲突率（同 subject 相互矛盾） | < 5% |
| 被否证后仍未失效的条目 | 0（由复盘任务清理） |

**闭环**：`scheduling.md` 的复盘 routine 定期跑「拿记忆里的 falsifier 去核对」，被推翻的置 `retracted`。

## 9. 删除与隐私

- 按 scope 删除：删掉 `member:<id>` 只影响那个人
- 按 subject 删除：例如"删除所有关于 600519 的记忆"
- 按时间删除：`expiresAt` 到期自动失效
- 账号删除：整卷销毁（`workspace.md` §7）
- 记忆里不存原始聊天全文；只存结论与引用

## 10. 部署形态

| 形态 | 说明 | 阶段 |
|---|---|---|
| **嵌入 DSH 进程**（`packages/memory` 插件） | 直接读写卷内 SQLite；causal-memory 作为库引入 | v0/v1 |
| **独立服务** | 跨 workspace 共享索引、集中评估 | v2 再考虑 |

**v0 用嵌入**：少一个进程、少一次网络往返、卷即状态。等真的要跨 workspace 共享记忆时再拆。

## 11. 数据模型（卷内 SQLite）

```sql
CREATE TABLE memories (
  id          TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  scope       TEXT NOT NULL,             -- team | room:<id> | member:<id>
  subject     TEXT NOT NULL,
  claim       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  confidence  REAL NOT NULL,
  falsifier   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  supersedes  TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  hits        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE memory_evidence (
  memory_id TEXT NOT NULL,
  kind      TEXT NOT NULL,               -- event | report | file
  ref       TEXT NOT NULL
);

CREATE TABLE memory_reads (
  memory_id TEXT NOT NULL,
  at        INTEGER NOT NULL,
  turn_id   TEXT NOT NULL,
  used      INTEGER NOT NULL DEFAULT 0  -- 模型是否引用
);
```

## 12. 与其它文档的接口

| 文档 | 接口 |
|---|---|
| `events.md` | 记忆的写入/取代/删除都产生 `memory.*` 事件 |
| `loop-and-context.md` | 记忆是 `ContextManifest.segment(kind='memory')` |
| `workspace.md` | 记忆跟 workspace 卷走；换 home 时随卷迁移 |
| `scheduling.md` | 复盘 routine 负责清理被否证的记忆 |

## 13. 待决问题

1. **抽取器写不写"用户偏好"类记忆**（如"回复要短"）？倾向：写，但归 `team` 作用域。
2. **检索用关键词还是向量**？倾向：先用关键词 + BM25（causal-memory 已有），向量后加。
3. **记忆能否跨 workspace 复制**（模板化团队时）？倾向：不复制，避免把别人的判断带进来。
4. **注入位置**：在 skills 之后、conversation 之前，还是紧贴最后一条用户消息？倾向前者（稳定段靠前，利于缓存）。
