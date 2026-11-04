# 房间：共享日志、轮次与派发

> 状态：最终方案（2026-11-04）。基于对 ds-bot 与 OpenMausBot 源码的深读，接 `messaging.md`（投递）、`agent-collaboration.md`（状态）、`sandboxing.md` §15（用户沙箱与长活 DSH）。
> 一句话：**房间是一条共享有序日志，一条用户消息开启一轮，轮次按规则把"未读增量"发给成员会话并收集回复。**

## 1. 为什么需要这一层

之前我们只有"消息投递"和"assignment"，没有定义**一个房间里一轮怎么跑**。两家成熟实现都证明这一层不能省：

| 问题 | ds-bot 的答案 | OMB 的答案 |
|---|---|---|
| 谁回答 | `everyone` / `admin` / `@Name` | `member` / `everyone` / `mentions` / `auto` |
| 多个 Bot 会不会抢话 | 轮次 slots 串行，一次一个 | responder 先定人，再串行 |
| Bot 之间怎么接力 | 回复里 `@Name` 调用下一个，限额 | 由 decider 或 @ 决定 |
| 上下文怎么给 | 每个成员只收**未读增量**，自己的话不再回灌 | 每个成员独立会话 + bulletin |
| 建群后第一句 | admin kickoff："这个群要做什么" | 用户直接说 |

## 2. 核心模型

```
Room（房间）
 ├─ log：一条有序、共享的对话日志（seq 单调）——我们的 events 表投影
 ├─ members[]：参与成员（Bot 或人），其中有且只有一个 host
 ├─ responder：默认谁回答（见 §4）
 ├─ bulletin：公告，每个成员说话前必读
 └─ rounds[]：轮次（一条用户消息 = 一轮）

Member 会话（每个成员一份，独立）
 ├─ sessionId = room-<roomId>-<botId>（确定性，DSH 里长活）
 ├─ seen[member] = 已读到的 seq（增量起点）
 └─ brief：该成员自己的私聊摘要（只通过工具进群，见 §5）
```

**三条不变量**

1. 房间日志只有一份（不进每个成员会话重复存）
2. 成员只收到"自己没读过、且不是自己说的"增量
3. 同一房间同一时刻只有一个轮次在跑，成员发言在轮内串行

## 3. 轮次（Round）

```
用户消息 → 开启 round(startSeq)
  ├─ slots：按 responder 生成的发言队列（有序）
  ├─ 逐个 slot：
  │   1. 组装该成员的 prompt（§5）
  │   2. 投递到它的会话，等结果（超时 240s，工作中宽限 15s）
  │   3. 结果分类：posted / passed([PASS]) / failed / missed / approval / working
  │   4. 解析回复里的 @Name → 插入新的 slot（受 §4 限额约束）
  ├─ 轮内用户插话 → 先入日志，加入队列（不打断当前成员）
  └─ 轮结束 → 回复写回日志 + SSE 推给所有端
```

**参数（借 ds-bot 实测值，作为默认）**

| 项 | 值 | 说明 |
|---|---|---|
| 单成员回复超时 | **240s** | 超过记 `missed`，轮次继续 |
| 工作宽限 | **15s** | 成员在跑工具，给一轮机会，不阻塞 |
| 每成员每轮发言次数 | **2**（host 4） | 防一个人霸场 |
| 每轮额外 turn 上限 | **4**（host 4） | 防 @ 风暴 |
| 房间成员上限 | **12** | 再多就不是讨论 |
| 日志保留 | **60 条**（最近 12 条首次全给，增量 24 条） | 上下文预算 |
| late rounds | **≤10** | 成员"晚到的结果"还能回群的轮数 |
| 公告上限 | **2,000** 字符（组内）；bulletin 12,000（OMB） | |

## 4. 派发（谁回答）

**四种模式**，前三种 v1 做，`auto` 后置：

| 模式 | 谁进 slots | 备注 |
|---|---|---|
| `member:<botId>` | 指定的那个成员 | 就是 OMB 的 lead / ds-bot 的 admin mode |
| `everyone` | 全部成员，host 先 | ds-bot 的 everyone |
| `mentions` | 只有被 @ 的成员；没人 @ 时取默认 lead | |
| `auto` | 决策模型挑人（带 fallback） | v2 |

**fallback 链（OMB 的写法，必须照抄）**

