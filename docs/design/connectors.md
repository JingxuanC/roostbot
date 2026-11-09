# 连接器：网关在中间，凭据不进沙箱

> 状态：方案（2026-11-03）。默认网关 **OpenConnector（自托管）**，Composio 作托管备选，原生 MCP 作补充。配套：`sandboxing.md`（凭据流）、`loop-and-context.md`（工具 schema 是上下文成本）。

## 1. 一句话

**Bot 不直接拿任何第三方凭据。** 它看到的是一个工具名，调用经我们的连接器插件 → 网关 → 第三方；凭据只存在于网关。

这和 `sandboxing.md` 的凭据三分法一致：模型 token 给模型代理，数据源 token 给沙箱 supervisor，**连接器 OAuth token 给网关**。

## 2. 三个后端，一个接口

```
DSH 插件 roost-connectors（唯一入口）
   │  connector.call(slug, action, args)
   ▼
网关适配层（GatewayBackend 接口）
   ├─ OpenConnector（默认，自托管）      MCP / HTTP / OAuth 目录
   ├─ Composio（托管备选）              不想自管 OAuth 应用时
   └─ Native MCP（补充）                飞书等有官方 MCP 的，直连该 MCP
```

| 后端 | 何时用 | 谁管 OAuth | 凭据存在哪 |
|---|---|---|---|
| **OpenConnector** | 默认 | 我们自己（docker compose） | 网关数据库 |
| **Composio** | 用户不想注册各家应用 | Composio | Composio |
| **Native MCP** | 有官方 MCP 的服务（飞书等） | 该服务 | 该 MCP 的配置 |

**接口形状**（`packages/connectors`）：

```ts
interface GatewayBackend {
  listConnectors(): Promise<ConnectorSummary[]>          // 可用目录
  authorize(slug: string, options?: {                     // OAuth 起点
    workspaceId?: string
    state?: string
  }): Promise<{ url: string }>
  call(req: { slug, action, args, grant, idem }): Promise<CallResult>
  status(slug: string, options?: { workspaceId?: string }): Promise<ConnectionStatus>
}
```

## 3. 授权三层，别合成一层

| 层 | 管什么 | 例子 |
|---|---|---|
| **工作区连接** | 这个 workspace 连了哪些服务 | 连了 Gmail、GitHub |
| **按 Bot 授权** | 哪个 Bot 能用哪些连接器的哪些动作 | 选股师只能读 GitHub issue，不能发邮件 |
| **动作级审批** | 有副作用的动作单次授权 | 发邮件、提交 PR、付款 |

规则：

1. **未授权 = 不可见**：没授权的连接器，工具 schema 根本不进上下文（`loop-and-context.md` 的 deny-invisible）
2. **读写分离**：`apps: { gmail: 'read' }` 与 `{ gmail: 'write' }` 是两回事
3. **副作用动作必须显式批准**：`send_email`、`create_pr`、`payment` 这类，默认关，需要人批一次

## 4. OAuth 流程

```
Bot/人点「连接 Gmail」
   ↓ 我们的插件向控制面要授权 URL（带 workspace_id + slug）
控制面 → 网关 authorize() → 返回 provider 的授权 URL（PKCE + state）
浏览器跳转 → 用户同意 → 回调到控制面
   ↓ 控制面用 code 换 token（client secret 只在网关/控制面）
网关存 token（加密），返回 connection_id
   ↓ 产生 auth 类事件 connector.connected
```

- **client secret 永不下发到 workspace 卷**
- 回调地址固定：`https://<host>/api/connectors/callback/:slug`
- state 绑定 `workspace_id + user_id`，10 分钟过期
- refresh token 轮换由网关负责；过期时工具调用返回 `needs_reauth`，面板提示重连

## 5. 凭据与调用路径

```
Bot 回合
  → 工具调用 connector__gmail__send_email（schema 已在上下文）
  → 插件校验：workspace 已连接 + Bot 有 write 授权 + 动作在 allowlist
  → 控制面/网关代理：（可选）等人工批准
  → 网关：取 token → 调 Gmail API
  → 结果（截断）回到上下文
```

