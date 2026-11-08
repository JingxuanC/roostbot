# Docker 直接运行 Agent 容器：替代 OpenShell 方案

> 状态：方案设计（2026-11-08），未实施。
> 前置：本地进程 runtime、`roost/agent:multi-runtime` 多 Runtime 镜像已验证。
> 目标：控制面不再依赖 OpenShell，直接在 Docker 宿主机上运行
> 「一个 workspace 一个容器」，容器里同时跑 room-agent 与多个 harness。

## 1. 决策

**放弃 OpenShell 作为默认 runtime，改用 Docker runtime worker。**

原因：

- 当前形态是「harness 整个在容器里」，容器已经是隔离边界。
- OpenShell 再叠一层 supervisor / mTLS / channel，没有带来当前需要的额外隔离，
  却让 sandbox provision、模型出网和 supervisor 鉴权变得脆弱。
- OpenShell supervisor 的 auth bundle 只有 token，没有 TLS client cert；
  gateway 开启 mTLS 时 supervisor 无法完成握手，sandbox 无法 ready。
- Docker 方案可以直接复用已经构建好的 `roost/agent:multi-runtime` 镜像和现有
  room-agent / AgentAdapter 代码，不需要改 Agent 协议。

保留后路：

- `ROOST_SANDBOX=openshell` 代码继续保留，作为 fallback / 实验。
- RuntimeManager 端口不变；以后接 gVisor / Kata / 微虚拟机只换实现。
- 多租户安全要求提高后，再考虑把容器 runtime 换到 gVisor / Kata。

## 2. 目标架构

```text
                控制面 (.116)
                ┌────────────────────────────┐
                │ roost-api                  │
                │ runtime-manager-docker.ts   │
                │  - RuntimeManager 实现      │
                │  - 签发 workspace token     │
                │  - 调 runtime worker        │
                └─────────────┬──────────────┘
                              │ HTTP (VPC 私网 + token)
                              ▼
                 Docker 宿主机 (.138)
                ┌────────────────────────────┐
                │ roost-docker-worker        │
                │  - ensure/status/stop/logs │
                │  - docker run/start/stop   │
                │  - ready 检查              │
                └─────────────┬──────────────┘
                              │ Docker API / CLI
                              ▼
                ┌────────────────────────────┐
                │ roost-ws-<hash>            │
                │  room-agent                │
                │    ├─ dsh --profile sdk    │
                │    ├─ claude               │
                │    └─ codex-acp            │
                │  /workspace (volume)       │
                └────────────────────────────┘
```

一个 workspace 一个容器；同一 workspace 的多个 Bot 共用容器和 workspace，
room-agent 内部按 Bot 会话隔离。

## 3. 为什么不从控制面直接调 Docker

控制面在 `.116`，Docker 在 `.138`。

可选方案：

1. 通过 SSH 执行 `docker`：脆弱、难做流式日志、错误恢复差。
2. 暴露 Docker TCP API：需要给控制面 Docker 权限，风险太高。
3. 在 `.138` 放一个小的 runtime worker：**推荐**。

worker 只做三件事：

```text
Docker 容器生命周期
ready 检查
日志/状态上报
```

不碰模型、不碰房间、不碰 token 签发。

## 4. Runtime worker API

服务：

```text
apps/runtime/docker-worker.mjs
```

绑定：

```text
172.17.43.58:8790 (VPC 私网)
```

鉴权：

```text
Authorization: Bearer <ROOST_DOCKER_WORKER_TOKEN>
```

### POST /v1/ensure

```json
{
  "workspaceId": "ws_...",
  "image": "roost/agent:multi-runtime",
  "containerName": "roost-ws-...",
  "workspaceDir": "/var/lib/roost/workspaces/ws_...",
  "env": { "ROOST_API": "...", "ROOST_RUNTIME_TOKEN": "..." },
  "readyTimeoutMs": 30000
}
```

返回：

```json
{ "sandbox": "docker:roost-ws-...", "phase": "ready", "created": true }
```

语义：

- 容器不存在 → 创建
- 容器存在且 running，ready → 复用，`created=false`
- 容器存在但 stopped → start，等待 ready
- 容器 error / removing / config 不匹配 → 删除后重建
- 创建或启动失败 → 返回 error，不假装 ready

### GET /v1/status?workspaceId=

```json
{ "sandbox": "docker:roost-ws-...", "phase": "ready", "container": "...", "startedAt": 0 }
```

没有容器时返回 `{ "sandbox": null, "phase": "stopped" }`。

### POST /v1/stop

```json
{ "workspaceId": "ws_...", "remove": true }
```

停止并可选删除容器；workspace 目录保留。

### GET /v1/logs?workspaceId=&tail=200

返回容器日志尾部，用于控制面诊断。

## 5. 容器启动参数

