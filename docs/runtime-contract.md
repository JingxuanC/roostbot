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

## 验收方式

一个最小 spike 就能验证全部七条：

1. 把本机 DSH 装进容器，`--base-path` 反代到浏览器
2. 注入 runtime token，验证 401/200
3. 发起一个长回合，`kill -TERM` 容器，确认回合不丢
4. 断开网络，确认 `/activity` 与 `/healthz` 仍可答
5. 用 lockfile 同步插件，确认失败即退出
6. 把数据 MCP 指向只读共享卷，跑一份报告
