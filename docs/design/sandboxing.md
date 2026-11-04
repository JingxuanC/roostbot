# 沙箱：决策在外，执行在内

> 状态：方案（2026-11-03）。配套：`workspace.md`（租户边界）、`scheduling.md`（睡/醒）、`loop-and-context.md`（上下文）。

## 1. 一句话

**DSH 决定做什么，沙箱只负责执行；凭据永远不进沙箱，只在出站时由可信侧注入。**

这句话是 Google Agent Compute Engine 与 NVIDIA OpenShell 的公共结论，也是它们与我们的现有设计唯一必须对齐的地方。

## 2. 两层边界（不要合成一层）

```
┌───────────────────────────────────────────────┐
│ workspace 容器（租户边界，一个 workspace 一个）  │
│                                               │
│   DSH 进程（决策：模型、工具选择、回合）          │
│        │ 工具执行请求                          │
│        ▼                                      │
│   ┌───────────────────────────────────────┐   │
│   │ 回合沙箱（执行边界，一个回合一个）        │   │
│   │  · 非 root、无 capabilities            │   │
│   │  · 文件系统：只读镜像 + 可写工作目录     │   │
│   │  · 网络：默认拒绝，唯一出站=监督者       │   │
│   │  · 凭据：不可见                         │   │
│   └───────────────────────────────────────┘   │
│        │ 唯一出站通道（互认证）                 │
│        ▼                                      │
│   监督者（可信侧）：查策略、注入凭据、开连接、审计  │
└───────────────────────────────────────────────┘
```

| 层 | 回答什么问题 | 谁实现 |
|---|---|---|
| workspace 容器 | 这是哪个租户？能碰哪些卷？ | 控制面 + 容器运行时 |
| 回合沙箱 | 这条命令能读什么、连哪里？ | 沙箱层（OpenShell / gVisor / microVM） |
| 监督者 | 这次出站允许吗？要加哪个凭据？ | 沙箱层的可信侧 |

**为什么不能合并**：ACE 的 microVM 与 OpenShell 的 supervisor 都证明，把“判断”和“执行”放在同一侧，凭据就必然暴露给 agent。

## 3. 选型：用 OpenShell，不自己写 bubblewrap

| 方案 | 隔离强度 | 自托管 | 现状 | 结论 |
|---|---|---|---|---|
| **NVIDIA OpenShell** | 内核 LSM（Landlock）+ seccomp 网络中介 + 策略证明 | ✅ Apache-2.0，Docker/K8s/microVM | 0.1.x 稳定发布节奏 | **采用** |
| gVisor | 用户态内核 | ✅ | 成熟 | 备选（GKE Agent Substrate 也在用） |
| Cloud Hypervisor microVM | 硬件 | ✅ | 需要宿主支持 | v2 用于高密度 |
| bubblewrap | 命名空间 | ✅ | 我们原先的想法 | **不够**：无网络中介、无凭据注入、无策略证明 |

OpenShell 已经解决了最难的四件事：

1. **按二进制限网**（不是按 IP）：`network_policies` 允许某二进制访问某目的地、且只允许某类请求（读 API 不允许写）
2. **凭据注入**：provider 存 key，supervisor 只在策略允许的端点加进请求
3. **失败关闭**：supervisor 连接断 → 冻结 agent，给短重连窗口，否则停
4. **策略证明**：Prover 在变更生效前用形式化验证算“会多放行什么”，有风险就阻塞自动批准

## 4. 凭据流（三类，路径不同）

| 凭据 | 存哪 | 谁注入 | 沙箱可见吗 |
|---|---|---|---|
| **模型 provider token**（BYO） | 控制面密钥服务 | 模型代理（DSH 侧 127.0.0.1 代理） | ❌ 只看到 `base_url` |
| **数据源 token**（Tushare/Wind/astock） | 控制面密钥服务 | 沙箱 supervisor 按策略注入到指定端点 | ❌ |
| **连接器 OAuth token**（Gmail/GitHub） | 连接器网关 | 网关按 `allowedConnections` 注入 | ❌ |

规则：**任何凭据都不写进 workspace 卷、不进 `$DSH_HOME`、不进提示词、不进日志。**

## 5. 策略模型（四段）

```yaml
version: 1
filesystem:
  read:  ["/usr", "/etc", "/opt/app"]          # 只读镜像
  write: ["/workspace", "/tmp"]                # 本回合可写
process:
  user: 1000
  caps: []                                     # 无 capabilities
network:
  default: deny
  allow:
    - binary: /opt/app/engine/report_engine
      host: api.qnaigc.com
      methods: [GET, POST]
      credentials: model-gateway               # 由 supervisor 注入
    - binary: /usr/bin/git
      host: github.com
      methods: [GET]
    - binary: /opt/app/dsh
      host: 127.0.0.1:4100                     # 仅本机模型代理
```

