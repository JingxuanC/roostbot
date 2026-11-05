# 认证：配对为主，密码为辅

> 状态：方案（2026-11-03）。配套：`workspace.md`（多端）、`events.md`（`auth.*` 事件）。

## 1. 一句话

**设备用一次性配对码换长期会话，不用密码登录；账号本身才需要密码或 OIDC。** 这来自三家实践的交集（OpenMausBot 的配对、DSH 的 URL token、我们自己的桌面端）。

## 2. 五类凭据

| 凭据 | 签发者 | 持有者 | 有效期 | 用途 |
|---|---|---|---|---|
| **配对码** | 控制面 | 人（口头/二维码） | **5 分钟**、单次 | 换设备会话 |
| **设备会话** | 控制面 | 浏览器 / 桌面 / 手机 | 30 天，剩余 <15 天时使用可续到 180 天 | 访问控制面 |
| **runtime token** | 控制面 | workspace 容器 | 分钟级，随容器 | 访问该容器的 DSH |
| **节点 token** | 控制面 | 本地能力节点 | 90 天，可吊销 | 出站连控制面 |
| **服务 token** | 控制面 | 内部服务 | 短期 | 服务间调用 |

**硬规则**：这五类互不替代。尤其 provider token（BYO 模型 key）只由模型代理持有，不属于这一层（见 `sandboxing.md` §4）。

## 3. 配对流程

```
① 已登录的设备/网页上点「添加设备」
     ↓ 控制面签发配对码（5 分钟、单次、绑定 workspace 或账号）
② 新设备输入配对码（或扫二维码）
     ↓ 控制面校验：未使用、未过期、未超尝试次数（5 次/分钟）
③ 新设备得到设备会话 + device_id；旧设备收到 auth.paired 事件
④ 新设备出现在「设备列表」，可单独吊销
```

**为什么不用密码登录设备**：设备是"窗口"，不是身份。密码只在**创建账号**和**恢复账号**时用。

**配对码安全**：6 位数字 + 速率限制；错误 5 次/分钟即锁 10 分钟；配对码只能换一次会话。

## 4. 账号

| 方式 | 用途 | 说明 |
|---|---|---|
| 邮箱 + 密码 | 主账号 | 密码 ≥ 12 位；Argon2id 哈希 |
| 邮箱验证码 | 登录（免密码） | 一次性、10 分钟 |
| 邮件 | SMTP（ROOST_SMTP_*）或默认写 journald | 注册验证、重置密码；未配置 SMTP 时不会真的发信 |
| OIDC | 任意标准 OIDC（Keycloak / Logto / Casdoor / Authentik / Google / GitHub…） | 企业客户与自托管优先；不自动合并同名邮箱；接入见 [deploy/oidc/README.md](../../deploy/oidc/README.md) |
| 邀请 | 加入 workspace | 邀请链接绑定邮箱 + 角色，7 天有效 |

**会话续期**：剩余有效期 < 15 天时，任意一次有效请求把会话续到 180 天（自配对起算）。超过 180 天必须重新配对——防止"一次配对永久有效"。

## 5. 角色与权限

| 角色 | 能做什么 |
|---|---|
| `owner` | 全部：计费、删除 workspace、转让 |
| `admin` | 成员管理、Bot 与插件、设备、策略 |
| `member` | 使用 Bot、房间、自己的会话；**不能**改策略、不能加成员 |
| `viewer` | 只读：看时间线、看报告；不能发消息 |

规则：

- 只有 owner/admin 能签发配对码
- 只有 owner 能删 workspace / 改计费
- 角色变更写 `auth.role.changed` 事件
- **Bot 没有角色**：Bot 的能力由 `bot-manifest` 与 sandbox 策略决定（`sandboxing.md`）

## 6. runtime token 与节点 token

```
控制面 ──(创建容器时注入)──► runtime token ──► DSH 的 /api/* 校验
本地节点 ──(出站 WS 带 node token)──► 控制面 ──► 绑定 workspace 与 grants
```

