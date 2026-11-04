# 错误码

> 本文件由 `node scripts/error-codes.mjs` 生成，**不要手改**。
> 改完 `apps/api/src/**` 的 `sendError` 调用后重跑；CI 用
> `node scripts/error-codes.mjs --check` 校验是否过期。

## 约定

- `error.code` 是**稳定契约**：英文、小写点分；前端按 code 分支，不要匹配中文文案。
- **只增不改不删**。重命名等于破坏兼容；废弃的 code 先保留，等下一个大版本再删。
- `error.message` 面向人：`sendError` 在 `ERROR_TEXT` 有词条时拼成
  `中文文案（调用点细节）`，没有词条时原样返回调用点给的 message。
- HTTP 状态表达类别。同一个 code 在极少数上下文里可能返回不同状态，下表列出全部。
- 只统计字面量调用；转发型调用（`parsed.code` / `auth.code` / `body.code`）复用上游
  或鉴权层的 code，不重复列出。`sendError` 定义本身不计入。

## 总览

- 调用点：**575** 个
- 唯一 code：**93** 个
- 覆盖模块：**20** 个文件
- 有中文文案（`ERROR_TEXT`）：**23** 个；其余回退调用点 message

## 按模块

### `approvals-routes.ts`（32 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `approval.invalid` | 400 | — | 1 |
| `approval.not_found` | 404 | — | 1 |
| `approval_grant.not_found` | 404 | — | 1 |
| `forbidden` | 403 | — | 3 |
| `internal_error` | 500 | 服务出错了，请稍后重试 | 1 |
| `invalid_body` | 400 | 请求内容不完整或格式不对 | 15 |
| `not_found` | 404 | — | 3 |
| `runtime.not_configured` | 503 | — | 5 |
| `unauthenticated` | 401 | 请先配对：缺少有效的会话令牌 | 1 |
| `workspace_not_found` | 404 | 找不到这个 workspace | 1 |

### `attachments-routes.ts`（17 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `attachment.token_invalid` | 403 | — | 1 |
| `forbidden` | 403 | — | 1 |
| `internal_error` | 500 | 服务出错了，请稍后重试 | 3 |
| `invalid_body` | 400 | 请求内容不完整或格式不对 | 2 |
| `not_found` | 404 | — | 5 |
| `payload_too_large` | 413 | 请求体过大 | 2 |
| `runtime.not_configured` | 503 | — | 2 |
| `unauthenticated` | 401 | 请先配对：缺少有效的会话令牌 | 1 |

### `audit-routes.ts`（4 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `forbidden` | 403 | — | 1 |
| `internal_error` | 500 | 服务出错了，请稍后重试 | 1 |
| `invalid_body` | 400 | 请求内容不完整或格式不对 | 1 |
| `runtime.not_configured` | 503 | — | 1 |

### `auth-devices-routes.ts`（3 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `device_not_found` | 404 | 找不到这个设备会话 | 1 |
| `devices_unavailable` | 503 | 设备管理需要 SQLite 存储 | 2 |

### `auth-login-routes.ts`（38 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `auth.csrf` | 403 | — | 1 |
| `auth.email_taken` | 409 | — | 2 |
| `auth.email_unverified` | 401 / 403 | — | 2 |
| `auth.invalid_credentials` | 401 | — | 1 |
| `auth.invalid_email` | 400 | — | 4 |
| `auth.oidc_failed` | 502 | — | 3 |
| `auth.oidc_state` | 400 | — | 4 |
| `auth.oidc_unavailable` | 404 | — | 2 |
| `auth.token_invalid` | 400 | — | 6 |
| `auth.unavailable` | 503 | — | 1 |
| `auth.weak_password` | 400 | — | 2 |
| `internal_error` | 500 | 服务出错了，请稍后重试 | 6 |
| `invalid_body` | 400 | 请求内容不完整或格式不对 | 3 |
| `unauthenticated` | 401 | 请先配对：缺少有效的会话令牌 | 1 |