**三条硬规则**

1. **默认拒绝**：没有列出的文件、目的、程序一律拒绝
2. **按程序授权**：不是“这个沙箱能连 github”，而是“`git` 能连 github 的只读接口”
3. **变更需证明**：新增“带凭据的新主机”“新 HTTP 方法”“云元数据端点（169.254.169.254）”必须人工批准

## 6. 失败语义

| 场景 | 行为 |
|---|---|
| 策略不允许 | 拒绝执行，把原因交回模型（不是静默失败） |
| supervisor 断连 | **冻结** agent，短窗口重连；超时则停回合 |
| 沙箱崩溃 | 回合标 `failed(sandbox_crashed)`；工作目录保留 |
| 快照恢复失败 | 回退到冷启动；连续失败 3 次告警 |
| 网络被拒后重试 | 同一回合内不允许“换条路绕过”，除非策略显式允许 |

## 7. 本地/桌面端的诚实边界

| 环境 | 能承诺什么 |
|---|---|
| 云上 workspace 容器 | 完整：OpenShell 沙箱、凭据注入、默认拒绝 |
| 本机（macOS/Windows 桌面） | **只能承诺“用户自己的信任域”**：没有 Landlock/seccomp，不宣称沙箱隔离 |
| 本地能力节点 | 同上；所有调用带 grant 与审计，但**不是安全边界** |

这条必须写进产品文案：**不要把“本地执行”说成“安全沙箱”**。

## 8. 与调度/工作区的接口

| 接口 | 用途 |
|---|---|
| `POST /internal/sandbox/prepare` | 为一个回合创建/恢复沙箱（带 policy id、volume 挂载） |
| `POST /internal/sandbox/exec` | 执行命令/工具（stdin/stdout 流式、超时、信号） |
| `GET /internal/sandbox/policy` | 当前生效策略（供面板展示与审计） |
| `POST /internal/sandbox/policy/propose` | 提议策略变更 → 走证明与人工批准 |
| `POST /internal/sandbox/snapshot` | 打快照（供 `scheduling.md` 的暂停-恢复） |

## 9. 数据模型

```sql
CREATE TABLE sandbox_policies (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  version      INTEGER NOT NULL,
  yaml         TEXT NOT NULL,
  proof        TEXT,                -- 形式化验证结果（若跑过）
  approved_by  TEXT,
  approved_at  INTEGER,
  created_at   INTEGER NOT NULL,
  UNIQUE (workspace_id, version)
);

CREATE TABLE sandbox_runs (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,       -- 对应 scheduling.md 的 Run
  policy_id    TEXT NOT NULL,
  state        TEXT NOT NULL,       -- creating|ready|frozen|stopped|failed
  snapshot_id  TEXT,
  started_at   INTEGER,
  finished_at  INTEGER,
  exit_code    INTEGER
);

CREATE TABLE sandbox_denials (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT NOT NULL,
  at        INTEGER NOT NULL,
  kind      TEXT NOT NULL,          -- file|network|process|credential
  detail    TEXT
);
```

## 10. 分期

### v0（本机，不上沙箱）
- 本地执行就是本地执行；**如实标注**，不承诺隔离
- 记录所有工具调用的“文件/网络”意图，为将来策略提供数据

### v1（云上，回合沙箱）
- 每个回合一个 OpenShell 沙箱；文件/网络四段策略；凭据经 supervisor 注入
- **验收**：
  1. 沙箱内 `curl` 任意外网 → 被拒，且拒绝原因进上下文
  2. 只有 `report_engine` 二进制能访问模型网关，`git` 只能只读 GitHub
  3. 沙箱内找不到任何真实 token（`env`、文件、`/proc/*/environ` 都没有）

### v2（密度与证明）
- 快照恢复（对齐 ACE 的 <500ms 目标）、microVM 备选
- 策略变更的 Prover 与人工批准流
- **验收**：新增“带凭据的新主机”必须经证明 + 人批；未批的变更不生效

## 11. 待决问题

1. **OpenShell 是每 workspace 一个 gateway，还是全平台共享一个？**（共享省资源，但凭据隔离要靠 token 作用域）
2. **沙箱粒度**：每回合一个（最干净）还是每会话一个（省创建成本）？
3. **GPU/本地模型**：需要在沙箱里暴露 GPU 时，策略怎么写？
4. **策略证明的覆盖**：只证明网络，还是连文件系统一起证明？

## 14. 接入状态（诚实版）

> 2026-11-03 更新：已在远端服务器上装好 CLI/gateway 并用 **Docker 驱动 + mTLS** 连上，
> 但 sandbox 创建卡在驱动内部错误。细节与复现步骤见
> [`docs/spikes/0002-openshell-on-remote.md`](../spikes/0002-openshell-on-remote.md)。

