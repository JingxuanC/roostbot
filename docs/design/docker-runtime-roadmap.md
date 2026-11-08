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
容器         roost-ws-<hash>，network=roost-ws（bridge），uid=1000
出口         iptables 默认拒绝，只放行 CP + api.deepseek.com:443
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
| worker 部署自动化 | systemd/脚本手工安装 | `scripts/install-docker-worker.sh` |

### P1：安全基线

| 项 | 当前状态 | 目标 |
|---|---|---|
| 网络 | ✅ bridge `roost-ws` + egress allowlist（`deploy/roost-egress-allowlist.sh`） | 保持 DNS 刷新、后续加域名白名单 |
| worker 指标 | ✅ `/metrics`（ensures/stops/failures/uptime） | CP 接入告警 |
| workspace 配额 | ✅ 启动前 `du` 检查和容器资源上限 | 运行时硬配额 |
| 备份 | ✅ `scripts/backup-docker-workspaces.sh` | 一致性快照 |
| 凭据 | ✅ 按 Bot 的 credentialRef JSON map 注入（workspace 内隔离） | 后续接 Vault/KMS |
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


## 6. 第二轮补充（2026-11-08）

```text
✅ 完整 Dockerfile 从零构建 roost/agent:multi-runtime-full
✅ worker 单测（fake docker）
✅ provider contract test
✅ workspace stop / runtime token revoke
✅ runtime logs API + docker ensure trace
✅ worker image/command/network allowlist
✅ bridge roost-ws + NAT
✅ egress 默认拒绝，只放行 CP 与 api.deepseek.com:443
✅ egress service/timer
✅ worker 安装脚本
```

远程桥接网络实测：

```text
Claude / Codex / DSH 同房间全部回复
BRIDGE_OK {
  CLAUDE_BRIDGE_OK: true,
  CODEX_BRIDGE_OK: true,
  DSH_BRIDGE_OK: true
}
```

未完成：

```text
⚠️ read-only rootfs：可配置开启，但 DSH native addon 需要可写缓存，默认关闭
✅ per-Bot credentialRef（文件 secret provider，workspace 内 Bot 隔离）
❌ gVisor/Kata
⚠️ 多 Docker 宿主：provider 已支持 `ROOST_DOCKER_WORKER_URLS` 确定性放置，实际第二台宿主待部署 / 备份 / 配额 / 指标告警
✅ ACP 权限桥（external-approvals.mjs）；Claude CLI 无 permission 协议 / Grok / Hermes / Native Relay
```


## 7. 第三轮补充（2026-11-08）

```text
✅ per-Bot credentialRef 文件 secret provider + 容器内 map
✅ ACP external approval bridge -> CP approvals
✅ multi-worker 确定性放置（ROOST_DOCKER_WORKER_URLS）
✅ worker /metrics、workspace 启动前配额检查
✅ 备份/恢复脚本
✅ gVisor/Kata 评估文档
✅ 镜像提升脚本
✅ 远端 bridge + egress 下三 Runtime 复测
```

复测：

```text
FINAL_OK {
  FINAL_CLAUDE_OK: true,
  FINAL_CODEX_OK: true,
  FINAL_DSH_OK: true
}
```

仍未完成：

```text
❌ gVisor/Kata 实际安装与兼容性验收
❌ 第二台 Docker 宿主实际部署
⚠️ Prometheus 规则已写（`deploy/prometheus-roost-rules.yml`），未接实际 Alertmanager
❌ Grok Build 二进制 / Hermes / Native Relay
⚠️ read-only rootfs 默认关闭（DSH native addon 可写缓存）
```


## 8. 第四轮补充（2026-11-08）

```text
✅ Native Relay PoC
   GET  /api/native/assignments
   POST /api/native/advance
   apps/runtime/native-relay.mjs
   docs/design/native-relay.md
✅ 远端控制面已部署该 API
```

仍受外部依赖阻塞：

```text
❌ Grok Build 官方二进制
❌ Hermes 协议
❌ 第二台 Docker 宿主
❌ Prometheus/Alertmanager 实例
❌ gVisor/Kata 安装
```