### `bot-rooms-routes.ts`（33 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `approval.decided` | 409 | — | 1 |
| `approval.invalid` | 400 | — | 3 |
| `approval.not_found` | 404 | — | 2 |
| `bot.not_found` | 404 | 找不到这个 Bot | 2 |
| `bot.room_invalid` | 400 | — | 3 |
| `bot.room_members` | 400 | — | 2 |
| `bot.room_quota` | 429 | — | 1 |
| `bot.room_workspace` | 403 | — | 1 |
| `forbidden` | 403 | — | 2 |
| `internal_error` | 500 | 服务出错了，请稍后重试 | 1 |
| `invalid_body` | 400 | 请求内容不完整或格式不对 | 5 |
| `not_found` | 404 | — | 2 |
| `room.invalid` | 400 | 房间信息不合法 | 1 |
| `room.members` | 400 | 房间成员不合法 | 1 |
| `room.responder` | 400 | 「谁回答」必须指向房间成员 | 1 |
| `runtime.not_configured` | 503 | — | 3 |
| `unauthenticated` | 401 | 请先配对：缺少有效的会话令牌 | 1 |
| `workspace_not_found` | 404 | 找不到这个 workspace | 1 |

### `bots-routes.ts`（26 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `bot.invalid` | 400 | Bot 信息不合法 | 8 |
| `bot.name_taken` | 409 | 这个 workspace 里已经有同名 Bot | 1 |
| `bot.no_model` | 400 | 创建 Bot 时必须指定模型 | 2 |
| `bot.not_found` | 404 | 找不到这个 Bot | 2 |
| `bot.restore_expired` | 409 | — | 1 |
| `forbidden` | 403 | — | 1 |
| `internal_error` | 500 | 服务出错了，请稍后重试 | 1 |
| `invalid_body` | 400 | 请求内容不完整或格式不对 | 4 |
| `no_workspace` | 409 | — | 1 |
| `not_found` | 404 | — | 4 |
| `workspace_not_found` | 404 | 找不到这个 workspace | 1 |

### `budget-routes.ts`（57 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `budget.invalid` | 400 | — | 1 |
| `forbidden` | 403 | — | 4 |
| `internal_error` | 500 | 服务出错了，请稍后重试 | 1 |
| `invalid_body` | 400 | 请求内容不完整或格式不对 | 42 |
| `not_found` | 404 | — | 2 |
| `quota_exhausted` | 429 | — | 1 |
| `quota_not_found` | 404 | — | 2 |
| `reservation_not_found` | 404 | — | 1 |
| `runtime.not_configured` | 503 | — | 1 |
| `unauthenticated` | 401 | 请先配对：缺少有效的会话令牌 | 1 |
| `workspace_not_found` | 404 | 找不到这个 workspace | 1 |

### `connectors-routes.ts`（37 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `connector.connect_failed` | 400 | — | 1 |
| `connector.invalid` | 400 | — | 1 |
| `connector.invalid_state` | 400 | — | 2 |
| `connector.not_configured` | 501 | — | 2 |
| `connector.oauth_failed` | 400 | — | 1 |
| `connector.unavailable` | 502 | — | 2 |
| `forbidden` | 403 | — | 5 |
| `internal_error` | 500 | 服务出错了，请稍后重试 | 1 |
| `invalid_body` | 400 | 请求内容不完整或格式不对 | 13 |
| `not_found` | 404 | — | 6 |
| `runtime.not_configured` | 503 | — | 1 |
| `unauthenticated` | 401 | 请先配对：缺少有效的会话令牌 | 1 |
| `workspace_not_found` | 404 | 找不到这个 workspace | 1 |

### `dsh-proxy-routes.ts`（12 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `dsh.not_running` | 503 | — | 1 |
| `dsh.unavailable` | 502 | — | 2 |
| `not_found` | 404 | — | 2 |
| `runtime.not_configured` | 503 | — | 1 |
| `unauthenticated` | 401 | 请先配对：缺少有效的会话令牌 | 1 |
| `workspace_not_found` | 404 | 找不到这个 workspace | 5 |

### `health-deep.ts`（1 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `method_not_allowed` | 405 | — | 1 |