```bash
docker run -d \
  --name roost-ws-<hash> \
  --network host \
  --user 1000:1000 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 2048 \
  --memory 2g \
  --cpus 2 \
  -e ROOST_API=http://172.17.43.89:8787 \
  -e ROOST_RUNTIME_TOKEN=... \
  -e ROOST_WORKSPACE_ID=... \
  -e ROOST_WORKDIR=/workspace \
  -e ROOST_MULTI_RUNTIME=1 \
  -e ROOST_READY_FILE=/workspace/.roost/ready \
  -e DSH_PERMISSION_MODE=danger-full-access \
  -e ROOST_DSH_PERMISSION_MODE=danger-full-access \
  -e ANTHROPIC_API_KEY=... \
  -e ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
  -e OPENAI_API_KEY=... \
  -e OPENAI_BASE_URL=https://api.deepseek.com/v1 \
  -v /var/lib/roost/workspaces/<hash>:/workspace \
  roost/agent:multi-runtime \
  node /opt/roost/room-agent.mjs
```

注意：

- 第一版用 `--network host`，优先跑通 CP / 模型出网；host network 不是隔离边界，
  后续换成专用 bridge + 出网 allowlist。
- 不用默认 Docker bridge，因为 `.138` 的 dockerd 当前是
  `--bridge=none --iptables=false`，没有 NAT。
- 容器不挂 Docker socket，不挂宿主敏感目录。
- vendor key 通过 env 注入，属于当前「同 key 临时模式」；后续按 Bot 注入。

## 6. ready 与健康检查

当前 room-agent 只在 stdout 打 `sdk ready`，Docker worker 不适合靠日志判断。

新增最小协议：

```text
room-agent 完成 DSH initialize 后
  → 写 ROOST_READY_FILE
  → 内容是 JSON: { readyAt, pid, dshVersion }

worker 启动前删除该文件
  → docker exec roost-ws-... test -f /workspace/.roost/ready
  → 轮询到 readyTimeoutMs
```

room-agent 退出时删除 ready 文件；worker 重启容器时重新等待。

长期可改为 room-agent 内部 HTTP `/healthz`，但第一版文件标记足够。

## 7. 控制面改动

新增：

```text
apps/api/src/runtime-manager-docker.ts
```

实现现有 `RuntimeManager`：

```ts
ensure(workspaceId, { store })   → 签发 token → worker.ensure
status(workspaceId)              → worker.status
stop(workspaceId)                → worker.stop（可选扩展）
```

复用 OpenShell manager 的：

- `RUNTIME_TOKEN_TTL_MS`
- store token 签发/吊销
- 创建失败回收 token
- 复用容器时吊销本次未使用的新 token
- profile lock 拉取（保留；锁 id 仍注入容器）
- `externalRuntimeEnv()`：把 Claude/Codex/Grok 变量传给 worker

`main.ts` 增加分支：

```ts
ROOST_SANDBOX === 'docker'
  → dockerRuntimeManager({
      workerUrl: process.env.ROOST_DOCKER_WORKER_URL,
      workerToken: process.env.ROOST_DOCKER_WORKER_TOKEN,
      image: process.env.ROOST_SANDBOX_IMAGE ?? 'roost/agent:multi-runtime',
      cpHost: process.env.ROOST_CP_HOST ?? '172.17.43.89',
      cpPort: Number(process.env.ROOST_CP_PORT ?? port),
      runtimeToken: ...
    })
```

`workspace-runtime.ts` 的端口保持不变；`stop` 先作为可选方法。

## 8. 网络与 CP 暴露

当前：

```text
控制面 .116  127.0.0.1:8787
nginx 443 → 127.0.0.1:8787
沙箱 .138    172.17.43.58
```

容器里 room-agent 需要访问 CP。两个选择：

### 推荐：VPC 私网

```text
ROOST_HOST=0.0.0.0:8787
安全组只放行 172.17.43.58 → 172.17.43.89:8787
```

nginx 继续走 127.0.0.1。

### 保守：VPC 端口转发

在 `.116` 上跑：

```text
socat TCP-LISTEN:18787,bind=172.17.43.89,fork TCP:127.0.0.1:8787
```

只暴露 18787 给 `.138`。

第一版建议用 socat，避免改变 CP 的 bind。

## 9. 镜像改动

`roost/agent:multi-runtime` 已可运行，补两点：

1. Codex DeepSeek 配置：

```text
/opt/roost/codex-home/config.toml
ENV CODEX_HOME=/opt/roost/codex-home
```

内容：

```toml
model = "deepseek-chat"
model_provider = "deepseek"
[model_providers.deepseek]
base_url = "https://api.deepseek.com/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
```

2. ready 文件支持（room-agent 代码改动）。

镜像最终 user：

```text
USER 1000:1000
```

## 10. 兼容与迁移

保留：

```text
ROOST_SANDBOX=openshell
ROOST_SANDBOX=local
```

新增：

```text
ROOST_SANDBOX=docker
```

迁移顺序：

