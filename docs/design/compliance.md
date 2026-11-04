# 合规：数据驻留、导出、删除与保留

> 状态：实现盘点（M6-6.7 / D4）。本文描述**当前代码实际做到什么**，不是合规承诺书。
> 与 `storage.md` §5（附件 GC）、`artifacts.md` §9（保留）逐项对齐；未实现的能力明确标注。

## 1. 数据清单

| 数据 | 位置 | 内容 | 备份 |
|---|---|---|---|
| 控制面 SQLite | `ROOST_DB`（默认 `/var/lib/roost/roost.db`） | 账号、设备、会话、配对码、workspace/成员、Bot/版本、房间/轮次、事件、审批/授权、附件元数据、产物、配额/用量、调度、插件市场、连接器 | `deploy/backup.sh` |
| 附件内容 | `ROOST_ATTACHMENTS_DIR`（默认 `/var/lib/roost/attachments`） | 内容寻址 blob + `meta.json`（mime/size/owner/audience） | `deploy/backup.sh` |
| 沙箱工作区 | OpenShell 卷（`/workspace`） | DSH 会话、`/workspace/.dsh`、room-agent 游标、工具产物原文 | **不在 backup.sh 内** |
| 结构化日志 | journald / launchd 日志文件 | 请求信封（method/path/status/耗时），不含 body | 由日志系统决定 |
| 指标 | 控制面进程内存 | HTTP 计数/直方图 + 3 个业务 gauge | 不持久化 |
| 反代访问日志 | nginx | 示例配置只记 `$uri`，不记 query | 由日志系统决定 |
| 备份 | 运维指定目录 | 数据库 + 附件 tar + manifest/counts/SHA256 | 运维自行轮转/异地 |

**不落在平台上的数据**：模型推理请求与上下文由用户自带的 provider 处理（BYO），平台不转售、
不代理推理；provider 的日志与保留策略由其自身条款决定。插件面板可能直接访问第三方服务，
由插件/连接器授权与审计覆盖。

## 2. 数据驻留

- 当前是**单机部署**：控制面、SQLite、附件卷、沙箱都在同一主机/同一区域。
  没有跨区域复制、没有对象存储、没有遥测上报。
- 备份文件落在 `deploy/backup.sh` 的目标目录；运维必须把它留在同一司法辖区，并限制访问。
- 沙箱卷由 OpenShell gateway 管理；如果 gateway 与数据盘跨区域，沙箱内数据也随之跨区域。
  仓库没有区域感知或迁移工具。
- 多区域、按租户选择区域、跨区容灾**均未实现**。对客承诺只能写“单区域单机”。

## 3. 导出

### 3.1 已实现

| 方式 | 范围 | 说明 |
|---|---|---|
| `deploy/backup.sh` | **整库 + 整个附件卷** | 不是按 workspace 过滤；包含所有租户 |
| `GET /api/audit` | 单个 workspace 的事件 | owner/admin；`from`/`to`/`kind`/`before`/`limit`（最大 200） |
| `GET /api/messages/:seq/files/:artifactId` | 单条消息引用的文件 | 消息级授权；`?raw=1` 强制下载 |
| `GET /api/attachments/:id?token=` | 单个对象 | HMAC + 5 分钟过期 |
| 日志导出 | 运维 | journald/nginx 日志，按日志系统导出 |

**敏感提示**：整库备份包含会话 token 的哈希、配对码明文（5 分钟有效期内）、成员/审批/用量等。
把它交给外部前必须先做脱敏或整卷销毁；仓库没有脱敏工具。

### 3.2 未实现

- 按 workspace 导出 ZIP（`artifacts.md` §9 的 v2 目标）。
- 按账号导出（个人信息可携带）。
- 记忆/claim 导出（`memory.md` 的 6.3.5 未做）。
- 只导出事件或只导出附件的独立命令；只能整库 + 整卷。
- 导出时的在线一致性保证：`backup.sh` 对数据库是一致的，但附件目录与数据库之间没有跨资源快照；
  备份期间新增的附件可能出现在 tar 里但不在数据库元数据中（反之亦然）。需要严格一致时先停服。

## 4. 删除

### 4.1 已实现

| 操作 | 行为 | 是否物理删除 |
|---|---|---|
| `DELETE /api/devices/:id` | 吊销会话（`revoked_at`）+ `auth.session.revoked` 事件 | 否，行保留 |
| `DELETE /api/bots/:id` | 软删 `bots.deleted_at`，Bot 退出所有房间 | 否，7 天内可恢复 |
| `POST /api/bots/:id/restore` | 清除 `deleted_at` | — |
| `DELETE /api/rooms/:id` | 删除 `rooms`、`room_members`、`room_rounds`、`room_seen`、`bot_sessions` | 是（仅这些投影表；事件与附件引用保留） |
| `DELETE /api/workspaces/:id/members/:accountId` | 移除成员 | 是（成员行） |
| `DELETE /api/schedules/:id`、`DELETE /api/connectors/:slug` 等 | 删除对应配置行 | 是（对应行） |
| `POST /api/internal/attachments/gc` | 删除 `ref_count=0` 且超过 7 天的附件行与 blob | 是，写 `attachment.gc` 事件 |

### 4.2 重要限制

- **事件是只追加事实源**：房间删除不会删除 `events` 里的 `chat.message`，也不会删除
  `message_attachments`。因此被消息引用的附件 `ref_count` 仍 > 0，GC 不会删。
