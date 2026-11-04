# TODO

> 唯一的任务清单。每完成一块，勾掉对应项、在「变更日志」追加一行、更新顶部进度。
> 进度：`node scripts/todo-stats.mjs`（或看顶部数字）。
> 图例：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 完成 · `[!]` 阻塞（后面写原因）

## 进度

- 完成：13 / 149 · 进行中：36
- 8 项为清单建立前完成，见末尾「已完成」
- TODO 总数从 149 增至 152（新增 4.2.16 / 4.2.17 / 4.2.18）
- 当前里程碑：**M4 产品闭环**
- 统计：`node scripts/todo-stats.mjs`

## M4 产品闭环（P0）

目标：浏览器里建 Bot → 建群拉成员 → 两轮对话有上下文 → 重启后还在。

### 4.1 Bot 域（`docs/design/bots.md`）

- [x] 4.1.1 `bots` 表 + `bot_versions` 表（迁移 0004）
- [x] 4.1.2 `POST /api/bots`（名字锁、重名/非法名校验、模型固定）
- [x] 4.1.3 `GET /api/bots` / `GET /api/bots/:id`
- [x] 4.1.4 `PATCH /api/bots/:id`（人设版本留痕、能力区仅 admin）
- [x] 4.1.5 `DELETE /api/bots/:id`（软删 7 天）
- [x] 4.1.6 创建后 kickoff（模型生成自我介绍 + 问用途）
- [x] 4.1.7 头像：程序化 glyph 默认 + 上传（≥256 WebP，剥 EXIF）
- [x] 4.1.8 `bot.created/updated/deleted` 事件

**验收**：见 4.5.1。

### 4.2 房间与轮次（`docs/design/rooms.md`）

- [x] 4.2.1 迁移 0005：`rooms` 扩展列（host/responder/bulletin/created_by/purpose）
- [x] 4.2.2 迁移 0005：`room_rounds` / `room_seen` / `bot_sessions`
- [x] 4.2.3 启用 `room_members`：建房写成员、host 唯一
- [x] 4.2.4 `POST /api/rooms` 扩参（name?/bulletin?/memberBotIds/hostBotId?/responder）
- [x] 4.2.5 `PATCH /api/rooms/:id`（name/bulletin/responder/responderBot）
- [x] 4.2.6 `POST/DELETE /api/rooms/:id/members`
- [x] 4.2.7 responder 四模式 + fallback 链（member/everyone/mentions/auto 占位）
- [x] 4.2.8 轮次开启：用户消息 → `room_rounds` + slots
- [x] 4.2.9 @ 调用（每成员 2 次、host 4 次、每轮额外 4、仅 host @all）
- [x] 4.2.10 `[PASS]` 静默 + failed/missed/working/approval 状态
- [x] 4.2.11 回复超时 240s
- [x] 4.2.16 工作宽限 15s / late rounds ≤10 / 轮内 stop（引擎与 runtime 尚未接）
- [x] 4.2.12 prompt 侧增量 24 / 更早 8
- [x] 4.2.17 房间日志裁剪到 60 条、首看 12（events 是事实源，裁剪做成投影）
- [x] 4.2.18 `DELETE /api/rooms/:id`（前端房间设置已有按钮，后端已落地）
- [x] 4.2.13 内部接口：`GET /internal/rooms/:id/round`、`POST /internal/rounds/:id/advance`
- [x] 4.2.14 建群 kickoff（无首句时 host 问"这个群要做什么"）
- [x] 4.2.15 Bot 建群：`POST /internal/rooms` + 一次人工确认 + 每日上限 3

**验收**：见 4.5.2。

### 4.3 会话与编排

- [x] 4.3.1 控制面 `POST /api/workspaces/:id/start`（替代 `planA-boot.mjs`）
- [x] 4.3.2 `runtimes` 表落库（沙箱名/阶段/最近心跳）
- [x] 4.3.3 `GET /api/workspaces/:id/runtime`（面板显示状态）
- [x] 4.3.4 沙箱启动前 profile sync 拉锁（`POST /api/internal/plugins/sync`，锁 = 基线 profile + integrity）
- [x] 4.3.5 room-agent 按 `room_members` prepare 会话（多 Bot）
- [x] 4.3.6 room-agent 断线重连/控制面不可达时的退避

**验收**：见 4.5.3。

