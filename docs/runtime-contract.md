# DSH 运行时契约

控制面要把 DSH 当成可编排的运行时，需要 DSH 提供下面七条。前六条是"补齐"，第七条是"已具备但要标准化"。

> 每一条都给了：为什么要、接口长什么样、没有它时平台侧要打什么补丁。

## 1. 健康与活动

**为什么**：控制面要判断容器能不能接流量、能不能回收。

```
GET /healthz   → 200 {"ok":true,"version":"0.2.1-rc.3","plugins":17}
GET /activity  → 200 {"busy":true,"turns":1,"lastActivity":"2026-11-03T11:02:11Z","sessions":3}
```

- 不要用某个插件的健康检查（比如行情中心的 `/health`）代替：没装那个插件的 workspace 也应该算就绪
- `busy` 必须覆盖"有回合在跑"，否则空闲回收会打断正在工作的 Bot

**没有它**：平台只能猜（端口通=就绪），回收只能靠固定超时，容易腰斩。

## 2. runtime token

**为什么**：DSH 现在信任本机 cookie；云上一个容器可能有多个入口。

```
Authorization: Bearer rt_<workspace>_<nonce>
```

- 控制面签发，容器启动时注入，分钟级过期
- DSH 对所有 HTTP 面校验；无效 → 401
- 与用户会话 token 完全分开（见 `decisions/0003-tokens.md`）

**没有它**：只能把容器端口暴露给控制面网络，靠网络策略兜底。

## 3. 优雅停机

**为什么**：容器会被回收，正在跑的回合不能丢。

```
SIGTERM → 拒绝新回合 → 等进行中的回合（上限 N 秒）→ 落盘 → 退出
```

- 退出前把"未完成回合"标记写进卷，下次启动可见
- 超过上限强停，并在事件日志里记 `run.aborted`

## 4. 计量

**为什么**：按容器秒计费，同时防滥用（BYO token 下平台不按 token 收费，但仍要知道用量）。

```
每回合结束 → POST 控制面 /internal/usage
{workspace, session, bot, turn, in_tokens, out_tokens, tool_calls, duration_ms}
```

- 失败要重试（本地排队），不能因为计量失败影响回合
- 来源可以是 DSH 的 usage 服务，不必新写一套

## 5. 子路径部署

**为什么**：控制面按 `/w/<id>/` 反代，不能让每个 workspace 抢根路径。

```
dsh --profile <ws> --base-path /w/<id>
```

- 现状：插件路由已经是文档相对的（`connection.fetch`），这是好基础
- 需要：静态资源、SSE、WebSocket 都遵循 base path
- 实现现状：控制面没有依赖 DSH 的 `--base-path`，而是在 `/w/<workspaceId>/dsh/*` 做前缀剥离，
  并重写 HTML 里的站内绝对路径；WebSocket 尚未处理。细节见 §8。

## 6. 插件同步（无交互）

**为什么**：容器启动时不能有人点确认。

```
dsh plugin --profile <ws> sync --lockfile plugins.lock.json
```

- lockfile 由控制面生成（插件名 + 版本 + 完整性哈希）
- 失败时明确报错并退出非零，容器不进入 running
- 供应链策略（minimumReleaseAge）必须可在镜像里预置，避免首次安装被拦

## 7. 只读共享数据面

**为什么**：行情缓存、已发布报告、新闻可以共享，租户笔记不能。

- 本机 MCP 端点（`127.0.0.1:50052` 这类）要能改成**可配置 base URL**
- 共享卷以只读挂载进容器；写路径必须留在自己的卷

**现状**：报告引擎与数据 MCP 都假设本机端口。这是迁移到云上最先撞到的一处。

## 附：这七条之外，平台侧自己补

| 能力 | 谁做 |
|---|---|
| 配对认证 | 控制面 |
| 容器编排 / 卷 / 快照 | 控制面 |
| 反代与 SSE 透传 | 控制面 |
| 回合级沙箱 | 控制面 + 运行时镜像 |
| 模型代理（BYO token） | 控制面 |
| 事件 → 计量/审计 | 控制面 |

## 8. Web 表面（已实现，ADR 0004）

DSH Web 只作为**插件面板容器**，不是产品主界面。控制面不把 DSH Web 暴露成主站路径。

### 8.1 路由

```
GET|HEAD|POST|PUT|PATCH|DELETE  /w/:workspaceId/dsh/*   → 127.0.0.1:<DSH_WEB_PORT>
POST                            /w/:workspaceId/dsh/session
GET                             /api/workspaces/:id/panels
GET                             /api/workspaces/:id/dsh/status
```

- `DSH_WEB_PORT` 默认 **4099**（`packages/plugins/src/surface.ts`）；上游固定 `127.0.0.1`。
- 控制面主进程仍在 `PORT`（默认 8787）上处理 `/w/...`；另起一个**只服务这些路径**的监听
  `ROOST_DSH_PROXY_PORT`（默认 4098，`0` 关闭）。后者才是 iframe 的独立源。
- 路径只做前缀剥离，不拼接目标地址（无 SSRF 面）；query 原样转发。
- 上游请求不带控制面的 `Authorization` / `Cookie` / `X-Runtime-*` / `X-Roost-*`；
  上游 `Set-Cookie` 不回传；去掉 hop-by-hop、`X-Frame-Options`，CSP 里的 `frame-ancestors` 被剥离；
  响应统一 `Cache-Control: no-store`。
