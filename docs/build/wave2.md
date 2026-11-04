# Wave 2 契约（记忆 / 预算 / 连接器 / 观测 / 调度）

> 与 `docs/build/wave1.md` 同源。**子 agent 只写自己 scope 的新文件 + 测试**；
> `server.ts` / `port.ts` / `store/index.ts` / `main.ts` 的接线由 Lead 做。测试必须全绿。

## A. 记忆 claims 与复盘模板（6.3.2 / 6.3.6 / 6.5.6）

`packages/memory/`（新包，`@roost/memory`）：
- `src/claims.ts`：`extractClaims({ text, now, dailyCap, alreadyToday })` → `{ claims, rejected }`
  - 每条 claim：`{ subject, predicate, object, falsifier, confidence, sourceQuote, at }`
  - **falsifier 必填**（去空白后 ≥ 10 字符，且不能是"无法证伪"这类空话清单）；非法 → rejected(reason='falsifier_missing')
  - `dailyCap` 内超过 → rejected(reason='daily_cap')
  - 纯函数，不读 DB；置信度 0..1；同文本重复 claim 去重
- `src/cleanup.ts`：`planCleanup({ claims, now, falsifiedOlderThanMs, keepRecent })` → `{ remove:[ids], keep:[ids] }`
  - 只清「已被否证且超过保留期」；被 `retracted` 的不动；最近 N 条不动
- `packages/scheduler/src/templates.ts`：`REVIEW_ROUTINE_TEMPLATE`、`reviewRoutineInput({ workspaceId, at, timezone })`（6.5.6）
  - 模板：每日复盘 → 清理被否证 claim → 写 lesson 候选；idem 按日期
- 测试 ≥ 15：falsifier 校验、daily cap、去重、cleanup 边界、模板形状/idem。

## B. 预算：模型代理 + 计量采集（6.4.5 / 6.4.7）

`packages/budget/`（新包，`@roost/budget`）：
- `src/metering.ts`：`containerSeconds({ startedAt, stoppedAt, now })`、`planMetering({ runtimes, volumes, now })` → `[{ kind:'container_seconds'|'storage_bytes', amount, workspaceId, idem }]`；幂等键按 workspace+日+kind；纯函数
- `src/proxy.ts`：`createModelProxy({ upstreamBase, upstreamPath='/v1/chat/completions', key, fetchImpl?, recordUsage?, limiter? })` → `(req,res) => Promise<void>`
  - 转发流式/非流式；从响应 `usage.prompt_tokens/completion_tokens` 记账；无 usage 时按字符估算并标 `estimated:true`
  - 429 由注入 limiter 决定；上游错误原样映射；**不记录 key**
- `apps/api/src/model-proxy-routes.ts`：导出 `handleModelProxy(ctx, req, res)`（Lead 接线 `/v1/*`），ctx 注入 proxy 实例
- 测试 ≥ 15：计量边界、幂等键、代理转发/记账/估算/上游错误/不泄露 key。

## C. 连接器 Composio + 缩略图（6.1.7 / 6.2.5）

- `packages/connectors/src/composio.ts`：实现 `GatewayBackend`（同 http.ts 接口）：
  `listConnections` / `authorize` / `call`，Composio 风格 env：`ROOST_COMPOSIO_BASE_URL/_API_KEY/_TIMEOUT_MS`；
  错误映射 `connector.not_configured` / `connector.upstream`；不把 key 写日志
- `packages/connectors/src/factory.ts`：`composio` 分支改为返回 Composio（保留 http/stub）
- `packages/storage/src/thumbnails.ts`：
  - `planThumbnail({ mime, bytes, maxEdge=320 })` → `{ mode:'passthrough'|'render'|'unsupported', reason? }`
  - `renderThumbnail({ bytes, mime, runner, workDir })`：按 `sips`（macOS）→ `pdftoppm`（PDF）→ `magick` 顺序尝试；`runner(cmd,args)` 注入；失败返回 `{ok:false,reason}` 不抛
  - EXIF 已存在（`image.ts` 的 `stripJpegExif`）：补 `prepareImage({bytes,mime})` 统一调用
- 测试 ≥ 12：Composio 请求形状/错误映射/key 不落日志、缩略图 passthrough/命令选择/失败降级/EXIF 调用。

## D. 观测（6.6.1 / 6.6.4 / 6.6.5 / 6.6.7）

`packages/observability/`（新包，`@roost/observability`）：
- `src/from-events.ts`：`metricsFromEvent(event)` → `[{name, kind:'counter'|'gauge'|'histogram', value, labels}]`
  - 覆盖 run.* / assignment.* / sandbox.* / budget.* / message.* / delivery.*；未知事件返回 []
- `src/alerts.ts`：`DEFAULT_ALERT_RULES`（sandbox_error、budget_exceeded、delivery_failed、health_degraded）；`evaluateAlerts({ snapshot, rules, now, cooldownMs })` → `[{ rule, severity, detail }]`，冷却窗口
- `src/health.ts`：`runHealthChecks({ probes, now })`，probes `{api, store, sandbox, gateway}` → `{status:'ok'|'degraded'|'down', checks[]}`
- `src/logs.ts`：`redactLine(line)`（token/key/secret/cookie/password/authorization）、`retentionPlan({files, now, maxAgeMs, maxBytes})` → `{ keep, delete }`
- `apps/api/src/health-deep.ts`：`handleDeepHealth(ctx, req, res)`，ctx 注入 probes（Lead 接 `/healthz/deep`）
- 测试 ≥ 18。

## E. 调度：激活控制器 + 空闲睡/醒（6.5.2 / 6.5.4）

- `packages/scheduler/src/activation-controller.ts`：
  `decideActivation({ routine, now, lastRunAt, catchUpMs, signals })` → `{ action:'run'|'skip'|'repair'|'missed', reason, idem }`
  - clock（到点）/ event（外部信号）/ repair（上次中断）/ missed（超 catch-up）四分支；幂等键与 `activation.ts` 的 `clockIdem` 对齐
- `apps/runtime/idle-sleeper.mjs`：
  `planIdleAction({ lastActivityAt, now, idleMs, phase })` → `'stop'|'wake'|'none'`；`startIdleSleeper({ backend, sandbox, idleMs, pollMs, log })`（stop/start，stop 后再活动要 wake）
- 测试 ≥ 12：四分支/幂等/边界；睡醒状态机与 fake backend。

## 验收

```
node --experimental-strip-types --test packages/*/test/*.test.ts apps/*/test/*.test.ts
sh scripts/verify.sh
```
