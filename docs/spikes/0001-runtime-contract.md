# Spike 0001 — DSH 能不能当云运行时

- 日期：2026-11-03
- 目的：用真实证据检验 `docs/runtime-contract.md` 的七条，产出一张“已具备 / 缺 / 绕过方式”的对照表
- 环境：macOS 14 (arm64)，Node 24.21.0，pnpm 11.28.5，DSH 0.2.1-rc.5（从 npm 安装）
- 结论：**可以，但七条里只有一条现成；其余由前置 sidecar 补齐，不需要改 DSH 内核**

## 一、环境发现（先记三个坑）

| 发现 | 证据 | 影响 |
|---|---|---|
| 这台机器**没有 Docker**（也没有 podman/colima/lima） | `docker --version` → not found；`docker info` 失败 | 容器级验证（冷启动、卷、网络隔离）本轮做不了，用“同机 + 独立端口 + sidecar”代替 |
| 从 npm 装 DSH 时 pnpm **默认跳过原生模块 build** | `[ERR_PNPM_IGNORED_BUILDS] …node-pty, koffi, node-addon-require-builtin` | 镜像构建必须把允许列表写进 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` |
| macOS arm64 上 `node-addon-require-builtin` **没有对应 ABI 的预编译包**，需要本地编译 | `No usable prebuilt binary found in darwin-arm64`，随后尝试 `build/nodeabi/node-v137-darwin-arm64/require_builtin.node` 失败 | 这是 macOS 测试环境的问题；**云镜像目标 Linux 必须在 CI 里验证一次**，不能假定 mac 上跑通等于 Linux 跑通 |

DSH CLI 本身可用：`dsh --version` → `0.2.1-rc.5`；`dsh --help` 有 `--profile`、`--from-default-profile`、`--patch`、`--dump-config`，**没有** `--base-path`、没有 `--token`。

## 二、七条契约的实测结果

用正在运行的 DSH Web（端口 65471）探测：

| # | 契约 | 现状 | 证据 |
|---|---|---|---|
| 1 | 健康与活动 `/healthz` `/activity` | ❌ 缺失 | 两者都返回 `404` |
| 2 | runtime token | ⚠️ 部分（DSH 有自己的 Web 认证） | `/` → `401 dsh web authentication required; reopen the URL printed by dsh web.`；`/api/bot` → `401 unauthorized` |
| 3 | 优雅停机 | ❓ 未验证 | 需要容器/独立进程；本轮不杀用户正在用的宿主进程 |
| 4 | 计量 | ❌ 缺失（宿主级） | 无 usage 端点；ds-bot 内部有 usage，但没出口 |
| 5 | 子路径部署 `--base-path` | ❌ 缺失 | `dsh --help` 无此参数；静态资源按根路径引用 |
| 6 | 无交互插件同步 | ✅ 已有 | `dsh plugin --profile <name> add <pkg>` 可非交互；`--dump-config` 可校验 |
| 7 | 只读共享数据面 | ⚠️ 需改造 | 数据 MCP 端点写死本机（`127.0.0.1:50052`），要支持 base URL 覆盖 |

**关键收获**：第 2 条其实比预期好——DSH 已经自带 Web 认证（URL token/cookie），不是裸奔。云上要做的是**在它前面再加一层 runtime token**，而不是从零做认证。

## 三、Sidecar 原型（已跑通）

`apps/runtime/sidecar/proxy.mjs`：放在 DSH 前面，补齐第 1、2、5 条。

```
GET  /w/<ws>/healthz     → 探活（上游返回任意 <500 即算活）
GET  /w/<ws>/activity    → busy / turns / lastActivity，读 ds-bot 的 inflight.json 与 state.json
*    /w/<ws>/...          → 剥掉 base path 转发；/api/* 需要 Bearer runtime token
```

实测（sidecar 在 19400，前置到真实的 65471）：

| 请求 | 结果 |
|---|---|
| `GET /w/ws_test/healthz` | `200 {"ok":true,"upstream":401}` |
| `GET /w/ws_test/activity` | `200 {"busy":true,"turns":1,"lastActivity":"…","source":["bot/inflight.json","bot/state.json:mtime"]}` |
| `GET /healthz`（base 外） | `404 outside-base-path` |
| `POST /w/ws_test/api/bot` 无 token | `401 runtime-token-required`（sidecar 拦下） |
| `POST /w/ws_test/api/bot` 带 token | 转发到 DSH → `401 unauthorized`（DSH 自己的认证，证明透传正确） |
| `GET /w/ws_test/` 带 token | 转发 → `401 dsh web authentication required…`（同上） |

`activity` 的 `busy:true, turns:1` 是**真实数据**：这台机器上确实有一个回合在跑（Chief 正在授权写 PIT 数据）。

## 四、结论与决定

1. **不改 DSH 内核**：七条里 1/2/5 由 sidecar 提供，4/7 由控制面与数据面配置提供，3/6 需要镜像与进程管理，都不需要动内核。
2. **sidecar 是运行时镜像的一部分**，每个 workspace 容器一个，且：
   - 它持有 runtime token（浏览器永远拿不到）
   - 它是 `/activity` 的权威来源（未来可以换成 DSH 提供的正式端点）
3. **`activity` 目前是近似值**：只覆盖 ds-bot 回合；纯 DSH 会话（非团队）不计入。这条要在契约里标注为“已知缺口”。
4. **镜像构建必须在 Linux 上验证**：macOS 的原生模块问题不能作为 Linux 能跑通的证据。

## 五、下一步

- [ ] Linux 容器里跑同一套 sidecar + DSH，验证冷启动时间与内存（需要 Docker，本轮环境不具备）
- [ ] `SIGTERM` 优雅停机：独立进程 + 进行中回合，量“回合不丢”的窗口
- [ ] 把 `activity` 换成 DSH 正式端点，或把 ds-bot 的 inflight 信号推广到所有会话
- [ ] 数据 MCP 支持 `BASE_URL` 环境变量（共享只读数据面的前置条件）
