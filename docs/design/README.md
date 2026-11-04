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
| 16 | [bot-identity.md](bot-identity.md) | Bot 的图标：程序化默认，上传/生成可选 |

## 读法建议

- **想知道"一句话从来到走"**：1 → 2 → 6 → 7
- **想部署**：9 → 8 → 10 → 3
- **想控成本**：1 → 4 → 5
