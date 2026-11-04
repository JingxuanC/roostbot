# Bot：身份、创建与设置

> 状态：最终方案（2026-11-04）。参考 ds-bot 的"创建轻、设置重"与 OMB 的分区向导。

## 1. 模型

```sql
CREATE TABLE bots (
  id            TEXT PRIMARY KEY,          -- bot_<ulid>
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  name          TEXT NOT NULL,             -- ≤40，workspace 内唯一
  role          TEXT NOT NULL DEFAULT '',  -- ≤24，只影响默认提示词
  persona       TEXT NOT NULL DEFAULT '',  -- SOUL，版本化
  provider      TEXT NOT NULL DEFAULT 'deepseek-official',
  model         TEXT NOT NULL,             -- 创建时固定
  avatar        TEXT,                      -- {shape,color} 或 {image}
  skills        TEXT NOT NULL DEFAULT '[]',
  tools_allow   TEXT NOT NULL DEFAULT '[]',
  tools_deny    TEXT NOT NULL DEFAULT '[]',
  approval      TEXT NOT NULL DEFAULT 'ask',   -- ask | edits | auto | full
  memory_scopes TEXT NOT NULL DEFAULT '["team"]',
  status        TEXT NOT NULL DEFAULT 'active',-- active | paused
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE bot_versions (             -- 人设/能力的版本留痕
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, field TEXT NOT NULL,
  value TEXT NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL
);
```

## 2. 创建（三条来自两家的硬规则）

1. **名字锁**：从校验到写入完成期间占住名字，防止多端并发创建重名（ds-bot `holdName`）
2. **模型创建时固定**：之后全局默认变了也不影响这个 Bot（ds-bot 注释原话）
3. **创建后 kickoff**：用模型生成一句自我介绍 + 问"你希望我专注什么"（ds-bot 的三种文案：Main / 副本 / 普通）

校验：名字非空、≤40、无非法字符、不重名；角色 ≤24；头像形状/颜色白名单或上传图片。

## 3. 图标

程序化图标（`packages/identity` 的确定性 glyph）是默认；上传或生成是升级项。规则见 `bot-identity.md`。

## 4. 设置页

```
身份      名称 / 角色 / 图标 / 颜色
人设      SOUL（版本化、可回滚、留事件）
能力      技能 / 工具允许 / 工具禁止 / 审批级别
记忆      作用域（团队/房间/个人）+ 保留期
模型      模型 + 额度
定时      routine 列表
危险区    暂停 / 删除（软删 7 天）
```

权限：能力区只有 workspace admin 能改；成员可改名字/图标；人设改动写 `bot.updated` 事件。

## 5. 暂停 / 删除

- 暂停：不接新轮次，进行中的回合跑完
- 删除：软删 7 天可恢复；期间房间里的 slot 显示"已删除"而不是崩掉
- 删除后它的私聊、记忆、会话按 `workspace.md` 的保留策略处理

## 6. Bot 与房间

- Bot 可以被拉进任意同 workspace 的房间（`room_members`）
- 每个 (room, bot) 一个会话 `room-<roomId>-<botId>`（`bot_sessions`）
- Bot 建群：见 `rooms.md` §6；`created_by=bot`，host 是创建者，一次人工确认 + 每日配额

## 7. 接口

```
GET    /api/bots
POST   /api/bots                {name, role, model, avatar, persona?}
GET    /api/bots/:id
PATCH  /api/bots/:id            {name?, role?, avatar?, persona?, skills?, tools?, approval?, memory?, model?, status?}
DELETE /api/bots/:id            ← 软删：写 deleted_at、退出所有房间（逐房 bot.removed_from_room 事件）
POST   /api/bots/:id/restore   ← 7 天内可恢复，超窗 409 bot.restore_expired
POST   /api/bots/:id/kickoff    ← 可选：重新生成开场（调试用）
```

错误沿用 `{ok:false,error:{code,message}}`；`bot.invalid` / `bot.name_taken` / `bot.no_model` 这类直接显示在原地。

## 8. 待决

1. 技能/工具在创建时给不给选？（倾向：不给，创建后设置）
2. 人设版本保留几个？（倾向：最近 20 个）
3. 删除时是否同时退出所有房间并通知？（已定：是。删除即退出所有房间含 DM，逐房写 `bot.removed_from_room` 事件（audience=room:<id>），另写 workspace 级 `bot.deleted`（audience=team）；恢复不自动回房间）

## 8.1 命令审批从哪来

DSH 默认给新会话 pin `workspace-write + ask`（base profile 的 `permission-presets`），所以每条
bash 都要审批。沙箱里我们的边界是 OpenShell，因此沙箱 env 固定 `DSH_PERMISSION_MODE=danger-full-access`，
DSH 自己的审批关闭；`bots.approval` 字段到 DSH 预设的映射还没做（TODO 4.2.19）。

## 9. 实现状态（2026-11-04）

已实现：`bots` / `bot_versions` 迁移、名字锁、模型创建时固定、CRUD API、人设版本、权限区、软删（迁移 0010 `bots.deleted_at`，7 天窗口 `BOT_SOFT_DELETE_WINDOW_MS`，`POST /api/bots/:id/restore`）、Bot 事件（`bot.created`/`bot.updated`/`bot.deleted`/`bot.restored`/`bot.removed_from_room`，写入 workspace 事件日志）、前端列表/新建/设置页。
已接：kickoff 消息（DM 房间开场）、头像上传（dataURL ≤256KB，store 上限 512k 字符，API body 上限 1MiB）、审批页。
注意：软删期间 `(workspace_id, name)` 唯一约束仍占住名字——恢复窗口内名字不可复用；超过 7 天的物理回收（GC）未做。
