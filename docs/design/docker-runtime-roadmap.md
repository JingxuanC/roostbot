# Docker Runtime：实施状态与剩余工作

> 状态：第一版已上线（2026-11-08）。
> 相关方案：[runtime-providers.md](runtime-providers.md)、[docker-runtime.md](docker-runtime.md)。
> 本文只记录“做了什么 / 还差什么 / 下一阶段验收”。

## 1. 已完成

```text
RuntimeProvider 接口
DockerRuntimeProvider
DockerRuntimeManager
Docker worker（ensure/status/stop/logs）
worker bearer token
一个 workspace 一个 Docker 容器
非 root / cap-drop ALL / no-new-privileges / memory/pids/cpu
room-agent ready 文件
Codex 可写 CODEX_HOME + DeepSeek provider 模板
远程真实 DeepSeek 验证
```

远程实测：

```text
ClaudeBot  → CLAUDE_DOCKER_OK
CodexBot   → CODEX_DOCKER_OK
DshBot     → DSH_DOCKER_OK
同房间     → THREE_OK
1329 tests pass
```

部署事实：

```text
CP .116      ROOST_RUNTIME_PROVIDER=docker
Docker .138  roost-docker-worker.service active
容器         roost-ws-<hash>，network=host，uid=1000
镜像         roost/agent:multi-runtime
```

## 2. 未完成工作

### P0：可稳定运行

| 项 | 当前问题 | 验收 |
|---|---|---|
| 镜像可重复构建 | 远程镜像是 overlay，不是完整 Dockerfile 重建 | 从 `agent.Dockerfile` 从零构建并跑通 |
| worker 单测 | 只有 Docker manager 测试 | fake docker runner 覆盖 ensure/stop/ready timeout/auth |
| provider 契约测试 | 各 provider 没有统一契约 | local/docker 至少通过同一套 contract |
| stop / token revoke | worker 有 stop，CP 没有公开 stop 路径 | 停 workspace 时 stop 容器并 revoke token |
| 容器清理 | 失败/归档容器可能残留 | 删除 workspace / 重建时清理 |
| CP 日志接 worker | 日志只有 `docker logs` | trace/运维接口可看容器日志 |
| worker 部署自动化 | systemd/脚本手工安装 | 仓库内一条部署命令 |

### P1：安全基线

| 项 | 当前状态 | 目标 |
|---|---|---|
| 网络 | host network | 专用 bridge + egress allowlist |
| 凭据 | vendor key 进容器 env | 按 Bot 注入 / CP 代理 |
| worker API | 可请求任意 image/command | 只允许 roost-ws-* 和允许的镜像 |
| 文件系统 | rootfs 可写 | read-only rootfs + tmpfs + workspace volume |
| seccomp | Docker 默认 | 明确 seccomp profile |
| 隔离 | Docker 容器 | gVisor / Kata 可选 |

### P2：生产化

```text
多 Docker 宿主调度
workspace 备份/恢复
workspace 磁盘配额
容器日志/指标/告警
镜像仓库与升级流程
OpenShell 代码封存/删除
旧 OpenShell workspace 数据迁移（明确不做）
```

### Agent 层未做

```text
外部 Agent 权限/审批桥
Claude/Codex tool permission 映射
Grok Build 真实接入
Hermes
Native Relay
按 Bot 的 credentialRef
```

## 3. 下一阶段实施顺序

```text
1. 从 Dockerfile 重建 roost/agent:multi-runtime
2. worker fake-runner 单测
3. provider contract test
4. stop + revoke + 容器清理
5. worker 日志进 CP trace
6. worker 自动部署
7. bridge + egress allowlist
8. per-Bot secret
9. gVisor/Kata 评估
```

## 4. 本轮不做的

```text
旧 OpenShell workspace 数据迁移
多 Docker 宿主调度
Grok/Hermes 接入
Agent 级权限桥
```

## 5. 结论

```text
能跑：✅ 已达成
能稳定运维：未完成 P0
能安全多租户：未完成 P1
生产级：未完成 P2
```