```
指定的 member 存在？→ 用它
auto 且 decider 开启？→ auto
否则 → 成员里的第一个
没有成员？→ mentions
```

**@ 调用规则（ds-bot 的边界，我们的安全阀）**

- 成员回复里 `@Name` → 把该成员插到当前 slot 后面（它还没说就提前；说过了就给一次额外 turn）
- 每成员每轮上限 2（host 4），超出忽略
- **只有 host 的 `@all` 能叫全员**，普通成员不能，防"@ 风暴"
- 中文名要处理前缀歧义（`@数据官` 不能匹配 `@数据官2`），用 OMB 的边界判定思路

**[PASS] 与静默**

成员可以回 `[PASS]` 表示"没有新信息"，不算失败、不写日志、UI 不显示。失败/超时/审批/继续工作要在房间里**显式**呈现（一行状态），不能假装它没说话。

## 5. 每个成员看到的上下文（装配顺序）

借 ds-bot 的 `roomPrompt` 结构：

```
1. 成员清单 + 谁是 host
2. 群公告（shared instructions）
3. host 附加说明（"plain messages come to you first…"）
4. 更早的上下文（本轮之前，最多 8 条）
5. 本轮增量（自己没读过的，最多 24 条）
6. 用户引用的会话/文件
7. 谁还在工作（"each posts when done"）
8. 本轮发言顺序 + 自己是第几个
9. 行为指令：一次一个短消息；该做事就做；没有新信息回 [PASS]
```

**私聊上下文不进群**：成员要让群看到它自己的私聊内容，必须通过工具读取，且房间会记录"它查了私聊"（ds-bot `read_own_chat` 的做法）。

## 6. 建群与 Bot 创建

### 创建 Bot（参考 ds-bot 的轻 + OMB 的分区）

```
[新建 Bot]
  图标（程序化 / 换一个 / 上传）
  名字（≤40，非法名与重名校验）
  角色（≤24）
  模型（创建时固定，之后全局默认变了不影响它）
  [ 创建并继续设置 ]
```

- **名字锁**：从校验到写入完成期间占住名字，防多端并发创建重名（ds-bot `holdName`）
- 创建后 **kickoff**：用模型生成一句自我介绍 + 问"你希望我专注什么"（ds-bot 三种文案）
- 头像：形状/颜色白名单校验，或上传图片（走 content store）

### Bot 设置（分区对齐 OMB，字段用我们的）

```
身份 / 人设（版本化可回滚）/ 技能 / 工具与审批 / 记忆范围 / 模型与额度 / 定时 / 危险区
```

能力区只有 admin 可改；人设改动留事件。

### 建群

```
[新建房间]
  名称（可空 → 按成员自动命名，≤60）
  公告（可选，≤2000）
  成员（多选 Bot；首个勾选默认 host）
  谁回答（member / everyone / mentions）
  [ 创建 ]
```

- **≥2 个 Bot** 才成群（与 ds-bot 一致）
- 没写第一句时，host 用 kickoff 问"这个群要做什么"（ds-bot 做法），用户答后 host 复述进公告
- Bot 建群：只能拉同 workspace 的 Bot；**一次人工确认**；每 Bot 每日上限 3；房间标"由 Bot 创建"
- 服务端校验：成员必须可见/存在；responder 必须指向房间成员（OMB `checkedGroupResponder`）；名称/公告长度

## 7. 数据模型

```sql
-- bots 见 bots.md（同批落地）
CREATE TABLE rooms (
  ...,
  host_bot_id   TEXT,
  responder     TEXT NOT NULL DEFAULT 'member',  -- member|everyone|mentions|auto
  responder_bot TEXT,
  bulletin      TEXT,
  created_by_kind TEXT, created_by TEXT,
  purpose       TEXT
);

CREATE TABLE room_members (room_id, bot_id, user_id, role);  -- 已有，启用

-- 轮次与已读游标（重启恢复用）
CREATE TABLE room_rounds (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL,
  start_seq  INTEGER NOT NULL,
  state      TEXT NOT NULL,      -- running|done|stopped
  slots_json TEXT NOT NULL,      -- [{botId,status,note,by}]
  turns      INTEGER NOT NULL,
  started_at INTEGER, ended_at INTEGER
);

CREATE TABLE room_seen (
  room_id TEXT NOT NULL, bot_id TEXT NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY (room_id, bot_id)
);

CREATE TABLE bot_sessions (
  room_id TEXT NOT NULL, bot_id TEXT NOT NULL, session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY (room_id, bot_id)
);
```