**Bot 全程看不到 token**；日志里只有 `slug/action/结果大小/是否被拒`。

**出站动作证据**：所有写操作进 `tool.result` 的 `outward` 字段（`git push`、`gmail.send`、`payment.charge`），供审计与 `assignment` 的 evidence 使用。

## 6. 上下文成本（这个必须管）

连接器的工具越多，`tool-schema` 越大。措施：

1. **按 Bot 授权裁剪**：只注入该 Bot 能用的动作
2. **按目录压缩**：一个连接器只暴露高频动作，其余用 `connector_search` 二级查找
3. **schema 上限**：单 Bot 的工具 schema 总 token 超过预算时，先裁连接器（`ContextManifest.dropped(reason='cap')`）
4. **工具桥**：与 superagent 的做法一致——把多个细粒度工具合成一个 `use_tool(name, args)`，schema 体积可降 60%+

## 7. 失败语义

| 场景 | 行为 |
|---|---|
| 网关不可达 | 工具返回 `unavailable`，不挂起；Bot 被要求换路径或问人 |
| 连接过期 | 返回 `needs_reauth`，面板出重连按钮 |
| provider 429/5xx | 网关内退避重试（最多 3 次，5s 起翻倍到 300s） |
| 授权被拒 | 返回 `denied` + 原因；回合继续 |
| 幂等冲突 | `idem` 命中返回首次结果（防重复发邮件） |

## 8. 数据模型

```sql
CREATE TABLE connections (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  slug          TEXT NOT NULL,          -- gmail | github | feishu …
  backend       TEXT NOT NULL,          -- openconnector | composio | native-mcp
  status        TEXT NOT NULL,          -- connected | expired | revoked
  account_label TEXT,                   -- 展示用（如邮箱），不含 token
  connected_by  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE (workspace_id, slug)
);

CREATE TABLE connector_grants (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  bot_id        TEXT NOT NULL,
  slug          TEXT NOT NULL,
  access        TEXT NOT NULL,          -- read | write
  actions       TEXT,                   -- JSON 数组；空=该 access 的全部
  granted_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE connector_calls (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  bot_id        TEXT NOT NULL,
  slug          TEXT NOT NULL,
  action        TEXT NOT NULL,
  ok            INTEGER NOT NULL,
  denied_reason TEXT,
  result_bytes  INTEGER,
  idem          TEXT,
  at            INTEGER NOT NULL
);
```

## 9. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/connectors` | 目录 + 当前连接状态 |
| POST | `/api/connectors/:slug/connect` | 起 OAuth |
| GET | `/api/connectors/callback/:slug` | OAuth 回调 |
| DELETE | `/api/connectors/:slug` | 断开（并撤销网关侧 token） |
| GET | `/api/connectors/:slug/grants` | 按 Bot 的授权 |
| PUT | `/api/connectors/:slug/grants` | 改授权（admin） |

工具命名：`connector__<slug>__<action>`（双下划线，避免与 MCP 命名冲突）。

## 10. 分期

### v0
- 只接 **OpenConnector** 一个后端；先接 2 个连接器（GitHub 读、一个日历或邮件）
- 只读动作；写动作一律拒绝并提示"待开放"
- **验收**：Bot 能列出 GitHub issue；未授权的连接器在工具列表里根本不出现

### v1
- 写动作 + 人工批准 + 幂等
- Composio 后端接入（同一接口）
- **验收**：发一封邮件需要批准；重复调用同一 `idem` 只发一封

### v2
- 原生 MCP 补充（飞书等）
- 连接器目录按租户可见性/配额管理
- **验收**：换后端不改 Bot 的授权模型

## 11. 待决问题

1. **网关放几份**：一个共享网关（token 作用域隔离）还是每个 workspace 一份（贵但干净）？倾向：v1 共享，v2 大客户独立。
2. **批准粒度**：每个动作批一次，还是"本会话允许 Gmail 写"？
3. **连接器目录进不进 marketplace**（第三方发布连接器）？倾向：v2 再谈，先只支持官方目录。
4. **中国区**：飞书等走原生 MCP，OpenConnector 目录里个别 Trigger 不能当"已支持"。

