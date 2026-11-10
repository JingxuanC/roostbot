# Provider console 接入

> 状态：客户端 + 路由 + 测试已落地（2026-11-09，分支 `feat/daytona-provider-console`）。
> 上游契约：daytona 仓库 issue #1「算力提供方控制台」P1–P4（`apps/api/src/provider`）。

## 1. 为什么接它

Roost 已经有 `daytona` RuntimeProvider（bot 跑在 Daytona sandbox 上）。但「**这些算力从哪来、谁在供给、成本多少**」在 Daytona 侧没有视图：

- 自托管 fork 新增了 `/api/provider/*`：节点状态、按节点×天的用量、定价、收益、结算单、告警；
- Roost 接进来后，可以把「bot/房间」与「算力节点」对上账，未来把成本写进 budget；
- Daytona Cloud **没有**这组端点（404），所以接入必须是**可选、可降级**的。

## 2. 契约（只读）

| 方法 | Roost 路由 | 上游（自托管 fork） |
|---|---|---|
| GET | `/api/provider/nodes` | `/provider/nodes` |
| GET | `/api/provider/nodes/:runnerId/sandboxes` | 同路径语义 |
| GET | `/api/provider/usage?from&to&granularity&runnerId` | 按节点 × UTC 天聚合 vCPU·h / GiB·h |
| GET | `/api/provider/earnings?from&to&runnerId` | 已结算读结算表，未结算实时计价 |
| GET | `/api/provider/settlements?status&from&to&runnerId&limit` | 结算单 |
| GET | `/api/provider/alerts?state&runnerId&limit` | 节点告警（OFFLINE / HEALTHCHECK_FAILED / HIGH_LATENCY / RESOURCE_PRESSURE） |
| POST | `/api/provider/alerts/:id/resolve` | 人工解除告警 |

Roost 侧鉴权：Bearer 会话（与 `/api/quotas` 一致）。上游鉴权：组织 API key（`dtn_...`）+ 可选 `X-Daytona-Organization-ID`。

## 3. 配置

```sh
# 默认关闭；显式打开（或直接设置 URL 即视为打开）
ROOST_PROVIDER_CONSOLE=1

# 上游 API base，默认取 DAYTONA_API_URL / Daytona Cloud
ROOST_PROVIDER_CONSOLE_URL=http://127.0.0.1:3100/api

# 组织 API key，默认复用 DAYTONA_API_KEY / ROOST_DAYTONA_API_KEY
ROOST_PROVIDER_CONSOLE_API_KEY=dtn_...

# 可选：组织 id（API key 认证时可省略）
DAYTONA_ORGANIZATION_ID=...
```

`main.ts` 启动时构造客户端并注入 `startServer({ providerConsole })`；不配置时相关路由返回 `501 provider.not_configured`。

## 4. 降级语义

| 上游情况 | Roost 返回 |
|---|---|
| 未配置 | `501 provider.not_configured` |
| Daytona Cloud（无 `/provider/*`，404） | `501 provider.not_supported` |
| 上游 401/403 | `401 provider.unauthorized` |
| 网络/超时 | `502 provider.unreachable` |
| 其余上游错误 | `502 provider.bad_response` |
| 查询参数非法（granularity/status/state/limit） | `400 invalid_query` |
| 未登录 | `401`（Bearer 会话） |

这样 Cloud 用户打开页面只会看到「此部署不支持」，不会看到 500。

## 5. 验证

```sh
# 单元/接线测试（客户端契约 + 路由 + 降级映射）
node --experimental-strip-types --test apps/api/test/provider-console.test.ts

# 真实 Daytona 生命周期冒烟（需要账号 key）
DAYTONA_API_KEY=dtn_... DAYTONA_SNAPSHOT=roost-agent-smoke node scripts/daytona-smoke.mjs
```

### smoke snapshot

`runtime-provider-daytona.ts` 的 ready 检查要求 sandbox 内存在 `/workspace/.roost/ready`。当前 Daytona 用 snapshot 决定资源，因此最小 smoke snapshot：

