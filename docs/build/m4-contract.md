# M4 契约（实现方共同遵守）

> 所有实现以本文件和 `packages/contract/src/index.ts` 为准。先读 `docs/design/bots.md` 与 `docs/design/rooms.md`。

## 1. 数据库（迁移 0004 / 0005）

```sql
-- 0004_bots.sql
CREATE TABLE bots (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', persona TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'deepseek-official', model TEXT NOT NULL,
  avatar_json TEXT, skills_json TEXT NOT NULL DEFAULT '[]',
  tools_allow_json TEXT NOT NULL DEFAULT '[]', tools_deny_json TEXT NOT NULL DEFAULT '[]',
  approval TEXT NOT NULL DEFAULT 'ask', memory_scopes_json TEXT NOT NULL DEFAULT '["team"]',
  status TEXT NOT NULL DEFAULT 'active', created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, name)
);
CREATE TABLE bot_versions (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, field TEXT NOT NULL,
  value TEXT NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL
);

-- 0005_rooms_rounds.sql
ALTER TABLE rooms ADD COLUMN host_bot_id TEXT;
ALTER TABLE rooms ADD COLUMN responder_json TEXT;
ALTER TABLE rooms ADD COLUMN bulletin TEXT;
ALTER TABLE rooms ADD COLUMN purpose TEXT;
ALTER TABLE rooms ADD COLUMN created_by_kind TEXT;
ALTER TABLE rooms ADD COLUMN created_by TEXT;

CREATE TABLE room_rounds (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, start_seq INTEGER NOT NULL,
  state TEXT NOT NULL, slots_json TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE TABLE room_seen (room_id TEXT, bot_id TEXT, seq INTEGER, PRIMARY KEY (room_id, bot_id));
CREATE TABLE bot_sessions (room_id TEXT, bot_id TEXT, session_id TEXT, updated_at INTEGER, PRIMARY KEY (room_id, bot_id));
```

> `room_members` 现有列是 (room_id, bot_id, user_id, role)，**role 已存在**，不要重复加；bot 成员写 `bot_id`、`role` 取 `host|member`。

## 2. API（用户侧，Bearer 会话）

```
GET    /api/bots?workspaceId=
POST   /api/bots                        CreateBotInput
GET    /api/bots/:id
PATCH  /api/bots/:id                    UpdateBotInput
DELETE /api/bots/:id                    软删

GET    /api/rooms?workspaceId=          返回含 members
POST   /api/rooms                       CreateRoomInput（无 name 时按成员名生成）
GET    /api/rooms/:id                   含 members + 当前 round
PATCH  /api/rooms/:id                   {name?,notice?,responder?,responderBot?}
POST   /api/rooms/:id/members           {botIds:[]}
DELETE /api/rooms/:id/members/:botId
POST   /api/rooms/:id/messages          {text}     ← 开启一轮
```

错误统一 `{ok:false,error:{code,message}}`，code 稳定（`bot.name_taken`/`bot.invalid`/`bot.no_model`/`room.invalid`/`room.members`/`room.responder`/`round.not_found`）。

## 3. API（内部，runtime token）

```
GET  /api/internal/rooms                      InternalRoomsResponse
GET  /api/internal/rooms/:id/round            当前 round 或 null
GET  /api/internal/rooms/:id/assignments      本轮所有 slot 的 RoundAssignment
POST /api/internal/rounds/:id/advance         RoundAdvanceInput → 更新 slot，必要时开下一 slot
POST /api/rooms/:id/say                       已有（成员发言，idem）
GET  /api/internal/rooms/:id/messages?after=  已有
```

### 3.1 内部接口的响应形状（实现已按此约定，补写进契约）

```
GET /api/internal/rooms/:id/assignments → { assignments: RoundAssignment[] }
POST /api/internal/rounds/:id/advance   ← { slotIndex, result: SlotResult }
```

- assignments 404/405/501 = 接口不可用 → room-agent 退回单 Bot `say` 路径
- assignments 5xx/网络错误 → **退避重试**，不回退（避免绕过轮次引擎造成重复发言）
- advance 的 4xx（400/404/409/410/422）视为轮次终态：记一行日志后继续，避免卡死重投

### 3.2 工作区启动（4.3.1–4.3.3）

```
POST /api/workspaces/:id/start     → { runtime: { sandbox, phase } }（鉴权：用户 Bearer）
GET  /api/workspaces/:id/runtime   → { runtime: { sandbox, phase, startedAt, lastHeartbeatAt } | null }
```

## 4. 轮次逻辑（packages/rooms，纯函数）

- `resolveResponder(responder, members)` → 实际成员列表（fallback 链）
- `openingSpeakers(room)` → slot 顺序（host 先）
- `applyMentions(round, speaker, text, limits)` → 插入/提前/额外 turn
- `classifyReply(text)` → posted/passed（`[PASS]`）
- `createRound(...)` / `advanceSlot(...)` / `finishRound(...)`
- 参数一律取自 `ROUND_LIMITS`

## 5. 前端（apps/web）

- 视图：`#/bots`（列表+新建）、`#/bots/:id`（设置）、`#/rooms/new`（建群）、`#/rooms/:id/settings`
- 保持现有配对页 + 房间页可用；数据来自上述 REST；房间页加"谁会回答"提示与 @ 菜单
- 不引入构建工具；ES module + 现有样式体系

## 6. runtime（apps/runtime）

- `room-agent.mjs`：从 `GET /api/internal/rooms` 拿成员；每个 (room,bot) prepare 会话；收到新消息后取 `assignments`，逐个投递、`advance` 回报
- 保留现有单 Bot 路径可用（`ROOST_BOT_ID`）；多成员时以 assignments 为准

## 7. 验收命令

```sh
node --experimental-strip-types --test packages/*/test/*.test.ts apps/*/test/*.test.ts
sh scripts/verify.sh
```

## 8. 实现进度（2026-11-04）

| 块 | 状态 | 证据 |
|---|---|---|
| 迁移 0004–0006 | ✅ | `migrations/` |
| bots CRUD | ✅ | `apps/api/src/bots-routes.ts`、35 store/api 测试 |
| 房间成员/responder | ✅ | `rooms-routes-ext.ts`、`room-members.ts` |
| 轮次引擎 | ✅ | `packages/rooms`，52 测试 |
| 开轮 + 内部接口 | ✅ | `round-orchestrator.ts`、`rounds-http.ts`、4+3 测试 |
| workspace start/runtime | ✅ | `workspace-runtime.ts`，3 测试；未配置返回 runtime null |
| room-agent 多成员 | ✅ | 43 runtime 测试 |
| 前端四视图 | ✅ | `apps/web/views`，41 测试 |
| 本地 E2E | ✅ | 双 Bot 假模型跑通；HTTP 冒烟 14/14 |
| 远端真实模型 | ⏳ | 待做 |