### 4.4 前端页面

- [x] 4.4.1 侧栏「新建 Bot」入口 + 创建页（图标/名字/角色/模型）
- [x] 4.4.2 Bot 设置页（身份/人设/技能/工具/记忆/模型/定时/危险区）
- [x] 4.4.3 建群对话框（名称/公告/成员多选/host/responder）
- [x] 4.4.4 房间设置页（成员/谁回应/公告/删除）
- [x] 4.4.5 输入框"谁会回答"提示 + @ 菜单（中文名前缀消歧）
- [x] 4.4.6 房间内轮次状态（谁在说/排队/失败/静默）
- [x] 4.4.7 Bot 列表与状态（active/paused/删除）
- [x] 4.4.8 空状态、错误态、加载态

**验收**：见 4.5.4。

### 4.5 M4 验收

- [x] 4.5.1 新建 Bot → 出现"自我介绍 + 问用途"的 kickoff 消息
- [x] 4.5.2 建群拉 2 个 Bot → 两个 Bot 都能按 responder 回答
- [ ] 4.5.3 远端真实模型两轮对话（记得上一句）→ 沙箱重启后仍记得
- [ ] 4.5.4 以上全部在浏览器里完成（不靠 curl / 手工脚本）

## M5 平台能力（P1）

### 5.1 插件市场（`docs/design/plugin-marketplace.md`）

- [ ] 5.1.1 表：`plugin_publishers` / `plugin_market` / `plugin_versions` / `plugin_installs`
- [ ] 5.1.2 市场 API（列表/详情/版本/预检）
- [ ] 5.1.3 安装流程：预检 → 权限披露 → 批准 → 写锁 → 沙箱 sync → 冒烟 → 回滚
- [ ] 5.1.4 profile lock 生成与校验（manifest + pnpm-lock + patch 行 + integrity）
- [ ] 5.1.5 已安装 API（更新/停用/卸载/回滚）
- [ ] 5.1.6 市场页 + 详情页 + 已安装页
- [ ] 5.1.7 Bot 工具列表标"来源插件"
- [ ] 5.1.8 白名单 + 签名/来源校验
- [ ] 5.1.9 运行时禁 postinstall（`--ignore-scripts`）
- [ ] 5.1.10 安装前快照 + 失败自动回滚

### 5.2 DSH web 面板表面（ADR 0004）

- [ ] 5.2.1 沙箱内起 `dsh web`（127.0.0.1:4099）与 room-agent 共存
- [ ] 5.2.2 控制面反代 `/w/<workspace>/dsh/*`（设备会话鉴权、base path 剥离）
- [ ] 5.2.3 iframe 容器（独立源、sandbox 属性、加载/失败兜底）
- [ ] 5.2.4 面板清单（manifest `panels` + 启动冒烟核对）
- [ ] 5.2.5 面板打开才唤醒、随沙箱 stop/start
- [ ] 5.2.6 整页打开 DSH Web（高级选项）

### 5.3 认证与角色（`docs/design/auth.md`）

- [ ] 5.3.1 注册/登录（邮箱+密码 Argon2id）/邮箱验证码
- [ ] 5.3.2 OIDC（Google/GitHub）
- [ ] 5.3.3 邀请与角色（owner/admin/member/viewer）
- [ ] 5.3.4 设备列表/吊销
- [ ] 5.3.5 会话续期（<15 天续到 180 天封顶）
- [ ] 5.3.6 token 改 HttpOnly cookie + CSRF 双提交
- [ ] 5.3.7 签发配对码需要 owner/admin（现在不鉴权）

### 5.4 审批（"需要你"）

- [ ] 5.4.1 `approvals` 表（单次/长期、动作、目标、后果）
- [ ] 5.4.2 审批 API（列表/批准/拒绝）
- [ ] 5.4.3 房间/工具/Bot 建群接入审批
- [ ] 5.4.4 需要你页真实数据 + 卡片渲染
- [ ] 5.4.5 审批决策事件与审计
- [ ] 5.4.6 长期授权（Allow always）与撤销

### 5.5 多端（`docs/design/workspace.md`）

