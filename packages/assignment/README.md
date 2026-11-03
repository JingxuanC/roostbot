# @roost/assignment

一个 Bot 委托给另一个 Bot 的**工作单元**：状态机、outcome、预算与合法迁移。

设计见 [`docs/design/agent-collaboration.md`](../../docs/design/agent-collaboration.md)。

## 与 Run 的区别

| | Run | Assignment |
|---|---|---|
| 是什么 | 一次激活的执行 | 一次 Bot 间的工作委托 |
| 谁产生 | 调度器 | Bot 的工具调用 |
| 关系 | Assignment 的执行**产生** Run | 一个 Run 也可以**发起**多个 Assignment |

## 硬约束

- **深度 ≤ 2**：再深就必须走房间讨论（每深一层都是一次完整上下文重建）
- **每 root 64 请求 / 96 执行**：预算按整棵树算
- **brief ≤ 12,000 字符**
- **无进展 10 分钟 → stalled**（租约，容器崩溃后可回收）
- **不能派回祖先**（直接成环）
- **迁移表之外的状态变化一律拒绝**，不静默接受

## 三条语义要点

1. `needs_input` 是**持久停车**，不是挂起进程；回答要记录 `answeredBy`
2. `evidence` 由 harness 观测，**不信模型自述**
3. `interrupted` 显式建模（容器重启是常态），恢复时明确 `rerun` 或 `cut`

## 不在这个包里

- 持久化（控制面或卷内 SQLite）
- 投递（`packages/messaging`）
- 执行（home runtime）

## 待办

- [ ] 迁移执行器：`applyTransition(assignment, to, outcome?)` + 事件追加
- [ ] 预算核算：按 root 聚合 requests/executions
- [ ] 恢复计划：按 rootId 分树、lastActivityAt 升序
