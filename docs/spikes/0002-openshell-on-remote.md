# Spike 0002：在远端服务器上真跑 OpenShell

> 日期：2026-11-03。机器：`47.90.253.85`（阿里云 Alibaba Cloud Linux 4，4 核 7.3GB，Docker 26.1.3，x86_64）。
> 目的：验证 `docs/design/sandboxing.md` 的选型，并把 `packages/sandbox` 的 CLI 假设对齐真实二进制。

## 结论（先看这个）

| 项 | 结果 |
|---|---|
| 装 OpenShell CLI / gateway / prover | ✅ 0.1.6（`rpm -i --nodeps`，见坑 1） |
| gateway 用 **Docker** 驱动启动 | ✅ 日志 `Using compute driver driver=docker` |
| CLI ↔ gateway 鉴权（mTLS） | ✅ `Authentication: Authenticated (mTLS transport)` |
| 创建 sandbox（Docker 26） | ❌ `BoundaryConfigWriteFailed: getent unable to find entry "1000:1000" in passwd database` |
| **创建 sandbox（Docker 28）** | ✅ 起来了，非 root uid=1000 |
| **默认拒绝出网** | ✅ `wget` 被拒（Permission denied） |
| **策略允许白名单** | ✅ `example.com` 放行，`blocked.example.org` 仍被拒 |
| 我们的 `renderPolicyYaml()` | ✅ 被网关接受（第一版字段名错了，已按 schema 改对） |

**根因已定位**（见下文「根因」）：OpenShell 0.1.6 的 docker 驱动要求 **Docker ≥ 28**。

## 环境事实

```
Alibaba Cloud Linux 4 (alinux 4)，kernel 6.6.102，x86_64
docker 26.1.3 (overlay2, cgroup v2)，容器里已有业务在跑
dnf 源里**没有 podman**（OpenShell 的 gateway RPM 硬依赖 podman）
磁盘 69G 用 81%（剩 13G），内存 7.3G（可用 1.7G）
```

## 坑与解法

### 坑 1：官方安装脚本装不上（gateway RPM 依赖 podman）

```
Problem: conflicting requests
  - nothing provides podman needed by openshell-gateway-0.1.6-1.fc44.x86_64
```

解法：只装需要的包并跳过依赖检查（这台机器用 Docker 驱动，不需要 podman 运行时）：

```sh
TAG=$(curl -sS https://api.github.com/repos/NVIDIA/OpenShell/releases/latest | jq -r .tag_name)  # v0.1.6
BASE="https://github.com/NVIDIA/OpenShell/releases/download/$TAG"
for pkg in openshell openshell-prover openshell-gateway; do
  curl -LsSf -o "/tmp/$pkg.rpm" "$BASE/$pkg-0.1.6-1.fc44.x86_64.rpm"
done
rpm -i --nodeps /tmp/openshell*.rpm
```

### 坑 2：gateway 不是 `gateway start`，是独立二进制 + `gateway add`

`openshell gateway` 只有 `add/remove/login/logout/select/info/list`。gateway 本体是 `/usr/bin/openshell-gateway`：

```sh
# 显式用 docker 驱动（RPM 默认配置 pin 的是 podman）
cat > /root/.config/openshell/gateway.toml <<'TOML'
[openshell]
version = 2
[openshell.gateway]
compute_driver = "docker"
TOML

# 首次启动会生成完整 PKI 到 /root/.local/state/openshell/tls/
# （server/、client/、ca.crt、jwt/）
/usr/bin/openshell-gateway --config /root/.config/openshell/gateway.toml
```

### 坑 3：`--disable-tls` 不是省事模式

`--disable-tls` 之后网关仍然要求 `authorization` 头，`openshell status` 报
`Authentication: Failed (missing authorization header)`，而且**没有**匿名模式开关。

### 坑 4：mTLS 的客户端证书位置与 `--gateway-insecure` 互斥

CLI 只在**不做 insecure 校验**时加载客户端证书。正确布局（来自二进制字符串
`client/tls.crt` / `client/tls.key`）：

```
~/.config/openshell/gateways/openshell/
  ca.crt
  client/tls.crt      ← /root/.local/state/openshell/tls/client/tls.crt
  client/tls.key
  metadata.json       ← {"auth_mode":"mtls",...}
```

然后**不要**加 `--gateway-insecure`：

```sh
openshell gateway add --local https://127.0.0.1:17670
openshell status
# Authentication: Authenticated (mTLS transport)
```

加了 `--gateway-insecure` 反而跳过客户端证书 → `missing authorization header`（花了很久才定位）。