日志本体仍是 events（`chat.message`），不另存。

## 8. 接口

**用户侧**

```
POST /api/rooms                    {workspaceId, name?, bulletin?, memberBotIds[], hostBotId?, responder}
PATCH /api/rooms/:id               {name?, bulletin?, responder?, responderBot?}
POST /api/rooms/:id/members        {botIds[]}
DELETE /api/rooms/:id/members/:botId
POST /api/rooms/:id/messages       {text}          ← 开启一轮
POST /api/rooms/:id/turns/:turnId/stop             ← 停止当前成员（不终止整轮）
GET  /api/rooms/:id                ← 房间 + members + 当前轮次 + 正在说话的人
GET  /api/rooms/:id/stream         ← SSE：message / round / speaking / status
```

**内部（runtime token，room-agent 用）**

```
GET  /api/internal/rooms                     ← 房间 + 成员 + responder
GET  /api/internal/rooms/:id/round           ← 当前轮次与 slots（断点续跑）
GET  /api/internal/rooms/:id/messages?after  ← 增量
POST /api/rooms/:id/say                      ← 成员发言（带 idem）
POST /api/internal/rounds/:id/advance        ← 报告 slot 状态（posted/passed/failed/working）
```

## 9. 和 room-agent（长活 DSH）怎么配合

```
控制面：房间状态、轮次、派发决策（纯逻辑、可审计）
沙箱里的 room-agent：
  ├─ 拉当前轮次与 slots
  ├─ 对每个 slot：把 §5 的 prompt 投进该成员的 DSH 会话（session/prompt）
  ├─ 等该会话 idle → 取 assistant 文本 → 回 advance（posted/passed/failed）
  └─ 会话忙就报 working，不阻塞轮次
```

**为什么派发决策放控制面**：可审计、可回放、多端一致；room-agent 只是执行器。这也符合我们 `events.md` 的"一份事实源"。

## 10. 恢复

| 场景 | 行为 |
|---|---|
| 沙箱 stop/start | 会话 resume（已实现）；轮次从 `room_rounds` 恢复为 `running` 或标 `stopped` |
| room-agent 崩溃 | 未完成 round 标 `interrupted`，发 recovery note 让成员先检查工作目录 |
| 成员会话丢失 | 该 slot 标 `failed(SESSION)`，轮次继续，不卡死 |
| 用户停止 | 只停当前成员，轮次继续（ds-bot 的 hold 语义） |

## 11. 分期

**v1（先做）**
- `bots` 表 + 创建/设置 API + 两个页面
- 房间成员 + 用户建群（≥2、host、三种 responder）
- 单 Bot 轮次跑通（现有沙箱链路）；多 Bot 进 slots 但不接力
- UI：输入框提示"谁会回答" + @ 菜单

**v1.5**
- 完整轮次：@ 接力、限额、[PASS]、工作/审批/超时状态
- Bot 建群（审批 + 配额）
- 房间设置分页（成员 / 谁回应 / 公告 / 回合超时）

**v2**
- `auto` 决策模型、跨房间广播限制、长期记忆接入

## 12. 待决

1. `auto` 的决策模型用哪个（v2 再定）
2. 轮次的持久化粒度：每 slot 落库（重放更准）还是每轮落库（更省）？倾向每轮 + 关键 slot 状态。
3. 私聊进群的工具要不要在 v1 就给（还是只给摘要）。

## 13. 实现状态（2026-11-04）

- `packages/rooms`：responder / openingSpeakers / @ 解析 / 轮限 / [PASS] / prompt 装配（52 测试）
- `packages/store`：bots / room_members / rooms-ext / rounds / workspace_runtime（迁移 0004–0006）
- `apps/api`：Bot CRUD、建群与成员、`POST /messages` 开轮、内部 assignments/round/advance、workspace start/runtime
- `apps/runtime`：room-agent 按 assignments 派发、单 Bot 回退、退避、session resume
- `apps/web`：Bot 列表/新建/设置、建群、房间设置、谁会回答、@ 菜单
- 本地验收：HTTP 冒烟 14/14、双 Bot 假模型 E2E、全量 297 测试
- 未接：kickoff、Bot 建群审批、profile sync、工作宽限/late rounds、日志裁剪、远端真实模型双 Bot