1. 完成 worker + manager + ready 文件；只在新 workspace 启用。
2. 本地/测试环境跑 DSH → Claude → Codex 单 Bot。
3. 跑三 Runtime 同房间。
4. 切换 `.116` 的默认 runtime 到 docker。
5. 观察一周后删除 OpenShell manager 的默认路径（代码可保留）。

旧 sandbox 容器不迁移；workspace 目录保留，重新在 Docker 容器打开。

## 11. 测试与验收

### 单元

- worker：ensure 复用/重建/失败、ready 超时、stop、logs、token 鉴权
- docker manager：签发 token、worker 不可达、复用容器时吊销新 token、错误映射
- 使用 fake runner，不依赖真实 Docker

### 集成（`.138`）

```text
docker-worker 启动
  → CP ensure
  → container running
  → ready 文件出现
  → CP 发消息
  → DSH 回复
  → stop / start 复用
  → workspace 文件保留
```

然后：

```text
Claude Bot → 真实 DeepSeek
Codex Bot  → 真实 DeepSeek
DSH+Claude+Codex 同房间
```

### 安全验收

- 容器内 uid=1000
- 容器无额外 capabilities
- no-new-privileges
- 不挂 docker.sock
- 只能写 /workspace 与 /tmp
- worker 只监听私网、无有效 token 拒绝
- CP 日志不出现 vendor key

## 12. 风险

| 风险 | 处理 |
|---|---|
| host network 无隔离 | 第一版接受；第二阶段 bridge + 出网 allowlist |
| 容器逃逸 = 宿主风险 | 非 root / cap-drop / seccomp；后续 gVisor/Kata |
| worker 持有 Docker 权限 | 私网 + token + 最小 API；只允许 roost-ws-* 容器 |
| vendor key 进入容器 | 临时同 key；后续 CP 代理/按 Bot 注入 |
| CP 私网暴露 | socat/安全组，不暴露公网 |
| Docker daemon 自定义 socket | worker `DOCKER_HOST=unix:///var/run/docker28/docker.sock` |
| 容器启动慢/模型首包慢 | ready 超时 30s；日志返回给 CP |
| 多租户资源争抢 | pids/memory/cpu 限制；worker 限并发 |

## 13. 工作量

| 项 | 估算 |
|---|---|
| Docker worker + 单测 | 0.5–1 天 |
| Docker runtime manager + 单测 | 0.5 天 |
| ready 文件 / room-agent 小改 | 0.5 天 |
| 镜像补 Codex 配置 / 重建 | 0.5 天 |
| `.138` worker 部署 + CP 网络 | 0.5 天 |
| 远程 E2E（DSH/Claude/Codex/同房间） | 0.5–1 天 |
| 文档 / 清理 / 回滚 | 0.5 天 |

总计：**3–4 个工作日**；如果只先跑单 Bot，**1–1.5 天**能出结果。

## 14. 结论

可行，而且比继续修 OpenShell supervisor/TLS 更直接：

- 不改 room-agent 协议
- 不改 AgentAdapter
- 不改房间/SSE/事件
- 只替换 RuntimeManager 和宿主容器生命周期
- 复用已构建的多 Runtime 镜像

第一版用 host network + 非 root 容器跑通；安全加固和 gVisor/Kata 放到第二阶段。

## 15. 实施记录（2026-11-08）

已落地并远程验证：

```text
CP .116      ROOST_RUNTIME_PROVIDER=docker
Docker .138   roost-docker-worker.service active
镜像          roost/agent:multi-runtime (uid 1000)
容器          roost-ws-a123e5ad9c4b  network=host
```

远程真实 DeepSeek 验证：

```text
ClaudeBot  → CLAUDE_DOCKER_OK
CodexBot   → CODEX_DOCKER_OK
DshBot     → DSH_DOCKER_OK
同房间     → THREE_OK {Claude/Codex/DSH 全部回复}
```

部署文件：

```text
deploy/roost-docker-worker.service
deploy/docker-worker.env.example
```

CP 额外环境：

```bash
ROOST_RUNTIME_PROVIDER=docker
ROOST_DOCKER_WORKER_URL=http://172.17.43.58:8790
ROOST_DOCKER_WORKER_TOKEN=...
ROOST_DOCKER_IMAGE=roost/agent:multi-runtime
ROOST_CP_HOST=172.17.43.89
ROOST_CP_PORT=8787
ROOST_CP_SCHEME=http
ROOST_CP_API_BASE=http://127.0.0.1:8787
ROOST_MULTI_RUNTIME=1
```

第一版限制：

```text
host network（无网络隔离）
vendor key 进入容器
workspace volume 在 .138 的 /var/lib/roost/workspaces
```

Codex 需要可写 CODEX_HOME；镜像提供模板，room-agent 启动时复制到
`/workspace/.codex/config.toml`。

## 16. OpenShell 封存

```text
默认不支持 openshell
ROOST_RUNTIME_PROVIDER=openshell 会启动失败
仅在遗留恢复时显式设置 ROOST_ALLOW_OPENSHELL=1
```

Docker 是默认生产 provider；旧 OpenShell 数据不迁移。