- runtime token：`rt_<workspace>_<nonce>`，容器重启即换；**浏览器永不接触**
- 节点 token：`nt_<node>_<nonce>`，与 workspace 绑定；吊销后节点立即断开
- 两者都不写进卷的明文（runtime token 只在进程内存）

## 7. 威胁模型

| 威胁 | 对策 |
|---|---|
| 配对码被偷看 | 5 分钟 + 单次 + 速率限制；高风险操作要求 owner 二次确认 |
| 设备丢失 | 设备列表一键吊销；吊销写 `auth.session.revoked` |
| token 重放 | 会话 token 绑 device_id + UA 指纹（弱绑定，只用于异常检测） |
| CSRF | 控制面所有写操作要求 `Origin` 校验 + 自定义头 |
| XSS 偷 token | 账号会话放 HttpOnly cookie；设备配对的 sessionToken 为支持手机网页刷新持久化，存 localStorage（同源、仅 token；所有渲染走 textContent，避免注入） |
| URL 泄漏 | **禁止把 token 放 query string**（DSH 桌面端那样是本地妥协，云上不学） |
| 日志泄漏 | 全链路脱敏（与 bot-events 同一套规则） |
| 内部越权 | 控制面每个路由显式声明所需角色 |

## 8. 失败与 UX

| 场景 | 表现 |
|---|---|
| 配对码过期 | 「配对码已过期，请重新生成」 |
| 会话过期 | 跳转配对页，不丢当前 workspace 选择 |
| token 被吊销 | 当前请求 401，提示「已在其他设备退出」 |
| 角色不足 | 403 + 说明缺哪个角色 |
| OIDC 邮箱与已有账号冲突 | 要求先用密码登录再绑定 |

## 9. 数据模型

```sql
CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT,                     -- Argon2id；OIDC-only 账号为空
  oidc_subject  TEXT,
  created_at    INTEGER NOT NULL,
  disabled_at   INTEGER
);

CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  label         TEXT,
  platform      TEXT,                     -- web|desktop|ios|android|cli
  last_seen_at  INTEGER,
  revoked_at    INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE pairing_codes (
  code          TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  workspace_id  TEXT,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  device_id     TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);

CREATE TABLE invites (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  accepted_at   INTEGER
);
```

## 10. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 邮箱 + 密码创建账号 |
| POST | `/api/auth/login` | 密码登录（返回设备会话） |
| POST | `/api/auth/email-code` | 发验证码 |
| POST | `/api/auth/oidc/:provider` | OIDC 回跳 |
| POST | `/api/pairing/codes` | 生成配对码（owner/admin） |
| POST | `/api/pairing/claim` | 用配对码换会话 |
| GET | `/api/devices` | 我的设备 |
| DELETE | `/api/devices/:id` | 吊销设备 |
| POST | `/api/workspaces/:id/invites` | 邀请成员 |
| DELETE | `/api/sessions/current` | 退出当前设备 |

## 11. 待决问题

1. **配对码绑定账号还是 workspace？**（绑定 workspace 更细，但一个账号多 workspace 时要分别配对）
2. **桌面端能不能免配对**（本机回环 + 文件权限证明）？倾向：仍要配对，但可自动续期。
3. **OIDC 与密码同邮箱合并策略**：自动合并（方便）还是拒绝（安全）？
4. **二次确认**用密码还是邮箱验证码（高风险操作时）？

## 12. 实现说明（v0 已落地的部分）

代码在 `apps/api`（控制面）与 `packages/store`（SQLite 存储）。与上文有意不同的地方：