### `marketplace-install-routes.ts`（49 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `forbidden` | 403 | — | 8 |
| `internal_error` | 500 | 服务出错了，请稍后重试 | 1 |
| `invalid_body` | 400 | 请求内容不完整或格式不对 | 7 |
| `not_found` | 404 | — | 8 |
| `plugin.already_installed` | 409 | — | 1 |
| `plugin.install_not_found` | 404 / 409 | — | 6 |
| `plugin.invalid_slug` | 400 | — | 1 |
| `plugin.job_invalid` | 400 | — | 1 |
| `plugin.job_not_found` | 404 | — | 3 |
| `plugin.job_pending` | 409 | — | 2 |
| `plugin.job_state` | 409 | — | 3 |
| `plugin.not_found` | 404 | — | 2 |
| `plugin.version_not_found` | 404 | — | 2 |
| `rate_limited` | 429 | 操作太频繁，请稍后再试 | 1 |
| `runtime.not_configured` | 503 | — | 1 |
| `unauthenticated` | 401 | 请先配对：缺少有效的会话令牌 | 1 |
| `workspace_not_found` | 404 | 找不到这个 workspace | 1 |

### `marketplace-routes.ts`（52 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `forbidden` | 403 | — | 7 |
| `internal_error` | 500 | 服务出错了，请稍后重试 | 1 |
| `invalid_body` | 400 | 请求内容不完整或格式不对 | 17 |
| `not_found` | 404 | — | 6 |
| `plugin.already_installed` | 409 | — | 1 |
| `plugin.install_not_found` | 404 | — | 2 |
| `plugin.invalid_slug` | 400 | — | 1 |
| `plugin.not_found` | 404 | — | 5 |
| `plugin.preflight_failed` | 400 | — | 2 |
| `plugin.publisher_unverified` | 403 | — | 2 |
| `plugin.tier` | 400 | — | 2 |
| `plugin.version_not_found` | 404 | — | 3 |
| `rate_limited` | 429 | 操作太频繁，请稍后再试 | 1 |
| `runtime.not_configured` | 503 | — | 1 |
| `workspace_not_found` | 404 | 找不到这个 workspace | 1 |

### `members-routes.ts`（14 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `forbidden` | 403 | — | 4 |
| `internal_error` | 500 | 服务出错了，请稍后重试 | 1 |
| `invalid_body` | 400 | 请求内容不完整或格式不对 | 2 |
| `member_not_found` | 404 | — | 1 |
| `runtime.not_configured` | 503 | — | 3 |
| `workspace.invalid_role` | 400 | — | 1 |
| `workspace.last_owner` | 409 | — | 1 |
| `workspace_not_found` | 404 | 找不到这个 workspace | 1 |

### `memories-routes.ts`（41 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `forbidden` | 403 | — | 3 |
| `internal_error` | 500 | 服务出错了，请稍后重试 | 1 |
| `invalid_body` | 400 | 请求内容不完整或格式不对 | 20 |
| `memory.daily_limit` | 429 | — | 1 |
| `memory.invalid` | 400 | — | 6 |
| `memory.not_found` | 404 | — | 2 |
| `not_found` | 404 | — | 2 |
| `runtime.not_configured` | 503 | — | 1 |
| `unauthenticated` | 401 | 请先配对：缺少有效的会话令牌 | 1 |
| `workspace_not_found` | 404 | 找不到这个 workspace | 4 |

### `model-proxy-routes.ts`（2 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `internal_error` | 500 | 服务出错了，请稍后重试 | 1 |
| `workspace_required` | 400 | — | 1 |

### `plugins-sync-routes.ts`（3 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `not_found` | 404 | — | 1 |
| `profile.lock_unavailable` | 500 | — | 1 |
| `unauthenticated` | 401 | 请先配对：缺少有效的会话令牌 | 1 |

### `rooms-routes-ext.ts`（40 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `forbidden` | 403 | — | 2 |
| `internal_error` | 500 | 服务出错了，请稍后重试 | 1 |
| `invalid_body` | 400 | 请求内容不完整或格式不对 | 5 |
| `no_workspace` | 409 | — | 2 |
| `not_found` | 404 | — | 5 |
| `room.invalid` | 400 | 房间信息不合法 | 8 |
| `room.members` | 400 / 404 | 房间成员不合法 | 9 |
| `room.responder` | 400 | 「谁回答」必须指向房间成员 | 4 |
| `room_not_found` | 404 | 找不到这个房间 | 3 |
| `workspace_not_found` | 404 | 找不到这个 workspace | 1 |

