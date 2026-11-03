# apps/runtime — 云上运行时镜像与控制

把 DSH 装进容器，并按 `docs/runtime-contract.md` 补齐 DSH 自己还没有的入口：
base path、`/healthz`、`/activity`、runtime token。实现方式是**前置一个 sidecar**，
不改 DSH 内核。设计取舍与实测见 `docs/spikes/0001-runtime-contract.md`。

```
控制面 / 浏览器
      │  <base>/...
      ▼
sidecar（127.0.0.1:19400）  ← runtime token、/healthz、/activity
      │  剥掉 base path 后转发
      ▼
DSH Web（127.0.0.1:4100）   ← 只监听回环，不直接暴露
```

## 本机怎么跑 sidecar

先有一个在跑的 DSH Web（本机通常是 `http://127.0.0.1:65471`），然后在仓库根目录：

```bash
UPSTREAM=http://127.0.0.1:65471 \
PORT=19400 \
BASE_PATH=/w/ws_test \
RUNTIME_TOKEN=rt_test_123 \
DSH_DATA_DIR="$HOME/.dsh/alpha-desk" \
node apps/runtime/sidecar/proxy.mjs
```

`PORT=0` 会让系统分配空闲端口，sidecar 启动日志里会打印真实端口（测试就是这么做的）。

```bash
curl -s http://127.0.0.1:19400/w/ws_test/healthz    # 200 {"ok":true,"upstream":401,...}
curl -s http://127.0.0.1:19400/w/ws_test/activity   # 200 {"busy":false,"turns":0,...}
curl -s http://127.0.0.1:19400/healthz              # 404 outside-base-path

# 无 token：sidecar 直接拒绝，不碰上游
curl -s -X POST http://127.0.0.1:19400/w/ws_test/api/bot
# 401 {"ok":false,"error":"runtime-token-required"}

# 有 token：转发到 DSH（DSH 自己的 401 原样返回，证明透传）
curl -s -X POST -H 'Authorization: Bearer rt_test_123' \
  http://127.0.0.1:19400/w/ws_test/api/bot
```

`RUNTIME_TOKEN` 只用于 sidecar 鉴权，**不会**转发给 DSH；浏览器导航仍可凭 DSH 自己的
cookie 通过。

### 测试

零依赖，`node:test` + 真实子进程；假上游用 `node:http` 返回 401。不需要 Docker，
不占用固定端口：

```bash
node --experimental-strip-types --test apps/runtime/test/*.test.ts
```

覆盖：`/healthz` 的 `upstream` 字段、`/activity` 的 `busy` 布尔、base 外 404（含
`/w/ws_testextra` 这类前缀兄弟）、无 token 的 401、有 token 的透传、以及 token 不泄漏
到上游。测试结束先发 `SIGTERM`，超时才用 `SIGKILL` 兜底。

## 容器怎么起

```bash
# 构建（本机没有 Docker，这一步从未跑过；见下面的诚实边界）
docker build -f apps/runtime/Dockerfile -t roostbot-runtime:dev apps/runtime

docker run --rm --init \
  -p 127.0.0.1:19400:19400 \
  -e RUNTIME_TOKEN="rt_dev_$(openssl rand -hex 12)" \
  -e BASE_PATH=/w/ws_dev \
  -v roostbot-data:/data \
  roostbot-runtime:dev
```

| 变量 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `UPSTREAM` | 是（镜像里有默认值） | `http://127.0.0.1:4100` | sidecar 转发的 DSH 地址 |
| `RUNTIME_TOKEN` | **是** | 无 | 控制面签发；空值直接 exit 2 |
| `BASE_PATH` | **是** | 无 | 如 `/w/ws_dev`；必须以 `/` 开头 |
| `PORT` | 否 | `19400` | sidecar 监听端口（只绑 127.0.0.1） |
| `DSH_PROFILE` | 否 | `/opt/roostbot/profile` | 控制面生成的 profile 目录 |
| `DSH_HOME` / `DSH_DATA_DIR` | 否 | `/data/dsh` / `$DSH_HOME/alpha-desk` | 状态与 activity 信号；挂卷 |
| `DSH_SHUTDOWN_TIMEOUT` | 否 | `20` | SIGTERM 后等 DSH 的秒数，超时才 SIGKILL |
| `DSH_EXTRA_ARGS` | 否 | 空 | 追加给 `dsh web` 的参数（按空格拆分） |