```json
POST /api/snapshots
{
  "name": "roost-agent-smoke",
  "imageName": "ubuntu:24.04",
  "entrypoint": ["sh", "-c", "mkdir -p /workspace/.roost && touch /workspace/.roost/ready && sleep infinity"],
  "cpu": 1, "memory": 1, "disk": 3, "sandboxClass": "container"
}
```

真实生产应把 `roost/agent` 镜像构建成 snapshot（entrypoint `node /opt/roost/room-agent.mjs`）。

## 6. 已知限制 / 下一步

- 当前是**只读**接入（告警可 resolve），定价/结算写入仍走 Daytona 侧接口；
- budget 记账尚未消费这些数据：下一步把 `/api/provider/usage` 的 `cpuHours/memoryGiBHours` 折算成 `container_seconds` 等预算口径，按 bot/房间分摊；
- Daytona `snapshot` 资源规则：创建 sandbox 时不能再传 cpu/memory/disk（由 snapshot 决定），provider 已按此修正，见 `apps/api/src/runtime-provider-daytona.ts`。

## 7. 参考：LangAlpha 的 Daytona 接入方式

LangAlpha（`ptc_agent/core/sandbox/providers/daytona.py`，SDK `daytona>=0.210.0`）是同一账号下已经跑通的 Daytona 接入，以下做法已对齐到 Roost 的 raw-HTTP provider：

| 做法 | LangAlpha | Roost 现状 |
|---|---|---|
| snapshot 决定资源 | `CreateSandboxFromSnapshotParams` 不带 cpu/memory/disk；「hosted Daytona 不能 resize 或创建时覆盖 snapshot 资源，tier 尺寸烘焙进 tier 专属 snapshot」 | ✅ 已对齐（`ensure` 的 create body 不再传资源，`ensureSnapshot` 用 `spec.resources` 建 snapshot） |
| snapshot 状态机 | `_SNAPSHOT_IN_PROGRESS`（pending/pulling/building/snapshotting/removing）等待；`_SNAPSHOT_FAILED`（build_failed/error）先删再建 | ✅ 已对齐（`SNAPSHOT_IN_PROGRESS` / `SNAPSHOT_FAILED`、`deleteSnapshotForRebuild`、`waitForSettledSnapshot`） |
| 409 竞态 | 「already exists」时等另一个构建 settle，只有 active 才可用 | ✅ 已对齐（409 → `waitForSettledSnapshot`） |
| 错误分类 | `DaytonaError.status_code/error_code`：FILE_NOT_FOUND vs NOT_FOUND、429 限流、5xx transient | ✅ 基本对齐：401/403 unauthorized、404 not_found、409 conflict、429/5xx retryable、网络错误 not_available |
| 自动停机间隔 | 创建时以**分钟**传 auto_stop/archive/delete（3600s→60、7d、90d） | ⚠️ Roost 默认 0 / -1（长活 workspace 不自动停），需要时按分钟配置 |
| Secrets | `CreateSandboxFromSnapshotParams(secrets=...)` + 组织级 Secret（`DAYTONA_SECRET_NAMESPACE`）、`sandbox.update_secrets` | ⚠️ 目前只传 env；建议后续把 per-Bot `credentialRef` 映射成 Daytona secrets，避免明文 env |
| 指标/用量 | SDK `sandbox.get_metrics(since, until)` → Analytics 后端（保留 3 天、限流约 1/s，429 需退避） | ⚠️ Cloud 上 telemetry 端点返回 403「Telemetry endpoints are disabled when Analytics API is configured」，所以 Cloud 用量要走 Analytics/Billing API；`/provider/*` 仍只存在于自托管 fork |
| 快照命名 | `{base}-{tier}-{config_hash}`，配置变更自动换新 snapshot | ⚠️ Roost 用固定 `DAYTONA_SNAPSHOT` 名；改了 snapshot 内容需手动换名或删旧 snapshot |

**结论**：执行面（sandbox 生命周期、snapshot、错误、执行通道）可以直接对齐 LangAlpha；经济面（用量/收益/结算）在 Cloud 上拿不到 `/provider/*`，只能走 Analytics/Billing，或者接自托管 fork。
