# Changelog

本文件记录 Roost Bot 的用户可见变化，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。仓库尚未发布到 npm，tag 形如 `v0.1.0`。

## [Unreleased]

## [Unreleased]

### Bot 小鸟头像（2026-11-05）

- 新增程序化小鸟头像 `apps/web/lib/bird.js`：18 物种（可爱 9 + 夸张 9）× 8 配色 × 倾斜/眉形/标记 × 6 配饰，同一个 bot id 永远同一只鸟；20px 可辨。
- Bot 列表、房间消息、详情页、头像编辑器预览全部换用小鸟；人类账号仍用 glyph。
- 配饰按角色自动戴（眼镜/耳机/安全帽/王冠）；房间图标 = 成员鸟头 2×2 拼合（host 戴王冠）。
- 状态：working 呼吸环、paused 去饱和闭眼、alert 眉眼上扬；尊重 `prefers-reduced-motion`。
- 设计说明 `docs/design/bot-avatar.md`；预览图 `docs/assets/bot-birds.png`、应用内 `docs/assets/bot-birds-app.png`；9 条测试。

## [0.1.0] - 2026-11-04

首个可运行版本：**M4 产品闭环 + M5 平台能力主体**。零依赖，Node ≥ 22.18 直接跑
（`node --experimental-strip-types`），不需要构建步骤。

### Added

- **Bot 域**：创建/读取/修改/软删 Bot，名字锁、模型必填、程序化图标与头像上传；
  创建后 kickoff（模型自我介绍 + 问用途）。
- **房间与多 Bot 轮次**：`room_rounds` / 轮次状态机、responder 四模式（member / everyone /
  mentions / auto）、`@` 调用上限、`[PASS]` 静默、回复超时、工作宽限与 late rounds、
  房间日志裁剪（events 仍是事实源）。控制面 `POST /api/workspaces/:id/start` 启动用户沙箱。
- **认证与角色**：邮箱 + 密码（scrypt，OWASP 下限参数；接口可换 Argon2id）、邮箱验证码、
  OIDC（Google/GitHub）、
  HttpOnly cookie + CSRF 双提交、会话续期（180 天封顶）、设备列表/吊销、
  owner/admin/member/viewer 成员管理。
- **插件市场**：市场/详情/版本/预检 API，安装流水线（预检 → 权限披露 → 批准 → 写 profile 锁 →
  沙箱 sync → 冒烟 → 回滚）、已安装管理（更新/停用/卸载/回滚）、运行时禁 postinstall、
  安装前快照与失败自动回滚。
- **DSH web 面板**：沙箱内起 `dsh web`（127.0.0.1:4099），控制面反代 `/w/<workspace>/dsh/*`
  （短时 HttpOnly cookie、base path 剥离、HTML 重写），前端 iframe 容器与面板清单。
- **审批**：`approvals` 表与 API（列表/批准/拒绝/运行时轮询），长期授权与撤销，
  「需要你」页真实数据、决策审计事件（恰好一次）。
- **多端**：设备管理页、同一 workspace 两窗口同步（`LIVE.seen` 去重 + 按 seq 乱序插入）、
  离线重连补拉、深链、移动端布局、「需要你」通知去重。
- **存储与产物**：内容寻址的 `LocalVolumeStore`（原子写）、附件表 + 引用计数 + GC、
  上传/下载（Range、预签名）、消息级文件授权、产物渲染（image/pdf/html/table/code）与卡片。
- **记忆**：作用域读写（本地 SQLite，接口可替换 causal-memory）、预算内检索注入、
  supersede 冲突与审计、删除/导出。
- **预算与计量**：usage 记账、预留-结算、四层配额、429 与 80% 软限提醒、用量页。
- **调度**：routines + cron（含 DST）、幂等 + 12h catch-up、重叠策略、定时任务页与运行历史。
- **连接器**：GatewayBackend + OpenConnector HTTP 后端、OAuth state 校验、按 Bot 授权、
  动作级审批与幂等、调用审计、连接器卡片。
- **观测与部署**：结构化日志 + 请求 id（token 脱敏）、审计查询、限流、SLO/降级文档、
  systemd/launchd 单元、反代与 TLS、SQLite + 附件备份/恢复、升级/回滚、多环境配置。

### Changed

- **运行时统一到 room-agent**：每个 workspace 一个沙箱，容器主进程是 `room-agent.mjs`，
  内部跑长活 `dsh --profile sdk`（JSON-RPC over stdio）+ 每 `(room, bot)` 一个 session；
  不再是每条消息 fork 一次 headless DSH。控制面 `POST /api/workspaces/:id/start` 是唯一启动入口。
- CI 明确拆成三步：类型擦除语法检查、全量 `node --test`、错误码文档一致性校验；任一步失败即红。
- 错误码收敛为稳定英文 code + 中文文案（`docs/error-codes.md`，由脚本生成）。
- 包版本从 `0.0.0` 升到 `0.1.0`，新增 `release` / `errors` / `e2e` 脚本。

### Removed

- `apps/runtime/worker.ts`（legacy 轮询 worker：轮询控制面 + 每条消息 fork headless DSH）
  及其专属测试、`dev:worker` npm script（TODO E1）。
- `apps/runtime/planA-boot.mjs`（一次性引导脚本，已由控制面启动接口取代，TODO E5）。

### Security

- runtime token 目前仍是控制面 env 里的**单个共享 token**，由控制面注入沙箱并可访问所有
  workspace 的内部接口。这是 0.1.0 的已知妥协，边界与 provider 方案见
  [ADR 0005](docs/decisions/0005-runtime-token.md)。
- 本机（macOS/Windows）**不是安全沙箱**：只承诺用户自己的信任域；云上 workspace 容器才是
  隔离边界（`docs/design/sandboxing.md` §7）。

### Known limits

- 远端真实模型两轮对话、浏览器内全流程尚未验收（TODO 4.5.3 / 4.5.4）。
- 镜像的 Docker 构建与 Linux 行为未在本机验证（`apps/runtime/README.md` 的诚实边界）。
- `runtimes` / `capability_grants` / `invites` 表尚无代码消费者，保留原因与删除条件见
  [ADR 0006](docs/decisions/0006-unused-control-plane-tables.md)。
- `apps/runtime/sandbox-runner.ts` 只剩测试在用；生产路径是 room-agent。