### `schedules-routes.ts`（33 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `forbidden` | 403 | — | 4 |
| `internal_error` | 500 | 服务出错了，请稍后重试 | 1 |
| `invalid_body` | 400 | 请求内容不完整或格式不对 | 16 |
| `not_found` | 404 | — | 1 |
| `run.not_found` | 404 | — | 2 |
| `runtime.not_configured` | 503 | — | 1 |
| `schedule.exists` | 409 | — | 1 |
| `schedule.invalid` | 400 | — | 2 |
| `schedule.not_found` | 404 | — | 4 |
| `unauthenticated` | 401 | 请先配对：缺少有效的会话令牌 | 1 |

### `server.ts`（81 个调用点）

| code | HTTP | 中文文案 | 次数 |
| --- | --- | --- | ---: |
| `csrf.invalid` | 403 | — | 1 |
| `forbidden` | 403 | — | 1 |
| `forbidden_origin` | 403 | 写操作来源不被允许 | 1 |
| `internal_error` | 500 | 服务出错了，请稍后重试 | 4 |
| `invalid_body` | 400 | 请求内容不完整或格式不对 | 17 |
| `model_proxy_not_configured` | 501 | — | 1 |
| `not_found` | 404 | — | 27 |
| `pairing_code_expired` | 401 | 配对码已过期，请重新生成 | 1 |
| `pairing_code_invalid` | 401 | 配对码不对 | 1 |
| `pairing_code_locked` | 429 | 尝试次数过多，请重新生成配对码 | 1 |
| `pairing_code_used` | 401 | 这个配对码已经用过了 | 1 |
| `pairing_unavailable` | 503 | — | 1 |
| `panel.unavailable` | 503 | — | 1 |
| `quota_exhausted` | 429 | — | 1 |
| `rate_limited` | 429 | 操作太频繁，请稍后再试 | 1 |
| `room_not_found` | 404 | 找不到这个房间 | 2 |
| `round.conflict` | 409 | — | 1 |
| `round.not_found` | 404 | — | 1 |
| `runtime.not_configured` | 503 | — | 9 |
| `runtime.start_failed` | 502 | — | 1 |
| `session_create_failed` | 500 | — | 1 |
| `session_expired` | 401 | 会话已过期，请重新配对 | 1 |
| `too_many_attempts` | 429 | 尝试次数过多，请稍后再试 | 1 |
| `unauthenticated` | 401 | 请先配对：缺少有效的会话令牌 | 3 |
| `workspace_not_found` | 404 | 找不到这个 workspace | 1 |

## code 索引

