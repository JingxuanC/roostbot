# @roost/workspace

工作区、运行时、客户端、能力节点的类型定义。

设计见 [`docs/design/workspace.md`](../../docs/design/workspace.md)。

## 三条硬规则

1. **一个 workspace 有且只有一个 home runtime**；两个家 = 状态分叉
2. **客户端无状态**：断线不影响回合，重连从事件 `seq` 续
3. **本地节点只出站**，能力按 `grant` 白名单，断线返回 `unavailable` 而不是挂起

## 不在这个包里

- 控制面的容器编排与反代（`apps/`）
- 事件流与持久化（`packages/event-schema`）
- 调度与激活（`packages/scheduler`）

## 待办

- [ ] `WorkspaceState` 状态机与非法迁移的拒绝
- [ ] 能力调用的 `grant` 校验（路径前缀/命令白名单）
- [ ] 客户端协议版本协商（`minProtocol`）