## 12. 实现状态（M6-6.1，2026-11-04）

已落地控制面框架，但**没有接真实 OAuth 网关**。

| 层 | 状态 | 说明 |
|---|---|---|
| 数据模型 | ✅ | `migrations/0016_connectors.sql`：`connections` / `connector_grants` / `connector_calls` |
| 幂等索引 | ✅ | `connector_calls` 用 partial unique index：`(workspace_id, bot_id, idem) WHERE idem IS NOT NULL` |
| store | ✅ | `packages/store/src/connectors.ts`：连接 upsert/get/list/delete、grant 覆盖/list/find、`recordCall`（idem 幂等） |
| 事件 | ✅ | `domain='connector'`：`connector.connected` / `.disconnected` / `.grant.changed` / `.call`（成功与被拒都记，`deniedReason` 在 payload） |
| 网关接口 | ✅（Stub + HTTP） | `StubGatewayBackend`（目录为空，`authorize`/`call` 抛 `connector.not_configured`）；`HttpGatewayBackend` 实现 OpenConnector/Composio 共用的 HTTP 契约 |
| 后端选择 | ✅ | `createGatewayBackend(env)`：`ROOST_CONNECTOR_BACKEND=stub|openconnector|composio`（默认 stub）；缺 `ROOST_CONNECTOR_URL` 或 URL 非法时回退 stub 并写日志 |
| 用户 API | ✅ | `GET /api/connectors`、`POST /:slug/connect`、`GET /callback/:slug`、`DELETE /:slug`、`GET / PUT /:slug/grants` |
| 内部 API | ✅ | `POST /api/internal/connectors/call`：连接/授权三层校验、只读直调、写动作走审批、idem 去重 |
| memory port | ✅ | 全部接口无 `rawStore` 时 503 `runtime.not_configured` |

### 网关 HTTP 契约（HttpGatewayBackend）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/connectors` | — | `[{slug,title,actions:string[]}]` |
| POST | `/authorize` | `{slug,workspaceId?,state?}` | `{url}` |
| GET | `/status` | `?slug=&workspaceId=` | `{status:'connected'|'expired'|'revoked',accountLabel?}` |
| POST | `/call` | `{slug,action,args,idem?,workspaceId,botId}` | `{ok:true,result}` / `{ok:false,code,message}` |

- 配置了 `ROOST_CONNECTOR_TOKEN` 时所有请求带 `Authorization: Bearer <token>`；token 不落日志、不回显到错误串，错误信息截断到 200 字符。
- 默认 5s 超时；`call` 的传输/超时/5xx 映射为 `{ok:false,code:'unavailable'}`，契约失败体按 `denied|unavailable|needs_reauth|provider_error` 透传，未知 code 回退 `provider_error`。
- 目录契约只给动作名，适配器统一按 `read` 展示；实际读写权限仍以 `connector_grants` 为准。

实现细节与偏差：

- **OAuth state** 保存在控制面进程内存（`Map`），10 分钟过期、绑定 `workspace/account/slug`、一次有效；服务重启或多副本部署会丢，需要换成共享存储（Redis/SQLite）。
- **回调响应**：成功返回 `200 {connected:true}`；还没有前端回调页，所以没有 302。接前端时改为 302 到 `/connectors`。
- **connect/status 的网关调用**：`GatewayBackend` 已新增可选 `options.workspaceId/state`；但 `connectors-routes.ts` 目前仍只传 `slug`，所以发往网关的请求暂时缺这两个字段。v1 扩路由时补传（workspaceId 来自连接请求，state 来自控制面生成的值），而不是把凭据塞进 state。
- **accountLabel**：`/status` 契约允许返回账号展示名，但 `GatewayBackend.status()` 只返回状态，未回写 `connections.account_label`（可后续扩展返回值或单独接口）。
- **选择/回退**：`server.ts` 默认 `createGatewayBackend(process.env)`；`options.connectorBackend` 仍可注入覆盖（测试用）。未知后端值或非法 URL 也回退 stub，日志只写原因、不回显 URL/token。
- **写动作**：`requiresApprovalForWrite(access, action)` 为真时先查 `approval_grants`（`kind='connector_action'`、`action=<slug>.<action>`、`target=<botId>`）；命中直接放行，否则落 pending 审批并返回 202，不调用网关。
- **idem 重放**：`connector_calls` 只存 `ok/result_bytes/denied_reason`，不存结果正文，所以重放成功调用返回 `200 {ok:true,deduped:true}`（说明无法重放结果）；重放被拒调用返回 403 + 首次 `deniedReason`。
- **断开**只删本地连接并写事件，**没有调用网关撤销 token**（`GatewayBackend` 尚无 revoke 方法）。

