# Daytona 与 Kubernetes RuntimeProvider

> 状态：已实现 provider + 契约测试（2026-11-09）。
> 上位文档：[runtime-providers.md](runtime-providers.md)。两者都只是 Layer 3 的
> 计算 provider，不改控制面、房间、SSE、AgentAdapter。

## 1. 抽象没有变

```text
RuntimeManager   编排：token + RuntimeSpec + ready + 落库
RuntimeProvider  计算：Daytona sandbox / Kubernetes Pod
AgentAdapter     容器里的 harness：dsh / claude-code / codex / grok-build
```

新增：

```text
apps/api/src/runtime-provider-daytona.ts
apps/api/src/runtime-provider-kubernetes.ts
apps/api/src/runtime-manager-daytona.ts
apps/api/src/runtime-manager-kubernetes.ts
```

Daytona/Kubernetes manager 复用 Docker manager 的编排（token、profile lock、
credentialRef、env），只替换 provider。

## 2. Daytona

一个 workspace：

```text
Daytona Volume（S3/FUSE，挂 /workspace）
  + Daytona Sandbox（来自 roost/agent snapshot）
```

创建 sandbox 时：

```json
{
  "name": "roost-ws-<hash>",
  "snapshot": "roost-agent-snapshot",
  "volumes": [{ "volumeId": "vol_...", "mountPath": "/workspace", "subpath": "ws_..." }],
  "env": { "ROOST_API": "...", "ROOST_RUNTIME_TOKEN": "...", "ROOST_WORKSPACE_ID": "..." },
  "autoStopInterval": 0,
  "autoDeleteInterval": -1
}
```

room-agent 由 snapshot entrypoint 启动：

```text
node /opt/roost/room-agent.mjs
```

### 环境变量

```text
ROOST_RUNTIME_PROVIDER=daytona
DAYTONA_API_URL=https://app.daytona.io/api
DAYTONA_API_KEY=...
DAYTONA_ORGANIZATION_ID=...          # 可选
DAYTONA_SNAPSHOT=roost-agent:latest  # 必需
DAYTONA_VOLUME=roost-workspaces      # 可选，默认 roost-workspaces
DAYTONA_TARGET=...                   # 可选
ROOST_CP_HOST=...                    # Daytona 能访问的控制面地址
ROOST_CP_PORT=...
```

### 已知限制

Daytona 的生命周期 API 还没有便宜的 `/workspace/.roost/ready` 文件/exec 探针，
第一版在 sandbox `started` 时就报告 ready。room-agent 若没真正就绪，轮次会失败；
下一步应接 Daytona toolbox/PTY API 检查 marker，或让 room-agent 向控制面回报 ready。

## 3. Kubernetes

一个 workspace：

```text
PVC roost-ws-<hash>-workspace（/workspace）
  + Pod roost-ws-<hash>（node /opt/roost/room-agent.mjs）
```

Pod 的 readinessProbe 直接检查 marker：

```yaml
readinessProbe:
  exec:
    command: ["test", "-f", "/workspace/.roost/ready"]
```

因此 Pod `Ready=True` 才报告 ready。

### 环境变量

```text
ROOST_RUNTIME_PROVIDER=kubernetes
ROOST_K8S_API_URL=https://kubernetes.default.svc
ROOST_K8S_TOKEN=...                  # 缺省读 in-cluster serviceaccount token
ROOST_K8S_NAMESPACE=roost
ROOST_K8S_IMAGE=ghcr.io/.../roost-agent:...
ROOST_K8S_STORAGE_CLASS=...
ROOST_K8S_STORAGE_SIZE=10Gi
ROOST_K8S_SERVICE_ACCOUNT=...
ROOST_K8S_IMAGE_PULL_SECRETS=secret-a,secret-b
ROOST_CP_HOST=...                    # Pod 能访问的控制面地址
ROOST_CP_PORT=...
```

### 已知限制

- 第一版不实现 `exec`（Kubernetes exec 是 WebSocket 协议），诊断走 Pod logs。
- Pod 是单副本、无 Service；room-agent 只出站，不需要入站 Service。
- `stop` 删除 Pod，保留 PVC；workspace 删除/GC 是后续独立的生命周期。
- 需要镜像可拉取、namespace 已存在、存储类支持 RWO。

## 4. Kagent 是什么

用户提到的 `kagents` 实际是 **kagent**（CNCF 项目），不是 Kubernetes 的
sandbox/runtime。

kagent 是 Kubernetes-native 的 **AI Agent 控制平面**：

```text
Agent / AgentTemplate / Harness      CRD
Controller                           编译、调度、会话
Substrate                            运行/暂停/恢复 agent workload
A2A / MCP / gRPC                     对外协议
PostgreSQL                           sessions / tasks / history
```

它支持 Go/Python ADK、Codex、Claude 和自定义 harness，工具通过 MCP 接入。

它和我们的关系：

```text
我们的 Kubernetes provider  → 把 roost/agent 当作普通 Pod 跑
kagent                     → 另一个 agent 控制平面/框架
```

**不要把 kagent 当成 RuntimeProvider。** 可选集成方向：

1. 把 Roost Bot 暴露为 kagent 的 A2A agent；
2. 把 kagent 的 Agent 作为 Roost 的 Native/外部 Agent 接入房间；
3. 把 kagent 的 Harness 作为 AgentAdapter 的一种，而不是 provider。

当前先做 1/2 的边界，不引入 kagent 作为必需依赖。
