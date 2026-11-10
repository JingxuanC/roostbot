# Runtime Provider：把 Docker 变成可替换的运行时提供者

> 状态：接口方案（2026-11-08），Docker 是实现之一，不是架构本身。
> 相关：[docker-runtime.md](docker-runtime.md)、[agent-runtimes.md](agent-runtimes.md)、
> [sandboxing.md](sandboxing.md)、[local-runtime.md](local-runtime.md)。

## 1. 先分清四层

Roost 里已经有三个容易混在一起的概念。应该明确拆成四层：

```text
Layer 1  Control Plane
         房间、轮次、SSE、事件、token 签发
         只认 RuntimeManager 端口

Layer 2  WorkspaceRuntimeManager
         编排：签发 token → 构造 RuntimeSpec → ready → 落库
         不直接碰 Docker / OpenShell / Shell

Layer 3  RuntimeProvider
         计算与生命周期：docker / openshell / local / kubernetes
         ensure / status / stop / logs / exec

Layer 4  AgentAdapter
         容器里的 harness：dsh / claude-code / codex / grok-build
         只认 AgentAdapter 契约
```

关键边界：

```text
Docker 属于 Layer 3，不是新的产品层。
OpenShell 也只是 Layer 3 的一个实现。
```

## 2. 接口在代码里的位置

新增：

```text
apps/api/src/runtime-provider.ts
```

核心类型：

```ts
interface RuntimeProvider {
  readonly id: RuntimeProviderId
  capabilities(): RuntimeProviderCapabilities
  probe(context?: RuntimeProviderContext): Promise<RuntimeProviderProbe>
  ensure(spec: RuntimeSpec, context?: RuntimeProviderContext): Promise<RuntimeEnsureOutcome>
  status(key: RuntimeKey, context?: RuntimeProviderContext): Promise<RuntimeProviderStatus | null>
  stop(key: RuntimeKey, options?: RuntimeStopOptions, context?: RuntimeProviderContext): Promise<void>
  logs?(key, options?, context?): Promise<string>
  exec?(key, argv, options?, context?): Promise<RuntimeExecResult>
}
```

`RuntimeProvider` 只做计算：

- 创建/复用/停止运行时
- 报告真实 phase
- 返回日志
- 可选执行一次性命令

它**不做**：

- 不签发 room/runtime token
- 不写 workspace_runtime 表
- 不碰模型 key
- 不碰房间事件

这些仍然是控制面的职责。

## 3. RuntimeSpec

控制面只传“运行什么”，不传“这台机器具体怎么跑”。

```ts
interface RuntimeSpec {
  workspaceId: string
  name?: string
  image?: string
  command?: string[]
  env?: Record<string, string>
  secrets?: Array<{ name: string; ref: string }>
  resources?: { cpus?: number; memoryMb?: number; pids?: number }
  network?: 'none' | 'host' | 'bridge' | 'private'
  labels?: Record<string, string>
  readyTimeoutMs?: number
}
```

约束：

- `workspaceId` 是所有 provider 的稳定 key。
- provider 自己把 `workspaceId` 映射成容器名、PVC 名、进程目录。
- 控制面不传宿主机绝对路径。
- `env` 只放非敏感值；模型 key 最终应走 `secrets` / provider secret 机制。
  第一版为兼容现网，允许 runtime token 通过 `env` 注入，但要在文档里标为临时。

## 4. RuntimeProviderCapabilities

每种 provider 必须诚实上报能力，不要假装一致：

```ts
interface RuntimeProviderCapabilities {
  isolation: 'process' | 'container' | 'microvm' | 'remote'
  persistentWorkspace: boolean
  logs: boolean
  exec: boolean
  suspend: boolean
  resume: boolean
  networkPolicy: boolean
  resourceLimits: boolean
  secrets: 'env' | 'ref' | 'none'
}
```

示例：

| Provider | isolation | networkPolicy | exec | secrets |
|---|---|---|---|---|
| local | process | false | false | env |
| docker | container | false（第一版） | true | env |
| openshell | container | true | true | ref |
| kubernetes | container | 可做 | true | ref |
| microvm | microvm | true | true | ref |

控制面按能力决定：

- 是否显示“停止/重启”
- 是否允许 exec 诊断
- 是否使用 secret ref
- 是否提示“当前隔离较弱”

## 5. RuntimeManager 怎么组合 provider

保留现有控制面端口：

```ts
interface RuntimeManager {
  ensure(workspaceId, context?): Promise<RuntimeEnsureResult>
  status(workspaceId): Promise<{ sandbox: string; phase: RuntimePhase } | null>
}
```

内部实现变成：