## 真实 CLI 形状（与我们的后端假设对照）

`openshell sandbox create --help`（0.1.6）：

| 我们的假设 | 真实 |
|---|---|
| `sandbox create --name --policy --detach --from` | ✅ 都有；`--detach` 存在 |
| `--mount host:path:ro` | ❌ **没有 `--mount`**；持久化用 `--workspace`，bind mount 由 gateway 配置 `enable_bind_mounts` |
| `--env KEY=VALUE` | ✅ 有（文档明确说不要放密钥，用 provider） |
| `sandbox exec <id> -- cmd` | ✅，另有 `--timeout <秒>`（0=不超时）、`--workdir` |
| `sandbox stop <id>` | ✅（保留工作区）；`sandbox start/suspend/resume/delete` 也有 |

`packages/sandbox/src/openshell.ts` 已按此修正：去掉 `--mount`（改为明确报 `unsupported`）、
exec 传 `--timeout` 秒、stop 用 `sandbox stop`。

## 根因：Docker ≤ 27 不解析 `uid:gid`，OpenShell 需要 ≥ 28

**OpenShell 侧**（`crates/openshell-driver-docker/src/lib.rs:5092`）：staging 容器显式设置
`user: Some(format!("{SUPERVISOR_UID}:{SUPERVISOR_GID}"))`，即 `"1000:1000"`，注释写明这是为了让
`copyUIDGID` 上传按这个身份落盘。

**Docker 侧**：

| 版本 | `daemon/archive_tarcopyoptions_unix.go` 的行为 | 结果 |
|---|---|---|
| v26.1.3 / v27.5.1 | `idtools.LookupUser(container.Config.User)` —— 把**整个** `"1000:1000"` 当用户名查 | ❌ getent 找不到 |
| v28.0.0+ | `getUIDGID()` 先按 `:` 切开，数字部分直接用 | ✅ 正常 |

所以这是**版本不兼容**，不是发行版问题，也不是宿主缺 UID 1000。

### 验证方式（不动系统 Docker）

在远端跑了一个**独立 dockerd 28.5.1**（独立 socket 与 data-root，系统 Docker 未受影响）：

```sh
curl -LsSf -o /tmp/docker28.tgz https://download.docker.com/linux/static/stable/x86_64/docker-28.5.1.tgz
tar xzf /tmp/docker28.tgz -C /opt && mv /opt/docker /opt/docker28
/opt/docker28/dockerd --host unix:///var/run/docker28/docker.sock \
  --data-root /var/lib/docker28 --exec-root /var/run/docker28/exec \
  --iptables=false --bridge=none
```

gateway 配置指向这个 socket：

```toml
[openshell.gateway]
compute_driver = "docker"

[openshell.drivers.docker]
socket_path = "unix:///var/run/docker28/docker.sock"
```

### 实测输出（sandbox 内）

```
$ openshell sandbox create --name probe28 --from node:22-alpine --no-keep \
    -- sh -lc 'id; wget -q -T 5 -O /dev/null https://example.com && echo NET_OK || echo NET_BLOCKED'

uid=1000(node) gid=1000(node) groups=1000(node)
NET_BLOCKED
wget: can't connect to remote host (198.18.0.2): Permission denied
```

### 策略白名单实测

用我们渲染的 policy（`renderPolicyYaml()` 第一版字段名全错，网关直接拒绝：
`unknown field 'filesystem_policy.read'`；按 `docs/how-it-works/policies/schema.mdx` 改成
`read_only` / `read_write` / `run_as_user` / `network_policies.<name>.endpoints|binaries` 后通过）：

```
$ openshell sandbox create --name pol2 --from node:22-alpine --policy /tmp/roost-policy.yaml \
    -- sh -lc 'wget -q -T 8 -O /dev/null https://example.com && echo NET_ALLOWED || echo NET_DENIED;
               wget -q -T 8 -O /dev/null https://blocked.example.org && echo OTHER_ALLOWED || echo OTHER_DENIED'

NET_ALLOWED
OTHER_DENIED
wget: can't connect to remote host (198.18.0.3): Permission denied
```

一次验证了四件事：**策略被接受、白名单放行、默认拒绝、非 root 身份**。

## 生产落地建议

| 选项 | 说明 |
|---|---|
| **升级 Docker 到 ≥ 28** | 最干净；需要维护窗口（这台机器还跑着别的业务容器） |
| 独立 dockerd 28 + `socket_path` | 不动系统 Docker，已验证可行；多一个守护进程要管 |
| 换 Podman 驱动 | 需要能装 podman 的发行版（alinux 4 源里没有） |

