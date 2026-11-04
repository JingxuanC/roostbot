# 可观测性：日志、指标、审计与限流

> 状态：实现补充（M6-6.6）。本文只覆盖控制面 `apps/api` 已落地的部分；
> 告警规则与 SLO 尚未配置，建议见 §6。

## 1. 请求 id

- 每个请求生成或沿用 `x-request-id`；客户端值必须匹配 `[A-Za-z0-9._-]{8,128}`，否则忽略并随机生成。
- 所有响应（含 4xx/5xx、静态文件、`/metrics`）都回写 `x-request-id`。
- SSE 长连接在连接结束时记一条完成日志。

## 2. 结构化日志

`apps/api/src/logger.ts` 输出一行一个 JSON：

```json
{"level":"info","time":"2026-11-04T12:00:00.000Z","requestId":"...","method":"GET","path":"/healthz","status":200,"durationMs":1}
```

- 级别：4xx `warn`，5xx `error`，其余 `info`；请求异常导致的 500 带 `msg:"request failed"`。
- 只记录请求信封，不记录 body。
- `path` 里的 query 会脱敏：`token`、`access_token`、`authorization`、`cookie` 替换为 `[REDACTED]`。
- `redactForLog()` 是 headers 等对象字段的通用兜底；当前不打印 headers。

## 3. 指标（GET /metrics）

无鉴权，`text/plain; version=0.0.4`。`path` 标签只使用路由模板，未识别路径统一为 `other`。

| 指标 | 类型 | 标签 | 说明 |
|---|---|---|---|
| `roost_http_requests_total` | counter | `method,path,status` | 每个完成请求加一 |
| `roost_http_request_duration_seconds` | histogram | `method,path` | buckets：0.01/0.05/0.1/0.5/1/5，另有 `+Inf` |
| `roost_pending_approvals` | gauge | 无 | `approvals.status='pending'` |
| `roost_runs_queued` | gauge | 无 | `runs.status='queued'` |
| `roost_plugins_installing` | gauge | 无 | `plugin_installs.state='installing'` |

业务 gauge 在每次抓取时从 rawStore 现查；内存 port（无 rawStore）输出 0。

## 4. 审计查询（GET /api/audit）

- Bearer 会话；目标 workspace 需要 owner/admin。
- 参数：`workspaceId`（必填）、`domain`、`kind`、`from`、`to`、`limit`（默认 50，最大 200）、`before`（可选游标）。
- `from`/`to` 接受 ISO 8601 或 epoch 毫秒；区间为左闭右开 `[from, to)`。
- 按 `events.seq` 倒序；返回 `{events:[{seq,at,domain,kind,actor,subject,payload}], nextBefore?}`。
- `nextBefore` 是当前页最旧一条的 seq，下一页传 `before=<nextBefore>`。
- 内存 port（无 rawStore）返回 503；参数非法 400。

workspace 归属过滤（宁少不多）：

1. `payload.workspaceId` 精确匹配；存在但指向别的 workspace 时整条排除；
2. `payload.scope='workspace'` 且 `payload.scopeId` 匹配；
3. `payload.roomId` / `payload.botId` 属于该 workspace；
4. `subject` 为 workspace/room/bot/approval/schedule/run/quota/reservation/usage 且归属匹配；
5. `audience='room:<id>'` 且房间属于该 workspace；
6. `audience='team'` 且 actor 是 workspace 成员（user）或 Bot（bot）。

## 5. 写接口限流

每个 server 实例独立的内存令牌桶，按账号计数；超限返回 429 `rate_limited` + `Retry-After`（秒）。

| 接口 | 容量 / 回填 |
|---|---|
| `POST /api/rooms/:id/messages` | 30 / 分钟 |
| `POST /api/marketplace/plugins/:slug/install` | 10 / 小时 |

配对码沿用原有失败窗口与单码锁定，不在本模块内。令牌桶按时间匀速回填，不是固定窗口。

## 6. 告警与 SLO（建议，未实现）

- 可用性：`/healthz` 连续失败 3 次（30s）告警；目标月可用性 99.9%。
- 错误率：5xx / 全部请求 > 1% 持续 5 分钟告警；按 `path` 模板聚合。
- 延迟：`histogram_quantile(0.95, rate(roost_http_request_duration_seconds_bucket[5m])) > 1s` 告警；SLO 建议 p95 < 500ms（控制面本机调用）。
- 队列：`roost_runs_queued > 20` 持续 10 分钟；`roost_pending_approvals` 长期不降提示审批积压。
- 限流：429 `rate_limited` 突增按账号排查，不直接把阈值当告警线。
- 审计：owner/admin 的审计查询失败、events 读取错误记 error 日志；保留期按 events.md §8。
