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

## 待办

- [ ] OpenConnector 后端实现（`listConnectors/authorize/call/status`）
- [ ] OAuth 回调与 state 校验
- [ ] 动作级审批与 `idem` 幂等仓储
- [ ] Composio 后端（同接口）