| code | HTTP 状态 | 出现模块 |
| --- | --- | --- |
| `approval.decided` | 409 | `bot-rooms-routes.ts` |
| `approval.invalid` | 400 | `approvals-routes.ts`<br>`bot-rooms-routes.ts` |
| `approval.not_found` | 404 | `approvals-routes.ts`<br>`bot-rooms-routes.ts` |
| `approval_grant.not_found` | 404 | `approvals-routes.ts` |
| `attachment.token_invalid` | 403 | `attachments-routes.ts` |
| `auth.csrf` | 403 | `auth-login-routes.ts` |
| `auth.email_taken` | 409 | `auth-login-routes.ts` |
| `auth.email_unverified` | 401 / 403 | `auth-login-routes.ts` |
| `auth.invalid_credentials` | 401 | `auth-login-routes.ts` |
| `auth.invalid_email` | 400 | `auth-login-routes.ts` |
| `auth.oidc_failed` | 502 | `auth-login-routes.ts` |
| `auth.oidc_state` | 400 | `auth-login-routes.ts` |
| `auth.oidc_unavailable` | 404 | `auth-login-routes.ts` |
| `auth.token_invalid` | 400 | `auth-login-routes.ts` |
| `auth.unavailable` | 503 | `auth-login-routes.ts` |
| `auth.weak_password` | 400 | `auth-login-routes.ts` |
| `bot.invalid` | 400 | `bots-routes.ts` |
| `bot.name_taken` | 409 | `bots-routes.ts` |
| `bot.no_model` | 400 | `bots-routes.ts` |
| `bot.not_found` | 404 | `bot-rooms-routes.ts`<br>`bots-routes.ts` |
| `bot.restore_expired` | 409 | `bots-routes.ts` |
| `bot.room_invalid` | 400 | `bot-rooms-routes.ts` |
| `bot.room_members` | 400 | `bot-rooms-routes.ts` |
| `bot.room_quota` | 429 | `bot-rooms-routes.ts` |
| `bot.room_workspace` | 403 | `bot-rooms-routes.ts` |
| `budget.invalid` | 400 | `budget-routes.ts` |
| `connector.connect_failed` | 400 | `connectors-routes.ts` |
| `connector.invalid` | 400 | `connectors-routes.ts` |
| `connector.invalid_state` | 400 | `connectors-routes.ts` |
| `connector.not_configured` | 501 | `connectors-routes.ts` |
| `connector.oauth_failed` | 400 | `connectors-routes.ts` |
| `connector.unavailable` | 502 | `connectors-routes.ts` |
| `csrf.invalid` | 403 | `server.ts` |
| `device_not_found` | 404 | `auth-devices-routes.ts` |
| `devices_unavailable` | 503 | `auth-devices-routes.ts` |
| `dsh.not_running` | 503 | `dsh-proxy-routes.ts` |
| `dsh.unavailable` | 502 | `dsh-proxy-routes.ts` |
| `forbidden` | 403 | `approvals-routes.ts`<br>`attachments-routes.ts`<br>`audit-routes.ts`<br>`bot-rooms-routes.ts`<br>`bots-routes.ts`<br>`budget-routes.ts`<br>`connectors-routes.ts`<br>`marketplace-install-routes.ts`<br>`marketplace-routes.ts`<br>`members-routes.ts`<br>`memories-routes.ts`<br>`rooms-routes-ext.ts`<br>`schedules-routes.ts`<br>`server.ts` |
| `forbidden_origin` | 403 | `server.ts` |
| `internal_error` | 500 | `approvals-routes.ts`<br>`attachments-routes.ts`<br>`audit-routes.ts`<br>`auth-login-routes.ts`<br>`bot-rooms-routes.ts`<br>`bots-routes.ts`<br>`budget-routes.ts`<br>`connectors-routes.ts`<br>`marketplace-install-routes.ts`<br>`marketplace-routes.ts`<br>`members-routes.ts`<br>`memories-routes.ts`<br>`model-proxy-routes.ts`<br>`rooms-routes-ext.ts`<br>`schedules-routes.ts`<br>`server.ts` |
| `invalid_body` | 400 | `approvals-routes.ts`<br>`attachments-routes.ts`<br>`audit-routes.ts`<br>`auth-login-routes.ts`<br>`bot-rooms-routes.ts`<br>`bots-routes.ts`<br>`budget-routes.ts`<br>`connectors-routes.ts`<br>`marketplace-install-routes.ts`<br>`marketplace-routes.ts`<br>`members-routes.ts`<br>`memories-routes.ts`<br>`rooms-routes-ext.ts`<br>`schedules-routes.ts`<br>`server.ts` |
| `member_not_found` | 404 | `members-routes.ts` |
| `memory.daily_limit` | 429 | `memories-routes.ts` |
| `memory.invalid` | 400 | `memories-routes.ts` |
| `memory.not_found` | 404 | `memories-routes.ts` |
| `method_not_allowed` | 405 | `health-deep.ts` |
| `model_proxy_not_configured` | 501 | `server.ts` |
| `no_workspace` | 409 | `bots-routes.ts`<br>`rooms-routes-ext.ts` |
| `not_found` | 404 | `approvals-routes.ts`<br>`attachments-routes.ts`<br>`bot-rooms-routes.ts`<br>`bots-routes.ts`<br>`budget-routes.ts`<br>`connectors-routes.ts`<br>`dsh-proxy-routes.ts`<br>`marketplace-install-routes.ts`<br>`marketplace-routes.ts`<br>`memories-routes.ts`<br>`plugins-sync-routes.ts`<br>`rooms-routes-ext.ts`<br>`schedules-routes.ts`<br>`server.ts` |
| `pairing_code_expired` | 401 | `server.ts` |
| `pairing_code_invalid` | 401 | `server.ts` |
| `pairing_code_locked` | 429 | `server.ts` |
| `pairing_code_used` | 401 | `server.ts` |
| `pairing_unavailable` | 503 | `server.ts` |
| `panel.unavailable` | 503 | `server.ts` |
| `payload_too_large` | 413 | `attachments-routes.ts` |
| `plugin.already_installed` | 409 | `marketplace-install-routes.ts`<br>`marketplace-routes.ts` |
| `plugin.install_not_found` | 404 / 409 | `marketplace-install-routes.ts`<br>`marketplace-routes.ts` |
| `plugin.invalid_slug` | 400 | `marketplace-install-routes.ts`<br>`marketplace-routes.ts` |
| `plugin.job_invalid` | 400 | `marketplace-install-routes.ts` |
| `plugin.job_not_found` | 404 | `marketplace-install-routes.ts` |
| `plugin.job_pending` | 409 | `marketplace-install-routes.ts` |
| `plugin.job_state` | 409 | `marketplace-install-routes.ts` |
| `plugin.not_found` | 404 | `marketplace-install-routes.ts`<br>`marketplace-routes.ts` |
| `plugin.preflight_failed` | 400 | `marketplace-routes.ts` |
| `plugin.publisher_unverified` | 403 | `marketplace-routes.ts` |
| `plugin.tier` | 400 | `marketplace-routes.ts` |
| `plugin.version_not_found` | 404 | `marketplace-install-routes.ts`<br>`marketplace-routes.ts` |
| `profile.lock_unavailable` | 500 | `plugins-sync-routes.ts` |
| `quota_exhausted` | 429 | `budget-routes.ts`<br>`server.ts` |
| `quota_not_found` | 404 | `budget-routes.ts` |
| `rate_limited` | 429 | `marketplace-install-routes.ts`<br>`marketplace-routes.ts`<br>`server.ts` |
| `reservation_not_found` | 404 | `budget-routes.ts` |
| `room.invalid` | 400 | `bot-rooms-routes.ts`<br>`rooms-routes-ext.ts` |
| `room.members` | 400 / 404 | `bot-rooms-routes.ts`<br>`rooms-routes-ext.ts` |
| `room.responder` | 400 | `bot-rooms-routes.ts`<br>`rooms-routes-ext.ts` |
| `room_not_found` | 404 | `rooms-routes-ext.ts`<br>`server.ts` |
| `round.conflict` | 409 | `server.ts` |
| `round.not_found` | 404 | `server.ts` |
| `run.not_found` | 404 | `schedules-routes.ts` |
| `runtime.not_configured` | 503 | `approvals-routes.ts`<br>`attachments-routes.ts`<br>`audit-routes.ts`<br>`bot-rooms-routes.ts`<br>`budget-routes.ts`<br>`connectors-routes.ts`<br>`dsh-proxy-routes.ts`<br>`marketplace-install-routes.ts`<br>`marketplace-routes.ts`<br>`members-routes.ts`<br>`memories-routes.ts`<br>`schedules-routes.ts`<br>`server.ts` |
| `runtime.start_failed` | 502 | `server.ts` |
| `schedule.exists` | 409 | `schedules-routes.ts` |
| `schedule.invalid` | 400 | `schedules-routes.ts` |
| `schedule.not_found` | 404 | `schedules-routes.ts` |
| `session_create_failed` | 500 | `server.ts` |
| `session_expired` | 401 | `server.ts` |
| `too_many_attempts` | 429 | `server.ts` |
| `unauthenticated` | 401 | `approvals-routes.ts`<br>`attachments-routes.ts`<br>`auth-login-routes.ts`<br>`bot-rooms-routes.ts`<br>`budget-routes.ts`<br>`connectors-routes.ts`<br>`dsh-proxy-routes.ts`<br>`marketplace-install-routes.ts`<br>`memories-routes.ts`<br>`plugins-sync-routes.ts`<br>`schedules-routes.ts`<br>`server.ts` |
| `workspace.invalid_role` | 400 | `members-routes.ts` |
| `workspace.last_owner` | 409 | `members-routes.ts` |
| `workspace_not_found` | 404 | `approvals-routes.ts`<br>`bot-rooms-routes.ts`<br>`bots-routes.ts`<br>`budget-routes.ts`<br>`connectors-routes.ts`<br>`dsh-proxy-routes.ts`<br>`marketplace-install-routes.ts`<br>`marketplace-routes.ts`<br>`members-routes.ts`<br>`memories-routes.ts`<br>`rooms-routes-ext.ts`<br>`server.ts` |
| `workspace_required` | 400 | `model-proxy-routes.ts` |
