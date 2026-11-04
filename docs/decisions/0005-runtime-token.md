# 0005 — runtime token 仍是 env：0.1.0 的妥协、边界与 provider 方案

- 状态：已定（0.1.0 保留 env；provider 尚未实现）
- 日期：2026-11-04
- 相关：ADR 0003（三种 token 分开）、`docs/design/workspace.md` §8、TODO E6 / E4

## 背景

内部接口（沙箱里的 room-agent 调控制面）用 `x-runtime-token` 鉴权。当前实现是**一个
控制面级共享 secret**：

| 位置 | 事实 |
|---|---|
| `apps/api/src/main.ts` | `runtimeToken: process.env.ROOST_RUNTIME_TOKEN ?? ''` 传给 `startServer` |
| `apps/api/src/runtime-manager-openshell.ts` | 起沙箱时把 `ROOST_RUNTIME_TOKEN` 原样写进沙箱 env |
| `apps/api/src/*-routes.ts` | 10 个模块各自实现 `runtimeTokenFrom()` + `token !== ctx.runtimeToken`（普通字符串比较，非定时安全） |
| `apps/runtime/sidecar/proxy.mjs` | **另一个** `RUNTIME_TOKEN`，只保护单个容器的 DSH 入口；与本文讨论的控制面 token 不是同一个东西 |

未配置时内部接口统一返回 404（`not_found`，"internal api is disabled"），这是有意的：
默认不暴露内部面。

## 问题（为什么 TODO E6 要改）

1. **没有 workspace 作用域**：任何拿到 token 的沙箱都能读写**所有** workspace 的内部接口
   （房间、审批、预算、记忆、插件 sync、连接器……）。租户隔离只靠"沙箱里只有自己的
   workspace id"这条约定，不是边界。
2. **不能轮换**：换 token 要改控制面 env、重启控制面，并让所有已启动沙箱重新注入；
   sandbox 是 stop/start 复用的，旧 token 会在停止的沙箱 env 里留很久。
3. **没有过期/吊销**：ADR 0003 要求"容器崩溃重启后 runtime token 必须重新签发"，
   当前做不到——token 是部署级常量。
4. **不可归因**：审计里看到的是"内部接口调用"，无法从 token 反查是哪个 workspace/沙箱。
5. **泄露面**：env 会出现在 `docker inspect`、沙箱进程环境、崩溃转储和部分日志里；
   一次泄露 = 全集群内部面泄露。

## 决定（0.1.0）

**保留 env 方案，但把它明确标成"集群管理员级凭据"，不作为多租户隔离边界。** 理由：

- 当前部署形态是**单团队自托管**（一个控制面 + 自己的机器），没有不可信租户；
  先做 provider 会把 token 签发/存储/轮换/回收四件事一起拖进来，挡住 M4/M5 收尾。
- 改 provider 需要 schema 与启动路径联动（签发 → 注入 → 校验 → 停机回收），
  不是改一个常量；在 `runtimes` 表还没有消费者时硬做，容易做出第二套半成品。

因此 0.1.0 的边界写死为：

- token 视为**管理员凭据**：能拿到它的进程等于能调所有内部接口；不要在多租户环境里
  用同一个控制面托管互不信任的 workspace。
- 对外只暴露控制面/反代；沙箱与控制面之间走内网（OpenShell 网络策略默认拒绝出网）。
- 轮换方式：改 `ROOST_RUNTIME_TOKEN` → 重启控制面 → 对所有 workspace 执行 stop/start。
- 日志/错误信息不回显 token；`docs/design/observability.md` 的脱敏规则覆盖
  `authorization` / `x-runtime-token`。

## provider 方案（未实现，下一版）

目标：**每 workspace 一个短期 token，控制面签发、沙箱持有、API 按 workspace 校验、停机即失效。**

```
控制面                                沙箱
  issue(workspaceId, ttl)  ──注入 env──▶  ROOST_RUNTIME_TOKEN=<per-workspace>
  runtimes(id, workspace_id,              x-runtime-token: <token>
           token_hash, started_at,                │
           last_seen_at)                          ▼
  verify(token) → workspaceId ────────── 内部接口（只允许该 workspace）
```

要点：

1. **存储**：用 `runtimes` 表（migration 0002 已有 `token_hash` / `started_at` /
   `last_seen_at`）。这正是 E4 里"保留 `runtimes`"的理由之一；如果 provider 最终不用它，
   按 ADR 0006 的删除条件处理。
2. **签发**：`POST /api/workspaces/:id/start` 时生成 32 字节随机 token，只把 SHA-256
   存库，明文只进沙箱 env；TTL 跟沙箱生命周期（stop 即吊销）。
3. **校验**：`runtimeTokenFrom()` + hash 查 `runtimes`，得到 workspaceId，注入请求上下文；
   路由用它做 workspace 过滤。保留 header 名，沙箱侧不用改。
4. **轮换**：每次 start 重新签发；`last_seen_at` 由内部请求顺带更新（心跳）。
5. **兼容**：env 里的全局 `ROOST_RUNTIME_TOKEN` 保留一个过渡期，作为"管理员 token"，
   只能访问 `/api/internal/*` 的运维面（如 profile sync），不能读写租户数据；
   过渡期结束删掉。
6. **零依赖**：hash 用 `node:crypto` 的 `createHash('sha256')`，不需要新包。

改造清单（按顺序）：

- [ ] `runtimes` store 读写（issue / verify / revoke / touch）
- [ ] `start` 路径签发并注入；stop 吊销
- [ ] 10 个 `authorizeRuntime()` 收敛成一个共享实现，返回 `{workspaceId}` 而不是 boolean
- [ ] 内部路由按 workspace 过滤（现在多处信任调用方传的 `workspaceId`）
- [ ] 旧 env token 降级为管理员 token + 过期删除
- [ ] 测试：跨 workspace 调用必须 403；stop 后旧 token 立即 401；重启沙箱 token 变化

验收标准：把两个 workspace 的沙箱 token 互换，所有租户数据接口必须拒绝，且拒绝原因
可在审计里看到（不是静默 404）。

## 备选（不采用）

| 方案 | 结论 | 原因 |
|---|---|---|
| 每容器随机 token 只放内存 | ❌ | 控制面重启即全部失效，沙箱要重建；与 stop/start 复用冲突 |
| 自签 JWT（HMAC） | 暂缓 | 需要密钥管理/轮换；DB 查 hash 已够，零依赖更简单 |
| mTLS | ❌ 现在 | 需要证书签发与轮换，OpenShell 侧未验证；收益与复杂度不匹配 |
| 继续一个共享 token | ⚠️ 仅 0.1.0 | 单团队自托管可接受；多租户必须换 |

## 后果

- 0.1.0 不能宣称"多租户安全隔离"；产品文案与 `docs/design/sandboxing.md` §7 保持一致。
- E6 不算"已完成"，只算"有明确方案与边界"；TODO 保持未勾，等 provider 落地。
- `runtimes` 表的去留与本文绑定：provider 落地则转正，否则按 ADR 0006 删除。