- **没有消息删除 API**：无法单条撤回/删除消息内容。
- **没有账号删除、workspace 删除、租户级清除 API**。`auth.md` 里 owner 的“删除 workspace”
  是设计目标，代码未实现。
- **Bot 软删不会清理**会话、事件、头像附件或 DSH 里的 session；7 天后也没有自动硬删任务
  （只拒绝过期恢复）。
- **配对码过期不清理**：`pairing_codes` 行保留；码本身 5 分钟后失效，但明文仍在库里。
- **会话吊销不删行**：保留 `revoked_at` 以便审计。
- **沙箱卷不随控制面删除**：没有“删除 workspace 卷”的实现；需要运维在 OpenShell 侧处理。
- **备份不随删除更新**：旧备份仍含被删数据，直到按备份保留策略销毁。

### 4.3 数据主体删除的可执行路径（当前）

在线按租户删除不可用。可行但需要人工的全卷路径：

1. 停止控制面（保证没有新写入）。
2. 用 `deploy/backup.sh` 留一份现场（可选，取决于是否要保留审计）。
3. 对目标租户做离线清理（直接 SQL 或重建库）——**没有受支持的 SQL 清理脚本**，属于高风险操作。
4. 删除对应附件目录/沙箱卷。
5. 按备份保留策略销毁包含该租户的旧备份。
6. 若无法保证局部清理，只能**整卷销毁 + 从清洗后的备份重建**。

在对客承诺前，必须先把“账号/workspace 删除 API + 事件与附件级联策略”补上。

## 5. 保留期

| 数据 | 设计/现状 | 代码位置 |
|---|---|---|
| 事件 | 设计默认 365 天可配置；**实现是永久保留，没有清理任务** | `events.md` §8；`packages/store/src/events.ts` |
| 附件/产物 | `ref_count=0` 且超过 **7 天** 才可 GC；被引用则永久保留 | `ATTACHMENT_RETENTION_MS`（7 天） |
| 附件 GC 触发 | **手动** `POST /api/internal/attachments/gc`；没有定时任务调用 | `apps/api/src/attachments-routes.ts` |
| 会话 | 30 天，剩余 <15 天续到 180 天上限；吊销行保留 | `server.ts` / `sessions.ts` |
| 配对码 | 5 分钟有效；行不清理 | `pairing_codes` |
| 审批/授权/用量/调度 | 无保留期与清理任务 | 各表 |
| 日志 | 应用不轮转、不设保留；由 journald/launchd/nginx 决定 | `observability.md` §2 |
| 指标 | 进程内存，重启清零 | `metrics.ts` |
| 备份 | 运维决定；脚本不自动轮转 | `deploy/backup.sh` |
| 沙箱卷 | 无自动保留/清理；stop/start 保留，删除未实现 | `sandboxing.md` §15 |

### 与 storage / artifacts 的对齐

- `storage.md` §5 的 GC 条件（`ref_count=0`、7 天、先写 `attachment.gc`）与实现一致。
- `artifacts.md` §9 的“消息删除 → 引用减一”**未实现**（没有消息删除）；因此产物不会因消息删除而可 GC。
- `artifacts.md` §9 的“页面产物保留最近 10 个版本”**未实现**。
- 图片缩略图用合成引用 `artifact:<id>` 保活；缩略图本身也受 7 天 GC 约束（但被引用则保留）。
- JPEG 登记时会剥 EXIF；PNG/GIF/WebP 的元数据未处理。

## 6. 访问控制与审计

| 项 | 现状 |
|---|---|
| 数据库/附件权限 | systemd `UMask=0077`；附件目录 0700、文件 0600（`local.ts`） |
| 会话 token | 只存 SHA-256 哈希；明文只在签发瞬间出现 |
| 配对码 | 6 位数字，5 分钟、单次；失败 5 次锁 10 分钟；明文入库 |
| 审计查询 | `GET /api/audit`，owner/admin，按 workspace 保守过滤 |
| 审计事件 | `approval.*`、`auth.*`、`bot.*`、`artifact.published`、`attachment.gc`、`connector` 调用等写入 events |
| 日志脱敏 | query 中的 `token/access_token/authorization/cookie` 替换为 `[REDACTED]`；不记 headers/body |
| 反代日志 | 示例配置只记 `$uri`，不记 `?access_token=` |
| 指标 | `/metrics` 无鉴权，必须网络隔离 |
| 篡改证据 | 无：events 与应用日志都没有签名/只读存储证明 |

## 7. 合规待办（按优先级）

1. 账号/workspace 删除 API + 事件/附件/会话级联策略（含沙箱卷）。
2. 按 workspace 导出 ZIP（消息 + 产物 + 审计），带权限与有效期。
3. 事件与审计的保留/归档任务（默认 365 天，可按租户配置）。
4. 定时附件 GC（当前手动），并在 `/metrics` 暴露 GC 结果。
5. 配对码过期清理与会话过期清理。
6. 备份保留策略与加密（当前脚本只做权限与校验和，不做加密）。
7. 日志保留与访问控制（journald 容量、日志导出审批）。
8. PNG/GIF/WebP 元数据清理；PDF 预览的隐私检查。
9. 沙箱卷备份/快照纳入恢复流程（当前只备份控制面 DB + 附件）。