## worker 接入沙箱（端到端，2026-11-03）

`apps/runtime/sandbox-runner.ts` 把 worker 的「想」放进沙箱：起一个沙箱，每条回复在里面跑一次探针命令，
把证据写回房间。远端实际跑通：

```
$ ROOST_API=http://127.0.0.1:8787 ROOST_RUNTIME_TOKEN=… \
  ROOST_SANDBOX=openshell ROOST_BOT_ID=selector \
  node --experimental-strip-types apps/runtime/worker.ts

[sandbox] sandbox roost-uk8sbb00v8 created
[room-worker] replied in rm_01M6HDQ… to seq 1
```

房间里收到的 Bot 消息：

```
[user] 盘前看一下异动
[bot]  收到：「盘前看一下异动」。这条回复由 openshell 沙箱内的同名进程生成
       （uid=1000 gid=1000 · host=eadc2b1188d8）；DSH 回合还没接进来。
```

再加两个实测约束（都已在代码里修掉）：

| 坑 | 现象 | 修法 |
|---|---|---|
| sandbox 名上限 19 字符 | `name exceeds maximum length (21 > 19)` | 名字改成 `roost-` + 10 位随机；后端先校验 `[a-z0-9][a-z0-9-]{0,18}` |
| 没有网络规则时**不会**自动加 baseline 路径 | `/bin/sh` 启动即 `Permission denied (os error 13)` | 策略里显式列 `/lib`、`/lib64`、`/sbin`、`/dev/null` |

第二条尤其值得记：schema 文档说「有网络规则时」才加 baseline 路径，我们默认拒绝出网 →
没有网络规则 → 必须自己把动态链接器路径列全。

## DSH 在沙箱里跑完一个回合（2026-11-03）

worker 的回复路径切到 `ROOST_SANDBOX_TURN=dsh`：沙箱内起 mock 模型（loopback），
执行 `dsh --profile headless --json "<房间消息>"`，解析 `final` 事件，把文本写回房间。

远端实测（房间里的两条消息）：

```
[user] 盘前看一下异动
[bot]  「这是沙箱内的 mock 模型回复：DSH 已在沙箱里跑完一个回合。」
       （沙箱内 DSH 回合 · mock 模型 · openshell）
```

`dsh --json` 的原始事件（沙箱内 stdout）：

```
{"type":"session","sessionId":"session-ef12c8eb-…","cwd":"/workspace"}
{"type":"text","text":"这是沙箱内的 mock 模型回复：…"}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"…"}
```

镜像：`roost/dsh-runtime:dev` = `node:22-slim` + `npm i -g @deepseek-ai/dsh@0.2.1-rc.5`
（glibc 让 native binding 用预编译包；alpine 的 musl 没验证）。

**这一轮又踩到三件事**：

| 坑 | 现象 | 修法 |
|---|---|---|
| 镜像的 CMD 立刻退出 | `sandbox is not ready (phase: Error)`，exec 被拒 | `create --detach` 必须带长期存活的 canonical process（默认 `sh -lc 'exec sleep infinity'`） |
| DSH 走 Anthropic Messages API | mock 只实现 `/chat/completions` 时 404 `/v1/messages` | mock 同时实现 `/v1/messages`（含 SSE 流式事件） |
| DSH_HOME 要可写 | `/var/lib/dsh` 不在 read_write 会失败 | 策略加 `/var/lib/dsh` 可写；`/proc`、`/opt` 只读 |

**换成真模型只改环境变量**：`ROOST_DSH_BASE_URL` 指向模型代理、`ROOST_DSH_MODEL` 指定模型、
`ROOST_DSH_MOCK=0`。密钥按设计应当走 provider，不进 `--env`。

## 对项目的意义

- 选型成立：gateway + docker 驱动 + 策略模型的形状与我们的 `SandboxBackend` 一致；
- **沙箱隔离在远端已真实验证**（默认拒绝 + 白名单 + 非 root），不再是纸面；
- 唯一硬约束：**docker 驱动要求 Docker ≥ 28**，写进 `sandboxing.md` 与部署文档；
- **worker 的回合已经是沙箱里的 DSH 回合**（模型用 mock，路径是真的）；
- 远端留着可用的 gateway（mTLS + docker28 socket）与独立 dockerd，下一次调试不用从零开始：

```sh
ssh root@47.90.253.85
openshell status                     # Authenticated
openshell sandbox list               # 当前为空
docker -H unix:///var/run/docker28/docker.sock ps   # 独立 dockerd 28
```
