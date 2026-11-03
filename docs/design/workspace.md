# 工作区：一个家，多个窗口，若干能力节点

> 状态：方案（2026-11-03）。与 `docs/architecture.md`（租户模型）、`docs/design/scheduling.md`（激活）配套。

## 1. 一句话

**Workspace 是逻辑身份；Runtime 是它的一个运行实例；客户端只是窗口；本地机器是能力节点。**

多端（云机 / 本机 / 桌面 / 手机）不是多份 workspace，而是**同一个 workspace 的多个客户端**，加上**可能的一个本地能力节点**。

## 2. 三个概念，别混用

| 概念 | 是什么 | 谁拥有状态 |
|---|---|---|
| **Workspace** | 一份 Bot 工作上下文：Bot 团队、房间、记忆、技能、routine、文件 | 它的 home runtime 的卷 |
| **Runtime** | 跑这份 workspace 的一个 DSH 进程（云容器或本机进程） | 进程 + 卷 |
| **Client** | 浏览器 / 桌面 / 手机的窗口 | 只持有 UI 偏好与草稿 |
| **Capability node** | 挂在 workspace 上的本机 DSH，只出站，提供文件/本机 MCP/本机模型 | 节点本机 |

**硬规则：一个 workspace 有且只有一个 home runtime。** 两个家 = 状态分叉，我们不接受。

## 3. 三种部署形态

### A. Cloud（默认）

```
手机/浏览器/桌面 ──► 控制面 ──► 云上 home runtime（容器 + 卷）
                                   │
                                   └─(出站 WS)─ 本地能力节点（可选）
```

- home 常驻或按 `docs/design/scheduling.md` 睡/醒
- 本地节点提供"够得着"的能力：本机文件、本机 MCP、本机模型额度

### B. Local（本机为主）

```
浏览器/桌面 ──► 本机 DSH（home runtime）
      └──────► 控制面（仅用于远程访问与备份）
```

- home 就是用户自己的机器；能力节点不需要，因为本来就同机
- 关盖即停：routine 会记 missed（见调度文档 §8），这是诚实的

### C. Hybrid（云 home + 本地节点）

最常见的长期形态：**Bot 团队住云上，需要时才伸手到你的机器**。

## 4. 客户端模型

| 项 | 规则 |
|---|---|
| 认证 | 每台设备一个 device token（配对获得），可单独吊销 |
| 会话 | 客户端无状态；断线重连从事件 `seq` 续 |
| 输入 | 谁先提交谁赢；每条带 `idem`，重发不重复 |
| 流式 | 同一回合可被多端同时观看（SSE 多订阅） |
| 草稿 | 只存客户端本地，不上云 |
| 升级 | 客户端与 home 有协议版本；home 升级中客户端显示"正在升级"，不伪装成断线 |

**多端并发不冲突的部分**：看、读、翻历史、审批。
**必须串行的部分**：同一个房间的回合（一次一个 speaker，见调度与对话文档）、同一个 Bot 的写操作。

## 5. 能力节点协议

本地 DSH 作为能力节点时，只说三件事：

```jsonc
// 节点启动后上报
{ "hello": { "nodeId": "ln_abc", "label": "paopao 的 MacBook",
             "provides": ["fs", "mcp:astock", "model:local"], "protocol": 1 } }

// 云上 Bot 请求一次能力
{ "call": { "id": "c1", "cap": "fs.read", "args": { "path": "~/drafts/x.md" },
            "grant": "g_7f", "deadline": "2026-11-03T12:05:00Z" } }

// 节点回结果或拒绝
{ "reply": { "id": "c1", "ok": true, "data": "…" } }
{ "reply": { "id": "c1", "ok": false, "code": "denied", "reason": "path outside grant" } }
```

规则：

1. **只出站**：节点连控制面，不开端口、不需要公网 IP
2. **能力白名单**：`grant` 由人授予（一次性 / 本轮 / 长期），节点自己再校验一次路径与命令
3. **断线即 unavailability**：调用方拿到 `unavailable`，不挂起等；重连后不自动重放（避免重复写），要人确认
4. **审计**：每次调用记一行（谁、哪个 Bot、哪个 grant、结果），不记内容

## 6. 状态分区

| 状态 | 位置 | 谁写 | 冲突规则 |
|---|---|---|---|
| Bot、房间、会话、记忆、routine、技能 | workspace 卷 | home runtime | **卷永远赢** |
| 索引、账本、计量、审计 | 控制面 DB | 控制面 | 从卷派生，可重建 |
| 附件（头像/图片/文件） | 对象存储 + 卷内引用 | 客户端上传经控制面 | 不可变，按内容寻址 |
| UI 偏好、草稿、已读位置 | 客户端本地 | 客户端 | 不回传 |
| device token、配对 | 控制面 | 控制面 | 可吊销 |

**明确不做的**：不在客户端缓存 Bot 数据（否则离线写入会分叉）。

## 7. 生命周期

```
absent ──create──► stopped ──start──► starting ──ready──► running
                     ▲                                      │
                     └──────────── stop / idle ──────────────┘
                                   │
                              snapshot（卷快照）
                                   │
                            migrate（换机器/换形态）
```