- **两进程编排**：`entrypoint.sh` 先起 sidecar（等 `/healthz` 200），再起
  `dsh web --profile "$DSH_PROFILE"`；一个后台探针每 2 秒检查 sidecar，连续 3 次失败就
  停 DSH，让容器以非零退出，而不是留一个没有前门的 DSH。
- **SIGTERM**：先停 DSH（给 `DSH_SHUTDOWN_TIMEOUT` 秒排空回合），再停 sidecar；两次都
  是 `TERM` 优先，超时才 `KILL`。第二个 TERM 会被忽略，避免停机中途留下孤儿进程。
- **HEALTHCHECK**：请求 sidecar 的 `<base>/healthz`，并要求 `"ok":true`。只有 200 不够：
  DSH 还没起来时 sidecar 也会答 200 + `{"ok":false}`。
- **profile**：镜像里的 `profile/` 只是空基线（`package.json` + 空 `cordis.yml` /
  `cordis.patch.yml`）。真实 profile 由控制面生成并从卷挂载/指过去；不要把自己的插件
  或 token 打进镜像。

## 诚实边界：本机不承诺沙箱

`docs/design/sandboxing.md` §7 的表格是产品文案的唯一依据：

| 环境 | 能承诺什么 |
|---|---|
| 云上 workspace 容器 | 完整：OpenShell 沙箱、凭据注入、默认拒绝 |
| 本机（macOS/Windows 桌面） | **只能承诺“用户自己的信任域”**：没有 Landlock/seccomp，不宣称沙箱隔离 |
| 本地能力节点 | 同上；所有调用带 grant 与审计，但**不是安全边界** |

所以：

- 本仓库的 sidecar / 测试只证明**路由、鉴权、停机**；不证明任何隔离。把“本地执行”
  说成“安全沙箱”是错的。
- 这个镜像本身是 **workspace 容器边界**（一个 workspace 一个），不是**回合沙箱**
  （sandboxing.md §2 的两层边界）。回合级隔离要由控制面 + OpenShell/gVisor 提供，
  `Dockerfile` 里没有实现。
- 本机没有 Docker（`docs/spikes/0001-runtime-contract.md`），因此 `Dockerfile` 与
  `entrypoint.sh` 的容器行为**未经构建验证**；具体未验证项写在 `Dockerfile` 头部。
  至少要在 Linux CI 上验证：npm 全局安装与 musl 原生模块、`dsh web --profile` 的真实
  参数、DSH 监听端口、HEALTHCHECK。**macOS 上跑通不等于 Linux 能跑。**
- 子路径部署仍是半成品：sidecar 会剥掉 base path，但 DSH 的静态资源引用是根路径的
  （spike 已记录）。浏览器直接打开 `<base>/` 可能仍会请求 `/assets/...`。
- `activity` 只统计 ds-bot 的 `inflight.json`；纯 DSH 会话不计入（已知缺口）。
- sidecar 不做 TLS，也不做 SSE 背压；云上由控制面/反代终止 TLS。

## 文件

- `sidecar/proxy.mjs`：零依赖 sidecar；`PORT=0`、base 边界、SIGTERM 排空。
- `test/sidecar.test.ts`：上面的集成测试。
- `Dockerfile`：node:22-alpine + DSH（`DSH_VERSION` 可覆盖）+ 基线 profile。
- `entrypoint.sh`：env 校验、两进程编排、SIGTERM 有序停机。
- `profile/`：空基线，不代表租户 profile。
