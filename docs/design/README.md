# 设计文档索引

按依赖顺序读；每份都能独立看，但合起来才是完整机制。

| # | 文档 | 回答什么 |
|---|---|---|
| 1 | [loop-and-context.md](loop-and-context.md) | **第一性原理**：Bot 是一个 loop，模型无状态，所有能力都是上下文工程 |
| 2 | [events.md](events.md) | 事实源：一份追加式日志 + 多投影（统一之前三套事件定义） |
| 3 | [auth.md](auth.md) | 谁能进来：配对码、设备会话、runtime/节点 token、角色 |
| 4 | [memory.md](memory.md) | 判断怎么留下来：claim + evidence + falsifier，按作用域注入 |
| 5 | [budget.md](budget.md) | 钱怎么扣：预留-结算、五个计量单位、超限行为 |
| 6 | [messaging.md](messaging.md) | Bot 之间怎么说话：注入 + 发送者框，不是消息总线 |
| 7 | [agent-collaboration.md](agent-collaboration.md) | 协作怎么追踪：Assignment 状态机与证据 |
| 8 | [scheduling.md](scheduling.md) | 什么时候开始干活：Activation、cron、checks、睡/醒握手 |
| 9 | [workspace.md](workspace.md) | 状态住在哪：一个家、多个窗口、能力节点 |
| 10 | [sandboxing.md](sandboxing.md) | 执行怎么隔离：决策在外、执行在内、凭据不入箱 |
| 11 | [connectors.md](connectors.md) | 第三方能力怎么进：网关在中间，OpenConnector 默认 |
| 12 | [storage.md](storage.md) | 内容存哪：接口化，默认本地卷 |
| 13 | [ui.md](ui.md) | 界面：安静优先、诚实优先、一个模型多个窗口 |
| 14 | [plugins.md](plugins.md) | 插件怎么装：同一套 DSH 模型 + 预检/无人值守/信任 |
| 15 | [artifacts.md](artifacts.md) | 产物怎么到用户手上：内容寻址 + 消息级授权 + 渲染矩阵 |
| 17 | [rooms.md](rooms.md) | 房间运行时：共享日志、轮次、派发、限额、恢复 |
| 18 | [bots.md](bots.md) | Bot 身份：名字锁、模型固定、kickoff、设置分区 |
| 19 | [plugin-marketplace.md](plugin-marketplace.md) | 插件市场：A/B/C/D 兼容分级、安装流程、市场数据模型 |
| 16 | [bot-identity.md](bot-identity.md) | Bot 的图标：程序化默认，上传/生成可选 |
| 20 | [observability.md](observability.md) | 请求 id、结构化日志、`/metrics`、审计查询、限流 |
| 21 | [deployment.md](deployment.md) | 单机拓扑、systemd/launchd、反代与 TLS、备份/恢复、升级/回滚、多环境 |
| 22 | [slo.md](slo.md) | 可用性/延迟/错误预算与告警阈值（基于 `/metrics` 与 `/healthz`） |
| 23 | [compliance.md](compliance.md) | 数据驻留、导出、删除、保留期（与 storage/artifacts 的 GC 对齐） |
| 24 | [attachments-ui.md](attachments-ui.md) | 消息附件与产物渲染：图片/PDF/HTML 沙箱/表格/代码及安全边界 |
| 25 | [architecture-v2.md](architecture-v2.md) | 模块化单体、房间事件流推送、可恢复轮次、routine 进房间的迁移顺序 |
| 26 | [agent-runtimes.md](agent-runtimes.md) | 多 Agent 运行时：Adapter、Native/Embedded、Grok Build/Claude Code/Codex 接入、能力/凭据/用量 |
| 27 | [runtime-providers.md](runtime-providers.md) | RuntimeProvider 接口：Docker/OpenShell/local/K8s 可替换；编排、计算、harness、工具执行分层 |
| 28 | [docker-runtime.md](docker-runtime.md) | 不用 OpenShell：Docker worker + 一个 workspace 一个容器 + ready/网络/安全方案 |
| 29 | [docker-runtime-roadmap.md](docker-runtime-roadmap.md) | Docker Runtime 实施状态：已完成 / P0/P1/P2 剩余工作 / 验收顺序 |

## 读法建议

- **想知道"一句话从来到走"**：1 → 2 → 6 → 7 → 25
- **想看下一阶段怎么拆**：25
- **想部署**：21 → 9 → 8 → 10 → 3
- **想控成本**：1 → 4 → 5
- **想上线运维**：21 → 20 → 22 → 23
- **想改附件/产物界面**：15 → 12 → 24
| 30 | [native-relay.md](native-relay.md) | Native Relay PoC：用户已有外部 Agent 会话绑定 Room Slot、轮询 assignment、回传 advance |
| 31 | [daytona-kubernetes.md](daytona-kubernetes.md) | Daytona 与 Kubernetes RuntimeProvider；Kagent 的边界 |
| 32 | [local-computer.md](local-computer.md) | 本地 Computer / roostd / CLI：把电脑加入 workspace，派发本地 Agent 任务 |
