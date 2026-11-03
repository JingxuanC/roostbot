# @roost/scheduler

把「Bot 什么时候开始一个回合」收敛成一个原语：**Activation**。

设计见 [`docs/design/scheduling.md`](../../docs/design/scheduling.md)。

## 范围

- `activation` / `run` / `run_event` 的类型与状态机（纯类型 + 纯函数，无 IO）
- cron → `nextRunAt` 的计算（IANA 时区、DST 跳过与重复）
- 幂等键：`(routineId, scheduledFor)`
- 退避与上限：套用设计文档 §6 的常量

## 不在这个包里

- 控制面的权威时钟与容器调度（在 `apps/`）
- 容器内的 effect 队列与 tick（在 `apps/runtime`）
- Bot routine 的 checks（在 Bot 定义里）

## 待办

- [ ] `Activation` / `Run` 类型与 JSON Schema
- [ ] `nextOccurrence(cron, timezone, after)` 实现 + DST 测试
- [ ] 幂等仓储接口（内存实现 + SQLite 实现）
- [ ] 退避/上限的纯函数与测试