| 部分 | 状态 |
|---|---|
| 策略模型（文件/进程/按二进制网络规则 + 默认拒绝） | ✅ `packages/sandbox`，有测试 |
| 策略 → OpenShell YAML 渲染 | ✅ `renderPolicyYaml()`；**字段名未对真 schema 校验** |
| `SandboxBackend` 接口（create / exec / stop / available / isolated） | ✅ |
| `OpenShellBackend`（调 CLI，零依赖） | ✅ 代码 + 用**假 CLI** 测过命令行形状；**没有真跑过** |
| `PassthroughBackend`（本机，明确 `isolated=false`） | ✅ 有测试 |
| 真 CLI 参数对齐 | ✅ 已实测并修正后端（无 `--mount`、exec `--timeout` 秒、stop 保留工作区） |
| 远端 gateway（Docker 驱动 + mTLS 认证） | ✅ 可用 |
| 真沙箱执行（远端验证） | ✅ 默认拒绝出网 + 白名单放行 + 非 root，见 spike 0002 |
| worker 回合在沙箱里执行 | ✅ `dsh --profile headless` 在沙箱内跑完（真实 DeepSeek，凭据由 provider 注入） |
| 部署硬约束 | **docker 驱动要求 Docker ≥ 28**（26/27 会把 `1000:1000` 当用户名查 getent） |

更新的实测（2026-11-03，远端）：

- Docker 26.1.3 → `BoundaryConfigWriteFailed: getent unable to find entry "1000:1000"`
- Docker 28.5.1（独立 dockerd）→ sandbox 起来；不写策略时 `wget` 被拒；写策略后 `example.com` 放行、`blocked.example.org` 仍拒
- 我们的 `renderPolicyYaml()` 第一版字段名不合 schema（网关报 `unknown field 'filesystem_policy.read'`），已按官方 schema 改为 `read_only` / `read_write` / `run_as_user` / `network_policies.<name>.endpoints|binaries`

为什么最初没真跑：

1. 这台机器**没有 Docker / Podman / Colima**（spike 早已记录），建不了 sandbox；
2. `pip install openshell` 装到的是 **SDK**（`SandboxClient` / `SandboxSession` / `WorkspaceClient`），
   入口点列表为空——**CLI 二进制不在 PyPI 包里**，要靠 install 脚本或发布产物；
3. 没有 gateway 可连，`SandboxClient.create()` 无从验证。

**下一步（有容器运行时的机器上，约 30 分钟）**：

```sh
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
openshell gateway start
openshell sandbox create --name probe --policy /tmp/probe.policy.yaml --detach
openshell sandbox exec probe -- sh -lc 'curl -sS https://example.com || true'   # 期望被拒
```

三件要对齐的事（按顺序）：

1. `sandbox create` / `exec` / `stop` 的真实参数顺序，与 `packages/sandbox/src/openshell.ts` 对照；
2. `renderPolicyYaml()` 的字段名对 schema（不一致就改渲染器，不改上游模型）；
3. SDK 的 `SandboxSession.suspend/resume` 与 `Scheduling` 的暂停-恢复握手对齐（密度靠快照恢复）。

在真跑通过之前，产品文案只能说「沙箱层已选定 OpenShell、策略与后端接口已就绪」，不能说「已隔离」。

## 15. 方案 A：一个用户一个沙箱，会话在里面长活

沙箱粒度定为**每用户/工作区一个**（租户边界，和 `workspace.md` 一致），不是每房间、每 Bot 一个：

```
沙箱 user-<workspace>（固定名字，workspace 卷持久）
  └─ room-agent（沙箱主进程，Node）
       ├─ 子进程：dsh --profile sdk（长活 JSON-RPC，stdio）
       ├─ 每 (room, bot) 一个 sessionId：room-<roomId>-<botId>
       ├─ 轮询控制面：取新消息 → session/prompt
       └─ 收 session.event/assistant/message → POST /api/rooms/:id/say
```

- 多轮上下文由 **DSH 会话自己维护**（不再每条消息 fork 一个 headless）
- 一个沙箱内多房间/多 Bot 用**不同 sessionId** 隔离；文件系统与工具权限是用户级共享
- 会话日志在 `$DSH_HOME/sessions`，`DSH_HOME=/workspace/.dsh` 跟着沙箱工作区持久化
- 单轮沙箱（sandboxing.md §2 的第二层）留到需要"每回合工具隔离"时再加

已落地：`apps/runtime/room-agent.mjs`（JSON-RPC 客户端 + 控制面循环 + 确定性 session id），
4 个测试覆盖多轮同会话、idem、协议解析。**尚未接线**：沙箱主进程改成 room-agent、控制面从沙箱可达（`host.openshell.internal`）、远端端到端验证。