- [ ] 5.5.1 设备管理页（列表/吊销/在线状态）
- [ ] 5.5.2 同一 workspace 两窗口同步（SSE 已验证，补 UI 去重）
- [ ] 5.5.3 离线态与重连补拉（after=seq）
- [ ] 5.5.4 深链（`/w/:id/room/:id`、`/w/:id/bot/:id`）
- [ ] 5.5.5 移动端布局
- [ ] 5.5.6 通知策略（只在"需要你"时提醒）

## M6 商业化与规模化（P2）

### 6.1 连接器（`docs/design/connectors.md`）

- [ ] 6.1.1 GatewayBackend 接口 + OpenConnector 后端
- [ ] 6.1.2 OAuth 回调与 state 校验
- [ ] 6.1.3 按 Bot 授权（read/write/actions）
- [ ] 6.1.4 动作级审批 + idem 幂等
- [ ] 6.1.5 调用审计（`connector_calls`）
- [ ] 6.1.6 连接器卡片 UI（连/断/授权）
- [ ] 6.1.7 Composio 后端（同接口）

### 6.2 存储与产物（`storage.md`/`artifacts.md`）

- [ ] 6.2.1 `LocalVolumeStore` 实现（内容寻址、原子写、权限）
- [ ] 6.2.2 附件表 + 引用计数 + GC
- [ ] 6.2.3 上传/下载 API + Range + 预签名
- [ ] 6.2.4 消息级文件授权路由
- [ ] 6.2.5 缩略图（图片 + PDF 首页）+ EXIF 剥离
- [ ] 6.2.6 产物渲染（image/pdf/html/table/code/page）
- [ ] 6.2.7 产物卡片 UI + 沙箱 iframe（HTML）

### 6.3 记忆（`memory.md`）

- [ ] 6.3.1 causal-memory 接入（作用域读写）
- [ ] 6.3.2 claim 抽取器（falsifier 必填、每日上限）
- [ ] 6.3.3 检索与注入（预算 1200 token / 8 条）
- [ ] 6.3.4 冲突 supersede 与审计
- [ ] 6.3.5 删除/导出（按 scope/subject）
- [ ] 6.3.6 复盘 routine 清理被否证条目

### 6.4 预算与计量（`budget.md`）

- [ ] 6.4.1 usage 表（按 run/turn/bot 记账）
- [ ] 6.4.2 预留-结算（准入预留，结束结算）
- [ ] 6.4.3 配额四层（tenant/workspace/run/turn）
- [ ] 6.4.4 429 与软限 80% 提醒
- [ ] 6.4.5 模型代理（token 记账、限流）
- [ ] 6.4.6 用量页（按 Run/Bot/房间）
- [ ] 6.4.7 容器秒/存储计量

### 6.5 调度（`scheduling.md`）

- [ ] 6.5.1 `routines` 表 + cron 计算（含 DST 测试）
- [ ] 6.5.2 激活控制器（clock/event/repair）
- [ ] 6.5.3 幂等（routineId+scheduledFor）+ 12h catch-up
- [ ] 6.5.4 睡/醒：空闲 stop/start（已验证，接调度）
- [ ] 6.5.5 定时任务页（列表/启停/历史）
- [ ] 6.5.6 复盘 routine 内置模板

### 6.6 观测与运维

- [ ] 6.6.1 事件→指标（Run/Assignment/沙箱/预算）
- [ ] 6.6.2 结构化日志 + 请求 id
- [ ] 6.6.3 审计查询页/API
- [ ] 6.6.4 告警（沙箱 Error、预算超限、投递失败）
- [ ] 6.6.5 健康检查（API/沙箱/网关）
- [ ] 6.6.6 限流（配对、消息、安装）
- [ ] 6.6.7 日志保留与脱敏
- [ ] 6.6.8 SLO 与降级策略

### 6.7 部署

- [ ] 6.7.1 部署文档（控制面 + 沙箱 + 网关）
- [ ] 6.7.2 systemd/launchd 单元 + 日志轮转
- [ ] 6.7.3 反代与 TLS（同源、无 CORS）
- [ ] 6.7.4 备份/恢复（SQLite + 卷快照）
- [ ] 6.7.5 升级与回滚流程
- [ ] 6.7.6 多环境配置（dev/staging/prod）

## 工程债（P2/P3）

