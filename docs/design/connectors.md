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
  authorize(slug: string): Promise<{ url: string }>      // OAuth 起点
  call(req: { slug, action, args, grant, idem }): Promise<CallResult>
  status(slug: string): Promise<ConnectionStatus>
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