```text
providerRuntimeManager(provider, tokenIssuer, specBuilder)
  ensure(workspaceId):
    1. 查已有 runtime（provider.status）
    2. 需要时签发 workspace token
    3. 构造 RuntimeSpec（镜像、env、readyTimeout）
    4. provider.ensure(spec)
    5. 记录 workspace_runtime
    6. 失败时吊销 token
```

这样 `runtime-manager-openshell.ts` / `runtime-manager-local.ts` / 未来的
`runtime-manager-docker.ts` 都只是“provider + 配置”的组合，不再是三套平行实现。

## 6. 现有代码映射

| 现状 | 目标 |
|---|---|
| `runtime-manager-openshell.ts` | `OpenShellRuntimeProvider` + 通用 manager |
| `runtime-manager-local.ts` | `LocalRuntimeProvider` + 通用 manager |
| 新增 Docker worker | `DockerRuntimeProvider` 的远端实现细节 |
| `packages/sandbox` | provider 的底层能力库；不再假设 OpenShell |
| `AgentAdapter` | 不变 |

注意：

`packages/sandbox` 的 `SandboxBackend` 是“工具执行后端”，不是
`RuntimeProvider`。两者可以在 provider 内部组合，但不要合并概念：

```text
RuntimeProvider  = 运行整个 workspace runtime
SandboxBackend   = 运行一条命令/工具
```

## 7. Docker provider 的位置

Docker provider 的形态：

```text
DockerRuntimeProvider (控制面)
  → HTTP + token
  → roost-docker-worker (.138)
  → docker run/start/stop
  → roost-ws-<hash> 容器
```

worker 是 Docker provider 的内部实现，不是第四层架构。

接口上仍然是：

```ts
const provider = createDockerRuntimeProvider({
  workerUrl,
  workerToken,
  image,
  cpUrl,
});
```

以后换 K8s：

```ts
const provider = createKubernetesRuntimeProvider({ kubeconfig, namespace });
```

控制面、room-agent、AgentAdapter、房间协议都不变。

## 8. 错误与就绪语义

统一错误码：

```ts
type RuntimeProviderErrorCode =
  | 'provider.not_available'
  | 'provider.unauthorized'
  | 'provider.provision_failed'
  | 'provider.ready_timeout'
  | 'provider.conflict'
  | 'provider.not_found'
  | 'provider.exec_failed'
```

必须遵守：

- `probe()` 失败不能伪装成 ready。
- `ensure()` 只有等到 room-agent ready 后才返回 `ready`。
- ready 超时必须返回 `provider.ready_timeout`，不能返回 success。
- 复用运行时 `created: false`，控制面负责吊销本次未使用的新 token。
- 失败启动必须回收 token。

ready 的 provider 实现：

- Docker worker：轮询容器内 `ROOST_READY_FILE`
- OpenShell：sandbox phase + room-agent ready 文件
- Kubernetes：Pod Ready + room-agent ready 文件
- local：等待 room-agent `sdk ready`

## 9. Contract test

新增一套 provider 契约测试，所有 provider 必须通过：

```text
probe 返回能力与版本
ensure 创建 → status ready
ensure 二次调用复用 created:false
stop → status stopped
stop 后 ensure 可重新启动
ready 超时返回 ready_timeout
provider 不可用时 not_available
不允许把失败包装成 ready
```

测试用 fake runner/worker，不依赖真实 Docker；另有一组 `.138` 集成测试。

## 10. 迁移顺序

1. 落地 `runtime-provider.ts` 类型与错误模型。
2. 把现有 local manager 包装成 `LocalRuntimeProvider`，跑 contracts。
3. 把 OpenShell manager 包装成 `OpenShellRuntimeProvider`（只做适配，不改行为）。
4. 实现 Docker worker + `DockerRuntimeProvider`。
5. 环境变量切换：

```text
ROOST_RUNTIME_PROVIDER=docker
```

兼容期保留：

```text
ROOST_SANDBOX=openshell
ROOST_SANDBOX=local
```

内部映射为对应 provider。

6. `.138` 集成通过后，默认切 docker。
7. OpenShell provider 保留为显式 fallback，不删代码。

## 11. 工作量

接口与类型：0.5 天

包装 local/OpenShell：0.5–1 天

Docker worker/provider：1–1.5 天

契约测试：0.5 天

镜像/ready/部署：1 天

远程 E2E：0.5–1 天

总计：**3–4 天**，与 Docker 方案估算一致；但后续换 provider 的成本从
“重写 runtime 层” 降到 “新增一个 provider”。

## 12. 结论

Docker 只是一个 provider。

```text
RuntimeManager   = 编排
RuntimeProvider  = 计算与生命周期
AgentAdapter     = harness
SandboxBackend   = 单次工具执行
```

这样 Docker、OpenShell、local、K8s、gVisor 都只是可替换实现，
房间、SSE、事件、Bot、AgentAdapter 全部不用动。
