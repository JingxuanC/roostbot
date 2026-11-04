# @roost/connectors

连接器网关接口：**默认 OpenConnector（自托管）**，Composio 托管备选，原生 MCP 补充。凭据只在网关，Bot 全程看不到。

设计见 [`docs/design/connectors.md`](../../docs/design/connectors.md)。

## 三层授权

| 层 | 管什么 |
|---|---|
| 工作区连接 | 这个 workspace 连了哪些服务 |
| 按 Bot 授权 | 哪个 Bot 能用哪些动作（`read` / `write`） |
| 动作级审批 | 有副作用的动作单次批准 + 幂等键 |

**未授权 = 不可见**：没授权的连接器，工具 schema 根本不进上下文。

## 命名

```
connector__<slug>__<action>          例：connector__gmail__send_email
```

## 网关 HTTP 契约

`HttpGatewayBackend`（OpenConnector / Composio 共用）：

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/connectors` | — | `[{slug,title,actions:string[]}]` |
| POST | `/authorize` | `{slug,workspaceId?,state?}` | `{url}` |
| GET | `/status` | `?slug=&workspaceId=` | `{status:'connected'|'expired'|'revoked',accountLabel?}` |
| POST | `/call` | `{slug,action,args,idem?,workspaceId,botId}` | `{ok:true,result}` / `{ok:false,code,message}` |

配置了 token 时每个请求带 `Authorization: Bearer <token>`；默认 5s 超时，token 不落日志、不回显到错误串。

后端选择：`createGatewayBackend(env)` 读 `ROOST_CONNECTOR_BACKEND=stub|openconnector|composio`（默认 stub），`openconnector`/`composio` 需要 `ROOST_CONNECTOR_URL`；缺失时回退 stub。

## 待办

- [x] OpenConnector HTTP 适配器（`HttpGatewayBackend`）
- [ ] OAuth code→token 交换与网关侧 token 撤销
- [ ] 回调路由透传 workspaceId/state 给网关（接口已留可选参数）
- [ ] Composio 字段差异对齐（同一 HTTP 契约，真实账号字段待验证）
