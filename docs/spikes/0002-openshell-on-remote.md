# Spike 0002：在远端服务器上真跑 OpenShell

> 日期：2026-11-03。机器：`47.90.253.85`（阿里云 Alibaba Cloud Linux 4，4 核 7.3GB，Docker 26.1.3，x86_64）。
> 目的：验证 `docs/design/sandboxing.md` 的选型，并把 `packages/sandbox` 的 CLI 假设对齐真实二进制。

## 结论（先看这个）

| 项 | 结果 |
|---|---|
| 装 OpenShell CLI / gateway / prover | ✅ 0.1.6（`rpm -i --nodeps`，见坑 1） |
| gateway 用 **Docker** 驱动启动 | ✅ 日志 `Using compute driver driver=docker` |
| CLI ↔ gateway 鉴权（mTLS） | ✅ `Authentication: Authenticated (mTLS transport)` |
| 创建 sandbox | ❌ `BoundaryConfigWriteFailed: ... getent unable to find entry "1000:1000" in passwd database` |
| 因此真沙箱隔离 | ❌ 仍未验证 |

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

## 仍未解决：创建 sandbox 失败

```
Error: sandbox entered error phase while provisioning:
  BoundaryConfigWriteFailed stage Docker sandbox bundle:
  Docker responded with status code 500: getent unable to find entry "1000:1000" in passwd database
```

试过：`alpine:3.20`、`node:22-alpine`、`ubuntu:24.04`、`nvcr.io/nvidia/base/ubuntu:24.04`；宿主已有 `admin:1000:1000`；`docker run --user 1000:1000` 正常。

判断：这是 docker 驱动在 “stage bundle” 阶段对 `uid:gid` 做 passwd 查找的行为（可能是该版本在 alinux/非 userns 环境下的缺陷）。下一步：

1. 在 Ubuntu/Debian 机器上复现（排除发行版因素）；
2. 或换 **Podman 驱动**（需要能装 podman 的发行版）；
3. 或向 OpenShell 提 issue，附上面的日志与 `docker info`。

## 对项目的意义

- 选型不需要改：gateway + 驱动 + 策略模型的形状与我们的 `SandboxBackend` 一致；
- **但“已接入”仍不成立**：创建 sandbox 都没成功，谈不上隔离验证；
- 远端现在留着一个可用的 gateway（mTLS 已认证、docker 驱动），下一次调试不用从零开始：

```sh
ssh root@47.90.253.85
openshell status          # Authenticated
openshell sandbox list    # 当前为空
```