- [ ] E1 删除或标注 legacy `apps/runtime/worker.ts`（headless 逐条 fork）
- [ ] E2 `bot-manifest` / `event-schema` 补 `src/`（TS 类型生成 + 校验 CLI）
- [ ] E3 迁移 0004+（bots/rooms 扩展/rounds/sessions/marketplace）
- [ ] E4 用起来 `runtimes` / `capability_grants` / `invites` 表（或删除）
- [ ] E5 planA-boot 收编为控制面接口
- [ ] E6 runtime token 从 env 改为 provider
- [ ] E7 CI 在远端/GitHub 真跑（typecheck + 138 测试）
- [ ] E8 远端 e2e 自动化（脚本 → CI job）
- [ ] E9 web 端从"UI 切片"升级（组件化、tokens 包接入、可访问性审计）
- [ ] E10 统一 SSE 断线重连与去重（已有 after=seq，补客户端）
- [ ] E11 错误码/文案统一（中文 + 稳定 code）
- [ ] E12 包版本与发布（Changesets 或手写 CHANGELOG）

## 文档待写

- [ ] D1 `docs/design/observability.md`（指标/日志/审计/告警）
- [ ] D2 `docs/design/deployment.md`（部署/升级/备份/回滚）
- [ ] D3 `docs/design/slo.md`（SLO 与降级）——或并入 D1
- [ ] D4 `docs/design/compliance.md`（数据驻留/导出/删除/保留）
- [ ] D5 `docs/design/attachments-ui.md`（若 6.2 需要独立交互说明）
- [ ] D6 更新 `runtime-contract.md`（DSH web 表面 + SDK 会话）

## 已完成（清单建立前）

- [x] 事件日志 + 幂等 + 迁移（`packages/store`，53 测试）
- [x] 控制面最小 API（配对/会话/workspace/房间/消息/SSE，46 测试）
- [x] 网页配对页 + 房间页（真实 API + SSE + Markdown）
- [x] room-agent：长活 SDK + 每房间会话 + resume（4 测试）
- [x] 用户沙箱管理：固定名/复用/Error 重建（4 测试）
- [x] OpenShell 后端 + 策略渲染（8 测试）
- [x] 远端实测：真实 DeepSeek 回合、凭据注入、多轮 4271、stop/start 后仍记得
- [x] 设计文档 19 份 + 决策 4 份 + 实验 2 份

## 变更日志

- 2026-11-04 建立清单（149 项：M4 41 · M5 35 · M6 47 · 工程债 12 · 文档 6 · 已完成 8）。
- 2026-11-04 M4 拆给 4 个子 agent 并行实现（数据/API、轮次引擎、前端、runtime），Lead 验收并集成轮次接口。
- 2026-11-04 头像链路打通：store 的 image 上限从 512 字符放宽到 512k 字符 + dataURL 校验，API body 上限 64KiB→1MiB；HTTP 350k 字符冒烟通过。
- 2026-11-04 收尾修正：kickoff 轮未结束时用户消息并入同一轮（否则 cloud-run 的双 Bot 验收会只回一个）。
- 2026-11-04 第二批子 agent：kickoff（DM+群）、Bot 建群+审批+配额、头像上传/审批页、轮次 stop/宽限/late rounds 全部落地并接线；367 测试 + 4 个 HTTP 冒烟（kickoff/审批/stop）全过。
- 2026-11-04 M4 主体完成：bots CRUD/建群/成员/responder/轮次引擎/内部接口/workspace start-local/前端四视图；本地 HTTP 冒烟 14/14、本地双 Bot E2E 通过。剩：kickoff、软删、Bot 建群、profile sync、远端真实模型双 Bot、浏览器全流程（见 4.1.5/4.1.6/4.2.14/4.2.15/4.3.4/4.5.1/4.5.3/4.5.4）。
- 2026-11-04 M4 收尾第三批子 agent：Bot 软删 7 天 + 恢复（迁移 0010、`POST /api/bots/:id/restore`、删即退房 + `bot.removed_from_room`）、`bot.created/updated/deleted/restored` 事件、房间日志裁剪投影（保留 60 / 首看 12 / `before` 翻页 / 增量不受影响）、`DELETE /api/rooms/:id`、profile sync 拉锁（`POST /api/internal/plugins/sync`，ensure 前硬门 + `ROOST_PROFILE_LOCK_ID` 注入沙箱）。392 测试全绿 + 真实 HTTP 冒烟（锁拉取/软删/恢复/删房间）通过。M4 仅剩远端真实模型验收（4.5.3/4.5.4）。