- **create**：控制面建卷 + 首次启动，profile 从镜像基线复制
- **start**：挂卷 → 注入 runtime token → 启动 → 健康检查（`/healthz` + `nextDueAt`）
- **stop**：drain（拒绝新回合、等进行中、超时强停）
- **snapshot**：卷快照，用于迁移与备份；**不包含** provider token
- **migrate**：快照 → 新 runtime 挂载 → 客户端重连；迁移期间 workspace 只读

### 形态切换（Local ↔ Cloud）

这是**显式迁移**，不是同时跑两份：

1. 旧 home drain 并写一个 checkpoint（进行中的回合结束或标记 `interrupted`）
2. 卷快照 → 新 home
3. 客户端从控制面拿到新地址，重连
4. 旧 home 保持 stopped，不删卷（回滚用）

**禁止**：两个 home 同时跑同一卷。技术上会用文件锁 + master-id 兜底（参考 `~/.dsh/alpha-desk/bot/home-lock.json` 这类做法），但产品上不允许进入这种状态。

## 8. 数据模型（控制面）

```sql
CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  home_mode   TEXT NOT NULL,              -- cloud | local
  state       TEXT NOT NULL,              -- absent|stopped|starting|running|stopping
  volume_id   TEXT,
  profile_ver TEXT NOT NULL,              -- 镜像里的产品版本
  created_at  INTEGER NOT NULL
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL,             -- owner|admin|member|viewer
  invited_by   TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE runtimes (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind         TEXT NOT NULL,             -- home | local-node
  container_id TEXT,
  base_url     TEXT,                      -- 控制面内部地址，不对外
  token_hash   TEXT NOT NULL,
  started_at   INTEGER,
  last_seen_at INTEGER
);

CREATE TABLE client_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  device_label TEXT,
  token_hash   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at   INTEGER
);

CREATE TABLE capability_grants (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  node_id      TEXT NOT NULL,
  cap          TEXT NOT NULL,             -- fs | mcp:<name> | model:<name>
  scope        TEXT NOT NULL,             -- 允许的路径前缀/命令白名单，JSON
  granted_by   TEXT NOT NULL,
  expires_at   INTEGER,
  created_at   INTEGER NOT NULL
);
```

## 9. 接口（控制面）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workspaces` | 我有权看到的 workspace（含状态、home_mode） |
| POST | `/api/workspaces` | 创建（分配卷、选 home_mode） |
| POST | `/api/workspaces/:id/start` | 启动 home |
| POST | `/api/workspaces/:id/stop` | 优雅停机 |
| POST | `/api/workspaces/:id/snapshot` | 打快照 |
| POST | `/api/workspaces/:id/migrate` | 切换 home（换机器/换形态） |
| POST | `/api/workspaces/:id/nodes` | 登记本地能力节点（配对后） |
| GET | `/api/workspaces/:id/presence` | 谁在线、哪些设备在看 |
| WS | `/api/realtime` | 事件流（多端同源）与节点出站通道 |

## 10. 失败模式与对策

| 场景 | 表现 | 对策 |
|---|---|---|
| home 睡着 | 请求变慢或 402/503 | 控制面唤醒（提前 1–3 分钟），客户端显示"正在唤醒" |
| 本地节点离线 | 依赖本机能力的工具失败 | 返回 `unavailable`，Bot 被要求换路径或问人；不挂起 |
| 两个客户端同时发消息 | 可能重复 | `idem` 去重；房间一次一个 speaker |
| 客户端版本旧 | 协议不匹配 | 握手报 `minProtocol`，提示升级；不静默降级 |
| 迁移中断 | 旧 home 已停、新 home 未起 | `state=migrating` 时禁止操作；从快照重试 |
| 卷损坏 | 启动失败 | 从最近快照恢复；不自动覆盖，需人确认 |
| 时钟偏斜 | routine 提前/延后 | 以控制面时钟为准；home 只报相对时间 |

## 11. 分期

### v0（单机）
- 一个 workspace = 本地 profile；客户端 = 浏览器
- 控制面可以不存在（本地直连 DSH）
- **验收**：本机开两个浏览器标签，看到同一 workspace、同一会话，消息不重复

### v1（云 home + 多客户端）
- 控制面持 workspace/runtime/client_session；浏览器与桌面同时连
- **验收**：
  1. 手机与桌面同时看一个房间，流式内容一致，不重复
  2. 一个设备被吊销后立刻失效
  3. home drain 期间新回合被拒，进行中的回合不丢

### v2（本地能力节点 + 迁移）
- 节点配对、grant、审计；Move to Cloud / Move Local
- **验收**：
  1. 断网后节点调用返回 unavailable，恢复后不自动重放写操作
  2. 迁移后客户端自动重连，会话与记忆完整
  3. 两个 home 不可能同时运行（锁 + 控制面拒绝）

## 12. 待决问题

1. **本地模式要不要控制面？** 不接控制面时远程访问怎么办（内网穿透 vs 中继）？
2. **能力节点的默认授权**：每次调用都问人，还是按路径前缀长期授权？
3. **附件存哪**：对象存储（多端一致）还是卷内（迁移更简单）？
4. **协作编辑**：同一份 workspace 多人同时用时，是否需要"谁在编辑哪个 Bot"的软锁？