- HTML 响应在 `content-encoding: identity` 时缓冲重写站内绝对路径：
  `href|src|action="/..."` → `/w/<workspaceId>/dsh/...`，并重算 `Content-Length`。
  为保证可重写，向上游转发时去掉了 `Accept-Encoding`。

### 8.2 鉴权与会话 cookie

- 普通调用接受 Bearer 会话（`Authorization: Bearer <sessionToken>`）。
- iframe 的 `sandbox="allow-scripts allow-same-origin"` 保留反代端口自己的源，但读不到主控面
  localStorage；所以提供 `POST /w/:workspaceId/dsh/session`（Bearer 鉴权 + workspace 成员校验）
  换短时 cookie：
  - 名称：`roost_dsh_<sha256(workspaceId) 前 16 hex>`
  - 值：`base64url(workspaceId|accountId|exp)` + `.` + `HMAC-SHA256(secret, payload)`
  - 属性：`HttpOnly; SameSite=Lax; Path=/w/<workspaceId>/dsh/; Max-Age=900`
- 签名密钥优先 `ROOST_SIGNING_SECRET`；未配置则进程内随机（重启后旧 cookie 失效）。
- cookie 不区分端口：主端口签发的 cookie 对反代端口同样有效；反代端口再校验 workspace 成员。

### 8.3 独立 origin 的硬要求

- 浏览器 origin 由**公开协议 + host + port** 决定。把 `/w/` 反代到另一个上游端口，不会让浏览器
  变成独立 origin。
- 必须让主站与 DSH 反代在浏览器侧是**不同端口或不同 host**。ADR 0004 采用“同 host、不同端口”
  （`ServerOptions.dshProxyPort`）。
- 如果直接把反代端口暴露给浏览器，它只服务 `/w/.../dsh/*`，其余路径 JSON 404。

### 8.4 当前缺口

| 缺口 | 影响 |
|---|---|
| WebSocket upgrade 未处理 | DSH Web 若用 ws 推事件，握手会被直接断开 |
| OPTIONS/CORS 未实现 | opaque origin 的预检请求会被拒；面板必须用独立源的 `allow-same-origin` |
| `/api/config` 固定返回 `http://<Host>:<ROOST_DSH_PROXY_PORT>` | TLS 部署下 iframe 会混合内容；不会推导 https/外部端口 |
| 反代目标固定 `127.0.0.1:4099` | 宿主到 OpenShell 沙箱的端口转发不在本仓库实现内 |
| 面板实际注册数冒烟 | 只读 manifest 声明，未核对 DSH Web 实际注册 |
| 面板打开才唤醒 / 随沙箱 stop-start | 未实现 |

## 9. Sandbox 会话（已实现）

### 9.1 形态

```
OpenShell 沙箱 user-<workspaceId 的 8 位 hex>（每 workspace 一个，固定名复用）
  └─ room-agent（Node，主进程）
       ├─ dsh --profile sdk（长活 JSON-RPC over stdio）
       ├─ 每 (room, bot) 一个 sessionId：room-<roomId>-<botId>
       ├─ 轮询控制面 /api/internal/rooms/... 取消息与 assignments
       └─ 收 session.event → POST /api/rooms/:id/say（幂等键带 botId）
```

- 多轮上下文由 DSH session 维护，不再每条消息 fork 一个 headless。
- 沙箱 stop/start 后 `$DSH_HOME` 仍在；room-agent 对每个 session 先 `session/resume`，再
  `session/prompt`；没有 `session.status` 通知时用 `session/wait` 兜底。
- 游标落 `/workspace/.dsh/room-cursors.json`，按房间记最后 `seq`；重启后不重复消费。
- 工作目录 `/workspace`，`DSH_HOME=/workspace/.dsh`。

### 9.2 注入的环境变量

| 变量 | 来源/默认 | 用途 |
|---|---|---|
| `ROOST_API` | `http://<ROOST_CP_HOST>:<ROOST_CP_PORT>` | 控制面内部接口 |
| `ROOST_RUNTIME_TOKEN` | 控制面注入 | 内部接口鉴权 |
| `ROOST_PROFILE_LOCK_ID` | profile sync 拉到的锁 id | 插件锁一致性 |
| `ROOST_BOT_ID` | 默认 `selector` | 旧单 Bot 路径/兜底 |
| `ROOST_WORKSPACE_ID` | workspace id | 房间过滤 |
| `ROOST_STATE_FILE` | `/workspace/.dsh/room-cursors.json` | 游标 |
| `ROOST_WORKDIR` | `/workspace` | dsh 工作目录 |
| `ROOST_DSH_PROVIDER` | `deepseek-official` | provider 名（凭据由 OpenShell 注入） |
| `ROOST_DSH_MODEL` | `deepseek-chat` | 模型 |

### 9.3 约束

- runtime token 目前经 `--env` 注入沙箱，OpenShell 会给出警告；长期应由 provider/密钥服务注入
  （TODO E6）。
- 沙箱粒度是**每 workspace 一个**，不是每房间/每回合一个；同一沙箱内多房间靠 sessionId 隔离，
  文件系统与工具权限是用户级共享。
- 回合级工具隔离（第二层沙箱）尚未加；见 `sandboxing.md` §2/§15。

## 验收方式

一个最小 spike 就能验证全部七条：

1. 把本机 DSH 装进容器，`--base-path` 反代到浏览器
2. 注入 runtime token，验证 401/200
3. 发起一个长回合，`kill -TERM` 容器，确认回合不丢
4. 断开网络，确认 `/activity` 与 `/healthz` 仍可答
5. 用 lockfile 同步插件，确认失败即退出
6. 把数据 MCP 指向只读共享卷，跑一份报告