| 文档 | 实现 | 原因 |
|---|---|---|
| `POST /api/pairing/codes`（§10） | `POST /api/pairing/code` | 单数，与 claim 配对 |
| token 放 HttpOnly cookie（§7） | `Authorization: Bearer` + 前端内存变量 | v0 还没有同源 HTTPS 部署；cookie 与 CSRF 一起留给 v1 |
| `claim` 响应只写 `{deviceId, sessionToken}` | 多返回 `expiresAt` | 前端要显示"这设备何时需要重新配对" |
| 签发配对码需要 owner/admin 会话（§5） | 已实现：带 Bearer 时 `body.accountId` 必须等于会话账号，`workspaceId` 必须是该账号 owner/admin 的 workspace；无会话时只走 bootstrap 例外 | 首配没有会话可带；v0 以账号维度判定「目标 workspace 无有效会话」（sessions 表没有 workspace_id） |
| `GET /api/devices` / `DELETE /api/devices/:id`（§10） | 已实现，但需要 SQLite 存储；`:id` 是会话 id（不是 device id），吊销写 `auth.session.revoked` | memory port 没有会话查询与事件投影，两个接口返回 503 `devices_unavailable` |
| 「5 次/分钟锁 10 分钟」 | 失败累计 5 次即锁；成功清零；已用码再试也计一次失败 | 表里没有时间窗列；码本身 5 分钟过期 |
| 会话续期「<15 天续到 180 天」 | 已实现（SQLite 模式）：有效请求在剩余 <15 天且未到 180 天封顶时续到 `createdAt+180d`，只增不减；memory 模式仍固定 30 天 | memory port 没有会话查询接口 |
| 中文话术 | `{code, message}`：message 中文 + 括号里保留技术细节 | 前端可以按 `code` 分支，人能看懂 |

**bootstrap 例外（配对码签发）**：仅当请求来自回环地址（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`）且该账号尚无任何有效会话时，才允许不带 Bearer 签发配对码；账号一旦有会话，再签发必须带该账号的有效 Bearer。带了但无效的 Bearer 不会回退到 bootstrap。

同源伺服：`apps/api` 同时伺服 `apps/web`（`GET /`），所以不需要 CORS；`?api=` 跨源在 v0 仍会被浏览器拦。

## 13. 实现补充：成员与角色（M5-5.3.3，邀请除外）

§10 只列了邀请接口；v0 还没有账号注册/邮箱体系，邀请留到 5.3.1。这一批先补「已有成员」的管理与角色强制：

| 方法 | 路径 | 需要的角色 | 说明 |
|---|---|---|---|
| GET | `/api/workspaces/:id/members` | 该 workspace 任意成员 | 非成员返回 404，不泄漏 workspace 是否存在 |
| PATCH | `/api/workspaces/:id/members/:accountId` | owner/admin | `{role}`；admin 不能授予 owner；最后一个 owner 不能降级 → 409 `workspace.last_owner` |
| DELETE | `/api/workspaces/:id/members/:accountId` | owner/admin | 移除自己允许，但最后一个 owner 不能移除 → 409 |

实现细节与 §5/§10 的差异：

- **`auth.member.removed` 是实现补充**：§5 只规定角色变更写 `auth.role.changed`；移除成员没有对应事件，本批补写 `auth.member.removed`（actor=user/by，subject=`{kind:'member',id:accountId}`，payload `{workspaceId, role}`）。
- **`auth.role.changed` 形状**：actor=`{kind:'user',id:by}`，subject=`{kind:'member',id:accountId}`，payload `{workspaceId, from, to}`；角色没变时不写事件。
- **行与事件同生共死**：角色变更/移除与事件写入在同一个 savepoint；事件写失败会回滚成员行。
- **`getWorkspaceRole` 不默认 viewer**：非成员返回 `null`；viewer 只用于展示，不能拿缺省值做授权（§5 的「内部越权」约束）。
- **角色强制范围（只做确定项）**：Bot 创建/更新/删除/恢复 = owner/admin；房间设置/删除/成员增删 = owner/admin；建房间 = member 及以上；发消息（`POST /api/rooms/:id/messages`）= member 及以上，viewer → 403 `forbidden`。审批决策、配对码、插件安装、附件维持原语义；`POST /api/rooms/:id/say` 是 runtime token 内部接口，不适用用户角色，未改。
- **memory port 没有成员表**：成员接口返回 503 `runtime.not_configured`；其余写接口在无 `rawStore` 时跳过角色校验，保持 v0 行为。
- **未做**：邀请（email + 角色绑定）、成员加入 API、`viewer` 在前端的只读 UI（前端由另一个 agent 负责）。