遗留：真实网关字段对齐（authorize/status 的 workspaceId/state 透传、accountLabel 回写、目录动作读写标记）、OAuth code→token 交换、网关侧 token 撤销、回调 302 前端页、state 共享存储。

## 13. 多账号连接模型（2026-11-09 修正）

旧模型 `connections UNIQUE(workspace_id, slug)` 把“工作区连接”和“用户账号”合成了一层，导致：

- 一个 workspace 只能有一个 GitHub 账号
- 多人无法连各自账号
- bridge 的 `statusFor()`/`call` 不带 named connection，所有 workspace/用户会落到同一个默认 GitHub token

v1 修正为四层，而不是三层：

```text
Connector App         部署级：GitHub OAuth App 的 clientId/clientSecret
Connection            账号级：某个用户授权的账号，alias = roost_<hash>
Workspace Default     workspace+slug 的默认连接
Bot Grant             bot + connectionId + access/actions
```

### 数据模型

migration `0027_connector_accounts.sql`：

```sql
connections (
  id, workspace_id, slug, backend, status, account_label,
  account_id, alias, is_default, created_at,
  UNIQUE (workspace_id, slug, account_id),
  UNIQUE (workspace_id, alias)
)

connector_grants (
  ...,
  connection_id,   -- null = workspace 默认连接
  UNIQUE (workspace_id, bot_id, slug)
)
```

`connectionAliasFor(workspaceId, accountId, slug)` 生成稳定 alias：

```text
roost_<sha256(workspaceId + accountId + slug)[0..24]>
```

### 网关契约

控制面发给 bridge：

```json
POST /authorize
{
  "slug": "github",
  "workspaceId": "ws_x",
  "accountId": "acc_y",
  "connectionName": "roost_abc123",
  "state": "..."
}
```

```json
POST /call
{
  "slug": "github",
  "action": "list_issues",
  "args": {},
  "workspaceId": "ws_x",
  "botId": "bot_z",
  "connectionName": "roost_abc123"
}
```

bridge 转发 OpenConnector：

```text
POST /v1/connections/github/connect
  { returnUri, connectionName }

POST /v1/actions/github.list_issues
  x-oo-connector-alias: roost_abc123

GET /v1/connections
  按 connectionName 过滤
```

### OAuth callback

OAuth App 仍然只需要一个，部署级。

建议：

```text
https://roostbots.com/oauth/callback
  → nginx
  → bridge :3011 /oauth/callback
  → OpenConnector :3010 /oauth/callback
  → 302 回 https://roostbots.com/api/connectors/callback/<slug>
```

bridge 已加未鉴权的 callback 代理；nginx 需要加：

```nginx
location = /oauth/callback {
  proxy_pass http://<bridge-host>:3011;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

OpenConnector 设置：

```text
OOMOL_CONNECT_ORIGIN=https://roostbots.com
```

### UI 语义

- 任何成员都可以“连接我的账号”
- 卡片显示当前账号自己的连接；没有自己的连接时显示 workspace 默认
- owner/admin 在“按 Bot 授权”里选择 Bot 使用哪条连接
- `connections` 仍只是展示用 account_label，不含 token
